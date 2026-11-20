"""Hazard outlook: source parsers on saved payloads, exposure scoring, and the API.

Fixtures in tests/fixtures/outlook/ were saved from the live sources on 2026-11-20;
the EONET and GDACS ones have coordinates and dates adapted so every rule is exercised.
The endpoint tests run against the local Postgres after:

    python pipeline/import_hazard_zones.py
    python pipeline/outlook_worker.py --once
"""

from __future__ import annotations

import copy
import importlib.util
import json
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.hazard_taxonomy import HAZARDS
from app.main import app
from app.routers.outlook import SCORED_HAZARDS, _RedactPointQuery, cell_for

ROOT = Path(__file__).resolve().parents[3]
FIX = Path(__file__).resolve().parent / "fixtures" / "outlook"
NOW = datetime(2026, 11, 20, 3, 0, tzinfo=timezone.utc)
BBOX = (-122.46, 47.48, -122.22, 47.75)
DOWNTOWN = {"lat": 47.6097, "lng": -122.3331}
ALKI = {"lat": 47.5790, "lng": -122.4090}       # low beach, tsunami zone
QUEEN_ANNE = {"lat": 47.6370, "lng": -122.3570}  # hilltop, ~120 m


def load(name: str):
    path = ROOT / "pipeline" / f"{name}.py"
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


src = load("outlook_sources")
scoring = load("hazard_scoring")


def fixture(name: str):
    return json.loads((FIX / name).read_text())


def assert_item(it: dict):
    assert it["hazard"] in HAZARDS
    assert it["level"] in ("watch", "likely", "imminent")
    assert it["confidence"] in ("low", "medium", "high")
    assert it["valid_to"] > it["valid_from"] or it["valid_to"] >= NOW
    assert it["sources"] and all(s["url"].startswith("http") for s in it["sources"])
    assert it["geometry"]["type"] in ("Polygon", "MultiPolygon")
    assert it["id"].startswith(it["source"] + ":")


# ---- parsers ----------------------------------------------------------------------

def test_eonet_rules():
    items = {it["id"]: it for it in src.parse_eonet(fixture("eonet.json"), BBOX, NOW)}
    for it in items.values():
        assert_item(it)
    assert items["nasa-eonet:EONET_T1"]["level"] == "watch"          # wildfire ~15 km away
    assert items["nasa-eonet:EONET_T6"]["level"] == "imminent"       # wildfire inside the area
    assert items["nasa-eonet:EONET_T4"]["hazard"] == "volcano"       # Rainier, ~90 km: ash possible
    assert "nasa-eonet:EONET_T2" not in items                        # prescribed fire skipped
    assert "nasa-eonet:EONET_T3" not in items                        # too far
    assert "nasa-eonet:EONET_T5" not in items                        # stale (August)


def test_gdacs_keeps_only_near_events():
    items = src.parse_gdacs(fixture("gdacs.json"), BBOX, NOW)
    assert [it["id"] for it in items] == ["gdacs:FL999001"]
    assert items[0]["hazard"] == "flood" and items[0]["level"] == "watch"


def test_nws_watches_and_future_alerts():
    items = src.parse_nws_alerts(fixture("nws_alerts.json"), BBOX, NOW)
    by_event = {it["title"]: it for it in items}
    for it in items:
        assert_item(it)
    assert by_event["Flood Watch"]["level"] == "watch" and by_event["Flood Watch"]["hazard"] == "flood"
    assert by_event["Wind Advisory"]["level"] == "likely" and by_event["Wind Advisory"]["hazard"] == "storm"
    assert by_event["Winter Storm Warning"]["level"] == "imminent"
    assert "Small Craft Advisory" not in by_event                    # marine zones only
    assert len([t for t in by_event if t == "Flood Warning"]) == 1   # the Immediate one is left to the alerts feed
    assert by_event["Flood Watch"]["affected_zones"]                 # no polygon: zone geometries fetched later
    assert by_event["Flood Warning"]["affected_zones"] == []         # has its own polygon


def test_nws_level_rules():
    soon, later = NOW + timedelta(hours=2), NOW + timedelta(hours=30)
    assert src.nws_level("Flood Watch", "Future", later, NOW) == "watch"
    assert src.nws_level("Heat Advisory", "Expected", later, NOW) == "likely"
    assert src.nws_level("High Wind Warning", "Expected", soon, NOW) == "imminent"
    assert src.nws_level("High Wind Warning", "Future", later, NOW) == "likely"
    assert src.nws_level("Tornado Warning", "Immediate", soon, NOW) is None


