"""Safe places: hazards with their suitable kinds of place, places on the map,
and the nearest suitable places for a hazard.

Data comes from pipeline/import_safe_places.py (OpenStreetMap and official
lists). OSM data is (c) OpenStreetMap contributors, ODbL; the web app must show
that attribution wherever these places are shown.

Privacy: the caller's coordinates are never stored or logged. /nearest is
`Cache-Control: no-store`, and its query string is removed from the uvicorn
access log (a reverse proxy in front of the API must do the same).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response
from psycopg.types.json import Jsonb

from ..db import pool
from ..hazard_taxonomy import HAZARD_KEYS, HAZARDS

router = APIRouter(tags=["safe places"])

KIND_LABELS = {
    "shelter": "Shelter",
    "bomb_shelter": "Bomb shelter",
    "bunker": "Bunker",
    "assembly_point": "Emergency assembly point",
    "emergency_hub": "Emergency hub",
    "hospital": "Hospital",
    "police": "Police station",
    "fire_station": "Fire station",
    "community_centre": "Community centre",
    "underground_station": "Underground station",
    "social_shelter": "Social services shelter",
}
KINDS = tuple(KIND_LABELS)
# Shown only when asked for by name: social-service shelters are not public disaster refuges.
DEFAULT_KINDS = [k for k in KINDS if k != "social_shelter"]
MAX_FEATURES = 2000       # /safe-places: places closest to the bbox center win
MAX_NEAREST = 20          # /safe-places/nearest?limit=
PREFERRED_RADIUS_M = 2000  # better-ranked kinds win only within this distance (~25 min walk)
CACHE = {"Cache-Control": "public, max-age=300"}
NO_STORE = {"Cache-Control": "no-store"}
NEAREST_PATH = "/safe-places/nearest"


def parse_bbox(value: str) -> tuple[float, float, float, float]:
    """'west,south,east,north' -> floats; 422 when malformed or out of range."""
    try:
        west, south, east, north = (float(v) for v in value.split(","))
    except ValueError:
        raise HTTPException(422, "bbox must be west,south,east,north in degrees") from None
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise HTTPException(422, "bbox must be west,south,east,north with west < east and south < north")
    return west, south, east, north


def parse_kinds(value: str | None) -> list[str] | None:
    if not value:
        return None
    kinds = []
    for part in value.split(","):
        part = part.strip().lower()
        if part in KIND_LABELS:
            kinds.append(part)
        elif part:
            raise HTTPException(422, f"unknown place kind '{part}'; use {', '.join(KINDS)}")
    return sorted(set(kinds)) or None


def kinds_or_default(value: str | None) -> list[str]:
    return parse_kinds(value) or DEFAULT_KINDS


@router.get("/hazards")
def hazards(response: Response) -> dict:
    """Every hazard key with its label and the kinds of safe place to go to, best first."""
    with pool.connection() as conn:
        rows = conn.execute(
            "SELECT hazard, array_agg(kind ORDER BY rank) FROM hazard_place_kinds GROUP BY hazard").fetchall()
    kinds = dict(rows)
    response.headers.update(CACHE)
    return {"hazards": [{"key": key, "label": HAZARDS[key]["label"], "placeKinds": kinds.get(key, [])}
                        for key in HAZARD_KEYS]}


@router.get("/safe-places")
def safe_places(
    bbox: Annotated[str, Query(description="west,south,east,north in degrees")],
    kinds: Annotated[str | None, Query(description="comma-separated place kinds; default all")] = None,
) -> Response:
    """Safe places inside the box as GeoJSON points (at most 2000, closest to the box center first;
    `truncated` is true when there were more)."""
    west, south, east, north = parse_bbox(bbox)
    sql = """
        WITH p AS (
            SELECT place_id, name, kind, address, phone, opening_hours, source, geom,
                   geom <-> ST_SetSRID(ST_MakePoint(%(cx)s, %(cy)s), 4326)::geography AS d
            FROM safe_places_visible
            WHERE geom::geometry && ST_MakeEnvelope(%(w)s, %(s)s, %(e)s, %(n)s, 4326)
              AND (%(kinds)s::text[] IS NULL OR kind = ANY(%(kinds)s::text[]))
            ORDER BY d, place_id
            LIMIT %(cap)s + 1
        ), n AS (
            SELECT p.*, row_number() OVER (ORDER BY d, place_id) AS ord FROM p
        )
        SELECT json_build_object(
            'type', 'FeatureCollection',
            'truncated', (SELECT count(*) FROM p) > %(cap)s,
            'features', COALESCE((
                SELECT json_agg(json_build_object(
                    'type', 'Feature',
                    'id', n.place_id,
                    'geometry', ST_AsGeoJSON(n.geom, 6)::json,
                    'properties', json_build_object(
                        'id', n.place_id,
                        'name', n.name,
                        'kind', n.kind,
                        'kindLabel', %(labels)s::jsonb ->> n.kind,
                        'address', n.address,
                        'phone', n.phone,
                        'openingHours', n.opening_hours,
                        'source', n.source)
                ) ORDER BY n.ord)
                FROM n WHERE n.ord <= %(cap)s), '[]'::json)
        )::text
    """
    params = {"w": west, "s": south, "e": east, "n": north, "cx": (west + east) / 2, "cy": (south + north) / 2,
              "kinds": kinds_or_default(kinds), "cap": MAX_FEATURES, "labels": Jsonb(KIND_LABELS)}
    with pool.connection() as conn:
        text = conn.execute(sql, params).fetchone()[0]
    return Response(content=text, media_type="application/json", headers=CACHE)


@router.get(NEAREST_PATH)
def nearest(
    response: Response,
    lat: Annotated[float, Query(ge=-90, le=90)],
    lng: Annotated[float, Query(ge=-180, le=180)],
    hazard: Annotated[str | None, Query(description="hazard key from /api/hazards; default all kinds")] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_NEAREST)] = 5,
) -> dict:
    """The nearest suitable safe places for a hazard.

    Within 2 km, places are ordered by how suitable their kind is for the hazard
    (hazard_place_kinds.rank), then by straight-line distance. When fewer than
    `limit` suitable places are that close, the nearest ones further away follow,
    by distance. Without a hazard, every kind counts and only distance matters.
    """
    if hazard is not None:
        hazard = hazard.strip().lower()
        if hazard not in HAZARDS:
            raise HTTPException(422, f"unknown hazard '{hazard}'; use {', '.join(HAZARD_KEYS)}")
    sql = """
        WITH pt AS (
            SELECT ST_SetSRID(ST_MakePoint(%(lng)s, %(lat)s), 4326)::geography AS g
        ), k AS (
            SELECT kind, rank FROM hazard_place_kinds WHERE hazard = %(hazard)s
            UNION ALL
            SELECT unnest(%(all)s::text[]), 1 WHERE %(hazard)s::text IS NULL
        ), c AS (
            SELECT k.rank, p.*, ST_Distance(p.geom, pt.g) AS dist
            FROM k CROSS JOIN pt
            CROSS JOIN LATERAL (
                SELECT v.place_id, v.name, v.kind, v.address, v.phone, v.opening_hours, v.source, v.geom
                FROM safe_places_visible v
                WHERE v.kind = k.kind
                ORDER BY v.geom <-> pt.g
                LIMIT %(limit)s
            ) p
        )
        SELECT place_id, name, kind, ST_Y(geom::geometry), ST_X(geom::geometry), dist,
               address, phone, opening_hours, source
        FROM c
        ORDER BY dist <= %(radius)s DESC,
                 CASE WHEN dist <= %(radius)s THEN rank END,
                 dist, place_id
        LIMIT %(limit)s
    """
    params = {"lat": lat, "lng": lng, "hazard": hazard, "all": DEFAULT_KINDS, "limit": limit,
              "radius": PREFERRED_RADIUS_M}
    with pool.connection() as conn:
        rows = conn.execute(sql, params).fetchall()
    response.headers.update(NO_STORE)
    return {
        "hazard": hazard,
        "places": [{
            "id": r[0],
            "name": r[1],
            "kind": r[2],
            "kindLabel": KIND_LABELS[r[2]],
            "lat": round(r[3], 6),
            "lng": round(r[4], 6),
            "distanceM": round(r[5]),
            "address": r[6],
            "phone": r[7],
            "openingHours": r[8],
            "source": r[9],
        } for r in rows],
    }
