"""Shared helpers for the hazard outlook scripts (import_hazard_zones.py, outlook_worker.py).

Only free, open sources; nothing here needs an API key. The User-Agent names
the project, never a person.
"""

from __future__ import annotations

import json
import ssl
import sys
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pg import ROOT  # noqa: E402,F401

SCHEMA = ROOT / "db" / "schema" / "005_hazard_outlook.sql"
CACHE_DIR = ROOT / "data" / "hazard_cache"     # git-ignored downloads (terrain tiles)
USER_AGENT = "beacon-dev/0.1 (+https://github.com/rajryadav4/beacon)"

# The crime grid box (west, south, east, north): 135 x 80 cells of 0.002 x 0.003 degrees.
SEATTLE_BBOX = (-122.46, 47.48, -122.22, 47.75)
GRID = {"lat0": 47.48, "lng0": -122.46, "dLat": 0.002, "dLng": 0.003, "rows": 135, "cols": 80}

_context: ssl.SSLContext | None = None


def ssl_context() -> ssl.SSLContext:
    global _context
    if _context is None:
        try:
            import certifi
            _context = ssl.create_default_context(cafile=certifi.where())
        except ImportError:
            _context = ssl.create_default_context()
    return _context


def http_get(url: str, params: dict | None = None, timeout: int = 60, accept: str = "*/*",
             data: bytes | None = None) -> bytes:
    if params:
        url = url + ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT, "Accept": accept})
    with urllib.request.urlopen(request, timeout=timeout, context=ssl_context()) as response:
        return response.read()


def http_json(url: str, params: dict | None = None, timeout: int = 60, accept: str = "application/json"):
    return json.loads(http_get(url, params, timeout, accept))


def parse_bbox(text: str) -> tuple[float, float, float, float]:
    """'west,south,east,north' -> floats."""
    west, south, east, north = (float(v) for v in text.split(","))
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise ValueError("bbox must be west,south,east,north")
    return west, south, east, north


def apply_schema(conn) -> None:
    conn.execute(SCHEMA.read_text())
    conn.commit()


def upsert_source(conn, key: str, name: str, category: str, url: str, license: str,
                  attribution: str | None = None) -> None:
    conn.execute(
        """INSERT INTO hazard_sources (source_key, name, category, url, license, attribution)
           VALUES (%s, %s, %s, %s, %s, %s)
           ON CONFLICT (source_key) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category,
               url = EXCLUDED.url, license = EXCLUDED.license, attribution = EXCLUDED.attribution""",
        (key, name, category, url, license, attribution))


def record_status(conn, key: str, status: str, message: str | None = None, count: int | None = None) -> None:
    conn.execute(
        """UPDATE hazard_sources SET last_fetch = now(), status = %s, message = %s, item_count = %s,
               last_success = CASE WHEN %s = 'ok' THEN now() ELSE last_success END
           WHERE source_key = %s""",
        (status, message, count, status, key))