def test_nwps_flood_stage_rules():
    gauge, flow = fixture("nwps_gauge.json"), fixture("nwps_stageflow.json")
    assert src.flood_categories(gauge) == {"major": 16.0, "moderate": 14.5, "minor": 13.0, "action": 10.4}
    assert src.parse_nwps(gauge, flow, NOW) == []                    # 8.6 ft, well below action stage
    rising = copy.deepcopy(flow)
    for i, d in enumerate(rising["forecast"]["data"]):
        d["primary"] = 9.0 + i * 0.4                                  # crosses 13 ft after ~60 h
    items = src.parse_nwps(gauge, rising, NOW)
    assert len(items) == 1 and items[0]["level"] == "likely" and items[0]["zones"] == ["flood_zone"]
    assert "Flood stage (minor) is 13.0 ft" in items[0]["summary"]
    flooding = copy.deepcopy(flow)
    flooding["observed"]["data"][-1]["primary"] = 14.8
    assert src.parse_nwps(gauge, flooding, NOW)[0]["level"] == "imminent"


def _meteo(mutate) -> list[dict]:
    points = copy.deepcopy(fixture("open_meteo.json"))
    for p in points:
        h = p["hourly"]
        times = src._hours(h)
        for i, t in enumerate(times):
            if NOW <= t <= NOW + timedelta(hours=72):
                mutate(h, i, t)
    return points


BOXES = [(-122.46, 47.48, -122.34, 47.615), (-122.34, 47.615, -122.22, 47.75)]


def test_open_meteo_quiet_weather_gives_nothing():
    assert src.parse_open_meteo(fixture("open_meteo.json"), BOXES, BBOX, NOW) == []


def test_open_meteo_heat_and_wind_thresholds():
    def hot_windy(h, i, t):
        if t == NOW + timedelta(hours=20):
            h["apparent_temperature"][i] = 96.0
            h["wind_gusts_10m"][i] = 61.0
    items = {it["id"]: it for it in src.parse_open_meteo(_meteo(hot_windy), BOXES, BBOX, NOW)}
    assert items["open-meteo:heat"]["level"] == "watch" and items["open-meteo:heat"]["confidence"] == "low"
    assert items["open-meteo:wind"]["level"] == "likely"             # 58+ mph gusts: High Wind Warning criteria
    assert items["open-meteo:wind"]["hazard"] == "storm"


def test_landslide_threshold():
    def soaking(h, i, t):
        h["precipitation"][i] = 1.0                                   # 24 mm/day for three days
    items = {it["id"]: it for it in src.parse_open_meteo(_meteo(soaking), BOXES, BBOX, NOW)}
    slide = items["open-meteo:landslide"]
    assert slide["hazard"] == "flood" and slide["zones"] == ["landslide"]
    assert slide["level"] == "watch"                                  # cumulative threshold only
    assert "P3 >= 3.5 - 0.67 x P15" in slide["summary"]


def test_landslide_check_math():
    start = NOW - timedelta(hours=18 * 24)
    times = [start + timedelta(hours=i) for i in range(21 * 24)]
    dry = [0.0] * len(times)
    assert src.landslide_check(times, dry, NOW) is None
    burst = dry.copy()
    k = times.index(NOW + timedelta(hours=10))
    for i in range(k - 5, k + 1):
        burst[i] = 20.0                                               # 120 mm in 6 h
    res = src.landslide_check(times, burst, NOW)
    assert res["level"] == "likely" and res["id_hours"] is not None


def test_air_quality_categories():
    assert src.parse_air_quality([fixture("open_meteo_air.json")], [BBOX], NOW) == []
    smoky = copy.deepcopy(fixture("open_meteo_air.json"))
    smoky["hourly"]["pm2_5"] = [60.0] * len(smoky["hourly"]["pm2_5"])
    items = src.parse_air_quality([smoky], [BBOX], datetime(2026, 11, 20, 0, 0, tzinfo=timezone.utc))
    assert items[0]["level"] == "likely" and "Unhealthy" in items[0]["title"]
    assert src.pm25_category(9.0) == "Good" and src.pm25_category(35.5) == "Unhealthy for Sensitive Groups"


