"""Safe places API. Integration tests against the local Postgres with Seattle loaded:

    python pipeline/import_safe_places.py --seattle-official
"""

from __future__ import annotations

import importlib.util
import logging
import math
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.hazard_taxonomy import HAZARD_KEYS, HAZARDS
from app.main import app
from app.privacy import RedactLocation
from app.routers.safe_places import KIND_LABELS, PREFERRED_RADIUS_M

SEATTLE_BBOX = "-122.46,47.48,-122.22,47.75"
DOWNTOWN = {"lat": 47.6097, "lng": -122.3331}
PROPERTY_KEYS = {"id", "name", "kind", "kindLabel", "address", "phone", "openingHours", "source"}
PLACE_KEYS = {"id", "name", "kind", "kindLabel", "lat", "lng", "distanceM", "address", "phone",
              "openingHours", "source"}


@pytest.fixture(scope="module")
def client():
    try:
        with TestClient(app) as c:
            yield c
    except Exception as exc:  # pool could not connect
        pytest.skip(f"database not available: {exc}")


@pytest.fixture(scope="module")
def guidance(client):
    return {h["key"]: h["placeKinds"] for h in client.get("/api/hazards").json()["hazards"]}


def meters(lat1, lng1, lat2, lng2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2
    return 2 * 6_371_008.8 * math.asin(math.sqrt(a))


# ---- /api/hazards ------------------------------------------------------------

def test_hazards_cover_every_key(client):
    body = client.get("/api/hazards").json()
    hazards = body["hazards"]
    assert [h["key"] for h in hazards] == list(HAZARD_KEYS)
    for h in hazards:
        assert h["label"] == HAZARDS[h["key"]]["label"]
        assert h["placeKinds"], h["key"]
        assert set(h["placeKinds"]) <= set(KIND_LABELS)


def test_hazard_guidance(guidance):
    assert guidance["conflict"][:3] == ["bomb_shelter", "bunker", "shelter"]
    assert guidance["earthquake"][:2] == ["assembly_point", "emergency_hub"]
    assert guidance["crime"][0] == "police"
    assert guidance["hazmat"][0] == "shelter"


# ---- /api/safe-places --------------------------------------------------------

def test_safe_places_in_box(client):
    response = client.get("/api/safe-places", params={"bbox": SEATTLE_BBOX})
    assert response.status_code == 200
    body = response.json()
    assert body["type"] == "FeatureCollection" and body["truncated"] is False
    features = body["features"]
    assert len(features) > 200
    kinds = set()
    for f in features:
        lng, lat = f["geometry"]["coordinates"]
        assert 47.48 <= lat <= 47.75 and -122.46 <= lng <= -122.22
        props = f["properties"]
        assert set(props) == PROPERTY_KEYS
        assert props["kindLabel"] == KIND_LABELS[props["kind"]] and props["name"]
        kinds.add(props["kind"])
    assert {"emergency_hub", "hospital", "police", "fire_station", "community_centre"} <= kinds


def test_safe_places_kind_filter(client):
    everything = len(client.get("/api/safe-places", params={"bbox": SEATTLE_BBOX}).json()["features"])
    body = client.get("/api/safe-places", params={"bbox": SEATTLE_BBOX, "kinds": "police,hospital"}).json()
    kinds = {f["properties"]["kind"] for f in body["features"]}
    assert kinds == {"police", "hospital"}
    assert 0 < len(body["features"]) < everything


def test_safe_places_empty_box(client):
    body = client.get("/api/safe-places", params={"bbox": "-150.1,10.0,-150.0,10.1"}).json()
    assert body == {"type": "FeatureCollection", "truncated": False, "features": []}


def test_osm_duplicates_of_official_places_are_hidden(client):
    features = client.get("/api/safe-places", params={"bbox": SEATTLE_BBOX, "kinds": "hospital"}).json()["features"]
    official = [f for f in features if f["properties"]["source"] != "osm"]
    for f in features:
        if f["properties"]["source"] == "osm":
            lng, lat = f["geometry"]["coordinates"]
            assert all(meters(lat, lng, o["geometry"]["coordinates"][1], o["geometry"]["coordinates"][0]) > 140
                       for o in official)


# ---- /api/safe-places/nearest ----------------------------------------------

def assert_rank_then_distance(places, kinds):
    near = [p for p in places if p["distanceM"] <= PREFERRED_RADIUS_M]
    far = places[len(near):]
    assert all(p["distanceM"] > PREFERRED_RADIUS_M for p in far), "close places come first"
    keys = [(kinds.index(p["kind"]), p["distanceM"]) for p in near]
    assert keys == sorted(keys)
    assert [p["distanceM"] for p in far] == sorted(p["distanceM"] for p in far)


@pytest.mark.parametrize("hazard", ["earthquake", "crime", "heat", "conflict", "flood", "other"])
def test_nearest_orders_by_rank_then_distance(client, guidance, hazard):
    response = client.get("/api/safe-places/nearest", params={**DOWNTOWN, "hazard": hazard, "limit": 10})
    assert response.status_code == 200
    body = response.json()
    assert body["hazard"] == hazard
    places = body["places"]
    assert len(places) == 10
    assert all(set(p) == PLACE_KEYS and p["kind"] in guidance[hazard] for p in places)
    assert_rank_then_distance(places, guidance[hazard])


def test_nearest_crime_goes_to_police(client):
    places = client.get("/api/safe-places/nearest", params={**DOWNTOWN, "hazard": "crime"}).json()["places"]
    assert len(places) == 5
    assert places[0]["kind"] == "police" and places[0]["distanceM"] < 2000


def test_nearest_distance_is_straight_line(client):
    places = client.get("/api/safe-places/nearest", params={**DOWNTOWN, "limit": 3}).json()["places"]
    for p in places:
        assert p["distanceM"] == pytest.approx(meters(DOWNTOWN["lat"], DOWNTOWN["lng"], p["lat"], p["lng"]),
                                               rel=0.01, abs=2)


def test_nearest_without_hazard_is_by_distance(client):
    body = client.get("/api/safe-places/nearest", params={**DOWNTOWN, "limit": 20}).json()
    assert body["hazard"] is None
    distances = [p["distanceM"] for p in body["places"]]
    assert len(distances) == 20 and distances == sorted(distances)
    assert len({p["kind"] for p in body["places"]}) > 1


def test_nearest_falls_back_when_nothing_is_close(client, guidance):
    # Open Pacific: no preferred place within a few km, so the nearest of any listed kind.
    body = client.get("/api/safe-places/nearest", params={"lat": 47.0, "lng": -130.0, "hazard": "conflict",
                                                          "limit": 4}).json()
    places = body["places"]
    assert len(places) == 4
    assert all(p["distanceM"] > PREFERRED_RADIUS_M for p in places)
    assert [p["distanceM"] for p in places] == sorted(p["distanceM"] for p in places)
    assert {p["kind"] for p in places} <= set(guidance["conflict"])


def test_nearest_is_not_cached(client):
    response = client.get("/api/safe-places/nearest", params=DOWNTOWN)
    assert response.headers["cache-control"] == "no-store"


def test_access_log_drops_coordinates():
    record = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, '%s - "%s %s HTTP/%s" %d',
                               ("127.0.0.1:5000", "GET", "/api/safe-places/nearest?lat=47.6&lng=-122.3",
                                "1.1", 200), None)
    assert RedactLocation().filter(record)
    assert "47.6" not in record.getMessage() and "/api/safe-places/nearest" in record.getMessage()
    other = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, '%s - "%s %s HTTP/%s" %d',
                              ("127.0.0.1:5000", "GET", "/api/heatmap?band=night", "1.1", 200), None)
    RedactLocation().filter(other)
    assert "band=night" in other.getMessage()


