"""Hazard classifier: classify() and the /api/hazard endpoints.

The model tests skip when ml/hazard/output/hazard_model.joblib is absent (it is git-ignored;
build it with ml/hazard/train_hazard_model.py). They do not need the database: the router
is mounted on a bare FastAPI app.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import hazard_model
from app.hazard_taxonomy import HAZARD_KEYS
from app.main import app as main_app
from app.routers import hazard

HAS_MODEL = hazard_model.model_path().exists()
needs_model = pytest.mark.skipif(not HAS_MODEL, reason="hazard model not trained (ml/hazard/train_hazard_model.py)")


@pytest.fixture(scope="module")
def client():
    api = FastAPI()
    api.include_router(hazard.router, prefix="/api")
    with TestClient(api) as c:
        yield c


def test_routes_are_mounted_in_main_app():
    paths = set(main_app.openapi()["paths"])
    assert "/api/hazard/classify" in paths and "/api/hazard/model" in paths


@pytest.mark.parametrize("body", [{}, {"text": ""}, {"text": "x" * 5001}, {"text": 42}, {"txt": "flood"}])
def test_classify_validation(client, body):
    assert client.post("/api/hazard/classify", json=body).status_code == 422


def test_blank_text_rejected(client):
    assert client.post("/api/hazard/classify", json={"text": "   "}).status_code == 422


def test_missing_model_gives_503(client, monkeypatch, tmp_path):
    monkeypatch.setattr(hazard_model, "_bundle", None)
    monkeypatch.setenv("HAZARD_MODEL_PATH", str(tmp_path / "nope.joblib"))
    r = client.post("/api/hazard/classify", json={"text": "Flash flooding downtown"})
    assert r.status_code == 503 and "train_hazard_model.py" in r.json()["detail"]
    assert client.get("/api/hazard/model").status_code == 503
    with pytest.raises(hazard_model.HazardModelUnavailable):
        hazard_model.classify("Flash flooding downtown")


@needs_model
@pytest.mark.parametrize("text,expected", [
    ("Flash flooding is occurring. Do not drive through flooded roads. Move to higher ground now.", "flood"),
    ("A tornado has been sighted. Take shelter now in a basement or an interior room on the lowest floor.", "storm"),
    ("Tsunami danger on the coast. Go to high ground or move inland.", "tsunami"),
    ("Heavy snow and blowing snow, travel could be very difficult. Roads will be icy.", "winter"),
    ("Dangerously hot temperatures with heat index values up to 115. Drink plenty of fluids.", "heat"),
    ("Child abduction: police are looking for a 5 year old girl taken in a blue pickup truck.", "crime"),
])
def test_obvious_messages(text, expected):
    result = hazard_model.classify(text)
    assert result["hazard"] == expected, result


@needs_model
def test_classify_endpoint_shape(client):
    r = client.post("/api/hazard/classify", json={"text": "River rising rapidly, evacuate low areas"})
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"hazard", "hazardLabel", "confidence", "severity", "scores", "model", "method"}
    assert body["method"] == "model"
    assert body["hazard"] in HAZARD_KEYS
    assert 0.0 <= body["confidence"] <= 1.0
    assert len(body["scores"]) == 3 and all(k in HAZARD_KEYS for k in body["scores"])
    assert body["severity"] in {"Extreme", "Severe", "Moderate", "Minor"}
    assert body["model"].startswith("hazard-")


@needs_model
def test_low_confidence_abstains_to_other():
    result = hazard_model.classify("zzqx blorp")
    if result["confidence"] < hazard_model.load_model()["threshold"]:
        assert result["hazard"] == "other"


@needs_model
def test_model_endpoint(client):
    body = client.get("/api/hazard/model").json()
    assert body["version"].startswith("hazard-")
    assert body["trainedAt"] and 0 < body["threshold"] < 1
    assert body["metrics"]["macroF1Masked"] > 0.5


@pytest.mark.parametrize("text, expected", [
    ("Strong shaking felt downtown, buildings damaged", "earthquake"),
    ("Air raid sirens, go to the nearest shelter immediately", "conflict"),
    ("Tsunami waves expected after the earthquake, move inland", "tsunami"),
    ("Mount Rainier eruption: ash fall expected east of the mountain", "volcano"),
    ("Missile alert: take cover in a basement now", "conflict"),
])
def test_rare_hazard_rules(text, expected):
    pytest.importorskip("joblib")
    from app import hazard_model
    try:
        result = hazard_model.classify(text)
    except hazard_model.HazardModelUnavailable:
        pytest.skip("hazard model not trained")
    assert result["hazard"] == expected and result["method"] == "rules"


def test_non_emergency_text_abstains():
    from app import hazard_model
    try:
        result = hazard_model.classify("Lunch at noon in the cafeteria")
    except hazard_model.HazardModelUnavailable:
        pytest.skip("hazard model not trained")
    assert result["hazard"] == "other" and result["method"] == "abstain" and result["severity"] is None


def test_rule_patterns_without_model():
    from app.hazard_model import rule_hazard
    assert rule_hazard("Tsunami warning issued after a strong earthquake")[0] == "tsunami"
    assert rule_hazard("Tornado warning: sirens are sounding") is None  # sirens alone are not an attack
    assert rule_hazard("Flash flood warning for the Cedar River") is None