def test_spc_and_ero():
    assert src.parse_spc(fixture("spc_day1.json"), 1, NOW) == []     # general thunder only
    slight = copy.deepcopy(fixture("spc_day1.json"))
    slight["features"][0]["properties"].update({"LABEL": "SLGT", "LABEL2": "Slight Risk"})
    assert src.parse_spc(slight, 1, NOW)[0]["level"] == "watch"
    ero = src.parse_ero(fixture("ero_day1.json"), 1, NOW)
    assert {it["id"].split("-")[-1] for it in ero} == {"marginal", "slight", "moderate", "high"}
    best = src.most_serious_per_group(ero)
    assert [it["id"] for it in best] == ["noaa-wpc-ero:day1-high"] and best[0]["level"] == "likely"


def test_tsunami_feed():
    entries = src.parse_tsunami_atom((FIX / "tsunami_paaq.xml").read_bytes())
    assert entries[0]["category"] == "Information" and entries[0]["no_threat"]
    assert src.tsunami_items(entries, {e["id"]: True for e in entries}, BBOX, NOW) == []
    warning = dict(entries[0], category="Warning", no_threat=False, updated=NOW - timedelta(minutes=10))
    items = src.tsunami_items([warning], {warning["id"]: True}, BBOX, NOW)
    assert items[0]["level"] == "imminent" and items[0]["zones"] == ["tsunami_inundation"]
    assert src.tsunami_items([warning], {warning["id"]: False}, BBOX, NOW) == []
    cap = "<alert><info><area><areaDesc>Coastal areas of Washington and Puget Sound</areaDesc></area></info></alert>"
    assert src.cap_mentions_region(cap)
    assert not src.cap_mentions_region("<alert><area><areaDesc>Kodiak Island, Alaska</areaDesc></area></alert>")


def test_earthquakes_are_never_forecast():
    assert src.parse_usgs_quakes(fixture("usgs_quakes.json"), BBOX, NOW) == []   # all far away
    near = copy.deepcopy(fixture("usgs_quakes.json"))
    f = near["features"][0]
    f["geometry"]["coordinates"][:2] = [-122.5, 47.4]
    f["properties"].update({"mag": 5.4, "time": int((NOW - timedelta(hours=6)).timestamp() * 1000)})
    items = src.parse_usgs_quakes(near, BBOX, NOW)
    assert len(items) == 1 and items[0]["level"] == "watch"
    assert "cannot be predicted" in items[0]["summary"] and "Aftershocks possible" in items[0]["title"]
    small = copy.deepcopy(near)
    small["features"][0]["properties"]["mag"] = 4.2
    assert src.parse_usgs_quakes(small, BBOX, NOW) == []


def test_firms_csv():
    head = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight"
    rows = ["47.60,-122.30,330.1,0.4,0.4,2026-11-19,2115,N20,VIIRS,n,2.0NRT,290.1,5.2,N",
            "47.61,-122.31,301.0,0.4,0.4,2026-11-19,2115,N20,VIIRS,l,2.0NRT,280.0,1.0,N",
            "45.00,-118.00,330.1,0.4,0.4,2026-11-19,2115,N20,VIIRS,h,2.0NRT,290.1,5.2,N"]
    items = src.parse_firms_csv("\n".join([head, *rows]), BBOX, NOW)
    assert len(items) == 1 and items[0]["level"] == "likely" and "1 active-fire" in items[0]["summary"]
    assert src.parse_firms_csv(head + "\n", BBOX, NOW) == []


# ---- exposure scoring ---------------------------------------------------------------

def test_zone_factor_is_cumulative_and_capped():
    assert scoring.zone_factor(1, 1, 1) == 1
    assert scoring.zone_factor(0, 0, 0) == 0
    assert scoring.zone_factor(0, 1, 1) == pytest.approx(0.6)
    assert scoring.zone_factor(0, 0, 1) == pytest.approx(0.3)
    assert scoring.zone_factor(0.5, 0.5, 1) == pytest.approx(0.5 + 0.3 * 0.5)


