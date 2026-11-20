"""Beacon Simulator (POST /api/simulate). Runs against the local Postgres with Seattle and
its safe places loaded; routing servers and terrain tiles are mocked, nothing leaves the machine."""

from __future__ import annotations

import logging
import math
import struct
import zlib

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.simulation import geometry, models, routing, terrain

DOWNTOWN = {"lat": 47.6097, "lng": -122.3331}
UNDERGROUND = {"bomb_shelter", "bunker", "underground_station"}


# ---- Fakes ----

def line(a, b, n=20):
    """[[lng, lat], ...] from a to b (both (lat, lng))."""
    return [[round(a[1] + (b[1] - a[1]) * i / n, 6), round(a[0] + (b[0] - a[0]) * i / n, 6)] for i in range(n + 1)]


def fake_trip(origin, dest, engine="valhalla", via=None):
    pts = line(origin, via) + line(via, dest)[1:] if via else line(origin, dest)
    d = sum(geometry.meters(p[1], p[0], q[1], q[0]) for p, q in zip(pts, pts[1:]))
    return {"engine": engine, "coordinates": pts, "distanceM": round(d), "durationS": round(d / 1.3),
            "steps": [{"instruction": "Walk north.", "distanceM": round(d)}], "excluded": False}


class Router:
    """Records the routing calls; answers with straight lines."""

    def __init__(self, valhalla_ok=True, osrm_ok=True):
        self.valhalla_ok, self.osrm_ok = valhalla_ok, osrm_ok
        self.valhalla_calls: list[dict] = []
        self.osrm_calls = 0

    def valhalla(self, origin, dest, mode, exclude=None, alternates=0):
        self.valhalla_calls.append({"mode": mode, "exclude": exclude, "alternates": alternates})
        if not self.valhalla_ok:
            raise OSError("unreachable")
        return [fake_trip(origin, dest)]

    def osrm(self, origin, dest, mode):
        self.osrm_calls += 1
        if not self.osrm_ok:
            raise OSError("unreachable")
        return [fake_trip(origin, dest, "osrm")]


@pytest.fixture
def router(monkeypatch):
    r = Router()
    monkeypatch.setattr(routing, "valhalla", r.valhalla)
    monkeypatch.setattr(routing, "osrm", r.osrm)
    return r


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("tests must not call the network")

    monkeypatch.setattr("app.simulation.net.fetch_bytes", refuse)
    monkeypatch.setattr("app.simulation.net.fetch_json", refuse)


@pytest.fixture
def slope(monkeypatch):
    """Synthetic terrain: sea level at longitude -122.36, rising 10 m per km to the east."""
    elev = {c: round((terrain.cell_center(c)[1] + 122.36) * 75_000 * 0.01, 1) for c in terrain.all_cells()}
    monkeypatch.setattr(terrain, "cell_elevations", lambda conn=None: elev)
    return elev


@pytest.fixture(scope="module")
def client():
    try:
        with TestClient(app) as c:
            yield c
    except Exception as exc:  # pool could not connect
        pytest.skip(f"database not available: {exc}")


def simulate(client, hazard, origin, event, size=None, params=None, mode="walk"):
    body = {"hazard": hazard, "origin": origin, "event": {**event, **({"size": size} if size is not None else {})},
            "mode": mode}
    if params:
        body["event"]["params"] = params
    return client.post("/api/simulate", json=body)


def point_in(geom: dict, lat: float, lng: float) -> bool:
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    for poly in polys:
        inside = False
        ring = poly[0]
        for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
            if (y1 > lat) != (y2 > lat) and lng < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
                inside = not inside
        if inside and not any(_in_ring(h, lat, lng) for h in poly[1:]):
            return True
    return False


def _in_ring(ring, lat, lng):
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > lat) != (y2 > lat) and lng < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def zone(data, level):
    return next((f["geometry"] for f in data["affected"]["features"] if f["properties"]["level"] == level), None)


# ---- Scenarios ----

