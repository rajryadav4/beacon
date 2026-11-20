"""Alerts: feed parsers and rules (fixture payloads, no network) and the alerts API (local Postgres)."""

from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import alerts_rules
from app.alerts_rules import (
    hide_call,
    incident_hazard,
    is_survival,
    quake_radius_km,
    quake_severity,
    resolve_hazard,
)
from app.main import app
from app.privacy import redact

FIXTURES = Path(__file__).parent / "fixtures"
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "pipeline"))

import alerts_sources as src  # noqa: E402

UTC = timezone.utc


def load(name: str):
    return json.loads((FIXTURES / name).read_text())


@pytest.fixture(autouse=True)
def no_classifier(monkeypatch):
    """Parsers run without the trained classifier unless a test installs a fake one."""
    monkeypatch.setattr(alerts_rules, "_classifier", None)


# ---- hazard resolution -----------------------------------------

def test_hazard_from_code_then_event_name():
    assert resolve_hazard(["FFW"], "Flash Flood Warning") == ("flood", "source", None)
    assert resolve_hazard(["MAW"], "Special Marine Warning") == ("storm", "source", None)
    assert resolve_hazard(["LAE"], "Local Area Emergency", "gas leak") == ("other", "source", None)
    assert resolve_hazard([], "Dense Fog Advisory", "fog") == ("other", "none", None)


def test_classifier_hook_used_only_without_a_specific_code():
    calls = []

    def fake(text):
        calls.append(text)
        return {"hazard": "hazmat", "confidence": 0.91}

    assert resolve_hazard(["LAE"], "Local Area Emergency", "gas leak, evacuate", classifier=fake) == \
        ("hazmat", "model", 0.91)
    assert resolve_hazard(["EQW"], "Earthquake Warning", "shaking", classifier=fake) == \
        ("earthquake", "source", None)
    assert calls == ["gas leak, evacuate"]


def test_classifier_low_confidence_or_failure_falls_back():
    assert resolve_hazard(["CEM"], "Civil Emergency Message", "text",
                          classifier=lambda t: {"hazard": "flood", "confidence": 0.2}) == ("other", "source", None)
    assert resolve_hazard([], "Something", "text",
                          classifier=lambda t: {"hazard": "not-a-key", "confidence": 0.99}) == ("other", "none", None)

    def broken(_):
        raise RuntimeError("model file missing")

    assert resolve_hazard([], "Something", "text", classifier=broken) == ("other", "none", None)


# ---- survival rule and earthquakes --------------------------------

@pytest.mark.parametrize("severity,urgency,status,expected", [
    ("Extreme", "Immediate", "Actual", True),
    ("Severe", "Expected", "Actual", True),
    ("Severe", "Future", "Actual", False),
    ("Moderate", "Immediate", "Actual", False),
    ("Extreme", "Immediate", "Exercise", False),
    ("Severe", "Past", "Actual", False),
])
def test_survival_rule(severity, urgency, status, expected):
    assert is_survival({"severity": severity, "urgency": urgency, "status": status}) is expected


def test_quake_severity_and_radius():
    assert [quake_severity(m) for m in (6.0, 5.2, 4.0, 3.9, None)] == \
        ["Extreme", "Severe", "Moderate", "Minor", "Unknown"]
    radii = [quake_radius_km(m) for m in (2.5, 4, 5, 6, 7, 9.5)]
    assert radii == sorted(radii)
    assert 2 < radii[0] < 4 and 40 < radii[2] < 60 and radii[-1] == 1000


# ---- NWS ---------------------------------------------------------