@pytest.mark.parametrize("url", [
    "/api/safe-places",
    "/api/safe-places?bbox=1,2,3",
    "/api/safe-places?bbox=a,b,c,d",
    "/api/safe-places?bbox=3,2,1,4",
    "/api/safe-places?bbox=-122.4,47.6,-122.3,95",
    f"/api/safe-places?bbox={SEATTLE_BBOX}&kinds=castle",
    "/api/safe-places/nearest?lng=-122.3",
    "/api/safe-places/nearest?lat=91&lng=-122.3",
    "/api/safe-places/nearest?lat=47.6&lng=-181",
    "/api/safe-places/nearest?lat=nan&lng=-122.3",
    "/api/safe-places/nearest?lat=47.6&lng=-122.3&hazard=zombies",
    "/api/safe-places/nearest?lat=47.6&lng=-122.3&limit=0",
    "/api/safe-places/nearest?lat=47.6&lng=-122.3&limit=21",
])
def test_bad_parameters(client, url):
    assert client.get(url).status_code == 422


# ---- importer: OSM tag rules ---------------------------------------------------

def load_importer():
    path = Path(__file__).resolve().parents[3] / "pipeline" / "import_safe_places.py"
    spec = importlib.util.spec_from_file_location("import_safe_places", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("tags, kind", [
    ({"amenity": "hospital", "emergency": "yes"}, "hospital"),
    ({"amenity": "hospital", "emergency": "no"}, None),
    ({"amenity": "police"}, "police"),
    ({"amenity": "fire_station"}, "fire_station"),
    ({"amenity": "community_centre"}, "community_centre"),
    ({"emergency": "assembly_point"}, "assembly_point"),
    ({"amenity": "shelter", "shelter_type": "bomb_shelter"}, "bomb_shelter"),
    ({"amenity": "shelter", "shelter_type": "bomb_shelter", "access": "private"}, None),
    ({"amenity": "shelter", "shelter_type": "public_transport"}, None),
    ({"amenity": "shelter", "shelter_type": "picnic_shelter"}, None),
    ({"amenity": "shelter", "shelter_type": "gazebo"}, None),
    ({"amenity": "shelter"}, None),
    ({"military": "bunker"}, None),
    ({"building": "bunker", "access": "yes"}, "bunker"),
    ({"amenity": "social_facility", "social_facility": "shelter"}, "shelter"),
    ({"emergency": "shelter"}, "shelter"),
])
def test_osm_classification(tags, kind):
    assert load_importer().classify_osm(tags) == kind


def test_osm_rows_use_way_centers():
    rows = load_importer().osm_rows([
        {"type": "way", "id": 7, "center": {"lat": 47.6, "lon": -122.3},
         "tags": {"amenity": "hospital", "name": "General", "addr:housenumber": "1", "addr:street": "Main St",
                  "addr:city": "Seattle", "capacity": "120 beds"}},
        {"type": "node", "id": 8, "lat": 47.61, "lon": -122.31, "tags": {"amenity": "shelter"}},
    ])
    assert len(rows) == 1
    row = rows[0]
    assert (row["source_ref"], row["kind"], row["lat"], row["lng"]) == ("way/7", "hospital", 47.6, -122.3)
    assert row["address"] == "1 Main St, Seattle" and row["capacity"] == 120
