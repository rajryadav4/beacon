"""Hazard outlook worker: what may be coming to the region in the next ~72 hours.

Fetches free, open sources (no API keys needed), applies the transparent rules in
pipeline/outlook_sources.py and stores the result in hazard_outlook, replacing each
source's items after every successful fetch. A failing source keeps its previous
items until they expire, and its error is recorded in hazard_sources.

    NASA EONET (open natural events), GDACS, NOAA tsunami.gov, NWS watches and
    future alerts, NWS river forecasts (NWPS), NOAA SPC convective outlooks, NOAA
    WPC excessive rainfall outlooks, Open-Meteo weather and air-quality forecasts,
    USGS earthquakes (recent activity only: earthquakes cannot be predicted), and
    NASA FIRMS hotspots only when FIRMS_MAP_KEY is set (free key, optional).

Usage, from the repository root:

    python pipeline/outlook_worker.py --once
    python pipeline/outlook_worker.py --interval 30          # loop, minutes
    python pipeline/outlook_worker.py --once --bbox -122.46,47.48,-122.22,47.75

On a python.org build of Python on macOS, set SSL_CERT_FILE=$(python -m certifi).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import outlook_sources as osrc  # noqa: E402
from hazard_common import SEATTLE_BBOX, apply_schema, http_get, http_json, parse_bbox, record_status, upsert_source  # noqa: E402
from pg import connect  # noqa: E402

NEAR_DEG = 0.25  # items are kept when their area comes within ~25 km of the region
PUBLIC_DOMAIN = "US federal government data (public domain)"

SOURCES = {
    "nasa-eonet": ("NASA EONET natural events", "https://eonet.gsfc.nasa.gov/api/v3/events",
                   "NASA open data, no restrictions on use (event sources keep their own terms)",
                   "NASA Earth Observatory Natural Event Tracker (EONET)"),
    "gdacs": ("GDACS disaster alerts", "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH",
              "Free public alert information; credit GDACS (European Commission JRC and UN OCHA)",
              "Global Disaster Alert and Coordination System (GDACS)"),
    "tsunami-gov": ("NOAA tsunami.gov (National Tsunami Warning Center)", "https://www.tsunami.gov/events/xml/PAAQAtom.xml",
                    PUBLIC_DOMAIN, "NOAA / National Weather Service"),
    "nws": ("NWS watches and future alerts", "https://api.weather.gov/alerts/active", PUBLIC_DOMAIN,
            "NOAA / National Weather Service"),
    "nwps": ("NWS river forecasts (National Water Prediction Service)", "https://api.water.noaa.gov/nwps/v1/gauges",
             PUBLIC_DOMAIN + "; gauge observations from USGS", "NOAA / NWS National Water Prediction Service, USGS"),
    "noaa-spc": ("NOAA SPC convective outlooks", "https://www.spc.noaa.gov/products/outlook/", PUBLIC_DOMAIN,
                 "NOAA Storm Prediction Center"),
    "noaa-wpc-ero": ("NOAA WPC excessive rainfall outlooks",
                     "https://mapservices.weather.noaa.gov/vector/rest/services/hazards/wpc_precip_hazards/MapServer",
                     PUBLIC_DOMAIN, "NOAA Weather Prediction Center"),
    "open-meteo": ("Open-Meteo weather forecast", "https://api.open-meteo.com/v1/forecast",
                   "Data CC BY 4.0; the free API is for non-commercial use (the server is open source, AGPL-3.0, "
                   "and can be self-hosted)", "Weather data by Open-Meteo.com"),
    "open-meteo-air": ("Open-Meteo air-quality forecast (CAMS)", "https://air-quality-api.open-meteo.com/v1/air-quality",
                       "Data CC BY 4.0; free API for non-commercial use; contains modified Copernicus Atmosphere "
                       "Monitoring Service information", "Open-Meteo.com, Copernicus Atmosphere Monitoring Service"),
    "usgs-quakes": ("USGS earthquakes (recent activity, no forecast)", "https://earthquake.usgs.gov/fdsnws/event/1/query",
                    PUBLIC_DOMAIN, "U.S. Geological Survey"),
    "nasa-firms": ("NASA FIRMS active fires (optional, FIRMS_MAP_KEY)", "https://firms.modaps.eosdis.nasa.gov/api/area/",
                   "NASA open data; needs a free MAP_KEY (optional source)", "NASA FIRMS / LANCE"),
}


# ---- fetchers (network) ---------------------------------------------------------------

def sample_boxes(bbox, n: int = 3) -> list[tuple]:
    w, s, e, nn = bbox
    dx, dy = (e - w) / n, (nn - s) / n
    return [(w + i * dx, s + j * dy, w + (i + 1) * dx, s + (j + 1) * dy) for j in range(n) for i in range(n)]


def fetch_eonet(bbox, now):
    w, s, e, n = bbox
    m = 3.5  # degrees: volcanoes up to ~350 km away matter (ash)
    payload = http_json(SOURCES["nasa-eonet"][1], {"status": "open", "days": 10,
                                                   "bbox": f"{w - m},{n + m},{e + m},{s - m}"}, timeout=90)
    return osrc.parse_eonet(payload, bbox, now), f"{len(payload.get('events', []))} open events in the wider area"


def fetch_gdacs(bbox, now):
    payload = http_json(SOURCES["gdacs"][1], {"eventlist": "TC;FL;VO;WF", "alertlevel": "Green;Orange;Red"})
    return osrc.parse_gdacs(payload, bbox, now), f"{len(payload.get('features', []))} current events worldwide"


def fetch_tsunami(bbox, now):
    entries = osrc.parse_tsunami_atom(http_get(SOURCES["tsunami-gov"][1], accept="application/atom+xml"))
    affects = {}
    for e in entries:
        if e["category"].lower() in osrc.TSUNAMI_LEVEL and e["cap"] and not e["no_threat"]:
            affects[e["id"]] = osrc.cap_mentions_region(http_get(e["cap"]))
    cats = ", ".join(sorted({e["category"] for e in entries})) or "none"
    return osrc.tsunami_items(entries, affects, bbox, now), f"latest bulletins: {cats}"


def region_zones(bbox) -> list[str]:
    """NWS forecast, county and fire-weather zones under the region's center and inset corners."""
    w, s, e, n = bbox
    pts = [((w + e) / 2, (s + n) / 2), (w + 0.2 * (e - w), s + 0.2 * (n - s)), (e - 0.2 * (e - w), s + 0.2 * (n - s)),
           (w + 0.2 * (e - w), n - 0.2 * (n - s)), (e - 0.2 * (e - w), n - 0.2 * (n - s))]
    zones = set()
    for lng, lat in pts:
        try:
            p = http_json(f"https://api.weather.gov/points/{lat:.4f},{lng:.4f}", accept="application/geo+json")["properties"]
        except Exception:
            continue
        for k in ("forecastZone", "county", "fireWeatherZone"):
            if p.get(k):
                zones.add(p[k].rstrip("/").rsplit("/", 1)[-1])
    return sorted(zones)