def test_earthquake_downtown(client, router):
    r = simulate(client, "earthquake", DOWNTOWN, {"lat": 47.59, "lng": -122.36}, size=6.8)
    assert r.status_code == 200, r.text
    assert r.headers["cache-control"] == "no-store"
    d = r.json()
    assert d["scenario"]["simulated"] is True and "SIMULATION" in d["disclaimer"]
    severe = zone(d, "severe")
    assert severe and point_in(severe, 47.59, -122.36)
    assert d["userStatus"] == "inside_severe"
    assert d["action"] == "move_to_open_ground"
    assert "Drop" in d["guidance"][0]
    dest = d["destination"]["place"]
    assert dest["kind"] in ("assembly_point", "emergency_hub")
    assert not point_in(severe, dest["lat"], dest["lng"])
    assert set(dest) >= {"id", "name", "kind", "kindLabel", "lat", "lng", "distanceM", "address", "phone",
                         "openingHours", "source"}
    route = d["route"]
    assert route["engine"] == "valhalla" and route["geometry"]["type"] == "LineString"
    assert route["distanceM"] > 0 and route["steps"]
    assert d["cells"]["severe"] and all(isinstance(c, int) for c in d["cells"]["severe"])
    assert any("Arrive at" in t["label"] for t in d["timeline"])
    assert [t["tMinutes"] for t in d["timeline"]] == sorted(t["tMinutes"] for t in d["timeline"])
    # The user starts inside the severe zone: no exclusion polygon, alternates requested.
    assert all(c["exclude"] is None for c in router.valhalla_calls)
    assert router.valhalla_calls[0]["mode"] == "walk"


def test_air_raid_goes_underground(client, router):
    r = simulate(client, "conflict", DOWNTOWN, {"lat": 47.6105, "lng": -122.3370}, size=800)
    d = r.json()
    assert r.status_code == 200, r.text
    assert d["action"] == "go_underground"
    place = d["destination"]["place"]
    assert place["kind"] in UNDERGROUND
    assert not point_in(zone(d, "severe"), place["lat"], place["lng"])
    assert "Underground" in d["destination"]["reason"]


def test_small_severe_zone_is_excluded_from_routing(client, router):
    """User outside a small severe zone: Valhalla gets it as exclude_polygons."""
    origin = {"lat": 47.6205, "lng": -122.3200}
    r = simulate(client, "conflict", origin, {"lat": 47.6105, "lng": -122.3370}, size=300)
    assert r.status_code == 200, r.text
    excluded = [c["exclude"] for c in router.valhalla_calls if c["exclude"]]
    assert excluded and excluded[0][0][0] == excluded[0][0][-1]  # closed ring
    assert sum(routing.ring_circumference(ring) for ring in excluded[0]) <= routing.MAX_EXCLUDE_CIRCUMFERENCE_M


def test_tsunami_goes_to_high_ground(client, router, slope):
    origin = {"lat": 47.5900, "lng": -122.3500}
    r = simulate(client, "tsunami", origin, {"lat": 47.60, "lng": -122.37}, size=15000, params={"scenario": "cascadia"})
    d = r.json()
    assert r.status_code == 200, r.text
    assert d["userStatus"] in ("inside_severe", "inside_moderate")
    assert d["action"] == "go_to_high_ground"
    dest = d["destination"].get("place") or d["destination"]["area"]
    assert slope[terrain.cell_at(dest["lat"], dest["lng"])] > slope[terrain.cell_at(origin["lat"], origin["lng"])] + 5
    assert d["scenario"]["details"]["firstWaveMin"] == 90
    assert len(d["growth"]) >= 2


def test_flood_uses_terrain(client, router, slope):
    origin = {"lat": 47.60, "lng": -122.357}
    r = simulate(client, "flood", origin, {"lat": 47.60, "lng": -122.355}, size=3000, params={"depthM": 4})
    d = r.json()
    assert r.status_code == 200, r.text
    assert "Terrain" in " ".join(d["scenario"]["sources"])
    assert d["userStatus"] == "inside_severe"
    area = d["destination"].get("area") or {}
    dest = d["destination"].get("place") or area
    assert slope[terrain.cell_at(dest["lat"], dest["lng"])] > slope[terrain.cell_at(origin["lat"], origin["lng"])]
    assert any("flood water" in s for s in d["guidance"])


def test_wildfire_destination_is_not_downwind(client, router):
    event = {"lat": 47.6610, "lng": -122.4150}
    r = simulate(client, "wildfire", {"lat": 47.6575, "lng": -122.4000}, event, size=400,
                 params={"windDeg": 250, "windKmh": 30})
    d = r.json()
    assert r.status_code == 200, r.text
    assert d["action"] == "evacuate"
    dest = d["destination"].get("place") or d["destination"]["area"]
    toward = geometry.bearing(event["lat"], event["lng"], dest["lat"], dest["lng"])
    assert geometry.angle_diff(toward, 70) >= 50
    assert [g["tMinutes"] for g in d["growth"]] == [0, 15, 30, 60]


