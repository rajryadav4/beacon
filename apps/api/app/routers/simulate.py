"""Beacon Simulator ("digital twin" demo mode): POST /api/simulate.

Drop a test calamity on Seattle and a user somewhere near it; Beacon says whether
the user is in danger, what to do, which safe place to go to and how to get there.
**Every result is a simulation for demos, not a real alert.** Nothing is stored:
the scenario lives only in the request (the web page encodes it in its share URL).

Request: `{hazard, origin: {lat, lng}, event: {lat, lng, size?, params?}, mode: walk|drive}`.
`size` is the magnitude for an earthquake and a radius in metres for everything else
(defaults in `app/simulation/models.py`). `params`: `windDeg` (direction the wind blows
FROM, degrees) and `windKmh` for wildfire, hazmat, storm, air quality and volcano;
`scenario` (`cascadia` | `seattle_fault`) for a tsunami; `depthM` for a flood.

Models (simple and explainable on purpose; each response repeats its own in `scenario.model`):

- **earthquake**: intensity rings from magnitude, severe within 10^(0.5M-2.9) km
  (M6.8 = 3.2 km), moderate within 10^(0.5M-2.0) km (M6.8 = 25 km). If `hazard_zones`
  holds liquefaction / landslide areas, those inside the moderate ring become severe
  from M6. Destination: an emergency assembly point or hub (open ground) outside the
  severe zone; guidance: drop, cover, hold on, then move to open ground.
- **tsunami**: the WA DNR inundation polygons in `hazard_zones` for the chosen scenario
  (water deeper than 1 ft = severe, up to 1 ft = moderate), clipped to `size` metres
  around the event. Without them: grid cells within `size` whose centre elevation (AWS
  Terrain Tiles, cached; or `cell_terrain`) is <= 5 m (severe) or <= 10 m (moderate). The
  evacuation margin (moderate) uses cells rated high/moderate in `cell_hazard_exposure`
  when present, else low ground near the inundation zone. Open-water cells
  (`cell_terrain.water_share` >= 0.5) are never counted as land or high ground.
  Destination: the nearer of high ground (a cell >= 15 m, outside the zones) and a
  suitable safe place outside the zones; a warning when the first wave could arrive first.
- **flood**: water rises `depthM` (default 3 m) above the ground at the event; cells within
  `size` up to half that height above it are severe, up to the full height moderate
  (plus cells rated high flood exposure in `cell_hazard_exposure`, or mapped `flood_zone`
  areas). Destination: high ground or a hub outside.
- **wildfire**: a wind-driven ellipse; the head moves downwind at 5 + 1.5 x wind km/h
  metres per minute, the back at 15 % of that, length-to-breadth 1 + wind/20. Severe =
  fire area after 60 min (timeline at 0/15/30/60 min); moderate = embers and smoke up to
  2.2 x as far. Places downwind of the fire are penalised, so the pick is upwind or crosswind.
- **conflict** (air raid / attack): severe target circle of `size` m, moderate 3 x.
  Destination: the nearest bomb shelter, bunker or underground station even inside the
  moderate zone (going underground beats fleeing); other kinds only as a fallback.
- **hazmat**: an isolation circle of `size` m plus a downwind plume (severe 4 x size,
  moderate 14 x size long, scaled by wind). Inside the moderate zone: shelter in place;
  inside the severe zone: leave across the wind, then upwind.
- **storm**: a damage path along the storm track (severe) inside the storm cell (moderate).
- **heat, winter, air quality**: rings (air quality: a smoke plume downwind); destination:
  the nearest cooling, warming or clean-air place (community centres, shelters).
- **volcano**: blast / lahar circle (severe) and a downwind ashfall plume (moderate).
- **crime, other**: severe circle of `size` m, moderate 2.5 x.

Safe places inside the severe zone are never chosen, except for heat, winter and air
quality, where the danger is being outdoors and the public building is the refuge. Places are ranked by straight-line
distance x the hazard's kind rank (`hazard_place_kinds`), with penalties for the moderate
zone, for being downwind, for low ground, and for lying beyond the severe zone.

Routing (free, no keys): Valhalla on the FOSSGIS public server with the severe zone as
`exclude_polygons` when the user starts outside it and the zone is small enough, plus a
plain request with alternates; OSRM (routing.openstreetmap.de) when Valhalla is down;
a straight line when both are. The candidate with the least length inside the danger
zones wins (score = metres + 25 x severe metres + 4 x moderate metres the user was not
already in). `avoidsDanger`: the route never enters the severe zone (or, starting inside
it, leaves it once and does not come back).

Privacy: coordinates are used for this request only. They are never stored or logged
(request bodies are not logged; the response is `Cache-Control: no-store`). Routing
servers receive the two route end points and the zone outline, nothing else.
"""