def test_parse_nws():
    rows = src.parse_nws(load("nws_alerts.json"), feed="area=WA")
    by_event = {r["event"]: r for r in rows}
    assert "Test Message" not in by_event  # Test status / TST code skipped
    assert len(rows) == 5

    ffw = by_event["Flash Flood Warning"]
    assert (ffw["hazard"], ffw["classified_by"], ffw["event_code"]) == ("flood", "source", "FFW")
    assert ffw["geometry"]["type"] == "Polygon"
    assert ffw["refs"] == ["urn:oid:2.49.0.1.840.0.test-ffw-old.001.1"]
    assert ffw["msg_type"] == "Update" and ffw["sender"] == "NWS Seattle WA"
    assert ffw["expires"] == datetime(2026, 11, 20, 5, 15, tzinfo=UTC)
    assert ffw["feed"] == "area=WA" and ffw["source"] == "nws"

    wsw = by_event["Winter Storm Warning"]
    assert wsw["geometry"] is None and len(wsw["zones"]) == 2
    assert wsw["hazard"] == "winter"
    assert wsw["headline"] == "WINTER STORM WARNING IN EFFECT FROM 4 AM THURSDAY"  # NWSheadline fallback

    smw = by_event["Special Marine Warning"]
    assert smw["hazard"] == "storm" and smw["event_code"] == "MAW"  # SAME 'NWS' is ignored

    fog = by_event["Dense Fog Advisory"]
    assert (fog["hazard"], fog["classified_by"]) == ("other", "none")

    cancel = [r for r in rows if r["msg_type"] == "Cancel"][0]
    assert cancel["refs"] == ["urn:oid:2.49.0.1.840.0.test-flw.001.1"]


def test_parse_nws_uses_classifier_when_installed(monkeypatch):
    monkeypatch.setattr(alerts_rules, "_classifier", lambda text: {"hazard": "air_quality", "confidence": 0.7})
    fog = [r for r in src.parse_nws(load("nws_alerts.json"), "area=WA") if r["event"] == "Dense Fog Advisory"][0]
    assert (fog["hazard"], fog["classified_by"], fog["confidence"]) == ("air_quality", "model", 0.7)


def test_parse_zone_keeps_polygons_only():
    feature = {"properties": {"id": "WAZ567", "type": "public", "name": "Cascades", "state": "WA"},
               "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}}
    zone = src.parse_zone("https://api.weather.gov/zones/forecast/WAZ567", feature)
    assert zone["zone_id"] == "WAZ567" and zone["geometry"]["type"] == "Polygon"
    empty = src.parse_zone("https://api.weather.gov/zones/forecast/PZZ999", None)
    assert empty["zone_id"] == "PZZ999" and empty["geometry"] is None


# ---- USGS ----------------------------------------------------------

def test_parse_usgs():
    collection = load("usgs_quakes.json")
    first_origin = datetime.fromtimestamp(1795136400, tz=UTC)
    rows = src.parse_usgs(collection, now=first_origin + timedelta(hours=1))
    assert [r["source_id"] for r in rows] == ["uw00000001", "us00000002", "nc00000003"]  # quarry blast dropped

    big, mid, small = rows
    assert (big["hazard"], big["severity"], big["urgency"]) == ("earthquake", "Extreme", "Immediate")
    assert big["magnitude"] == 6.4 and big["radius_km"] > 200
    assert big["point"] == (-122.1, 47.7) and big["geometry"] is None
    assert big["expires"] == first_origin + timedelta(hours=72)
    assert "tsunami" in big["description"] and big["instruction"]
    assert (mid["severity"], mid["urgency"]) == ("Moderate", "Past")  # 10 h before `now`
    assert (small["severity"], small["instruction"]) == ("Minor", None)
    assert small["expires"] - small["sent"] == timedelta(hours=24)


# ---- IPAWS ---------------------------------------------------------

def test_parse_ipaws():
    rows = src.parse_ipaws(load("ipaws_alerts.json")["IpawsArchivedAlerts"])
    by_id = {r["source_id"]: r for r in rows}
    assert set(by_id) == {"test-ipaws-lae-1", "test-ipaws-cdw-1"}  # NWS copy and monthly test skipped

    lae = by_id["test-ipaws-lae-1"]
    assert lae["headline"] == "Example Alert: Gas leak on Main St. Evacuate now."  # English info, CMAM fallback
    assert lae["description"].startswith("Example Alert: A natural gas leak")
    assert (lae["hazard"], lae["classified_by"]) == ("other", "source")  # LAE: the text decides
    assert lae["geometry"]["type"] == "Polygon" and lae["instruction"] is None
    assert lae["sender"] == "Example County Emergency Management"
    assert "originalMessage" not in lae["raw"] and "searchGeometry" not in lae["raw"]

    cdw = by_id["test-ipaws-cdw-1"]
    assert (cdw["hazard"], cdw["severity"], cdw["msg_type"]) == ("conflict", "Extreme", "Update")
    assert cdw["geometry"]["type"] == "Polygon"  # from searchGeometry: the area has geocodes only
    assert cdw["refs"] == ["test-ipaws-cdw-0"]


# ---- Seattle Fire --------------------------------------------------------

def test_parse_seattle_fire():
    calls = src.parse_seattle_fire(load("seattle_fire.json"))
    assert [c["source_call_id"] for c in calls] == [f"FTEST000{i}" for i in range(1, 7)]
    first = calls[0]
    assert first["call_time"].astimezone(UTC) == datetime(2026, 11, 20, 3, 19, tzinfo=UTC)  # PST = UTC-8
    summer = calls[4]
    assert summer["call_time"].astimezone(UTC) == datetime(2026, 7, 4, 19, 0, tzinfo=UTC)  # PDT = UTC-7
    assert calls[5]["lat"] is None
    assert [c["hidden"] for c in calls] == [True, False, False, False, False, False]


@pytest.mark.parametrize("call_type,hazard", [
    ("Hazardous Mat- Spill-Leak", "hazmat"), ("Natural Gas Leak Major", "hazmat"),
    ("Brush Fire Freeway", "wildfire"), ("Water Rescue Response", "flood"),
    ("Scenes Of Violence 7", "crime"), ("Fire in Building", "other"), ("Car Fire", "other"), (None, "other"),
])
def test_incident_hazard(call_type, hazard):
    assert incident_hazard(call_type) == hazard


def test_hidden_calls():
    assert all(hide_call(t) for t in ("Aid Response", "Medic Response- Overdose", "Low Acuity Response",
                                      "TEST - MIS TEST", "Trans to AMR", "Med Resp- 6 Mem. Rule Freeway"))
    assert not any(hide_call(t) for t in ("Fire in Building", "MVI - Motor Vehicle Incident",
                                          "Scenes Of Violence Aid", "Multiple Casualty Incident"))


def test_access_log_redacts_location():
    assert redact("/api/alerts/active?lat=47.61&lng=-122.33") == "/api/alerts/active?lat=redacted&lng=redacted"
    record = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, '%s - "%s %s HTTP/%s" %d',
                               ("127.0.0.1:5000", "GET", "/api/alerts/active?lng=1.5&lat=2.5", "1.1", 200), None)
    for f in logging.getLogger("uvicorn.access").filters:
        f.filter(record)
    assert "1.5" not in record.getMessage() and "2.5" not in record.getMessage()


