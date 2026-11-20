"""Integration tests against the local Postgres (docker compose up -d db, then load the data)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture(scope="module")
def client():
    try:
        with TestClient(app) as c:
            yield c
    except Exception as exc:  # pool could not connect
        pytest.skip(f"database not available: {exc}")


def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok", "database": "ok"}


def test_meta(client):
    body = client.get("/api/meta").json()
    assert body["grid"]["rows"] == 135 and body["grid"]["cols"] == 80
    assert [b["key"] for b in body["bands"]] == ["night", "morning", "afternoon", "evening"]
    assert len(body["groups"]) == 8
    assert body["totals"]["incidents"] > 100_000
    assert body["risk"]["levels"]["high"] > body["risk"]["levels"]["elevated"]
    assert body["model"]["version"].startswith("risk-")


def test_heatmap_all(client):
    body = client.get("/api/heatmap").json()
    assert body["type"] == "FeatureCollection"
    features = body["features"]
    assert len(features) > 3000
    first = features[0]
    lng, lat = first["geometry"]["coordinates"]
    assert 47.48 < lat < 47.75 and -122.46 < lng < -122.22
    assert first["properties"]["count"] > 0


def test_heatmap_filters_narrow_the_result(client):
    everything = sum(f["properties"]["count"] for f in client.get("/api/heatmap").json()["features"])
    night_robbery = client.get("/api/heatmap", params={"band": "night", "groups": "robbery"}).json()
    subset = sum(f["properties"]["count"] for f in night_robbery["features"])
    assert 0 < subset < everything
    # robbery severity is 4
    f = night_robbery["features"][0]["properties"]
    assert f["weight"] == pytest.approx(f["count"] * 4)


def test_risk_grid(client):
    body = client.get("/api/risk", params={"band": "evening"}).json()
    assert body["band"] == 3
    features = body["features"]
    assert len(features) == 4192
    levels = {f["properties"]["level"] for f in features}
    assert levels == {"low", "elevated", "high"}
    ring = features[0]["geometry"]["coordinates"][0]
    assert len(ring) == 5  # closed rectangle


@pytest.mark.parametrize("url", ["/api/heatmap?band=noon", "/api/risk?band=all",
                                 "/api/heatmap?groups=pickpocket"])
def test_bad_parameters(client, url):
    assert client.get(url).status_code == 422