from __future__ import annotations

import json
import math
from typing import Literal

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field

from ..db import pool
from ..hazard_taxonomy import HAZARDS
from ..simulation import geometry as geo
from ..simulation import guidance as gd
from ..simulation import models, routing, terrain
from .safe_places import KIND_LABELS

router = APIRouter(tags=["simulator"])

# The data region: the crime grid box (db/schema/002_app.sql) plus about 10 km.
REGION = {"south": 47.48, "north": 47.75, "west": -122.46, "east": -122.22}
MARGIN_LAT, MARGIN_LNG = 0.09, 0.13
SIZE_LIMITS = {"earthquake": (3.0, 9.5)}
RADIUS_LIMITS = (50.0, 50_000.0)
UNDERGROUND = {"bomb_shelter", "bunker", "underground_station"}
INDOOR_HAZARDS = {"earthquake", "heat", "winter", "air_quality", "storm"}
# The danger is being outdoors: a public building inside the zone is the refuge itself.
INDOOR_REFUGE = {"heat", "winter", "air_quality"}
OPEN_GROUND = {"assembly_point", "emergency_hub"}
LEAVE_AFTER_MIN = {"earthquake": 2}
DISCLAIMER = ("SIMULATION: a demo scenario, not a real alert. In a real emergency, follow official "
              "instructions and Wireless Emergency Alerts.")


class LatLng(BaseModel):
    model_config = ConfigDict(extra="forbid")
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class EventParams(BaseModel):
    model_config = ConfigDict(extra="forbid")
    windDeg: float | None = Field(default=None, ge=0, le=360)
    windKmh: float | None = Field(default=None, ge=0, le=150)
    scenario: Literal["cascadia", "seattle_fault"] | None = None
    depthM: float | None = Field(default=None, ge=0.5, le=15)


class Event(LatLng):
    size: float | None = None
    params: EventParams | None = None


class SimulateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    hazard: str
    origin: LatLng
    event: Event
    mode: Literal["walk", "drive"] = "walk"


def in_region(p: LatLng) -> bool:
    return (REGION["south"] - MARGIN_LAT <= p.lat <= REGION["north"] + MARGIN_LAT
            and REGION["west"] - MARGIN_LNG <= p.lng <= REGION["east"] + MARGIN_LNG)


def validate(req: SimulateRequest) -> tuple[str, float, dict]:
    hazard = req.hazard.strip().lower()
    if hazard not in HAZARDS:
        raise HTTPException(422, f"unknown hazard '{req.hazard}'; use {', '.join(HAZARDS)}")
    for name, point in (("origin", req.origin), ("event", req.event)):
        if not in_region(point):
            raise HTTPException(422, (
                f"The {name} is outside the simulator's data region. The simulator covers Seattle: latitude "
                f"{REGION['south']} to {REGION['north']}, longitude {REGION['west']} to {REGION['east']}, "
                "plus about 10 km around it."))
    size = req.event.size if req.event.size is not None else models.DEFAULT_SIZE[hazard]
    low, high = SIZE_LIMITS.get(hazard, RADIUS_LIMITS)
    if not (low <= size <= high) or math.isnan(size):
        what = "magnitude" if hazard == "earthquake" else "radius in metres"
        raise HTTPException(422, f"event.size ({what}) must be between {low:g} and {high:g} for {hazard}")
    params = req.event.params.model_dump(exclude_none=True) if req.event.params else {}
    return hazard, float(size), params


# ---- Zone geometry in PostGIS ----

ZONES_CTE = """
    z AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON(%(sev)s::text), 4326) AS s,
                 ST_SetSRID(ST_GeomFromGeoJSON(%(mod)s::text), 4326) AS m)
"""


def resolve(conn, part: models.Part) -> str | None:
    if part.geojson is not None:
        return json.dumps(part.geojson)
    row = conn.execute(part.sql, part.params).fetchone()
    return row[0] if row and row[0] else None