# ---- API against the database ----------------------------------------
# Test rows sit in the middle of the Pacific (around 0.5 N, 150.5 W) and are removed afterwards.

LAT, LNG = 0.5, -150.5
PREFIX = "beacon-test-"
ZONE_URL = "https://api.weather.gov/zones/forecast/BEACONTEST1"


def square(lng: float, lat: float, half: float) -> dict:
    return {"type": "Polygon", "coordinates": [[[lng - half, lat - half], [lng + half, lat - half],
                                                [lng + half, lat + half], [lng - half, lat + half],
                                                [lng - half, lat - half]]]}


def make_row(source_id: str, **overrides) -> dict:
    now = datetime.now(UTC)
    row = {
        "source": "nws", "source_id": PREFIX + source_id, "feed": "test", "event": "Test event",
        "event_code": None, "hazard": "other", "classified_by": "source", "confidence": None,
        "severity": "Moderate", "urgency": "Expected", "certainty": "Likely", "status": "Actual",
        "msg_type": "Alert", "headline": "headline", "description": "description", "instruction": None,
        "area_desc": "Test area", "sender": "Test sender", "sent": now - timedelta(minutes=30),
        "effective": now - timedelta(minutes=30), "onset": now - timedelta(minutes=30),
        "expires": now + timedelta(hours=2), "ends": None, "url": None, "magnitude": None,
        "radius_km": None, "geometry": None, "zones": None, "point": None, "refs": [], "raw": {},
    }
    row.update(overrides)
    return row


def cleanup(conn) -> None:
    conn.execute("DELETE FROM alerts WHERE source_id LIKE %s", (PREFIX + "%",))
    conn.execute("DELETE FROM alert_zones WHERE zone_url = %s", (ZONE_URL,))
    conn.execute("DELETE FROM emergency_calls WHERE source_call_id LIKE 'BEACONTEST%'")
    conn.commit()