def fetch_nws(bbox, now):
    zones = region_zones(bbox)
    if not zones:
        raise RuntimeError("no NWS zones found for the region (outside the US?)")
    payload = http_json(SOURCES["nws"][1], {"zone": ",".join(zones)}, accept="application/geo+json")
    items = osrc.parse_nws_alerts(payload, bbox, now)
    cache: dict[str, dict | None] = {}
    for it in items:
        polys = []
        for url in it.pop("affected_zones", []):
            if url not in cache:
                try:
                    cache[url] = http_json(url, accept="application/geo+json").get("geometry")
                except Exception:
                    cache[url] = None
            g = cache[url]
            if g and g["type"] == "Polygon":
                polys.append(g["coordinates"])
            elif g and g["type"] == "MultiPolygon":
                polys.extend(g["coordinates"])
        if polys:
            it["geometry"] = {"type": "MultiPolygon", "coordinates": polys}
    return items, f"{len(payload.get('features', []))} active alerts for zones {', '.join(zones)}"


def fetch_nwps(bbox, now):
    w, s, e, n = bbox
    m = 0.1
    listing = http_json(SOURCES["nwps"][1], {"bbox.xmin": w - m, "bbox.ymin": s - m, "bbox.xmax": e + m,
                                             "bbox.ymax": n + m, "srid": "EPSG_4326"})
    items, checked = [], []
    for g in listing.get("gauges", []):
        if ((g.get("status") or {}).get("observed") or {}).get("floodCategory") in (None, "not_defined"):
            continue
        lid = g["lid"]
        detail = http_json(f"{SOURCES['nwps'][1]}/{lid}")
        stageflow = http_json(f"{SOURCES['nwps'][1]}/{lid}/stageflow")
        checked.append(lid)
        items.extend(osrc.parse_nwps(detail, stageflow, now))
    return items, f"gauges with flood stages checked: {', '.join(checked) or 'none'}"


