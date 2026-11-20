"""Hazard classifier for free-text emergency messages (model: ml/hazard).

Use it only for text without a usable official code: an EAS/SAME event code or NWS
event name always wins (see hazard_taxonomy.py). Below the model's confidence
threshold the answer is hazard "other".

Two transparent rules sit on top of the model (`method` in the result says which decided):
  * "rules": rare hazards with very few US training alerts (tsunami, volcano, conflict,
    earthquake) are decided by clear terms such as "aftershock", "eruption", "air raid";
    the model alone confuses them with storms. Rule answers report RULE_CONFIDENCE.
  * "abstain": text with no emergency vocabulary at all ("lunch at noon") returns "other"
    unless the model is very confident (NON_EMERGENCY_MIN).

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

RULE_CONFIDENCE = 0.8
NON_EMERGENCY_MIN = 0.8

# Order matters: a tsunami warning often mentions the earthquake that caused it.
RARE_HAZARD_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("tsunami", re.compile(r"\b(tsunami|tidal wave)s?\b", re.I)),
    ("volcano", re.compile(r"\b(volcan\w*|erupt\w*|ash ?fall|lahar)\b", re.I)),
    ("conflict", re.compile(
        r"\b(air[- ]raid|missiles?|rockets? (fire|attack|launch)\w*|air ?strikes?|shelling|"
        r"drone (attack|strike)s?|bomb(s|ing|ings)?|active shooter|armed attack|"
        r"terror(ist|ism)? attack|invasion|incoming fire)\b", re.I)),
    ("earthquake", re.compile(r"\b(earthquakes?|quakes?|aftershocks?|seismic|tremors?|(strong |violent )?shaking)\b", re.I)),
)

EMERGENCY_WORDS = re.compile(
    r"\b(warning|watch|advisory|alert|emergency|evacuat\w*|shelter|danger\w*|hazard\w*|"
    r"flood\w*|fire\w*|smoke|storm\w*|wind|tornado\w*|hurricane|snow|ice|icy|blizzard|"
    r"freez\w*|cold|heat|hot|temperature|rain\w*|thunder\w*|lightning|surge|river|"
    r"spill\w*|leak\w*|chemical|gas|toxic|radiation|air quality|unhealthy|"
    r"police|shoot\w*|gunfire|missing|abduct\w*|amber|endangered|suspect|"
    r"injur\w*|rescue|911|stay (indoors|inside|away)|take cover|seek|immediately|now)\b", re.I)


def rule_hazard(text: str) -> tuple[str, str] | None:
    """(hazard, matched term) for a clear rare-hazard term, else None."""
    for hazard, pattern in RARE_HAZARD_RULES:
        match = pattern.search(text)
        if match:
            return hazard, match.group(0)
    return None


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
    method, matched = "model", None
    rule = rule_hazard(clean) if clean else None
    if rule:
        hazard, matched = rule
        confidence, method = max(RULE_CONFIDENCE, float(proba[classes.index(hazard)]) if hazard in classes else 0.0), "rules"
    elif clean and not EMERGENCY_WORDS.search(clean) and confidence < NON_EMERGENCY_MIN:
        hazard, method = "other", "abstain"
    severity = str(bundle["severity"].predict(X)[0]) if clean and hazard != "other" else None
    result = {
        "hazard": hazard,
        "hazardLabel": HAZARDS[hazard]["label"],
        "confidence": round(confidence, 4),
        "severity": severity,
        "scores": {classes[i]: round(float(proba[i]), 4) for i in order[:3]},
        "model": bundle["version"],
        "method": method,
    }
    if matched:
        result["matched"] = matched
    return result