@pytest.fixture(scope="module")
def db():
    import ingest_alerts

    try:
        conn = ingest_alerts.connect()
    except Exception as exc:
        pytest.skip(f"database not available: {exc}")
    ingest_alerts.apply_schema(conn)
    cleanup(conn)
    now = datetime.now(UTC)
    rows = [
        make_row("flood", event="Flash Flood Warning", hazard="flood", severity="Severe", urgency="Immediate",
                 geometry=square(LNG, LAT, 0.2), instruction="Move to higher ground now."),
        make_row("wind", event="Wind Advisory", hazard="storm", severity="Moderate",
                 onset=now - timedelta(hours=1), geometry=square(LNG, LAT, 0.5)),
        make_row("expired", event="Old Warning", severity="Extreme", urgency="Immediate",
                 expires=now - timedelta(minutes=5), geometry=square(LNG, LAT, 0.5)),
        make_row("exercise", event="Exercise Warning", status="Exercise", severity="Extreme",
                 urgency="Immediate", geometry=square(LNG, LAT, 0.5)),
        make_row("old", event="Flood Warning", hazard="flood", geometry=square(LNG, LAT, 0.5)),
        make_row("zoned", event="Winter Storm Warning", hazard="winter", zones=[ZONE_URL]),
        make_row("quake-near", source="usgs", event="Earthquake", hazard="earthquake", severity="Severe",
                 urgency="Past", magnitude=5.2, radius_km=quake_radius_km(5.2),
                 sent=now - timedelta(minutes=10), effective=now - timedelta(minutes=10),
                 onset=now - timedelta(minutes=10), point=(LNG + 0.45, LAT)),  # ~50 km east, radius ~63 km
        make_row("quake-far", source="usgs", event="Earthquake", hazard="earthquake", severity="Minor",
                 magnitude=3.0, radius_km=quake_radius_km(3.0), point=(LNG + 1.0, LAT)),
    ]
    ingest_alerts.upsert_alerts(conn, rows)
    # An update that supersedes the "old" flood warning.
    ingest_alerts.upsert_alerts(conn, [make_row("update", event="Flood Statement", hazard="flood",
                                                msg_type="Update", refs=[PREFIX + "old"],
                                                geometry=square(LNG + 5, LAT, 0.1))])
    ingest_alerts.mark_expired(conn)
    # Zone shape already cached: the fill step must not need the network.
    conn.execute("INSERT INTO alert_zones (zone_url, zone_id, geom) VALUES "
                 "(%s, 'BEACONTEST1', ST_Multi(ST_GeomFromGeoJSON(%s)))",
                 (ZONE_URL, json.dumps(square(LNG, LAT, 0.3))))

    class NoNetwork:
        def get(self, *a, **k):
            raise AssertionError("zone fetch should come from the cache")

    ingest_alerts.fill_zone_geometries(conn, NoNetwork())
    source_id = conn.execute("SELECT source_id FROM data_sources WHERE dataset_identifier = 'kzjm-xkqj'").fetchone()[0]
    for call_id, call_type, minutes, east in [("BEACONTEST1", "Hazardous Mat- Spill-Leak", 10, 0.002),
                                              ("BEACONTEST2", "Aid Response", 5, 0.001),
                                              ("BEACONTEST3", "Fire in Building", 180, 0.001),
                                              ("BEACONTEST4", "Brush Fire", 20, 0.05)]:
        conn.execute("INSERT INTO emergency_calls (source_id, source_call_id, call_time, call_type, geom)"
                     " VALUES (%s, %s, now() - make_interval(mins => %s), %s,"
                     " ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography)",
                     (source_id, call_id, minutes, call_type, LNG + east, LAT))
    conn.commit()
    yield conn
    cleanup(conn)
    conn.close()


@pytest.fixture(scope="module")
def client(db):
    """A client without the app lifespan: the shared pool cannot be reopened once a lifespan
    closes it, so this module uses its own pool and leaves app.db.pool to the other test modules."""
    from psycopg_pool import ConnectionPool

    from app.db import database_url
    from app.routers import alerts as alerts_router

    own_pool = ConnectionPool(database_url(), min_size=1, max_size=2, open=False)
    try:
        own_pool.open(wait=True, timeout=10)
    except Exception as exc:
        pytest.skip(f"database not available: {exc}")
    shared_pool, alerts_router.pool = alerts_router.pool, own_pool
    try:
        yield TestClient(app)
    finally:
        alerts_router.pool = shared_pool
        own_pool.close()


