"""Ground elevation for every grid cell centre, for the flood and tsunami models.

Sources, first that works:
1. `cell_terrain.elev_median` when that table exists and is filled (outlook pipeline);
2. a JSON cache on disk (apps/api/.cache/, git-ignored) from an earlier fetch;
3. AWS Terrain Tiles (Mapzen terrarium PNGs, open data, no key) at zoom 12, sampled at
   each cell centre, then written to the cache.

Terrarium decoding: elevation_m = R * 256 + G + B / 256 - 32768.
Terrain attribution: Mapzen / AWS Terrain Tiles (Open Data on AWS).
"""

from __future__ import annotations

import io
import json
import logging
import math
import struct
import threading
import time
import zlib
from pathlib import Path

from . import net

log = logging.getLogger(__name__)

TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
ZOOM = 12
# The crime grid (db/schema/002_app.sql): 135 rows x 80 cols of 0.002 deg lat x 0.003 deg lng.
GRID_WEST, GRID_SOUTH, GRID_ROWS, GRID_COLS, DLNG, DLAT = -122.46, 47.48, 135, 80, 0.003, 0.002
CACHE_FILE = Path(__file__).resolve().parents[2] / ".cache" / f"cell_elevation_z{ZOOM}.json"
RETRY_AFTER_S = 300

_lock = threading.Lock()
_elevations: dict[int, float] | None = None
_failed_at = 0.0


def cell_center(cell_id: int) -> tuple[float, float]:
    """cell_id -> (lat, lng) of its centre."""
    row, col = divmod(cell_id, 100)
    return GRID_SOUTH + (row + 0.5) * DLAT, GRID_WEST + (col + 0.5) * DLNG


def cell_at(lat: float, lng: float) -> int | None:
    row = math.floor((lat - GRID_SOUTH) / DLAT)
    col = math.floor((lng - GRID_WEST) / DLNG)
    if 0 <= row < GRID_ROWS and 0 <= col < GRID_COLS:
        return row * 100 + col
    return None


def all_cells() -> list[int]:
    return [r * 100 + c for r in range(GRID_ROWS) for c in range(GRID_COLS)]


# ---- PNG decoding (8-bit RGB/RGBA, non-interlaced; no image library needed) ----

def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def decode_png(data: bytes) -> tuple[int, int, int, list[bytearray]]:
    """-> (width, height, bytes per pixel, rows of raw pixel bytes)."""
    try:  # Pillow is much faster when it happens to be installed
        from PIL import Image  # type: ignore[import-not-found]

        img = Image.open(io.BytesIO(data)).convert("RGB")
        w, h = img.size
        raw = img.tobytes()
        return w, h, 3, [bytearray(raw[r * w * 3:(r + 1) * w * 3]) for r in range(h)]
    except ImportError:
        pass
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, idat, width = 8, b"", 0
    height = bpp = 0
    while pos < len(data):
        length, kind = struct.unpack(">I4s", data[pos:pos + 8])
        chunk = data[pos + 8:pos + 8 + length]
        if kind == b"IHDR":
            width, height, depth, color, _, _, interlace = struct.unpack(">IIBBBBB", chunk)
            if depth != 8 or color not in (2, 6) or interlace:
                raise ValueError("unsupported PNG format")
            bpp = 3 if color == 2 else 4
        elif kind == b"IDAT":
            idat += chunk
        elif kind == b"IEND":
            break
        pos += 12 + length
    raw = zlib.decompress(idat)
    stride = width * bpp
    rows: list[bytearray] = []
    prev = bytearray(stride)
    i = 0
    for _ in range(height):
        ftype = raw[i]
        line = bytearray(raw[i + 1:i + 1 + stride])
        i += 1 + stride
        if ftype == 1:
            for x in range(bpp, stride):
                line[x] = (line[x] + line[x - bpp]) & 0xFF
        elif ftype == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 0xFF
        elif ftype == 3:
            for x in range(stride):
                left = line[x - bpp] if x >= bpp else 0
                line[x] = (line[x] + ((left + prev[x]) >> 1)) & 0xFF
        elif ftype == 4:
            for x in range(stride):
                left = line[x - bpp] if x >= bpp else 0
                up_left = prev[x - bpp] if x >= bpp else 0
                line[x] = (line[x] + _paeth(left, prev[x], up_left)) & 0xFF
        rows.append(line)
        prev = line
    return width, height, bpp, rows


# ---- Tile maths ----

def tile_xy(lat: float, lng: float, z: int) -> tuple[float, float]:
    n = 2 ** z
    x = (lng + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def fetch_elevations() -> dict[int, float]:
    """Sample every cell centre from the terrarium tiles (about 20 tiles at zoom 12)."""
    tiles: dict[tuple[int, int], tuple[int, int, int, list[bytearray]]] = {}
    out: dict[int, float] = {}
    for cell in all_cells():
        lat, lng = cell_center(cell)
        fx, fy = tile_xy(lat, lng, ZOOM)
        key = (int(fx), int(fy))
        if key not in tiles:
            tiles[key] = decode_png(net.fetch_bytes(TILE_URL.format(z=ZOOM, x=key[0], y=key[1]), timeout=15))
        w, h, bpp, rows = tiles[key]
        px = min(w - 1, int((fx - key[0]) * w))
        py = min(h - 1, int((fy - key[1]) * h))
        r, g, b = rows[py][px * bpp:px * bpp + 3]
        out[cell] = round(r * 256 + g + b / 256 - 32768, 1)
    return out


def _from_db(conn) -> dict[int, float] | None:
    if conn is None:
        return None
    try:
        if conn.execute("SELECT to_regclass('cell_terrain')").fetchone()[0] is None:
            return None
        rows = conn.execute("SELECT cell_id, elev_median FROM cell_terrain WHERE elev_median IS NOT NULL").fetchall()
    except Exception:  # a table owned by another pipeline: never let it break the simulator
        log.info("cell_terrain not readable; using terrain tiles")
        return None
    if len(rows) < GRID_ROWS * GRID_COLS * 0.9:
        return None
    return {int(c): float(e) for c, e in rows}


def cell_elevations(conn=None) -> dict[int, float] | None:
    """Elevation (m above sea level) per cell id, or None when no source is available."""
    global _elevations, _failed_at
    from_db = _from_db(conn)
    if from_db:
        return from_db
    with _lock:
        if _elevations is not None:
            return _elevations
        if CACHE_FILE.exists():
            try:
                _elevations = {int(k): float(v) for k, v in json.loads(CACHE_FILE.read_text()).items()}
                return _elevations
            except (ValueError, OSError):
                pass
        if time.monotonic() - _failed_at < RETRY_AFTER_S and _failed_at:
            return None
        try:
            _elevations = fetch_elevations()
        except Exception as exc:  # network or decoding: degrade to the radius-only model
            _failed_at = time.monotonic()
            log.warning("terrain tiles unavailable (%s); flood and tsunami use the radius model", type(exc).__name__)
            return None
        try:
            CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
            (CACHE_FILE.parent / ".gitignore").write_text("*\n")
            CACHE_FILE.write_text(json.dumps(_elevations, separators=(",", ":")))
        except OSError:
            pass
        return _elevations
