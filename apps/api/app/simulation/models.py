"""Per-hazard danger-zone models for the simulator (see routers/simulate.py for the summary).

Each model returns `Zones`: the parts of the severe and the moderate zone (GeoJSON
built here, or SQL against optional tables such as `hazard_zones`), the growth of the
danger over time for the animation, a short timeline and the data it used.
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field

from . import geometry as g
from . import terrain


@dataclass
class Part:
    """One piece of a zone: a GeoJSON geometry, or SQL that returns one GeoJSON text (or NULL)."""
    geojson: dict | None = None
    sql: str | None = None
    params: dict = field(default_factory=dict)


@dataclass
class Zones:
    severe: list[Part] = field(default_factory=list)
    moderate: list[Part] = field(default_factory=list)
    # (minutes after the event, outline of the danger at that time), for the animation.
    growth: list[tuple[float, Part]] = field(default_factory=list)
    timeline: list[tuple[float, str]] = field(default_factory=list)
    model: str = ""
    sources: list[str] = field(default_factory=list)
    # Direction the danger travels toward (downwind), degrees, when wind matters.
    downwind: float | None = None
    # Elevation threshold for "high ground" destinations (flood and tsunami).
    high_ground_m: float | None = None
    # Data needed by the destination logic.
    extra: dict = field(default_factory=dict)


DEFAULT_SIZE = {
    "earthquake": 6.8, "tsunami": 15_000, "flood": 3_000, "wildfire": 400, "hazmat": 400,
    "conflict": 800, "storm": 1_500, "heat": 6_000, "winter": 5_000, "air_quality": 4_000,
    "volcano": 3_000, "crime": 300, "other": 1_000,
}

# hazard_zones sources (outlook pipeline), used when that table is present.
TSUNAMI_SOURCES = {"cascadia": "seattle-tsunami-cascadia", "seattle_fault": "seattle-tsunami-seattle-fault"}
TSUNAMI_LABEL = {"cascadia": "M9 Cascadia subduction zone", "seattle_fault": "M7.5 Seattle Fault"}
TSUNAMI_FIRST_WAVE_MIN = {"cascadia": 90, "seattle_fault": 3}

# Union of grid cells by id, smoothed a little so the outline reads as terrain, not squares.
CELLS_SQL = """
    SELECT ST_AsGeoJSON(ST_SimplifyPreserveTopology(
               ST_Buffer(ST_Buffer(ST_Union(cell), 0.0006, 'quad_segs=3'), -0.0005, 'quad_segs=3'), 0.00015), 5)
    FROM grid_cells WHERE cell_id = ANY(%(cells)s)
"""


def cells_in_zone(conn, zone_geojson: str) -> list[int]:
    """Grid cells whose centre lies inside a GeoJSON geometry."""
    rows = conn.execute("""
        WITH z AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326) AS g)
        SELECT c.cell_id FROM grid_cells c, z WHERE z.g && c.cell AND ST_Intersects(z.g, c.center::geometry)
    """, (zone_geojson,)).fetchall()
    return [r[0] for r in rows]


def near_cells(cells: list[int], anchors: list[int], rows: int, cols: int) -> list[int]:
    """The cells within `rows` x `cols` grid steps of any anchor cell."""
    reach = {(a // 100 + dr) * 100 + (a % 100 + dc) for a in anchors
             for dr in range(-rows, rows + 1) for dc in range(-cols, cols + 1) if 0 <= a % 100 + dc < 100}
    return [c for c in cells if c in reach]


def table_exists(conn, name: str) -> bool:
    return conn.execute("SELECT to_regclass(%s)", (name,)).fetchone()[0] is not None


_zone_cache: dict[tuple, tuple[tuple, str | None]] = {}
_zone_lock = threading.Lock()
ZONE_SIMPLIFY_DEG = 0.0001  # about 10 m: plenty for a city-scale simulation, and keeps unions fast

CLIP_SQL = """
    SELECT ST_AsGeoJSON(ST_CollectionExtract(ST_Intersection(
               ST_SetSRID(ST_GeomFromGeoJSON(%(zone)s), 4326), ST_SetSRID(ST_GeomFromGeoJSON(%(clip)s), 4326)), 3), 5)
