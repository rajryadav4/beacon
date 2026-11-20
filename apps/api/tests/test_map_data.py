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


def test_meta_years(client):
    years = client.get("/api/meta").json()["dataRange"]["years"]
    assert 3.5 < years < 4.5


def test_grid_contract(client):
    body = client.get("/api/grid").json()
    cells = body["cells"]
    assert body["version"] == 1
    assert len(cells) > 3000
    hoods = client.get("/api/neighborhoods").json()["neighborhoods"]
    for cell_id, nb, counts, risk in cells[:500]:
        row, col = divmod(cell_id, 100)
        assert 0 <= row < 135 and 0 <= col < 80
        assert -1 <= nb < len(hoods)
        assert len(counts) == 32 and sum(counts) > 0
        assert len(risk) == 4 and all(v >= 0 for v in risk)
    assert any(nb >= 0 for _, nb, _, _ in cells)
    assert max(max(r) for *_, r in cells) > 20  # some high-risk blocks


def test_neighborhoods_contract(client):
    hoods = client.get("/api/neighborhoods").json()["neighborhoods"]
    assert 50 <= len(hoods) <= 70
    names = [h["name"] for h in hoods]
    assert names == sorted(names, key=str.casefold)
    assert "Downtown" in names and "Lake City" in names  # NAME_FIXES display names
    assert not {"OOJ", "UNKNOWN", "FK ERROR", "-"} & {h["key"] for h in hoods}
    downtown = next(h for h in hoods if h["name"] == "Downtown")
    assert 47.59 < downtown["lat"] < 47.62 and -122.35 < downtown["lng"] < -122.32
    assert len(downtown["counts"]) == 32 and downtown["cells"] > 0
    assert downtown["areaKm2"] == pytest.approx(downtown["cells"] * 0.0501, abs=0.01)
    assert downtown["unlocated"] >= 0


def test_grid_neighborhood_index_matches_the_list(client):
    cells = client.get("/api/grid").json()["cells"]
    hoods = client.get("/api/neighborhoods").json()["neighborhoods"]
    # The center of Pioneer Square (row 60, col 64 area) belongs to a downtown-ish neighborhood.
    lat, lng = 47.6015, -122.3335
    target = int((lat - 47.48) / 0.002) * 100 + int((lng + 122.46) / 0.003)
    cell = next(c for c in cells if c[0] == target)
    assert hoods[cell[1]]["name"] in {"Pioneer Square", "Downtown", "Chinatown-International District"}