def finalize(conn, severe: list[str], moderate: list[str]) -> tuple[str | None, str | None]:
    """Union the parts; the moderate zone excludes the severe one."""
    sql = """
        WITH s AS (SELECT ST_CollectionExtract(ST_UnaryUnion(ST_Collect(
                       ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(x), 4326)))), 3) AS g
                   FROM unnest(%(sev)s::text[]) AS x),
             m0 AS (SELECT ST_CollectionExtract(ST_UnaryUnion(ST_Collect(
                       ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(x), 4326)))), 3) AS g
                    FROM unnest(%(mod)s::text[]) AS x),
             m AS (SELECT CASE WHEN s.g IS NULL OR ST_IsEmpty(s.g) THEN m0.g
                               ELSE ST_CollectionExtract(ST_Difference(m0.g, s.g), 3) END AS g FROM s, m0)
        SELECT CASE WHEN s.g IS NULL OR ST_IsEmpty(s.g) THEN NULL ELSE ST_AsGeoJSON(s.g, 6) END,
               CASE WHEN m.g IS NULL OR ST_IsEmpty(m.g) THEN NULL ELSE ST_AsGeoJSON(m.g, 6) END
        FROM s, m
    """
    return conn.execute(sql, {"sev": severe, "mod": moderate}).fetchone()


def zone_cells(conn, sev: str | None, mod: str | None) -> dict[str, list[int]]:
    sql = f"""
        WITH {ZONES_CTE}
        SELECT c.cell_id, COALESCE(ST_Intersects(z.s, c.center::geometry), false)
        FROM grid_cells c, z
        WHERE (z.s IS NOT NULL AND z.s && c.cell AND ST_Intersects(z.s, c.center::geometry))
           OR (z.m IS NOT NULL AND z.m && c.cell AND ST_Intersects(z.m, c.center::geometry))
        ORDER BY c.cell_id
    """
    out: dict[str, list[int]] = {"severe": [], "moderate": []}
    for cell_id, severe in conn.execute(sql, {"sev": sev, "mod": mod}).fetchall():
        out["severe" if severe else "moderate"].append(cell_id)
    return out


def user_status(conn, sev: str | None, mod: str | None, lat: float, lng: float) -> str:
    sql = f"""
        WITH {ZONES_CTE}, p AS (SELECT ST_SetSRID(ST_MakePoint(%(lng)s, %(lat)s), 4326) AS g)
        SELECT COALESCE(ST_Intersects(z.s, p.g), false), COALESCE(ST_Intersects(z.m, p.g), false) FROM z, p
    """
    severe, moderate = conn.execute(sql, {"sev": sev, "mod": mod, "lat": lat, "lng": lng}).fetchone()
    return "inside_severe" if severe else "inside_moderate" if moderate else "outside"


def candidate_places(conn, hazard: str, sev: str | None, mod: str | None, lat: float, lng: float) -> list[dict]:
    sql = f"""
        WITH {ZONES_CTE}, o AS (SELECT ST_SetSRID(ST_MakePoint(%(lng)s, %(lat)s), 4326) AS g)
        SELECT v.place_id, v.name, v.kind, ST_Y(v.geom::geometry), ST_X(v.geom::geometry),
               ST_Distance(v.geom, o.g::geography), v.address, v.phone, v.opening_hours, v.source, k.rank,
               COALESCE(ST_Intersects(z.s, v.geom::geometry), false),
               COALESCE(ST_Intersects(z.m, v.geom::geometry), false),
               COALESCE(ST_Intersects(z.s, ST_MakeLine(o.g, v.geom::geometry)), false)
        FROM safe_places_visible v
        JOIN hazard_place_kinds k ON k.kind = v.kind AND k.hazard = %(hazard)s
        CROSS JOIN z CROSS JOIN o
        ORDER BY v.geom <-> o.g::geography
        LIMIT 150
    """
    rows = conn.execute(sql, {"sev": sev, "mod": mod, "lat": lat, "lng": lng, "hazard": hazard}).fetchall()
    return [{
        "place": {"id": r[0], "name": r[1], "kind": r[2], "kindLabel": KIND_LABELS.get(r[2], r[2]),
                  "lat": round(r[3], 6), "lng": round(r[4], 6), "distanceM": round(r[5]), "address": r[6],
                  "phone": r[7], "openingHours": r[8], "source": r[9]},
        "rank": r[10], "inSevere": r[11], "inModerate": r[12], "crossesSevere": r[13],
    } for r in rows]


