"""Import official hazard zones for Seattle and score every grid cell's exposure.

Steps (all free, open data; no API keys):

  1. zones    Official hazard-zone polygons, clipped to the Seattle grid box, into
              hazard_zones: tsunami inundation (WA DNR models), liquefaction-prone
              areas, landslide areas (potential slides, known slides, 40 %+ steep
              slopes), flood-prone areas (City of Seattle ECA), FEMA National Flood
              Hazard Layer 1 % and 0.2 % annual-chance flood zones, and USGS
              Mount Rainier lahar / post-lahar sediment zones.
  2. terrain  Elevation and slope per grid cell from AWS Terrain Tiles (terrarium
              PNG, zoom 13, ~13 m pixels) into cell_terrain. Tiles are cached in
              data/hazard_cache/ (git-ignored).
  3. exposure Relative exposure score 0-100 per land cell and hazard into
              cell_hazard_exposure. Formula: pipeline/hazard_scoring.py.

Usage, from the repository root:

    python pipeline/import_hazard_zones.py                 # everything
    python pipeline/import_hazard_zones.py --skip-zones    # terrain + exposure
    python pipeline/import_hazard_zones.py --exposure-only

On a python.org build of Python on macOS, set SSL_CERT_FILE=$(python -m certifi).
"""

from __future__ import annotations

import argparse
import io
import json
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hazard_common import (CACHE_DIR, GRID, SEATTLE_BBOX, apply_schema, http_get, http_json,  # noqa: E402
                           record_status, upsert_source)
from hazard_scoring import SCORED_HAZARDS, exposure  # noqa: E402
from pg import connect  # noqa: E402

SEATTLE_GIS = "https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services"
FEMA_NFHL = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28"
TERRAIN_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
TERRAIN_ZOOM = 13
CLIP_MARGIN = 0.01  # degrees kept around the grid box
SIMPLIFY_DEG = 0.00002  # ~2 m: zone outlines are stored simplified

SEATTLE_LICENSE = "City of Seattle open GIS data, provided as is without warranty (City of Seattle Open Data Policy)"
DNR_LICENSE = ("Washington Geological Survey (WA DNR) tsunami model, vectorised and published by the City of "
               "Seattle; public data, provided as is")
FEMA_LICENSE = "FEMA National Flood Hazard Layer, US federal government data (public domain)"
USGS_VOLCANO_LICENSE = ("USGS volcano hazard zones compiled by the Washington Geological Survey, published by "
                        "the City of Seattle; US public domain / public data, provided as is")


def tsunami_level(value) -> str:
    return {3: "high", 2: "moderate", 1: "low"}.get(int(value or 0), "low")


TSUNAMI_DEPTH = {3: "deeper than 6 ft", 2: "1 to 6 ft deep", 1: "up to 1 ft deep"}


def _tsunami(field: str, scenario: str):
    def rule(props: dict):
        value = int(props.get(field) or 0)
        return tsunami_level(value), f"Tsunami inundation, {scenario}: water {TSUNAMI_DEPTH.get(value, 'depth unknown')}", \
            {"depthClass": value, "scenario": scenario}
    return rule


def fema_rule(props: dict):
    """FEMA flood zones: A*/V* = 1 % annual chance (100-year, high); X shaded = 0.2 % (500-year, moderate);
    levee-protected X = low; unshaded X (minimal hazard), D and open water are skipped."""
    zone = (props.get("FLD_ZONE") or "").strip().upper()
    subtype = (props.get("ZONE_SUBTY") or "").strip().upper()
    extra = {"fldZone": zone, "zoneSubtype": subtype or None, "sfha": props.get("SFHA_TF"),
             "staticBfe": props.get("STATIC_BFE") if (props.get("STATIC_BFE") or -9999) > -9999 else None}
    if zone.startswith("V"):
        return "high", f"FEMA coastal flood zone {zone} (1% annual chance, wave action)", extra
    if zone.startswith("A"):
        return "high", f"FEMA flood zone {zone} (1% annual chance, the '100-year' flood)", extra
    if zone == "X" and "0.2 PCT" in subtype:
        return "moderate", "FEMA flood zone X shaded (0.2% annual chance, the '500-year' flood)", extra
    if zone == "X" and "LEVEE" in subtype:
        return "low", "FEMA flood zone X: reduced flood risk due to levee", extra
    return None


