"""Hazard outlook: what may be coming (next ~72 h), where is worst and safest, and where to go.

Data comes from pipeline/import_hazard_zones.py (official hazard zones, terrain and
per-cell exposure) and pipeline/outlook_worker.py (free, open forecast and event
sources: NASA EONET, NOAA/NWS, USGS, GDACS, Open-Meteo, optional NASA FIRMS).

Exposure scores are relative (worst to safest within the map), not probabilities.
Earthquakes cannot be predicted: for earthquakes Beacon shows only preparedness
(liquefaction and landslide zones) and recent USGS activity.

Privacy: the caller's coordinates are never stored or logged. Point queries
(/outlook?lat&lng and /safe-areas) are `Cache-Control: no-store`, and their query
strings are removed from the uvicorn access log.
"""

from __future__ import annotations

import logging
import math
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response
from psycopg.types.json import Jsonb

from ..db import pool
from ..hazard_taxonomy import HAZARD_KEYS, HAZARDS
from .safe_places import KIND_LABELS, PREFERRED_RADIUS_M, parse_bbox

router = APIRouter(tags=["hazard outlook"])

GRID = {"lat0": 47.48, "lng0": -122.46, "dLat": 0.002, "dLng": 0.003, "rows": 135, "cols": 80}
SCORED_HAZARDS = ("tsunami", "flood", "earthquake", "volcano")  # pipeline/hazard_scoring.py
LEVELS = {"high": 50, "moderate": 20}
NEAR_M = 25_000          # /outlook: items whose area is within 25 km of the point
SAFE_MAX_SCORE = 10      # a "safe area" cell scores at most this ...
SAFE_MIN_ELEVATION_M = {"tsunami": 15, "flood": 5, "volcano": 15}  # ... and is at least this high
AREA_SPACING_M = 400     # suggested areas are at least this far apart
MAX_SAFE = 10
ZONE_SIMPLIFY_DEG = 0.00005  # ~5 m: /hazard-zones outlines for the map
CACHE = {"Cache-Control": "public, max-age=300"}
NO_STORE = {"Cache-Control": "no-store"}
POINT_PATHS = ("/api/outlook", "/api/safe-areas")

DISCLAIMER = ("Beacon's hazard outlook combines official forecasts, warnings and NASA observations with simple, "
              "published rules. It is not an official warning. Always follow instructions from local officials and "
              "emergency alerts. Exposure scores compare areas with each other; they are not probabilities. "
              "Earthquakes cannot be predicted.")
SAFE_AREAS_NOTE = ("Distances are straight-line, not routes. Areas come from mapped hazard zones and terrain; "
                   "follow official evacuation routes and signs when they exist.")
ADVICE = {
    "tsunami": "If you feel a strong earthquake near the coast or get a tsunami warning, go on foot to high ground "
               "or inland right away. Do not wait for an official order; stay there until officials give the all clear.",
    "flood": "Move to higher ground before water rises. Never walk or drive through flood water. "
             "In heavy rain stay away from the top and bottom of steep slopes.",
    "earthquake": "Drop, cover and hold on during shaking. Afterwards go to open ground away from buildings, "
                  "power lines and steep slopes; liquefaction zones can lose their footing.",
    "volcano": "For lahars, get out of river valleys that drain the volcano and climb to high ground. "
               "For ash fall, stay indoors with windows closed.",
}

LEVEL_SQL = "CASE o.level WHEN 'imminent' THEN 3 WHEN 'likely' THEN 2 ELSE 1 END"
CONF_SQL = "CASE o.confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END"