"""


def hazard_zone_part(conn, kinds: list[str], clip: dict, levels: list[str] | None = None,
                     sources: list[str] | None = None) -> Part | None:
    """Optional hazard_zones polygons of the given kinds, clipped to `clip`; None without the table or rows.

    The simplified union per (kinds, levels, sources) is cached in memory until the rows change.
    """
    if not table_exists(conn, "hazard_zones"):
        return None
    params = {"kinds": kinds, "levels": levels, "sources": sources}
    where = """kind = ANY(%(kinds)s) AND (%(levels)s::text[] IS NULL OR level = ANY(%(levels)s::text[]))
               AND (%(sources)s::text[] IS NULL OR source = ANY(%(sources)s::text[]))"""
    version = tuple(conn.execute(f"SELECT count(*), max(updated_at) FROM hazard_zones WHERE {where}", params).fetchone())
    if not version[0]:
        return None
    key = (tuple(kinds), tuple(levels or ()), tuple(sources or ()))
    with _zone_lock:
        cached = _zone_cache.get(key)
        if cached is None or cached[0] != version:
            # Union, close small gaps (about 30 m), drop slivers under about 3,000 m2, simplify.
            text = conn.execute(f"""
                WITH u AS (SELECT ST_UnaryUnion(ST_Collect(ST_MakeValid(
                                      ST_SimplifyPreserveTopology(geom, {ZONE_SIMPLIFY_DEG})))) AS g
                           FROM hazard_zones WHERE {where}),
                     d AS (SELECT (ST_Dump(ST_Buffer(ST_Buffer(u.g, 0.0003, 'quad_segs=2'), -0.0003, 'quad_segs=2'))).geom AS g
                           FROM u)
                SELECT ST_AsGeoJSON(ST_CollectionExtract(ST_MakeValid(
                           ST_SimplifyPreserveTopology(ST_Collect(g), 0.00012)), 3), 6)
                FROM d WHERE ST_Area(g) > 3e-7""", params).fetchone()[0]
            cached = _zone_cache[key] = (version, text)
    if not cached[1]:
        return None
    return Part(sql=CLIP_SQL, params={"zone": cached[1], "clip": json.dumps(clip)})


def cells_part(cells: list[int]) -> Part | None:
    return Part(sql=CELLS_SQL, params={"cells": cells}) if cells else None


def _cells_within(lat: float, lng: float, radius_m: float) -> list[int]:
    out = []
    for cell in terrain.all_cells():
        clat, clng = terrain.cell_center(cell)
        if abs(clat - lat) * g.M_PER_DEG_LAT <= radius_m and g.meters(lat, lng, clat, clng) <= radius_m:
            out.append(cell)
    return out


# ---- Models ----

def earthquake(conn, lat, lng, magnitude, params, elevations) -> Zones:
    severe_km = 10 ** (0.5 * magnitude - 2.9)
    moderate_km = 10 ** (0.5 * magnitude - 2.0)
    z = Zones(model=(f"Intensity rings from magnitude: strong shaking (severe) within 10^(0.5M-2.9) km = "
                     f"{severe_km:.1f} km, noticeable damage (moderate) within 10^(0.5M-2.0) km = {moderate_km:.0f} km. "
                     "A rule of thumb, not a ShakeMap."))
    z.severe.append(Part(geojson=g.circle(lat, lng, severe_km * 1000)))
    moderate_ring = g.circle(lat, lng, moderate_km * 1000)
    z.moderate.append(Part(geojson=moderate_ring))
    ground = hazard_zone_part(conn, ["liquefaction"], moderate_ring,
                              levels=["high"] if magnitude < 6.5 else None)
    if ground:
        (z.severe if magnitude >= 6 else z.moderate).append(ground)
        z.sources.append("City of Seattle ECA liquefaction-prone areas (hazard_zones)")
        z.model += (" Liquefaction-prone ground inside the moderate ring counts as severe from M6"
                    if magnitude >= 6 else " Liquefaction-prone ground counts as moderate")
        z.model += "."
    shaking_s = max(5, round(2 ** (magnitude - 4) * 4))
    z.growth = [(0, Part(geojson=g.circle(lat, lng, severe_km * 150))), (0.5, Part(geojson=g.circle(lat, lng, severe_km * 1000)))]
    z.timeline = [
        (0, f"M{magnitude:.1f} earthquake: shaking starts. Drop, cover, hold on."),
        (round(shaking_s / 60, 1), f"Shaking stops after about {shaking_s} s (simulated)."),
        (2, "Check for injuries and gas leaks. Leave damaged buildings by the stairs."),
        (30, "Aftershocks are likely for hours to days."),
    ]
    if magnitude >= 7:
        z.timeline.append((3, "A quake this strong can push a tsunami into Puget Sound: near the shore, go to high ground."))
    z.extra["magnitude"] = magnitude
    return z


def tsunami(conn, lat, lng, radius_m, params, elevations) -> Zones:
    scenario = params.get("scenario") or "cascadia"
    reach = g.circle(lat, lng, radius_m)
    first = TSUNAMI_FIRST_WAVE_MIN[scenario]
    z = Zones(high_ground_m=15)
    deep = hazard_zone_part(conn, ["tsunami_inundation"], reach, levels=["high", "moderate"],
                            sources=[TSUNAMI_SOURCES[scenario]])
    shallow = hazard_zone_part(conn, ["tsunami_inundation"], reach, levels=["low"], sources=[TSUNAMI_SOURCES[scenario]])
    low_cells = [c for c in _cells_within(lat, lng, radius_m) if elevations.get(c, 99) <= 10] if elevations else []
    if deep:
        z.severe.append(deep)
        if shallow:
            z.moderate.append(shallow)
        if low_cells:
            # Evacuation margin: low ground (<= 10 m) within about 1.2 km of the inundation zone.
            flooded = cells_in_zone(conn, deep.params["zone"])
            z.moderate.extend(p for p in [cells_part(near_cells(low_cells, flooded, rows=5, cols=5))] if p)
        z.model = (f"WA DNR tsunami inundation model for the {TSUNAMI_LABEL[scenario]} scenario, within "
                   f"{radius_m / 1000:.0f} km of the event: water deeper than 1 ft is severe; up to 1 ft, and low ground "
                   "(cell centre at most 10 m above sea level) within about 1.2 km of it, is moderate (the margin "
                   "officials ask people to leave).")
        z.sources.append(f"Washington DNR tsunami inundation, {TSUNAMI_LABEL[scenario]} scenario (hazard_zones)")
        z.growth = [(t, Part(sql=CLIP_SQL, params={"zone": deep.params["zone"],
                                                    "clip": json.dumps(g.circle(lat, lng, radius_m * f))}))
                    for t, f in ((0, 0.25), (first * 0.5, 0.6), (first, 1.0))]
    elif elevations:
        z.severe.extend(p for p in [cells_part([c for c in low_cells if elevations[c] <= 5])] if p)
        z.moderate.extend(p for p in [cells_part([c for c in low_cells if elevations[c] > 5])] if p)
        z.model = (f"Low ground within {radius_m / 1000:.0f} km of the event: grid cells whose centre is at most "
                   "5 m above sea level are severe, 5-10 m moderate (AWS Terrain Tiles).")
        z.growth = [(t, p) for t, f in ((0, 0.25), (first * 0.5, 0.6), (first, 1.0))
                    for p in [cells_part([c for c in low_cells if elevations[c] <= 5
                                          and g.meters(lat, lng, *terrain.cell_center(c)) <= radius_m * f])] if p]
    else:
        z.severe.append(Part(geojson=g.circle(lat, lng, radius_m * 0.25)))
        z.moderate.append(Part(geojson=g.circle(lat, lng, radius_m * 0.5)))
        z.model = "No terrain or inundation data available: rings around the event (25 % and 50 % of the reach)."
        z.growth = [(0, Part(geojson=g.circle(lat, lng, radius_m * 0.1))), (first, Part(geojson=g.circle(lat, lng, radius_m * 0.25)))]
    if elevations:
        z.sources.append("AWS Terrain Tiles (Mapzen terrarium), cell-centre elevation")
    z.timeline = [
        (0, f"{TSUNAMI_LABEL[scenario]} earthquake: strong shaking, then a tsunami is on its way."),
        (first, f"First wave reaches the shore near the event (simulated, about {first} min)."),
        (first + 60, "More waves keep coming for hours. The first is often not the largest."),
    ]
    z.extra["firstWaveMin"] = first
    z.extra["scenario"] = scenario
    return z


def flood(conn, lat, lng, radius_m, params, elevations) -> Zones:
    depth = float(params.get("depthM") or 3.0)
    reach = g.circle(lat, lng, radius_m)
    z = Zones()
    if elevations:
        base_cell = terrain.cell_at(lat, lng)
        base = elevations.get(base_cell, 0.0) if base_cell is not None else 0.0
        cells = _cells_within(lat, lng, radius_m)
        severe = [c for c in cells if elevations.get(c, 999) <= base + depth * 0.5]
        moderate = [c for c in cells if base + depth * 0.5 < elevations.get(c, 999) <= base + depth]
        z.severe.extend(p for p in [cells_part(severe)] if p)
        z.moderate.extend(p for p in [cells_part(moderate)] if p)
        z.growth = [(0, p) for p in [cells_part([c for c in cells if elevations.get(c, 999) <= base + depth * 0.2])] if p]
        z.growth += [(30, p) for p in [cells_part(severe)] if p]
        z.growth += [(90, p) for p in [cells_part(severe + moderate)] if p]
        z.high_ground_m = base + depth + 5
        z.model = (f"Water rises {depth:g} m above the ground at the event ({base:.0f} m above sea level) within "
                   f"{radius_m / 1000:.1f} km: cells up to {depth * 0.5:g} m above it are severe, up to {depth:g} m "
                   "moderate (AWS Terrain Tiles, cell-centre elevation).")
        z.sources.append("AWS Terrain Tiles (Mapzen terrarium), cell-centre elevation")
    else:
        z.severe.append(Part(geojson=g.circle(lat, lng, radius_m * 0.4)))
        z.moderate.append(Part(geojson=reach))
        z.growth = [(0, Part(geojson=g.circle(lat, lng, radius_m * 0.15))), (90, Part(geojson=reach))]
        z.model = "No terrain data available: rings around the event (40 % severe, 100 % moderate)."
    zone = hazard_zone_part(conn, ["flood_zone"], reach)
    if zone:
        z.moderate.append(zone)
        z.sources.append("Mapped flood zones (hazard_zones)")
    z.timeline = [
        (0, "Heavy rain: the river starts to rise."),
        (30, f"Low ground floods (simulated, about {depth * 0.5:g} m of water)."),
        (90, f"Flood peaks about {depth:g} m above normal (simulated)."),
    ]
    return z


def _wind(params) -> tuple[float, float]:
    """(direction the wind blows from, km/h); defaults to Seattle's common southwest wind."""
    return float(params.get("windDeg", 225) or 0) % 360, float(params.get("windKmh", 20) if params.get("windKmh") is not None else 20)