def volcano_rule(props: dict):
    kind = (props.get("HAZARD_TYPE") or "").strip()
    volcano = props.get("VOLCANO") or "volcano"
    extra = {"volcano": volcano, "hazardType": kind, "link": props.get("HYPERLINK")}
    if kind == "Lahars":
        return "high", f"{volcano} lahar hazard zone", extra
    if kind == "Sediment":
        return "moderate", f"{volcano} post-lahar sedimentation zone (river flooding from lahar sediment)", extra
    return None


# key, hazard, kind, url, out fields, rule(props) -> (level, name, extra) | None, license, dissolve
ZONE_SOURCES = [
    {"key": "seattle-tsunami-seattle-fault", "name": "Seattle Fault tsunami model 2022 (WA DNR)",
     "hazard": "tsunami", "kind": "tsunami_inundation",
     "url": f"{SEATTLE_GIS}/Seattle_Fault_Tsunami_Model_2022/FeatureServer/1", "fields": "OBJECTID,FieldDissolve",
     "rule": _tsunami("FieldDissolve", "M7.5 Seattle Fault earthquake (WA DNR 2022)"), "license": DNR_LICENSE},
    {"key": "seattle-tsunami-cascadia", "name": "Cascadia L1 tsunami inundation (WA DNR)",
     "hazard": "tsunami", "kind": "tsunami_inundation",
     "url": f"{SEATTLE_GIS}/Cascadia_L1_Tsunami_Inundation/FeatureServer/5", "fields": "OBJECTID,SimplifedInundation",
     "rule": _tsunami("SimplifedInundation", "M9 Cascadia subduction zone earthquake (WA DNR, L1 scenario)"),
     "license": DNR_LICENSE},
    {"key": "seattle-eca-liquefaction", "name": "Seattle ECA liquefaction-prone areas",
     "hazard": "earthquake", "kind": "liquefaction",
     "url": f"{SEATTLE_GIS}/ECA_Liquefaction_Prone_Areas/FeatureServer/5", "fields": "OBJECTID",
     "rule": lambda p: ("high", "Liquefaction-prone area (ground can turn soft in strong shaking)", {}),
     "license": SEATTLE_LICENSE},
    {"key": "seattle-eca-known-slides", "name": "Seattle ECA known landslides",
     "hazard": "flood", "kind": "landslide",
     "url": f"{SEATTLE_GIS}/Environmentally_Critical_Areas_Known_Slides/FeatureServer/1", "fields": "OBJECTID,YEAR_",
     "rule": lambda p: ("high", f"Known landslide{' (' + str(p['YEAR_']) + ')' if p.get('YEAR_') else ''}",
                        {"year": p.get("YEAR_")}),
     "license": SEATTLE_LICENSE},
    {"key": "seattle-eca-potential-slides", "name": "Seattle ECA potential landslide areas",
     "hazard": "flood", "kind": "landslide",
     "url": f"{SEATTLE_GIS}/Environmentally_Critical_Areas_Potential_Slide_Areas/FeatureServer/7", "fields": "OBJECTID",
     "rule": lambda p: ("moderate", "Potential landslide area (geology prone to sliding when wet or shaken)", {}),
     "license": SEATTLE_LICENSE},
    {"key": "seattle-eca-steep-slopes", "name": "Seattle ECA steep slopes (40 % or more)",
     "hazard": "flood", "kind": "landslide",
     "url": f"{SEATTLE_GIS}/Environmentally_Critical_Areas_Steep_Slope/FeatureServer/9", "fields": "OBJECTID",
     "rule": lambda p: ("moderate", "Steep slope, 40% grade or more", {}), "license": SEATTLE_LICENSE,
     "dissolve": True},
    {"key": "seattle-eca-flood-prone", "name": "Seattle ECA flood-prone areas",
     "hazard": "flood", "kind": "flood_zone",
     "url": f"{SEATTLE_GIS}/ECA_Flood_Prone_Areas/FeatureServer/0", "fields": "OBJECTID",
     "rule": lambda p: ("moderate", "Flood-prone area (FEMA flood zone plus 100 ft buffer)", {}),
     "license": SEATTLE_LICENSE},
    {"key": "fema-nfhl", "name": "FEMA National Flood Hazard Layer, flood hazard zones",
     "hazard": "flood", "kind": "flood_zone",
     "url": FEMA_NFHL, "fields": "OBJECTID,FLD_AR_ID,FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE",
     "where": "FLD_ZONE <> 'OPEN WATER' AND NOT (FLD_ZONE = 'X' AND (ZONE_SUBTY IS NULL OR ZONE_SUBTY LIKE 'AREA OF MINIMAL%'))",
     "rule": fema_rule, "license": FEMA_LICENSE, "page": 200},
    {"key": "usgs-volcano-zones", "name": "USGS volcano hazard zones (Mount Rainier lahars and sediment)",
     "hazard": "volcano", "kind": "lahar",
     "url": f"{SEATTLE_GIS}/Volcanic_Hazards_from_USGS/FeatureServer/9",
     "fields": "OBJECTID,VOLCANO,HAZARD_TYPE,HYPERLINK",
     "rule": volcano_rule, "license": USGS_VOLCANO_LICENSE},
]