def points_outside(conn, sev: str | None, mod: str | None, points: list[tuple[float, float]]) -> list[bool]:
    if not points:
        return []
    sql = f"""
        WITH {ZONES_CTE}
        SELECT NOT (COALESCE(ST_Intersects(z.s, p), false) OR COALESCE(ST_Intersects(z.m, p), false))
        FROM unnest(%(lats)s::float8[], %(lngs)s::float8[]) WITH ORDINALITY AS t(lat, lng, ord)
        CROSS JOIN LATERAL (SELECT ST_SetSRID(ST_MakePoint(t.lng, t.lat), 4326) AS p) q, z
        ORDER BY t.ord
    """
    rows = conn.execute(sql, {"sev": sev, "mod": mod, "lats": [p[0] for p in points],
                              "lngs": [p[1] for p in points]}).fetchall()
    return [r[0] for r in rows]


def severe_rings(conn, sev: str | None) -> list[list[list[float]]]:
    if not sev:
        return []
    text = conn.execute("SELECT ST_AsGeoJSON(ST_SimplifyPreserveTopology(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), 0.0004), 6)",
                        (sev,)).fetchone()[0]
    geom = json.loads(text)
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    return [poly[0] for poly in polys if poly]


def danger_metrics(conn, sev: str | None, mod: str | None, lines: list[list[list[float]]]) -> list[tuple[float, float, int]]:
    sql = f"""
        WITH {ZONES_CTE},
             r AS (SELECT ord, ST_SetSRID(ST_GeomFromGeoJSON(x), 4326) AS g
                   FROM unnest(%(lines)s::text[]) WITH ORDINALITY AS t(x, ord))
        SELECT COALESCE(ST_Length(ST_Intersection(r.g, z.s)::geography), 0),
               COALESCE(ST_Length(ST_Intersection(r.g, z.m)::geography), 0),
               COALESCE(ST_NumGeometries(ST_Multi(ST_LineMerge(ST_CollectionExtract(ST_Intersection(r.g, z.s), 2)))), 0)
        FROM r, z ORDER BY r.ord
    """
    texts = [json.dumps({"type": "LineString", "coordinates": c}) for c in lines]
    return [(float(a), float(b), int(n)) for a, b, n in conn.execute(sql, {"sev": sev, "mod": mod, "lines": texts}).fetchall()]


# ---- Destination choice ----

COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"]


def compass(deg: float) -> str:
    return COMPASS[round(deg / 45) % 8]


def fmt_distance(m: float) -> str:
    return f"{m / 1000:.1f} km" if m >= 1000 else f"{round(m / 10) * 10:.0f} m"


def score_place(c: dict, hazard: str, zones: models.Zones, status: str, event: tuple[float, float],
                elevations: dict[int, float] | None) -> float | None:
    p = c["place"]
    if c["inSevere"] and hazard not in INDOOR_REFUGE:
        return None
    score = max(p["distanceM"], 50) * (1 + 0.5 * (c["rank"] - 1))
    if hazard == "conflict":
        score *= 1 if p["kind"] in UNDERGROUND else 3
    elif hazard == "earthquake":
        score *= 1 if p["kind"] in OPEN_GROUND else 4  # hospitals are for the injured, not a meeting point
    elif c["inModerate"] and hazard not in INDOOR_HAZARDS:
        score *= 4 if hazard in ("tsunami", "flood") else 2.5
    if c["crossesSevere"] and status != "inside_severe":
        score *= 2
    if zones.downwind is not None:
        toward = geo.bearing(event[0], event[1], p["lat"], p["lng"])
        if geo.angle_diff(toward, zones.downwind) < 50:
            score *= 2
    if elevations and zones.high_ground_m is not None:
        cell = terrain.cell_at(p["lat"], p["lng"])
        if cell is not None and elevations.get(cell, 999) < zones.high_ground_m - 5:
            score *= 3
    return score