def test_exposure_formula():
    worst = scoring.exposure("tsunami", 1, 1, 1, elev_m=0, slope_deg=0, zone_dist_m=0, place_dist_m=5000)
    assert worst["score"] == 100 and worst["level"] == "high"
    clear = scoring.exposure("tsunami", 0, 0, 0, elev_m=2, slope_deg=0, zone_dist_m=5000, place_dist_m=5000)
    assert clear["score"] == 0 and clear["level"] == "low"     # low ground far from any zone does not count
    edge = scoring.exposure("tsunami", 0, 0, 0, elev_m=2, slope_deg=0, zone_dist_m=200, place_dist_m=0)
    assert edge["factors"]["lowland"] == pytest.approx(0.9) and edge["score"] == round(100 * 0.25 * 0.9 * 0.85)
    steep = scoring.exposure("earthquake", 0, 0, 0, elev_m=80, slope_deg=30, zone_dist_m=None, place_dist_m=0)
    assert steep["factors"]["slope"] == 1 and steep["score"] == round(100 * 0.25 * 0.85)
    near_shelter = scoring.exposure("flood", 1, 1, 1, elev_m=0, slope_deg=0, zone_dist_m=0, place_dist_m=0)
    assert near_shelter["score"] == 85 and set(near_shelter["factors"]) >= {"zone", "terrain", "access"}


def test_factor_shapes():
    assert scoring.lowland_factor(0) == 1 and scoring.lowland_factor(25) == 0 and scoring.lowland_factor(None) == 0
    assert scoring.slope_factor(5) == 0 and scoring.slope_factor(20) == pytest.approx(0.5)
    assert scoring.zone_gate(400) == 1 and scoring.zone_gate(750) == pytest.approx(0.5) and scoring.zone_gate(None) == 0
    assert scoring.access_factor(1500) == pytest.approx(0.5) and scoring.access_factor(None) == 1
    assert [scoring.level_for(s) for s in (0, 19, 20, 49, 50, 100)] == ["low", "low", "moderate", "moderate", "high", "high"]


# ---- API ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def client():
    try:
        with TestClient(app) as c:
            yield c
    except Exception as exc:  # pool could not connect
        pytest.skip(f"database not available: {exc}")


@pytest.fixture(scope="module")
def loaded(client):
    from app.db import pool
    with pool.connection() as conn:
        try:
            n = conn.execute("SELECT count(*) FROM cell_hazard_exposure").fetchone()[0]
        except Exception:
            n = 0
    if not n:
        pytest.skip("hazard zones not imported (python pipeline/import_hazard_zones.py)")
    return True


def test_cell_for():
    assert cell_for(47.481, -122.459) == 0
    assert cell_for(47.749, -122.221) == 134 * 100 + 79
    assert cell_for(40.0, -122.3) is None


def test_outlook_point(client, loaded):
    r = client.get("/api/outlook", params=DOWNTOWN)
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    body = r.json()
    assert set(body) == {"location", "outlook", "updatedAt", "disclaimer"}
    assert body["location"]["inRegion"] and "cannot be predicted" in body["disclaimer"]
    rank = {"watch": 1, "likely": 2, "imminent": 3}
    levels = [rank[i["level"]] for i in body["outlook"]]
    assert levels == sorted(levels, reverse=True)
    for i in body["outlook"]:
        assert set(i) == {"id", "hazard", "hazardLabel", "level", "title", "summary", "validFrom", "validTo",
                          "confidence", "sources", "distanceKm"}
        assert i["distanceKm"] <= 25 and all(set(s) == {"name", "url", "observed"} for s in i["sources"])
    assert {e["hazard"] for e in body["location"]["exposure"]} == set(SCORED_HAZARDS)


def test_outlook_point_validation(client):
    assert client.get("/api/outlook", params={"lat": 95, "lng": 0}).status_code == 422
    assert client.get("/api/outlook").status_code == 422


def test_outlook_areas_and_sources(client, loaded):
    areas = client.get("/api/outlook/areas", params={"bbox": "-122.46,47.48,-122.22,47.75"}).json()
    assert areas["type"] == "FeatureCollection"
    for f in areas["features"]:
        assert f["geometry"]["type"] == "MultiPolygon" and f["properties"]["level"] in ("watch", "likely", "imminent")
    sources = client.get("/api/outlook/sources").json()["sources"]
    keys = {s["key"] for s in sources}
    assert {"fema-nfhl", "seattle-tsunami-seattle-fault", "aws-terrain-tiles"} <= keys
    for s in sources:
        assert s["license"] and s["status"] in ("ok", "error", "skipped", "never")