# ---- zones -------------------------------------------------------------------

def fetch_arcgis(url: str, bbox, fields: str, where: str = "1=1", page: int = 1000) -> list[dict]:
    """All features of an ArcGIS layer that touch the box, as GeoJSON in EPSG:4326."""
    west, south, east, north = bbox
    features, offset = [], 0
    while True:
        params = {
            "where": where, "outFields": fields, "returnGeometry": "true", "outSR": 4326, "f": "geojson",
            "geometry": f"{west},{south},{east},{north}", "geometryType": "esriGeometryEnvelope", "inSR": 4326,
            "spatialRel": "esriSpatialRelIntersects", "geometryPrecision": 6,
            "resultOffset": offset, "resultRecordCount": page, "orderByFields": "OBJECTID",
        }
        for attempt in range(3):
            try:
                body = http_json(f"{url}/query", params, timeout=120)
                break
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(3 * (attempt + 1))
        if "error" in body:
            raise RuntimeError(f"{url}: {body['error']}")
        batch = body.get("features", [])
        features.extend(batch)
        more = body.get("exceededTransferLimit") or body.get("properties", {}).get("exceededTransferLimit")
        if not batch or not more:
            return features
        offset += len(batch)


INSERT_ZONE = """
    INSERT INTO hazard_zones (hazard, kind, source, source_ref, name, level, geom, properties, license)
    SELECT %(hazard)s, %(kind)s, %(source)s, %(ref)s, %(name)s, %(level)s, g, %(props)s, %(license)s
    FROM (
        SELECT ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SimplifyPreserveTopology(ST_Intersection(
                   ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(%(geom)s), 4326)),
                   ST_MakeEnvelope(%(w)s, %(s)s, %(e)s, %(n)s, 4326)), %(tol)s)), 3)) AS g
    ) x
    WHERE NOT ST_IsEmpty(g)
    ON CONFLICT (source, source_ref) DO NOTHING
"""

# Many tiny polygons (27k steep-slope patches) are merged per ~1 km tile, by level.
DISSOLVE = """
    INSERT INTO hazard_zones (hazard, kind, source, source_ref, name, level, geom, properties, license)
    SELECT hazard, kind, source, 'tile-' || tx || '-' || ty || '-' || level, min(name), level,
           ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SimplifyPreserveTopology(ST_Union(geom), 0.00002)), 3)),
           jsonb_build_object('mergedFeatures', count(*)), min(license)
    FROM (
        SELECT z.*, floor(ST_X(ST_Centroid(geom)) / 0.01)::int AS tx, floor(ST_Y(ST_Centroid(geom)) / 0.01)::int AS ty
        FROM hazard_zones_staging z
    ) s
    GROUP BY hazard, kind, source, level, tx, ty
"""


def load_zone_source(conn, src: dict, bbox) -> int:
    west, south, east, north = bbox
    clip = (west - CLIP_MARGIN, south - CLIP_MARGIN, east + CLIP_MARGIN, north + CLIP_MARGIN)
    features = fetch_arcgis(src["url"], clip, src["fields"], src.get("where", "1=1"), src.get("page", 1000))
    rows = []
    for f in features:
        if not f.get("geometry"):
            continue
        props = f.get("properties") or {}
        ruled = src["rule"](props)
        if not ruled:
            continue
        level, name, extra = ruled
        ref = str(props.get("FLD_AR_ID") or props.get("OBJECTID") or f.get("id"))
        rows.append({"hazard": src["hazard"], "kind": src["kind"], "source": src["key"], "ref": ref,
                     "name": name[:255], "level": level, "props": json.dumps({k: v for k, v in extra.items()
                                                                               if v is not None}),
                     "license": src["license"], "geom": json.dumps(f["geometry"]),
                     "w": clip[0], "s": clip[1], "e": clip[2], "n": clip[3], "tol": SIMPLIFY_DEG})
    with conn.transaction():
        conn.execute("DELETE FROM hazard_zones WHERE source = %s", (src["key"],))
        if src.get("dissolve"):
            conn.execute("CREATE TEMP TABLE hazard_zones_staging (hazard text, kind text, source text, source_ref text,"
                         " name text, level text, geom geometry, properties jsonb, license text) ON COMMIT DROP")
            with conn.cursor() as cur:
                cur.executemany(INSERT_ZONE.replace("INSERT INTO hazard_zones ", "INSERT INTO hazard_zones_staging ")
                                .replace("ON CONFLICT (source, source_ref) DO NOTHING", ""), rows)
            conn.execute(DISSOLVE)
        else:
            with conn.cursor() as cur:
                cur.executemany(INSERT_ZONE, rows)
        count = conn.execute("SELECT count(*) FROM hazard_zones WHERE source = %s", (src["key"],)).fetchone()[0]
    return count