def wildfire(conn, lat, lng, radius_m, params, elevations) -> Zones:
    wind_from, wind_kmh = _wind(params)
    downwind = (wind_from + 180) % 360
    ros = 5 + 1.5 * wind_kmh                   # forward rate of spread, m/min
    lb = 1 + wind_kmh / 20                     # length-to-breadth ratio

    def front(t: float, grow: float = 1.0) -> dict:
        head = radius_m + ros * t * grow
        back = radius_m + 0.15 * ros * t
        a = (head + back) / 2
        b = max(radius_m, a / lb * (1.3 if grow > 1 else 1))
        return g.ellipse(lat, lng, a, b, downwind, center_offset_m=(head - back) / 2)

    z = Zones(downwind=downwind)
    z.severe.append(Part(geojson=front(60)))
    z.moderate.append(Part(geojson=front(60, grow=2.2)))
    z.moderate.append(Part(geojson=g.circle(lat, lng, radius_m * 3)))
    z.growth = [(t, Part(geojson=front(t))) for t in (0, 15, 30, 60)]
    z.model = (f"Wind-driven ellipse: the head moves downwind ({downwind:.0f} deg) at 5 + 1.5 x wind = {ros:.0f} m/min, "
               f"the back at 15 % of that, length-to-breadth 1 + wind/20 = {lb:.1f}. Severe: fire area after 60 min; "
               "moderate: embers and smoke up to 2.2 x as far downwind.")
    z.timeline = [
        (0, f"Fire starts; wind {wind_kmh:.0f} km/h from {wind_from:.0f} deg."),
        (15, f"Fire front about {(radius_m + ros * 15) / 1000:.1f} km downwind (simulated)."),
        (30, f"Fire front about {(radius_m + ros * 30) / 1000:.1f} km downwind; embers start spot fires ahead."),
        (60, f"Fire front about {(radius_m + ros * 60) / 1000:.1f} km downwind (simulated)."),
    ]
    z.extra.update(windFrom=wind_from, windKmh=wind_kmh, rosMPerMin=ros)
    return z