def _multi(url: str, boxes, params: dict) -> list[dict]:
    lats = ",".join(f"{(b[1] + b[3]) / 2:.4f}" for b in boxes)
    lngs = ",".join(f"{(b[0] + b[2]) / 2:.4f}" for b in boxes)
    data = http_json(url, {"latitude": lats, "longitude": lngs, "timezone": "UTC", **params}, timeout=90)
    return data if isinstance(data, list) else [data]


def fetch_open_meteo(bbox, now):
    boxes = sample_boxes(bbox)
    points = _multi(SOURCES["open-meteo"][1], boxes, {
        "hourly": "precipitation,apparent_temperature,wind_speed_10m,wind_gusts_10m",
        "past_days": 18, "forecast_days": 4, "temperature_unit": "fahrenheit", "wind_speed_unit": "mph"})
    return osrc.parse_open_meteo(points, boxes, bbox, now), f"{len(points)} sample points"


def fetch_air(bbox, now):
    boxes = sample_boxes(bbox)
    points = _multi(SOURCES["open-meteo-air"][1], boxes, {"hourly": "pm2_5", "past_days": 1, "forecast_days": 4})
    return osrc.parse_air_quality(points, boxes, now), f"{len(points)} sample points"


def fetch_spc(bbox, now):
    items = []
    for day in (1, 2, 3):
        payload = http_json(f"https://www.spc.noaa.gov/products/outlook/day{day}otlk_cat.nolyr.geojson")
        items.extend(osrc.parse_spc(payload, day, now))
    return items, "days 1-3"


def fetch_ero(bbox, now):
    w, s, e, n = bbox
    items = []
    for day, layer in ((1, 0), (2, 1), (3, 2)):
        payload = http_json(f"{SOURCES['noaa-wpc-ero'][1]}/{layer}/query", {
            "where": "1=1", "outFields": "*", "f": "geojson", "outSR": 4326, "inSR": 4326,
            "geometry": f"{w - NEAR_DEG},{s - NEAR_DEG},{e + NEAR_DEG},{n + NEAR_DEG}",
            "geometryType": "esriGeometryEnvelope", "spatialRel": "esriSpatialRelIntersects"})
        items.extend(osrc.parse_ero(payload, day, now))
    return items, "days 1-3"