def test_hazmat_shelters_in_place_in_moderate_zone(client, router):
    event = {"lat": 47.575, "lng": -122.335}
    downwind = geometry.move(event["lat"], event["lng"], 20, 3500)  # wind from 200 deg blows toward 20 deg
    r = simulate(client, "hazmat", {"lat": downwind[0], "lng": downwind[1]}, event, size=400,
                 params={"windDeg": 200, "windKmh": 15})
    d = r.json()
    assert r.status_code == 200, r.text
    assert d["userStatus"] == "inside_moderate"
    assert d["action"] == "shelter_in_place"
    assert any("If you are told to evacuate" in s for s in d["guidance"])


@pytest.mark.parametrize("hazard", ["storm", "heat", "winter", "air_quality", "volcano", "crime", "other"])
def test_every_other_hazard_runs(client, router, hazard):
    r = simulate(client, hazard, DOWNTOWN, {"lat": 47.612, "lng": -122.335}, params={"windDeg": 180, "windKmh": 20})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["affected"]["features"] and d["guidance"] and d["timeline"]
    assert d["userStatus"] in ("inside_severe", "inside_moderate", "outside")


# ---- Routing choice and fallbacks ----

def test_route_with_least_danger_wins(client, monkeypatch):
    event = (47.6105, -122.3420)
    detour = (47.6400, -122.3550)

    def candidates(origin, dest, mode, exclude):
        return [fake_trip(origin, dest, via=event), fake_trip(origin, dest, via=detour)]

    monkeypatch.setattr(routing, "candidates", candidates)
    r = simulate(client, "conflict", {"lat": 47.6105, "lng": -122.3550}, {"lat": event[0], "lng": event[1]}, size=300)
    d = r.json()
    assert r.status_code == 200, r.text
    route = d["route"]
    assert route["candidates"] == 2
    assert [detour[1], detour[0]] in route["geometry"]["coordinates"]  # the detour, not the shortcut through the target
    assert route["dangerM"]["severe"] < 600


def test_osrm_fallback_when_valhalla_is_down(client, monkeypatch):
    r_ = Router(valhalla_ok=False)
    monkeypatch.setattr(routing, "valhalla", r_.valhalla)
    monkeypatch.setattr(routing, "osrm", r_.osrm)
    r = simulate(client, "conflict", DOWNTOWN, {"lat": 47.6105, "lng": -122.3370}, mode="drive")
    assert r.status_code == 200, r.text
    assert r.json()["route"]["engine"] == "osrm" and r_.osrm_calls == 1
    assert r_.valhalla_calls[0]["mode"] == "drive"


def test_straight_line_when_no_router_answers(client, monkeypatch):
    r_ = Router(valhalla_ok=False, osrm_ok=False)
    monkeypatch.setattr(routing, "valhalla", r_.valhalla)
    monkeypatch.setattr(routing, "osrm", r_.osrm)
    r = simulate(client, "conflict", DOWNTOWN, {"lat": 47.6105, "lng": -122.3370})
    assert r.status_code == 200, r.text
    route = r.json()["route"]
    assert route["engine"] == "straight_line" and len(route["geometry"]["coordinates"]) == 2


# ---- Validation ----

@pytest.mark.parametrize("body, message", [
    ({"hazard": "meteor"}, "unknown hazard"),
    ({"origin": {"lat": 40.71, "lng": -74.0}}, "Seattle"),
    ({"event": {"lat": 47.61, "lng": -125.0}}, "Seattle"),
    ({"event": {"lat": 47.61, "lng": -122.33, "size": 12}}, "magnitude"),
    ({"hazard": "wildfire", "event": {"lat": 47.61, "lng": -122.33, "size": 5}}, "radius"),
])
def test_bad_requests(client, router, body, message):
    base = {"hazard": "earthquake", "origin": DOWNTOWN, "event": {"lat": 47.6, "lng": -122.34}, "mode": "walk"}
    r = client.post("/api/simulate", json={**base, **body})
    assert r.status_code == 422
    assert message in r.json()["detail"]