class _RedactPointQuery(logging.Filter):
    """Drop the query string (lat/lng) of point queries from uvicorn's access log."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3 and isinstance(args[2], str) and "?" in args[2] \
                and args[2].split("?", 1)[0] in POINT_PATHS:
            record.args = (*args[:2], args[2].split("?", 1)[0], *args[3:])
        return True


_access_log = logging.getLogger("uvicorn.access")
if not any(isinstance(f, _RedactPointQuery) for f in _access_log.filters):
    _access_log.addFilter(_RedactPointQuery())


def cell_for(lat: float, lng: float) -> int | None:
    row = math.floor((lat - GRID["lat0"]) / GRID["dLat"])
    col = math.floor((lng - GRID["lng0"]) / GRID["dLng"])
    if 0 <= row < GRID["rows"] and 0 <= col < GRID["cols"]:
        return row * 100 + col
    return None


def check_hazard(hazard: str | None, scored_only: bool = False, required: bool = False) -> str | None:
    if hazard is None:
        if required:
            raise HTTPException(422, "hazard is required")
        return None
    hazard = hazard.strip().lower()
    if hazard not in HAZARDS:
        raise HTTPException(422, f"unknown hazard '{hazard}'; use {', '.join(HAZARD_KEYS)}")
    if scored_only and hazard not in SCORED_HAZARDS:
        raise HTTPException(422, f"no exposure grid for '{hazard}'; available: {', '.join(SCORED_HAZARDS)}")
    return hazard


def json_response(text: str, headers: dict = CACHE) -> Response:
    return Response(content=text, media_type="application/json", headers=headers)


def kind_label(kind: str) -> str:
    """Label of a safe-place kind (kinds added later fall back to a readable name)."""
    return KIND_LABELS.get(kind) or kind.replace("_", " ").capitalize()


def iso(dt) -> str | None:
    return dt.isoformat().replace("+00:00", "Z") if dt else None


# ---- what may be coming --------------------------------------------------------------

@router.get("/outlook")
def outlook(
    response: Response,
    lat: Annotated[float, Query(ge=-90, le=90)],
    lng: Annotated[float, Query(ge=-180, le=180)],
) -> dict:
    """Outlook items (next ~72 h) whose area covers or is within 25 km of the point, most serious first,
    plus the point's relative exposure per hazard."""
    sql = f"""
        WITH pt AS (SELECT ST_SetSRID(ST_MakePoint(%(lng)s, %(lat)s), 4326) AS g)
        SELECT o.outlook_id, o.hazard, o.level, o.title, o.summary, o.valid_from, o.valid_to, o.confidence,
               o.sources, ST_Distance(o.area::geography, pt.g::geography) AS dist
        FROM hazard_outlook o, pt
        WHERE o.valid_to > now()
          AND ST_DWithin(o.area::geography, pt.g::geography, %(near)s)
        ORDER BY {LEVEL_SQL} DESC, {CONF_SQL} DESC, dist, o.valid_from, o.outlook_id
    """
    cell = cell_for(lat, lng)
    with pool.connection() as conn:
        rows = conn.execute(sql, {"lat": lat, "lng": lng, "near": NEAR_M}).fetchall()
        updated = conn.execute(
            "SELECT max(last_success) FROM hazard_sources WHERE category = 'outlook'").fetchone()[0]
        exposure = conn.execute(
            "SELECT hazard, score, level FROM cell_hazard_exposure WHERE cell_id = %s", (cell,)).fetchall() \
            if cell is not None else []
    response.headers.update(NO_STORE)
    order = {h: i for i, h in enumerate(SCORED_HAZARDS)}
    return {
        "location": {
            "lat": round(lat, 5), "lng": round(lng, 5), "cellId": cell, "inRegion": cell is not None,
            "exposure": [{"hazard": h, "hazardLabel": HAZARDS[h]["label"], "score": s, "level": lvl}
                         for h, s, lvl in sorted(exposure, key=lambda r: order.get(r[0], 99))],
        },
        "outlook": [{
            "id": r[0],
            "hazard": r[1],
            "hazardLabel": HAZARDS.get(r[1], {"label": r[1]})["label"],
            "level": r[2],
            "title": r[3],
            "summary": r[4],
            "validFrom": iso(r[5]),
            "validTo": iso(r[6]),
            "confidence": r[7],
            "sources": [{"name": s.get("name"), "url": s.get("url"), "observed": s.get("observed")}
                        for s in (r[8] or [])],
            "distanceKm": round(r[9] / 1000, 1),
        } for r in rows],
        "updatedAt": iso(updated),
        "disclaimer": DISCLAIMER,
    }