def hazmat(conn, lat, lng, radius_m, params, elevations) -> Zones:
    wind_from, wind_kmh = _wind(params)
    downwind = (wind_from + 180) % 360
    wf = min(2.0, max(0.6, wind_kmh / 15))
    near_len, far_len = radius_m * 4 * wf, radius_m * 14 * wf
    z = Zones(downwind=downwind)
    z.severe.append(Part(geojson=g.plume(lat, lng, radius_m, near_len, radius_m * 1.3, downwind)))
    z.moderate.append(Part(geojson=g.plume(lat, lng, radius_m * 1.5, far_len, radius_m * 3.5, downwind)))
    speed = max(wind_kmh, 3) * 1000 / 60      # m/min the plume front travels
    z.growth = [(t, Part(geojson=g.plume(lat, lng, radius_m, max(radius_m * 1.2, min(far_len, speed * t)),
                                         radius_m * 3.5 * min(1, speed * t / far_len) + radius_m, downwind)))
                for t in (0, 2, 5, 10, 20)]
    reach_min = far_len / speed
    z.model = (f"Isolation circle of {radius_m:.0f} m plus a downwind plume ({downwind:.0f} deg): severe "
               f"{near_len / 1000:.1f} km long, moderate {far_len / 1000:.1f} km (scaled by wind {wind_kmh:.0f} km/h), "
               "in the style of the Emergency Response Guidebook's isolation and protective-action zones.")
    z.timeline = [
        (0, "Chemical release reported."),
        (round(near_len / speed, 1), f"Plume reaches {near_len / 1000:.1f} km downwind (simulated)."),
        (round(reach_min, 1), f"Plume reaches {far_len / 1000:.1f} km downwind (simulated)."),
    ]
    z.extra.update(windFrom=wind_from, windKmh=wind_kmh)
    return z