def import_zones(conn, bbox, only: set[str] | None = None) -> None:
    for src in ZONE_SOURCES:
        if only and src["key"] not in only:
            continue
        upsert_source(conn, src["key"], src["name"], "zones", src["url"], src["license"])
        conn.commit()
        started = time.time()
        try:
            count = load_zone_source(conn, src, bbox)
            record_status(conn, src["key"], "ok", None, count)
            print(f"  {src['key']}: {count} zones ({time.time() - started:.0f} s)")
        except Exception as exc:  # keep going: one broken source must not stop the rest
            conn.rollback()
            record_status(conn, src["key"], "error", str(exc)[:500], None)
            print(f"  {src['key']}: FAILED {exc}", file=sys.stderr)
        conn.commit()


FOOTPRINTS = """
    INSERT INTO hazard_zone_footprints (kind, geom)
    SELECT kind, ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Union(ST_MakeValid(
               ST_SnapToGrid(ST_SimplifyPreserveTopology(geom, 0.0001), 0.00001)))), 3))
    FROM hazard_zones GROUP BY kind
"""


def import_footprints(conn) -> None:
    """One dissolved outline per zone kind (~10 m simplification) for outlook areas."""
    started = time.time()
    with conn.transaction():
        conn.execute("DELETE FROM hazard_zone_footprints")
        conn.execute(FOOTPRINTS)
    kinds = [r[0] for r in conn.execute("SELECT kind FROM hazard_zone_footprints ORDER BY kind")]
    print(f"  footprints: {', '.join(kinds)} ({time.time() - started:.0f} s)")


# ---- terrain -----------------------------------------------------------------

def lnglat_to_tile(lng: float, lat: float, z: int) -> tuple[float, float]:
    n = 2 ** z
    x = (lng + 180.0) / 360.0 * n
    y = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n
    return x, y


def decode_terrarium(rgb):
    """Terrarium PNG pixels -> metres: (R * 256 + G + B / 256) - 32768."""
    import numpy as np
    rgb = rgb.astype(np.float64)
    return rgb[..., 0] * 256.0 + rgb[..., 1] + rgb[..., 2] / 256.0 - 32768.0


def fetch_tile(z: int, x: int, y: int) -> bytes:
    path = CACHE_DIR / "terrarium" / str(z) / str(x) / f"{y}.png"
    if path.exists():
        return path.read_bytes()
    data = http_get(TERRAIN_URL.format(z=z, x=x, y=y), timeout=60)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


def terrain_mosaic(bbox, z: int = TERRAIN_ZOOM):
    """Elevation mosaic covering the box: (elev[m], x0 tile, y0 tile)."""
    import numpy as np
    from PIL import Image
    west, south, east, north = bbox
    x0, y0 = (int(v) for v in lnglat_to_tile(west, north, z))
    x1, y1 = (int(v) for v in lnglat_to_tile(east, south, z))
    rows = []
    for ty in range(y0, y1 + 1):
        row = []
        for tx in range(x0, x1 + 1):
            img = Image.open(io.BytesIO(fetch_tile(z, tx, ty))).convert("RGB")
            row.append(decode_terrarium(np.asarray(img)))
        rows.append(np.hstack(row))
    return np.vstack(rows), x0, y0