@router.get("/outlook/areas")
def outlook_areas(
    bbox: Annotated[str | None, Query(description="west,south,east,north; default everything")] = None,
) -> Response:
    """Current outlook areas as GeoJSON polygons, most serious drawn last."""
    w, s, e, n = parse_bbox(bbox) if bbox else (-180, -90, 180, 90)
    sql = f"""
        SELECT json_build_object(
            'type', 'FeatureCollection',
            'features', COALESCE(json_agg(json_build_object(
                'type', 'Feature',
                'id', o.outlook_id,
                'geometry', ST_AsGeoJSON(o.area, 5)::json,
                'properties', json_build_object(
                    'id', o.outlook_id, 'hazard', o.hazard, 'hazardLabel', %(labels)s::jsonb ->> o.hazard,
                    'level', o.level, 'title', o.title, 'summary', o.summary,
                    'validFrom', o.valid_from, 'validTo', o.valid_to, 'confidence', o.confidence)
            ) ORDER BY {LEVEL_SQL}, o.outlook_id), '[]'::json)
        )::text
        FROM hazard_outlook o
        WHERE o.valid_to > now() AND o.area && ST_MakeEnvelope(%(w)s, %(s)s, %(e)s, %(n)s, 4326)
    """
    labels = Jsonb({k: v["label"] for k, v in HAZARDS.items()})
    with pool.connection() as conn:
        text = conn.execute(sql, {"w": w, "s": s, "e": e, "n": n, "labels": labels}).fetchone()[0]
    return json_response(text, {"Cache-Control": "public, max-age=120"})


@router.get("/outlook/sources")
def outlook_sources(response: Response) -> dict:
    """Every hazard data source: last fetch, status, license and attribution."""
    with pool.connection() as conn:
        rows = conn.execute(
            """SELECT source_key, name, category, url, license, attribution, last_fetch, last_success, status,
                      message, item_count
               FROM hazard_sources ORDER BY category, source_key""").fetchall()
    response.headers.update({"Cache-Control": "public, max-age=60"})
    return {"sources": [{
        "key": r[0], "name": r[1], "category": r[2], "url": r[3], "license": r[4], "attribution": r[5],
        "lastFetch": iso(r[6]), "lastSuccess": iso(r[7]), "status": r[8], "message": r[9], "itemCount": r[10],
    } for r in rows]}


# ---- where is worst / safest ---------------------------------------------------------------

@router.get("/hazard-zones")
def hazard_zones(
    hazard: Annotated[str | None, Query(description="hazard key; default every zone")] = None,
    bbox: Annotated[str | None, Query(description="west,south,east,north")] = None,
    kind: Annotated[str | None, Query(description="tsunami_inundation, liquefaction, landslide, flood_zone, lahar")] = None,
) -> Response:
    """Official hazard-zone polygons. `hazard=flood` includes landslide areas (heavy rain triggers them);
    `hazard=earthquake` is liquefaction and landslide areas."""
    hazard = check_hazard(hazard)
    w, s, e, n = parse_bbox(bbox) if bbox else (-180, -90, 180, 90)
    sql = """
        SELECT json_build_object(
            'type', 'FeatureCollection',
            'features', COALESCE(json_agg(json_build_object(
                'type', 'Feature',
                'id', z.zone_id,
                'geometry', ST_AsGeoJSON(ST_SimplifyPreserveTopology(z.geom, %(tol)s), 5)::json,
                'properties', json_build_object('id', z.zone_id, 'hazard', COALESCE(%(hazard)s, z.hazard),
                                                'kind', z.kind, 'level', z.level, 'name', z.name, 'source', z.source)
            ) ORDER BY CASE z.level WHEN 'low' THEN 1 WHEN 'moderate' THEN 2 ELSE 3 END, z.zone_id), '[]'::json)
        )::text
        FROM hazard_zones z
        WHERE z.geom && ST_MakeEnvelope(%(w)s, %(s)s, %(e)s, %(n)s, 4326)
          AND (%(hazard)s::text IS NULL OR z.kind IN (SELECT kind FROM hazard_zone_kinds WHERE hazard = %(hazard)s))
          AND (%(kind)s::text IS NULL OR z.kind = %(kind)s)
    """
    with pool.connection() as conn:
        text = conn.execute(sql, {"w": w, "s": s, "e": e, "n": n, "hazard": hazard, "tol": ZONE_SIMPLIFY_DEG,
                                  "kind": kind.strip().lower() if kind else None}).fetchone()[0]
    return json_response(text)