def conflict(conn, lat, lng, radius_m, params, elevations) -> Zones:
    z = Zones()
    z.severe.append(Part(geojson=g.circle(lat, lng, radius_m)))
    z.moderate.append(Part(geojson=g.circle(lat, lng, radius_m * 3)))
    z.growth = [(0, Part(geojson=g.circle(lat, lng, radius_m * 0.3))), (1, Part(geojson=g.circle(lat, lng, radius_m)))]
    z.model = (f"Target area of {radius_m:.0f} m (severe) and a {radius_m * 3 / 1000:.1f} km blast and debris area "
               "(moderate). Going underground nearby beats running through the open.")
    z.timeline = [
        (0, "Air-raid warning: sirens and phone alerts."),
        (1, "Get underground now: bomb shelter, bunker or underground station."),
        (15, "Stay underground until the official all-clear."),
    ]
    return z


def storm(conn, lat, lng, radius_m, params, elevations) -> Zones:
    wind_from, wind_kmh = _wind(params)
    track = (wind_from + 180) % 360
    z = Zones(downwind=track)
    z.severe.append(Part(geojson=g.ellipse(lat, lng, radius_m * 1.8, max(150, radius_m * 0.22), track,
                                           center_offset_m=radius_m * 1.2)))
    z.moderate.append(Part(geojson=g.circle(lat, lng, radius_m * 2.5)))
    z.growth = [(0, Part(geojson=g.circle(lat, lng, radius_m * 0.3))), (10, Part(geojson=g.circle(lat, lng, radius_m * 2.5)))]
    z.model = (f"Storm cell {radius_m * 2.5 / 1000:.1f} km across (moderate) with a damage path along its track "
               f"({track:.0f} deg), {radius_m * 3.6 / 1000:.1f} km long (severe).")
    z.timeline = [(0, "Severe storm warning issued."), (10, "Storm core arrives (simulated)."),
                  (40, "Storm moves on; downed lines and debris remain.")]
    return z