def cell_terrain_rows(bbox, in_city: set[int], z: int = TERRAIN_ZOOM) -> list[tuple]:
    """Per grid cell: median and min land elevation, 90th percentile slope, water share."""
    import numpy as np
    import pandas as pd
    elev, x0, y0 = terrain_mosaic(bbox, z)
    h, w = elev.shape
    n = 2 ** z
    px = (np.arange(w) + 0.5) / 256.0 + x0
    py = (np.arange(h) + 0.5) / 256.0 + y0
    lng = px / n * 360.0 - 180.0
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * py / n))))
    # Web Mercator pixels are square on the ground: 156543.03 m * cos(lat) / 2^z.
    pixel_m = 156543.03392 * np.cos(np.radians(lat)) / n
    dz_dy, dz_dx = np.gradient(elev)
    slope = np.degrees(np.arctan(np.hypot(dz_dx, dz_dy) / pixel_m[:, None]))
    # Water: at or below 0.3 m (Puget Sound surface), or hydro-flattened lake surfaces
    # (a pixel and all 8 neighbours flat to within ~1 cm per pixel; terrarium steps are 4 mm).
    flat = slope < 0.05
    flat_nb = flat.copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            flat_nb &= np.roll(np.roll(flat, dy, axis=0), dx, axis=1)
    water = (elev <= 0.3) | flat_nb
    col = np.floor((lng - GRID["lng0"]) / GRID["dLng"]).astype(int)
    row = np.floor((lat - GRID["lat0"]) / GRID["dLat"]).astype(int)
    cols, rows_ = np.meshgrid(col, row)
    ok = (cols >= 0) & (cols < GRID["cols"]) & (rows_ >= 0) & (rows_ < GRID["rows"])
    df = pd.DataFrame({"cell": (rows_ * 100 + cols)[ok], "elev": elev[ok], "slope": slope[ok], "water": water[ok]})
    share = df.groupby("cell")["water"].mean()
    land = df[~df["water"]].groupby("cell").agg(elev_median=("elev", "median"), elev_min=("elev", "min"),
                                               slope_p90=("slope", lambda s: float(np.percentile(s, 90))))
    out = []
    for cell, water_share in share.items():
        stats = land.loc[cell] if cell in land.index else None
        out.append((int(cell),
                    None if stats is None else float(stats["elev_median"]),
                    None if stats is None else float(stats["elev_min"]),
                    None if stats is None else float(stats["slope_p90"]),
                    float(water_share), int(cell) in in_city))
    return out


def import_terrain(conn, bbox) -> None:
    key = "aws-terrain-tiles"
    upsert_source(conn, key, "AWS Terrain Tiles (Mapzen terrarium elevation)", "terrain",
                  "https://registry.opendata.aws/terrain-tiles/",
                  "Open data on AWS; sources include USGS 3DEP (public domain), SRTM, GMTED, ETOPO1 and NOAA "
                  "coastal DEMs",
                  "Terrain Tiles: Mapzen, USGS 3DEP, NASA SRTM, NOAA ETOPO1/coastal DEMs, and others "
                  "(see https://github.com/tilezen/joerd/blob/master/docs/attribution.md)")
    conn.commit()
    started = time.time()
    try:
        in_city = {r[0] for r in conn.execute("SELECT cell_id FROM grid_cells WHERE neighborhood_id IS NOT NULL")}
        rows = cell_terrain_rows(bbox, in_city)
        with conn.transaction():
            conn.execute("DELETE FROM cell_terrain")
            with conn.cursor() as cur:
                cur.executemany("INSERT INTO cell_terrain (cell_id, elev_median, elev_min, slope_p90, water_share,"
                                " in_city) VALUES (%s, %s, %s, %s, %s, %s)", rows)
        record_status(conn, key, "ok", None, len(rows))
        print(f"  terrain: {len(rows)} cells ({time.time() - started:.0f} s)")
    except Exception as exc:
        conn.rollback()
        record_status(conn, key, "error", str(exc)[:500], None)
        print(f"  terrain: FAILED {exc}", file=sys.stderr)
    conn.commit()


# ---- exposure ----------------------------------------------------------------

LAND_WATER_SHARE = 0.5  # cells more than half open water are not scored

# Per land cell and hazard: cumulative zone shares (high, high+moderate, any level),
# distance to the nearest zone of the hazard (searched up to ~1.5 km), and distance to
# the nearest suitable safe place. Shares are summed within one source (its polygons do
# not overlap) and the largest share of any source is used, so overlapping layers (FEMA
# and the city's flood-prone areas) are not counted twice. Zones are simplified (~2 m)
# and subdivided first so each intersection stays small.
EXPOSURE_INPUTS = """
    CREATE TEMP TABLE zone_parts ON COMMIT DROP AS
    SELECT k.hazard, z.source, z.level,
           ST_Subdivide(ST_SimplifyPreserveTopology(z.geom, 0.00002), 256) AS geom
    FROM hazard_zones z JOIN hazard_zone_kinds k ON k.kind = z.kind;
    CREATE INDEX ON zone_parts USING gist (geom);
    ANALYZE zone_parts;
"""