@router.get("/hazard-grid")
def hazard_grid(
    hazard: Annotated[str, Query(description="tsunami, flood, earthquake or volcano")],
) -> Response:
    """Relative exposure (0-100) of every scored land cell as GeoJSON cell polygons, worst to safest."""
    hazard = check_hazard(hazard, scored_only=True, required=True)
    sql = """
        SELECT json_build_object(
            'type', 'FeatureCollection',
            'hazard', %(hazard)s::text,
            'levels', %(levels)s::jsonb,
            'note', 'Relative exposure compared with other cells, not a probability.',
            'features', COALESCE(json_agg(json_build_object(
                'type', 'Feature',
                'id', x.cell_id,
                'geometry', ST_AsGeoJSON(g.cell, 6)::json,
                'properties', json_build_object('cellId', x.cell_id, 'score', x.score, 'level', x.level,
                                                'factors', x.factors)
            ) ORDER BY x.cell_id), '[]'::json)
        )::text
        FROM cell_hazard_exposure x JOIN grid_cells g ON g.cell_id = x.cell_id
        WHERE x.hazard = %(hazard)s
    """
    with pool.connection() as conn:
        text = conn.execute(sql, {"hazard": hazard, "levels": Jsonb(LEVELS)}).fetchone()[0]
    return json_response(text)


# ---- where to go ------------------------------------------------------------------------------

def area_reason(hazard: str, factors: dict, score: int) -> str:
    elev = factors.get("elevationM")
    slope = factors.get("slopeDeg")
    high = f", ground about {round(elev)} m above sea level" if elev is not None else ""
    if hazard == "tsunami":
        return f"High ground outside the mapped tsunami inundation zones{high}"
    if hazard == "flood":
        return (f"Outside mapped flood and landslide zones{high}"
                + (f", gentle slope ({round(slope)}°)" if slope is not None else ""))
    if hazard == "earthquake":
        return ("No mapped liquefaction or landslide zones, not steep"
                + (f" ({round(slope)}°)" if slope is not None else "")
                + "; open ground away from buildings is safest during shaking")
    if hazard == "volcano":
        return f"Outside mapped lahar and lahar-sediment zones{high}"
    return f"Low exposure (score {score})"