def test_lifecycle_in_db(db):
    ended = dict(db.execute("SELECT source_id, end_reason FROM alerts WHERE source_id LIKE %s"
                            " AND ended_at IS NOT NULL", (PREFIX + "%",)).fetchall())
    assert ended == {PREFIX + "expired": "expired", PREFIX + "old": "superseded"}
    geom_source = db.execute("SELECT geom_source FROM alerts WHERE source_id = %s", (PREFIX + "zoned",)).fetchone()
    assert geom_source == ("zones",)


def test_active_alerts_for_point(client):
    r = client.get("/api/alerts/active", params={"lat": LAT, "lng": LNG})
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    body = r.json()
    assert body["location"] == {"lat": LAT, "lng": LNG}
    events = [a["event"] for a in body["alerts"]]
    # Severe first (flood, then the earthquake by onset), then Moderate; expired, exercise and superseded left out.
    assert events[:2] == ["Flash Flood Warning", "Earthquake"]
    assert set(events) == {"Flash Flood Warning", "Earthquake", "Wind Advisory", "Winter Storm Warning"}
    assert body["survival"] is True and body["topHazard"] == "flood"

    flood = body["alerts"][0]
    assert set(flood) == {"id", "source", "event", "hazard", "hazardLabel", "severity", "urgency", "certainty",
                          "headline", "description", "instruction", "areaDesc", "sender", "effective",
                          "expires", "url", "magnitude", "distanceKm"}
    assert flood["hazardLabel"] == "Flood" and flood["distanceKm"] == 0
    quake = body["alerts"][1]
    assert quake["magnitude"] == 5.2 and 45 < quake["distanceKm"] < 55

    incidents = body["incidents"]
    assert [i["type"] for i in incidents] == ["Hazardous Mat- Spill-Leak"]  # medical hidden, old and far left out
    assert incidents[0]["hazard"] == "hazmat" and incidents[0]["distanceKm"] < 1
    assert set(incidents[0]) == {"id", "type", "hazard", "time", "distanceKm"}


def test_no_alerts_elsewhere(client):
    body = client.get("/api/alerts/active", params={"lat": LAT + 3, "lng": LNG}).json()
    assert body["alerts"] == [] and body["survival"] is False and body["topHazard"] is None


def test_survival_off_for_moderate_only(client):
    # Inside the wind advisory and the winter zone but outside the flood polygon and quake radius.
    body = client.get("/api/alerts/active", params={"lat": LAT + 0.28, "lng": LNG - 0.28}).json()
    assert {a["event"] for a in body["alerts"]} == {"Wind Advisory", "Winter Storm Warning"}
    assert body["survival"] is False


def test_alerts_layer(client):
    r = client.get("/api/alerts", params={"bbox": f"{LNG - 1},{LAT - 1},{LNG + 2},{LAT + 1}"})
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "FeatureCollection"
    props = {f["properties"]["event"]: f for f in body["features"]}
    assert {"Flash Flood Warning", "Wind Advisory", "Winter Storm Warning", "Earthquake"} <= set(props)
    assert "Old Warning" not in props and "Exercise Warning" not in props
    assert props["Flash Flood Warning"]["geometry"]["type"] == "MultiPolygon"
    quake_types = {f["geometry"]["type"] for f in body["features"] if f["properties"]["hazard"] == "earthquake"}
    assert quake_types == {"Point"}
    assert set(props["Wind Advisory"]["properties"]) == {"id", "event", "hazard", "severity", "headline", "expires"}


@pytest.mark.parametrize("bbox", ["1,2,3", "10,0,5,1", "a,b,c,d", "-200,0,0,1"])
def test_alerts_layer_bad_bbox(client, bbox):
    assert client.get("/api/alerts", params={"bbox": bbox}).status_code == 422


@pytest.mark.parametrize("params", [{"lat": 91, "lng": 0}, {"lat": 0}, {"lat": "x", "lng": 0}])
def test_active_bad_parameters(client, params):
    assert client.get("/api/alerts/active", params=params).status_code == 422


def test_status(client):
    body = client.get("/api/alerts/status").json()
    assert [s["source"] for s in body["sources"]] == ["nws", "usgs", "ipaws", "seattle_fire"]
    nws = body["sources"][0]
    assert nws["total"] >= nws["active"] >= 3
    assert set(nws) == {"source", "name", "lastAttemptAt", "lastSuccessAt", "lastError", "lastCount",
                        "newestItemAt", "active", "total"}