def place_reason(c: dict, hazard: str, zones: models.Zones, elevations: dict[int, float] | None) -> str:
    p = c["place"]
    where = ("inside the zone, but indoors is the refuge" if c["inSevere"] else
             "outside the danger zone" if not c["inModerate"] else "outside the severe zone")
    base = f"{p['kindLabel']}, {fmt_distance(p['distanceM'])} away, {where}"
    if hazard == "conflict" and p["kind"] in UNDERGROUND:
        return f"{base}. Underground is the safest place in an air raid, so it beats leaving the city."
    if hazard == "earthquake" and p["kind"] in OPEN_GROUND:
        return f"{base}. Open ground away from buildings, where neighbours meet after a quake."
    if elevations and zones.high_ground_m is not None:
        cell = terrain.cell_at(p["lat"], p["lng"])
        if cell is not None and cell in elevations:
            return f"{base}, about {elevations[cell]:.0f} m above sea level."
    if zones.downwind is not None:
        return f"{base}, out of the path of the wind-driven spread."
    if hazard in ("heat", "winter", "air_quality"):
        return f"{base}: a public building to cool down, warm up or breathe cleaner air."
    return f"{base}."


def high_ground(origin: tuple[float, float], zones: models.Zones, cells: dict[str, list[int]],
                elevations: dict[int, float] | None, water: set[int] = frozenset()) -> dict | None:
    if not elevations or zones.high_ground_m is None:
        return None
    affected = set(cells["severe"]) | set(cells["moderate"]) | set(water)
    best = None
    for cell, elev in elevations.items():
        if elev < zones.high_ground_m or cell in affected:
            continue
        lat, lng = terrain.cell_center(cell)
        d = geo.meters(origin[0], origin[1], lat, lng)
        if best is None or d < best[0]:
            best = (d, cell, elev, lat, lng)
    if best is None:
        return None
    d, cell, elev, lat, lng = best
    direction = compass(geo.bearing(origin[0], origin[1], lat, lng))
    return {"type": "area", "area": {"kind": "high_ground", "name": f"High ground {fmt_distance(d)} {direction}",
                                     "lat": round(lat, 6), "lng": round(lng, 6), "elevationM": round(elev),
                                     "distanceM": round(d)},
            "reason": f"Ground about {elev:.0f} m above sea level, outside the flooded area: the nearest high ground."}


def escape_area(conn, origin: tuple[float, float], zones: models.Zones, sev, mod) -> dict | None:
    """Nearest point outside both zones, across the wind first, then upwind."""
    if zones.downwind is None:
        return None
    options = [(zones.downwind + 90, "across the wind"), (zones.downwind - 90, "across the wind"),
               (zones.downwind + 180, "upwind")]
    points, meta = [], []
    for dist in range(300, 6001, 300):
        for b, label in options:
            points.append(geo.move(origin[0], origin[1], b % 360, dist))
            meta.append((dist, b % 360, label))
    for ok, (lat, lng), (dist, b, label) in zip(points_outside(conn, sev, mod, points), points, meta):
        if ok:
            return {"type": "area", "area": {"kind": "open_area", "name": f"Open area {fmt_distance(dist)} {compass(b)}",
                                             "lat": round(lat, 6), "lng": round(lng, 6), "distanceM": dist},
                    "reason": f"The nearest point outside the danger zone, {label} of the spread."}
    return None


# ---- Endpoint ----