@router.get("/safe-areas")
def safe_areas(
    response: Response,
    lat: Annotated[float, Query(ge=-90, le=90)],
    lng: Annotated[float, Query(ge=-180, le=180)],
    hazard: Annotated[str, Query(description="hazard key from /api/hazards")],
    limit: Annotated[int, Query(ge=1, le=MAX_SAFE)] = 3,
) -> dict:
    """Where to go: the nearest low-exposure areas for the hazard and the best suitable safe places
    that lie in low-exposure areas (for a tsunami: high ground outside the inundation zones).
    Hazards without an exposure grid (heat, smoke, storms ...) get suitable places only."""
    hazard = check_hazard(hazard, required=True)
    scored = hazard in SCORED_HAZARDS
    cell = cell_for(lat, lng)
    min_elev = SAFE_MIN_ELEVATION_M.get(hazard)
    params = {"lat": lat, "lng": lng, "hazard": hazard, "max": SAFE_MAX_SCORE, "elev": min_elev,
              "radius": PREFERRED_RADIUS_M, "limit": limit, "scored": scored}
    area_sql = """
        WITH pt AS (SELECT ST_SetSRID(ST_MakePoint(%(lng)s, %(lat)s), 4326)::geography AS g)
        SELECT x.cell_id, ST_Y(g.center::geometry), ST_X(g.center::geometry), ST_Distance(g.center, pt.g),
               x.score, x.level, x.factors
        FROM cell_hazard_exposure x JOIN grid_cells g ON g.cell_id = x.cell_id, pt
        WHERE x.hazard = %(hazard)s AND x.score <= %(max)s AND (x.factors ->> 'zone')::float = 0
          AND (%(elev)s::float IS NULL OR (x.factors ->> 'elevationM')::float >= %(elev)s::float)
        ORDER BY g.center <-> pt.g
        LIMIT 300
    """
    # Suitable kinds for the hazard; a place counts when its cell is low exposure (or, for hazards
    # without a grid, always). Within 2 km the better kind wins, then distance (as /safe-places/nearest).
    place_sql = """
        WITH pt AS (SELECT ST_SetSRID(ST_MakePoint(%(lng)s, %(lat)s), 4326)::geography AS g),
        c AS (
            SELECT k.rank, v.place_id, v.name, v.kind, v.address, v.phone, v.opening_hours, v.source, v.geom,
                   ST_Distance(v.geom, pt.g) AS dist, x.score, x.level, x.factors
            FROM hazard_place_kinds k
            JOIN safe_places_visible v ON v.kind = k.kind
            CROSS JOIN pt
            LEFT JOIN cell_hazard_exposure x
                   ON x.hazard = k.hazard
                  AND x.cell_id = floor((ST_Y(v.geom::geometry) - 47.48) / 0.002)::int * 100
                                + floor((ST_X(v.geom::geometry) + 122.46) / 0.003)::int
            WHERE k.hazard = %(hazard)s
              AND (NOT %(scored)s OR (x.score <= %(max)s AND (x.factors ->> 'zone')::float = 0
                   AND (%(elev)s::float IS NULL OR (x.factors ->> 'elevationM')::float >= %(elev)s::float)))
            ORDER BY v.geom <-> pt.g
            LIMIT 200
        )
        SELECT place_id, name, kind, ST_Y(geom::geometry), ST_X(geom::geometry), dist, address, phone,
               opening_hours, source, score, level, factors
        FROM c
        ORDER BY dist <= %(radius)s DESC, CASE WHEN dist <= %(radius)s THEN rank END, dist, place_id
        LIMIT %(limit)s
    """
    with pool.connection() as conn:
        here = conn.execute("SELECT score, level FROM cell_hazard_exposure WHERE hazard = %s AND cell_id = %s",
                            (hazard, cell)).fetchone() if scored and cell is not None else None
        area_rows = conn.execute(area_sql, params).fetchall() if scored else []
        place_rows = conn.execute(place_sql, params).fetchall()
    areas = []
    for cid, clat, clng, dist, score, level, factors in area_rows:
        if any(_meters(clat, clng, a["lat"], a["lng"]) < AREA_SPACING_M for a in areas):
            continue
        areas.append({"cellId": cid, "lat": round(clat, 6), "lng": round(clng, 6), "distanceM": round(dist),
                      "score": score, "level": level, "reason": area_reason(hazard, factors, score)})
        if len(areas) >= limit:
            break
    places = [{
        "id": r[0], "name": r[1], "kind": r[2], "kindLabel": kind_label(r[2]),
        "lat": round(r[3], 6), "lng": round(r[4], 6), "distanceM": round(r[5]),
        "address": r[6], "phone": r[7], "openingHours": r[8], "source": r[9],
        "score": r[10], "level": r[11],
        "reason": (f"{kind_label(r[2])} in a low-exposure area: {area_reason(hazard, r[12], r[10]).lower()}"
                   if scored else f"{kind_label(r[2])}, a suitable place for {HAZARDS[hazard]['label'].lower()}"),
    } for r in place_rows]
    response.headers.update(NO_STORE)
    return {
        "hazard": hazard,
        "hazardLabel": HAZARDS[hazard]["label"],
        "location": {"cellId": cell, "inRegion": cell is not None,
                     "score": here[0] if here else None, "level": here[1] if here else None},
        "advice": ADVICE.get(hazard),
        "areas": areas,
        "places": places,
        "note": SAFE_AREAS_NOTE if scored else
        "No exposure map for this hazard yet; these are the nearest suitable places. " + SAFE_AREAS_NOTE,
        "disclaimer": DISCLAIMER,
    }


def _meters(lat1, lng1, lat2, lng2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2
    return 2 * 6_371_008.8 * math.asin(math.sqrt(a))
