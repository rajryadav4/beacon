"""Danger-aware routes from free public routing servers (no API keys).

1. Valhalla on the FOSSGIS public server (valhalla1.openstreetmap.de), costing
   `pedestrian` or `auto`. When the user starts outside the severe zone and the
   zone is small enough (the server allows exclusion polygons up to 10 km of
   circumference in total), one request passes the severe zone as
   `exclude_polygons`; a second, plain request asks for up to 2 alternates.
2. If Valhalla cannot be reached, OSRM on routing.openstreetmap.de (routed-foot /
   routed-car) with `alternatives=true`.
3. If neither answers, a straight line, flagged as such.

The caller scores every candidate by its length inside the danger zones and keeps
the best. Only the two coordinates (and the zone outline) are sent.
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor

from . import net
from .geometry import meters

log = logging.getLogger(__name__)

VALHALLA_URL = "https://valhalla1.openstreetmap.de/route"
OSRM_URL = {
    "walk": "https://routing.openstreetmap.de/routed-foot/route/v1/driving/{a};{b}",
    "drive": "https://routing.openstreetmap.de/routed-car/route/v1/driving/{a};{b}",
}
VALHALLA_COSTING = {"walk": "pedestrian", "drive": "auto"}
MAX_EXCLUDE_CIRCUMFERENCE_M = 9_500
TIMEOUT_S = 8
SPEED_MPS = {"walk": 1.3, "drive": 8.0}  # straight-line fallback only


def decode_polyline(encoded: str, precision: int = 6) -> list[list[float]]:
    """Google encoded polyline (Valhalla uses precision 6) -> [[lng, lat], ...]."""
    coords: list[list[float]] = []
    index = lat = lng = 0
    factor = 10 ** precision
    while index < len(encoded):
        for axis in (0, 1):
            shift = result = 0
            while True:
                b = ord(encoded[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else result >> 1
            if axis == 0:
                lat += delta
            else:
                lng += delta
        coords.append([round(lng / factor, 6), round(lat / factor, 6)])
    return coords


def ring_circumference(ring: list[list[float]]) -> float:
    return sum(meters(a[1], a[0], b[1], b[0]) for a, b in zip(ring, ring[1:]))


def _valhalla_trip(trip: dict, engine_note: str | None) -> dict:
    coords: list[list[float]] = []
    steps = []
    for leg in trip.get("legs", []):
        shape = decode_polyline(leg["shape"])
        coords.extend(shape if not coords else shape[1:])
        for m in leg.get("maneuvers", []):
            steps.append({"instruction": m.get("instruction", ""), "distanceM": round(m.get("length", 0) * 1000)})
    summary = trip.get("summary", {})
    return {"engine": "valhalla", "coordinates": coords, "distanceM": round(summary.get("length", 0) * 1000),
            "durationS": round(summary.get("time", 0)), "steps": steps, "excluded": engine_note == "excluded"}


def valhalla(origin: tuple[float, float], dest: tuple[float, float], mode: str,
             exclude: list[list[list[float]]] | None = None, alternates: int = 0) -> list[dict]:
    body: dict = {
        "locations": [{"lat": origin[0], "lon": origin[1]}, {"lat": dest[0], "lon": dest[1]}],
        "costing": VALHALLA_COSTING[mode],
        "units": "kilometers",
        "directions_options": {"units": "kilometers", "language": "en-US"},
    }
    if exclude:
        body["exclude_polygons"] = exclude
    if alternates:
        body["alternates"] = alternates
    data = net.fetch_json(VALHALLA_URL, timeout=TIMEOUT_S, body=body)
    note = "excluded" if exclude else None
    out = [_valhalla_trip(data["trip"], note)]
    for alt in data.get("alternates", []) or []:
        if "trip" in alt:
            out.append(_valhalla_trip(alt["trip"], note))
    return out


def _osrm_instruction(step: dict) -> str:
    m = step.get("maneuver", {})
    kind, modifier, name = m.get("type", ""), m.get("modifier", ""), step.get("name") or ""
    onto = f" onto {name}" if name else ""
    if kind == "depart":
        return f"Head out{(' on ' + name) if name else ''}"
    if kind == "arrive":
        return "Arrive at your destination"
    if kind in ("roundabout", "rotary"):
        return f"Take the roundabout{onto}"
    if modifier in ("straight", "") or kind in ("continue", "new name"):
        return f"Continue{(' on ' + name) if name else ' straight'}"
    return f"Turn {modifier}{onto}"


def osrm(origin: tuple[float, float], dest: tuple[float, float], mode: str) -> list[dict]:
    url = OSRM_URL[mode].format(a=f"{origin[1]:.6f},{origin[0]:.6f}", b=f"{dest[1]:.6f},{dest[0]:.6f}")
    data = net.fetch_json(url + "?overview=full&geometries=geojson&alternatives=true&steps=true", timeout=TIMEOUT_S)
    if data.get("code") != "Ok":
        raise RuntimeError(f"OSRM: {data.get('code')}")
    out = []
    for r in data.get("routes", []):
        steps = [{"instruction": _osrm_instruction(s), "distanceM": round(s.get("distance", 0))}
                 for leg in r.get("legs", []) for s in leg.get("steps", [])]
        out.append({"engine": "osrm", "coordinates": [[round(x, 6), round(y, 6)] for x, y in r["geometry"]["coordinates"]],
                    "distanceM": round(r["distance"]), "durationS": round(r["duration"]), "steps": steps,
                    "excluded": False})
    return out


def straight_line(origin: tuple[float, float], dest: tuple[float, float], mode: str) -> dict:
    d = meters(origin[0], origin[1], dest[0], dest[1])
    return {"engine": "straight_line", "coordinates": [[origin[1], origin[0]], [dest[1], dest[0]]],
            "distanceM": round(d), "durationS": round(d * 1.3 / SPEED_MPS[mode]),
            "steps": [{"instruction": "Routing servers unavailable: head toward the destination shown on the map",
                       "distanceM": round(d)}], "excluded": False}


def candidates(origin: tuple[float, float], dest: tuple[float, float], mode: str,
               exclude: list[list[list[float]]] | None) -> list[dict]:
    """Every route candidate we can get; never raises."""
    if exclude and sum(ring_circumference(r) for r in exclude) > MAX_EXCLUDE_CIRCUMFERENCE_M:
        exclude = None
    found: list[dict] = []
    valhalla_ok = False
    with ThreadPoolExecutor(max_workers=2) as pool:
        jobs = [pool.submit(valhalla, origin, dest, mode, None, 2)]
        if exclude:
            jobs.append(pool.submit(valhalla, origin, dest, mode, exclude, 0))
        for job in jobs:
            try:
                found.extend(job.result())
                valhalla_ok = True
            except Exception as exc:  # unreachable, or no route around the zone
                log.info("valhalla request failed: %s", type(exc).__name__)
    if not valhalla_ok:
        try:
            found.extend(osrm(origin, dest, mode))
        except Exception as exc:
            log.info("osrm request failed: %s", type(exc).__name__)
    return [c for c in found if len(c["coordinates"]) >= 2] or [straight_line(origin, dest, mode)]