def fetch_quakes(bbox, now):
    cx, cy = osrc.bbox_center(bbox)
    payload = http_json(SOURCES["usgs-quakes"][1], {
        "format": "geojson", "starttime": (now - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%S"),
        "minmagnitude": 2.5, "latitude": f"{cy:.4f}", "longitude": f"{cx:.4f}",
        "maxradiuskm": osrc.AFTERSHOCK_RADIUS_KM})
    s = osrc.summarize_quakes(payload, now)
    msg = (f"{s['count']} earthquakes M2.5+ within {osrc.AFTERSHOCK_RADIUS_KM} km in the past 7 days"
           + (f"; largest M{s['largestMag']:.1f} {s['largestPlace']}" if s["count"] else "")
           + ". Earthquakes cannot be predicted.")
    return osrc.parse_usgs_quakes(payload, bbox, now), msg


def fetch_firms(bbox, now):
    key = os.environ.get("FIRMS_MAP_KEY", "").strip()
    w, s, e, n = bbox
    m = 0.5
    url = f"{SOURCES['nasa-firms'][1]}csv/{key}/VIIRS_NOAA20_NRT/{w - m},{s - m},{e + m},{n + m}/2"
    text = http_get(url, timeout=90).decode("utf-8", "replace")
    if text.lstrip().lower().startswith(("invalid", "error")):
        raise RuntimeError("FIRMS rejected the request (check FIRMS_MAP_KEY)")  # never echo the key
    return osrc.parse_firms_csv(text, bbox, now), "VIIRS NOAA-20, last 2 days"


FETCHERS = {
    "nasa-eonet": fetch_eonet, "gdacs": fetch_gdacs, "tsunami-gov": fetch_tsunami, "nws": fetch_nws,
    "nwps": fetch_nwps, "noaa-spc": fetch_spc, "noaa-wpc-ero": fetch_ero, "open-meteo": fetch_open_meteo,
    "open-meteo-air": fetch_air, "usgs-quakes": fetch_quakes, "nasa-firms": fetch_firms,
}


# ---- storage --------------------------------------------------------------------------------

AREA_SQL = """
    WITH g AS (
        SELECT ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(%(geom)s), 4326)), 3)) AS g
    ), z AS (
        SELECT ST_SimplifyPreserveTopology(ST_Union(ST_Intersection(hz.geom, g.g)), 0.00003) AS zg
        FROM hazard_zones hz, g
        WHERE %(zones)s::text[] IS NOT NULL AND hz.kind = ANY(%(zones)s::text[]) AND hz.geom && g.g
    ), a AS (
        SELECT ST_Multi(ST_CollectionExtract(ST_MakeValid(
                   CASE WHEN z.zg IS NOT NULL AND NOT ST_IsEmpty(z.zg) THEN z.zg ELSE g.g END), 3)) AS area
        FROM g, z
    )
    SELECT ST_AsEWKB(area), ST_Intersects(area, ST_Expand(ST_MakeEnvelope(%(w)s, %(s)s, %(e)s, %(n)s, 4326), %(near)s))
    FROM a WHERE NOT ST_IsEmpty(area)
"""

INSERT_SQL = """
    INSERT INTO hazard_outlook (outlook_id, hazard, level, title, summary, area, valid_from, valid_to, sources,
                                confidence, source, updated_at)
    VALUES (%(id)s, %(hazard)s, %(level)s, %(title)s, %(summary)s, ST_GeomFromEWKB(%(area)s), %(valid_from)s,
            %(valid_to)s, %(sources)s, %(confidence)s, %(source)s, now())
    ON CONFLICT (outlook_id) DO UPDATE SET hazard = EXCLUDED.hazard, level = EXCLUDED.level, title = EXCLUDED.title,
        summary = EXCLUDED.summary, area = EXCLUDED.area, valid_from = EXCLUDED.valid_from,
        valid_to = EXCLUDED.valid_to, sources = EXCLUDED.sources, confidence = EXCLUDED.confidence,
        source = EXCLUDED.source, updated_at = now()
"""


def store(conn, key: str, items: list[dict], bbox) -> int:
    w, s, e, n = bbox
    kept = []
    for it in items:
        row = conn.execute(AREA_SQL, {"geom": json.dumps(it["geometry"]), "zones": it.get("zones"),
                                      "w": w, "s": s, "e": e, "n": n, "near": NEAR_DEG}).fetchone()
        if row and row[1]:
            kept.append({**it, "area": row[0]})
    kept = osrc.most_serious_per_group(kept)
    with conn.transaction():
        conn.execute("DELETE FROM hazard_outlook WHERE source = %s", (key,))
        for it in kept:
            conn.execute(INSERT_SQL, {**it, "sources": json.dumps(it["sources"]), "source": key})
    return len(kept)


def run_once(conn, bbox, only: set[str] | None = None) -> dict[str, str]:
    now = datetime.now(timezone.utc)
    report = {}
    for key, fetch in FETCHERS.items():
        if only and key not in only:
            continue
        name, url, license_, attribution = SOURCES[key]
        upsert_source(conn, key, name, "outlook", url, license_, attribution)
        conn.commit()
        if key == "nasa-firms" and not os.environ.get("FIRMS_MAP_KEY", "").strip():
            record_status(conn, key, "skipped", "optional: set FIRMS_MAP_KEY (free NASA key) to enable", None)
            conn.commit()
            report[key] = "skipped (no FIRMS_MAP_KEY)"
            continue
        try:
            items, note = fetch(bbox, now)
            count = store(conn, key, items, bbox)
            record_status(conn, key, "ok", note, count)
            report[key] = f"ok, {count} item(s) for the region ({len(items)} parsed); {note}"
        except Exception as exc:
            conn.rollback()
            msg = f"{type(exc).__name__}: {exc}"[:500]
            key_value = os.environ.get("FIRMS_MAP_KEY")
            if key_value:
                msg = msg.replace(key_value, "***")
            record_status(conn, key, "error", msg, None)
            report[key] = f"ERROR {msg}"
        conn.commit()
    conn.execute("DELETE FROM hazard_outlook WHERE valid_to < now() - interval '1 hour'")
    conn.commit()
    return report


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--once", action="store_true", help="one pass, then exit")
    ap.add_argument("--interval", type=float, default=30, help="minutes between passes in loop mode")
    ap.add_argument("--bbox", help="west,south,east,north (default: the Seattle grid box)")
    ap.add_argument("--only", help="comma-separated source keys")
    args = ap.parse_args()
    bbox = parse_bbox(args.bbox) if args.bbox else SEATTLE_BBOX
    only = set(args.only.split(",")) if args.only else None
    with connect() as conn:
        apply_schema(conn)
        while True:
            started = datetime.now(timezone.utc)
            print(f"Outlook pass {started:%Y-%m-%d %H:%M:%SZ}")
            for key, line in run_once(conn, bbox, only).items():
                print(f"  {key}: {line}")
            if args.once:
                break
            time.sleep(max(60.0, args.interval * 60))


if __name__ == "__main__":
    main()