@router.post("/simulate")
def simulate(req: SimulateRequest, response: Response) -> dict:
    """Run a simulated calamity (demo mode). See the module docstring for the models."""
    hazard, size, params = validate(req)
    origin = (req.origin.lat, req.origin.lng)
    event = (req.event.lat, req.event.lng)

    with pool.connection() as conn:
        zones = models.build(conn, hazard, event[0], event[1], size, params)
        elevations = zones.extra.pop("elevations", None)
        water = zones.extra.pop("water", set())
        sev_parts = [t for t in (resolve(conn, p) for p in zones.severe) if t]
        mod_parts = [t for t in (resolve(conn, p) for p in zones.moderate) if t]
        sev, mod = finalize(conn, sev_parts, mod_parts)
        growth = [(t, text) for t, text in ((t, resolve(conn, p)) for t, p in zones.growth) if text]
        cells = zone_cells(conn, sev, mod)
        status = user_status(conn, sev, mod, *origin)
        places = candidate_places(conn, hazard, sev, mod, *origin)
        scored = sorted(((s, c) for c in places
                         if (s := score_place(c, hazard, zones, status, event, elevations)) is not None),
                        key=lambda sc: sc[0])
        area = high_ground(origin, zones, cells, elevations, water) if status != "outside" else None
        if area is None and status != "outside" and hazard in ("wildfire", "hazmat", "volcano"):
            area = escape_area(conn, origin, zones, sev, mod)
        rings = severe_rings(conn, sev) if status != "inside_severe" else []

    options = [{"type": "place", "place": c["place"], "reason": place_reason(c, hazard, zones, elevations)}
               for _, c in scored[:3]]
    destination = options[0] if options else None
    if area and (destination is None or (zones.high_ground_m is not None
                                         and area["area"]["distanceM"] * 1.25 < destination["place"]["distanceM"])):
        destination = area
        alternatives = options[:2]
    else:
        alternatives = options[1:3] + ([area] if area else [])

    route = None
    if destination:
        dest = destination.get("place") or destination["area"]
        cands = routing.candidates(origin, (dest["lat"], dest["lng"]), req.mode, rings or None)
        with pool.connection() as conn:
            metrics = danger_metrics(conn, sev, mod, [c["coordinates"] for c in cands])
        already_moderate = status != "outside" or hazard == "conflict"

        def cost(i: int) -> float:
            severe_m, moderate_m, _ = metrics[i]
            return cands[i]["distanceM"] + 25 * severe_m + (0 if already_moderate else 4 * moderate_m)

        best = min(range(len(cands)), key=cost)
        c, (severe_m, moderate_m, parts) = cands[best], metrics[best]
        avoids = severe_m < 20 if status != "inside_severe" else parts <= 1
        route = {
            "engine": c["engine"],
            "geometry": {"type": "LineString", "coordinates": c["coordinates"]},
            "distanceM": c["distanceM"], "durationS": c["durationS"], "steps": c["steps"],
            "avoidsDanger": avoids,
            "dangerM": {"severe": round(severe_m), "moderate": round(moderate_m)},
            "candidates": len(cands),
        }

    action, headline, now, steps = gd.plan(hazard, status)
    timeline = [(float(t), label) for t, label in zones.timeline]
    if destination and route:
        dest_name = (destination.get("place") or destination["area"])["name"]
        leave = LEAVE_AFTER_MIN.get(hazard, 0)
        minutes = max(1, round(route["durationS"] / 60))
        how = "on foot" if req.mode == "walk" else "by car"
        go = f"Go to {dest_name}: {fmt_distance(route['distanceM'])}, about {minutes} min {how}."
        if action == "shelter_in_place":
            go = f"If you are told to evacuate, go to {dest_name} ({minutes} min {how}), across the wind."
        elif status == "outside":
            go = f"If you need a safe place, the nearest suitable one is {dest_name} ({minutes} min {how})."
        steps.insert(min(len(steps), 4 if hazard == "earthquake" else 1), go)
        if action != "shelter_in_place":
            timeline.append((leave, f"Leave for {dest_name}."))
            timeline.append((round(leave + route["durationS"] / 60, 1), f"Arrive at {dest_name} ({minutes} min {how})."))
        first = zones.extra.get("firstWaveMin")
        if hazard == "tsunami" and status != "outside" and first is not None and route["durationS"] / 60 > first:
            steps.insert(0, "The first wave may arrive before you reach high ground. If the water is coming, "
                            "go up now: the third floor or higher of a sturdy concrete building.")
        if not route["avoidsDanger"]:
            steps.append("No route fully avoids the danger zone: keep to the route shown and move quickly through it.")
    timeline.sort(key=lambda x: x[0])

    sev_geom = json.loads(sev) if sev else None
    mod_geom = json.loads(mod) if mod else None
    response.headers["Cache-Control"] = "no-store"
    return {
        "scenario": {
            "hazard": hazard, "hazardLabel": HAZARDS[hazard]["label"],
            "origin": {"lat": origin[0], "lng": origin[1]},
            "event": {"lat": event[0], "lng": event[1], "size": size, "params": params},
            "mode": req.mode, "simulated": True, "label": "SIMULATION, not a real alert",
            "model": zones.model, "sources": zones.sources, "details": zones.extra,
        },
        "disclaimer": DISCLAIMER,
        "affected": {"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"level": level}, "geometry": geom}
            for level, geom in (("moderate", mod_geom), ("severe", sev_geom)) if geom]},
        "growth": [{"tMinutes": t, "geometry": json.loads(text)} for t, text in growth],
        "cells": cells,
        "userStatus": status,
        "action": action,
        "actionLabel": gd.ACTION_LABEL[action],
        "headline": headline,
        "now": now,
        "guidance": steps,
        "destination": destination,
        "alternatives": alternatives,
        "route": route,
        "timeline": [{"tMinutes": round(t, 1), "label": label} for t, label in timeline],
    }
