"""Hazard classifier for free-text emergency messages (model: ml/hazard).

Use it only for text without a usable official code: an EAS/SAME event code or NWS
event name always wins (see hazard_taxonomy.py). Below the model's confidence
threshold the answer is hazard "other".

    from app.hazard_model import classify
    classify("River rising rapidly, evacuate low areas")
    # {"hazard": "flood", "hazardLabel": "Flood", "confidence": 0.93, "severity": "Severe",
    #  "scores": {"flood": 0.93, ...}, "model": "hazard-20261119"}

The model file is ml/hazard/output/hazard_model.joblib (git-ignored; build it with
ml/hazard/train_hazard_model.py). HAZARD_MODEL_PATH overrides the location.
"""

from __future__ import annotations

import os
import re
import threading
from pathlib import Path
from typing import Any

from .hazard_taxonomy import HAZARDS

DEFAULT_PATH = Path(__file__).resolve().parents[3] / "ml" / "hazard" / "output" / "hazard_model.joblib"
MAX_CHARS = 3000  # same truncation as training

_lock = threading.Lock()
_bundle: dict[str, Any] | None = None


class HazardModelUnavailable(RuntimeError):
    """The trained model file is missing or cannot be loaded."""


def model_path() -> Path:
    return Path(os.environ.get("HAZARD_MODEL_PATH", DEFAULT_PATH))


def load_model() -> dict[str, Any]:
    """Load the joblib bundle once (thread-safe) and return it."""
    global _bundle
    if _bundle is not None:
        return _bundle
    with _lock:
        if _bundle is None:
            path = model_path()
            if not path.exists():
                raise HazardModelUnavailable(
                    f"hazard model not found at {path}. Train it with "
                    "`python ml/hazard/fetch_ipaws.py` then `python ml/hazard/train_hazard_model.py`, "
                    "or set HAZARD_MODEL_PATH.")
            try:
                import joblib
                _bundle = joblib.load(path)
            except Exception as exc:  # corrupt file, sklearn version mismatch, ...
                raise HazardModelUnavailable(f"could not load hazard model {path}: {exc}") from exc
    return _bundle


def model_info() -> dict[str, Any]:
    bundle = load_model()
    return {"version": bundle["version"], "trainedAt": bundle["trainedAt"],
            "threshold": bundle["threshold"], "summary": bundle.get("summary", {})}


def _prepare(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()[: int(load_model().get("maxChars", MAX_CHARS))]


def classify(text: str) -> dict[str, Any]:
    """Classify one free-text message. Raises HazardModelUnavailable if the model is missing."""
    bundle = load_model()
    clean = _prepare(text)
    X = bundle["vectorizer"].transform([clean])
    proba = bundle["hazard"].predict_proba(X)[0]
    classes = [str(c) for c in bundle["hazard"].classes_]
    order = proba.argsort()[::-1]
    best, confidence = classes[order[0]], float(proba[order[0]])
    hazard = best if confidence >= float(bundle["threshold"]) and clean else "other"
    severity = str(bundle["severity"].predict(X)[0]) if clean else None
    return {
        "hazard": hazard,
        "hazardLabel": HAZARDS[hazard]["label"],
        "confidence": round(confidence, 4),
        "severity": severity,
        "scores": {classes[i]: round(float(proba[i]), 4) for i in order[:3]},
        "model": bundle["version"],
    }