def _rings(lat, lng, radius_m, inner: float, label: str, timeline) -> Zones:
    z = Zones()
    z.severe.append(Part(geojson=g.circle(lat, lng, radius_m * inner)))
    z.moderate.append(Part(geojson=g.circle(lat, lng, radius_m)))
    z.growth = [(0, Part(geojson=g.circle(lat, lng, radius_m * inner * 0.5))), (timeline[1][0], Part(geojson=g.circle(lat, lng, radius_m)))]
    z.model = (f"{label}: severe within {radius_m * inner / 1000:.1f} km of the centre, moderate within "
               f"{radius_m / 1000:.1f} km.")
    z.timeline = timeline
    return z


def heat(conn, lat, lng, radius_m, params, elevations) -> Zones:
    return _rings(lat, lng, radius_m, 0.45, "Heat island", [
        (0, "Extreme heat warning: over 35 C (95 F) expected."), (180, "Hottest part of the afternoon (simulated)."),
        (480, "Little relief overnight in the city core.")])


def winter(conn, lat, lng, radius_m, params, elevations) -> Zones:
    return _rings(lat, lng, radius_m, 0.4, "Ice storm", [
        (0, "Winter storm warning: freezing rain and snow."), (60, "Roads ice over; power cuts start (simulated)."),
        (360, "Cold continues overnight.")])


def air_quality(conn, lat, lng, radius_m, params, elevations) -> Zones:
    wind_from, wind_kmh = _wind(params)
    downwind = (wind_from + 180) % 360
    z = Zones(downwind=downwind)
    z.severe.append(Part(geojson=g.circle(lat, lng, radius_m * 0.35)))
    z.moderate.append(Part(geojson=g.plume(lat, lng, radius_m, radius_m * 2.5, radius_m * 1.2, downwind)))
    z.growth = [(0, Part(geojson=g.circle(lat, lng, radius_m * 0.2))), (60, Part(geojson=g.circle(lat, lng, radius_m)))]
    z.model = (f"Smoke: very unhealthy air within {radius_m * 0.35 / 1000:.1f} km (severe), unhealthy air drifting "
               f"downwind ({downwind:.0f} deg) up to {radius_m * 2.5 / 1000:.1f} km (moderate).")
    z.timeline = [(0, "Air quality alert: smoke moving in."), (60, "Air is unhealthy for everyone (simulated)."),
                  (240, "Smoke lingers until the wind changes.")]
    return z


def volcano(conn, lat, lng, radius_m, params, elevations) -> Zones:
    wind_from, wind_kmh = _wind(params)
    downwind = (wind_from + 180) % 360
    z = Zones(downwind=downwind)
    z.severe.append(Part(geojson=g.circle(lat, lng, radius_m)))
    z.moderate.append(Part(geojson=g.plume(lat, lng, radius_m, radius_m * 6, radius_m * 1.5, downwind)))
    lahar = hazard_zone_part(conn, ["lahar"], g.circle(lat, lng, radius_m * 10))
    if lahar:
        z.severe.append(lahar)
        z.sources.append("Lahar hazard zones (hazard_zones)")
    z.growth = [(0, Part(geojson=g.circle(lat, lng, radius_m * 0.5))), (30, Part(geojson=g.circle(lat, lng, radius_m)))]
    z.model = (f"Blast and lahar area of {radius_m / 1000:.1f} km (severe) and ashfall drifting downwind "
               f"({downwind:.0f} deg) up to {radius_m * 6 / 1000:.0f} km (moderate).")
    z.timeline = [(0, "Eruption."), (30, "Ash starts falling downwind (simulated)."),
                  (120, "Lahars can flow down river valleys for hours.")]
    return z


def other(conn, lat, lng, radius_m, params, elevations) -> Zones:
    return _rings(lat, lng, radius_m * 2.5, 0.4, "Incident area", [
        (0, "Emergency reported."), (5, "Responders set up a cordon (simulated)."), (60, "Area stays closed.")])


MODELS = {
    "earthquake": earthquake, "tsunami": tsunami, "flood": flood, "wildfire": wildfire, "hazmat": hazmat,
    "conflict": conflict, "storm": storm, "heat": heat, "winter": winter, "air_quality": air_quality,
    "volcano": volcano, "crime": other, "other": other,
}


def build(conn, hazard: str, lat: float, lng: float, size: float, params: dict) -> Zones:
    elevations = terrain.cell_elevations(conn) if hazard in ("tsunami", "flood") else None
    zones = MODELS[hazard](conn, lat, lng, size, params, elevations)
    if hazard in ("tsunami", "flood") and elevations:
        zones.extra["elevations"] = elevations
    return zones