EXPOSURE_QUERY = """
    WITH cells AS (
        SELECT g.cell_id, g.cell, g.center, t.elev_median, t.slope_p90
        FROM grid_cells g JOIN cell_terrain t ON t.cell_id = g.cell_id
        WHERE t.water_share <= %(water)s
    ), parts AS (
        SELECT c.cell_id, p.source, p.level, ST_Area(ST_Intersection(p.geom, c.cell)) AS a
        FROM cells c JOIN zone_parts p ON p.hazard = %(hazard)s AND p.geom && c.cell
    ), by_source AS (
        SELECT cell_id, source,
               COALESCE(sum(a) FILTER (WHERE level = 'high'), 0) AS a_high,
               COALESCE(sum(a) FILTER (WHERE level IN ('high', 'moderate')), 0) AS a_hm,
               sum(a) AS a_all
        FROM parts GROUP BY cell_id, source
    ), shares AS (
        SELECT cell_id, max(a_high) AS a_high, max(a_hm) AS a_hm, max(a_all) AS a_all
        FROM by_source GROUP BY cell_id
    )
    SELECT c.cell_id,
           LEAST(COALESCE(s.a_high, 0) / ST_Area(c.cell), 1), LEAST(COALESCE(s.a_hm, 0) / ST_Area(c.cell), 1),
           LEAST(COALESCE(s.a_all, 0) / ST_Area(c.cell), 1),
           c.elev_median, c.slope_p90,
           CASE WHEN COALESCE(s.a_all, 0) > 0 THEN 0 ELSE
               (SELECT min(ST_Distance(c.cell::geography, p.geom::geography))
                FROM zone_parts p WHERE p.hazard = %(hazard)s AND ST_DWithin(p.geom, c.cell, 0.015)) END,
           (SELECT ST_Distance(v.geom, c.center)
            FROM safe_places_visible v
            WHERE v.kind = ANY(%(kinds)s::text[])
            ORDER BY v.geom <-> c.center LIMIT 1)
    FROM cells c LEFT JOIN shares s ON s.cell_id = c.cell_id
"""


def import_exposure(conn) -> None:
    started = time.time()
    with conn.transaction():
        conn.execute(EXPOSURE_INPUTS)
        conn.execute("DELETE FROM cell_hazard_exposure")
        for hazard in SCORED_HAZARDS:
            kinds = [r[0] for r in conn.execute("SELECT kind FROM hazard_place_kinds WHERE hazard = %s", (hazard,))]
            rows = conn.execute(EXPOSURE_QUERY, {"hazard": hazard, "water": LAND_WATER_SHARE,
                                                 "kinds": kinds}).fetchall()
            out = []
            for cell_id, s_high, s_hm, s_all, elev, slope, zone_d, place_d in rows:
                e = exposure(hazard, s_high, s_hm, s_all, elev, slope, zone_d, place_d)
                out.append((cell_id, hazard, e["score"], e["level"], json.dumps(e["factors"])))
            with conn.cursor() as cur:
                cur.executemany("INSERT INTO cell_hazard_exposure (cell_id, hazard, score, level, factors)"
                                " VALUES (%s, %s, %s, %s, %s)", out)
            levels = {lvl: sum(1 for r in out if r[3] == lvl) for lvl in ("high", "moderate", "low")}
            print(f"  exposure {hazard}: {len(out)} cells {levels}")
    print(f"  exposure done ({time.time() - started:.0f} s)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--skip-zones", action="store_true")
    ap.add_argument("--skip-terrain", action="store_true")
    ap.add_argument("--exposure-only", action="store_true")
    ap.add_argument("--only", help="comma-separated zone source keys to (re)load")
    args = ap.parse_args()
    with connect() as conn:
        apply_schema(conn)
        if not args.exposure_only:
            if not args.skip_zones:
                print("Hazard zones:")
                import_zones(conn, SEATTLE_BBOX, set(args.only.split(",")) if args.only else None)
            if not args.skip_zones or not conn.execute("SELECT 1 FROM hazard_zone_footprints LIMIT 1").fetchone():
                import_footprints(conn)
            if not args.skip_terrain:
                print("Terrain:")
                import_terrain(conn, SEATTLE_BBOX)
        print("Exposure:")
        import_exposure(conn)


if __name__ == "__main__":
    main()