def test_hazard_zones(client, loaded):
    body = client.get("/api/hazard-zones", params={"hazard": "tsunami", "bbox": "-122.46,47.48,-122.22,47.75"}).json()
    assert body["features"]
    for f in body["features"]:
        assert {"id", "hazard", "level", "name", "source"} <= set(f["properties"])
        assert f["properties"]["hazard"] == "tsunami" and f["properties"]["level"] in ("high", "moderate", "low")
    quake = client.get("/api/hazard-zones", params={"hazard": "earthquake", "kind": "liquefaction"}).json()
    assert quake["features"] and {f["properties"]["kind"] for f in quake["features"]} == {"liquefaction"}
    assert client.get("/api/hazard-zones", params={"hazard": "nope"}).status_code == 422


def test_hazard_grid(client, loaded):
    body = client.get("/api/hazard-grid", params={"hazard": "tsunami"}).json()
    assert body["hazard"] == "tsunami" and len(body["features"]) > 5000
    levels = {f["properties"]["level"] for f in body["features"]}
    assert levels <= {"high", "moderate", "low"} and "high" in levels and "low" in levels
    p = body["features"][0]["properties"]
    assert set(p) == {"cellId", "score", "level", "factors"} and 0 <= p["score"] <= 100
    assert client.get("/api/hazard-grid", params={"hazard": "heat"}).status_code == 422
    assert client.get("/api/hazard-grid").status_code == 422


def test_beach_worse_than_hilltop(client, loaded):
    beach = client.get("/api/outlook", params=ALKI).json()["location"]["exposure"]
    hill = client.get("/api/outlook", params=QUEEN_ANNE).json()["location"]["exposure"]
    score = lambda xs, h: next(x["score"] for x in xs if x["hazard"] == h)
    assert score(beach, "tsunami") > score(hill, "tsunami")
    assert score(hill, "tsunami") == 0


def test_safe_areas_tsunami(client, loaded):
    r = client.get("/api/safe-areas", params={**ALKI, "hazard": "tsunami", "limit": 3})
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    body = r.json()
    assert body["hazard"] == "tsunami" and body["advice"]
    assert 1 <= len(body["areas"]) <= 3
    for a in body["areas"]:
        assert set(a) == {"cellId", "lat", "lng", "distanceM", "score", "level", "reason"}
        assert a["level"] == "low" and a["score"] <= 10 and "High ground" in a["reason"]
    dists = [a["distanceM"] for a in body["areas"]]
    assert dists == sorted(dists)
    for p in body["places"]:
        assert {"id", "name", "kind", "kindLabel", "lat", "lng", "distanceM", "address", "phone", "openingHours",
                "source", "score", "level", "reason"} <= set(p)
        assert p["level"] == "low"


def test_safe_areas_unscored_hazard_and_validation(client, loaded):
    body = client.get("/api/safe-areas", params={**DOWNTOWN, "hazard": "heat"}).json()
    assert body["areas"] == [] and body["places"]
    assert body["places"][0]["kind"] in ("community_centre", "shelter", "hospital")
    assert client.get("/api/safe-areas", params={**DOWNTOWN, "hazard": "nope"}).status_code == 422
    assert client.get("/api/safe-areas", params=DOWNTOWN).status_code == 422


def test_point_queries_not_logged():
    f = _RedactPointQuery()
    for path in ("/api/outlook?lat=47.6&lng=-122.3", "/api/safe-areas?lat=47.6&lng=-122.3&hazard=flood"):
        rec = logging.LogRecord("uvicorn.access", logging.INFO, "", 0, '%s - "%s %s HTTP/%s" %d',
                                ("127.0.0.1:1", "GET", path, "1.1", 200), None)
        f.filter(rec)
        assert "47.6" not in rec.getMessage()
    rec = logging.LogRecord("uvicorn.access", logging.INFO, "", 0, '%s - "%s %s HTTP/%s" %d',
                            ("127.0.0.1:1", "GET", "/api/outlook/areas?bbox=1,2,3,4", "1.1", 200), None)
    f.filter(rec)
    assert "bbox=1,2,3,4" in rec.getMessage()