@pytest.mark.parametrize("patch", [
    {"mode": "fly"}, {"extra": 1}, {"event": {"lat": 47.6, "lng": -122.34, "params": {"windDeg": 400}}},
    {"event": {"lat": 47.6, "lng": -122.34, "params": {"name": "x"}}}, {"origin": {"lat": 95, "lng": 0}},
])
def test_schema_errors(client, router, patch):
    base = {"hazard": "earthquake", "origin": DOWNTOWN, "event": {"lat": 47.6, "lng": -122.34}}
    assert client.post("/api/simulate", json={**base, **patch}).status_code == 422


def test_coordinates_are_not_logged(client, router, caplog):
    caplog.set_level(logging.DEBUG)
    simulate(client, "conflict", {"lat": 47.61234, "lng": -122.33456}, {"lat": 47.6105, "lng": -122.3370})
    assert "47.61234" not in caplog.text and "122.33456" not in caplog.text


# ---- Units ----

def test_decode_polyline():
    # Valhalla precision-6 encoding of (47.6, -122.3) -> (47.6001, -122.3002).
    def enc(v):
        v = ~(v << 1) if v < 0 else v << 1
        out = ""
        while v >= 0x20:
            out += chr((0x20 | (v & 0x1F)) + 63)
            v >>= 5
        return out + chr(v + 63)

    pts = [(47.6, -122.3), (47.6001, -122.3002)]
    s, plat, plng = "", 0, 0
    for lat, lng in pts:
        ilat, ilng = round(lat * 1e6), round(lng * 1e6)
        s += enc(ilat - plat) + enc(ilng - plng)
        plat, plng = ilat, ilng
    assert routing.decode_polyline(s) == [[-122.3, 47.6], [-122.3002, 47.6001]]


def test_valhalla_response_parsing(monkeypatch):
    shape = "_izlhA~rlgdF_{geC~ywl@"  # Google's sample polyline in precision 6 scale is fine for parsing
    monkeypatch.setattr("app.simulation.net.fetch_json", lambda url, timeout, body: {
        "trip": {"summary": {"length": 1.5, "time": 1100},
                 "legs": [{"shape": shape, "maneuvers": [{"instruction": "Walk north on 1st Avenue.", "length": 1.5}]}]},
        "alternates": [{"trip": {"summary": {"length": 2.0, "time": 1500},
                                 "legs": [{"shape": shape, "maneuvers": []}]}}]})
    out = routing.valhalla((47.6, -122.3), (47.61, -122.31), "walk", alternates=1)
    assert len(out) == 2 and out[0]["distanceM"] == 1500 and out[0]["durationS"] == 1100
    assert out[0]["steps"] == [{"instruction": "Walk north on 1st Avenue.", "distanceM": 1500}]


def test_shapes():
    c = geometry.circle(47.6, -122.33, 1000)
    ring = c["coordinates"][0]
    assert ring[0] == ring[-1]
    assert all(abs(geometry.meters(47.6, -122.33, p[1], p[0]) - 1000) < 5 for p in ring)
    e = geometry.ellipse(47.6, -122.33, 2000, 500, 90, center_offset_m=1000)  # pointing east
    lngs = [p[0] for p in e["coordinates"][0]]
    assert max(lngs) > -122.33 + 0.035 and min(lngs) > -122.33 - 0.02
    p = geometry.plume(47.6, -122.33, 300, 4000, 900, 0)  # pointing north
    lats = [q[1] for q in p["coordinates"][0]]
    assert max(lats) > 47.6 + 0.035 and min(lats) < 47.6


def test_png_decoder_without_pillow(monkeypatch):
    import builtins

    real_import = builtins.__import__

    def no_pil(name, *args, **kwargs):
        if name == "PIL":
            raise ImportError
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_pil)
    width, height = 3, 2
    rows = [bytes([128, 0, 0] * width), bytes([128, 10, 128] * width)]
    raw = b"\x00" + rows[0] + b"\x02" + bytes((a - b) & 0xFF for a, b in zip(rows[1], rows[0]))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
    w, h, bpp, out = terrain.decode_png(png)
    assert (w, h, bpp) == (3, 2, 3)
    r, g, b = out[1][0:3]
    assert r * 256 + g + b / 256 - 32768 == 10.5  # terrarium: 10.5 m


def test_grid_helpers():
    assert terrain.cell_at(*terrain.cell_center(4321)) == 4321
    assert terrain.cell_at(10, 10) is None
    assert models.near_cells([100, 105, 900], [101], rows=1, cols=1) == [100]
    assert math.isclose(geometry.angle_diff(350, 10), 20)
