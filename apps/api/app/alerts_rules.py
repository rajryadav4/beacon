"""Alert rules shared by the ingest (pipeline/) and the alerts API.

Pure functions, no database: hazard resolution (official code first, then the
event name, then the trained classifier), earthquake severity and radius,
the survival-mode rule and the Seattle Fire call-type keyword table.
"""

from __future__ import annotations

import logging
import math
from typing import Callable

from .hazard_taxonomy import HAZARD_KEYS, SEVERITY_RANK, hazard_from_event_name, hazard_from_same_code

log = logging.getLogger(__name__)

# ---- Hazard resolution -----------------------------------------

MODEL_MIN_CONFIDENCE = 0.5
_UNSET = object()
_classifier: object = _UNSET


def load_classifier() -> Callable[[str], dict] | None:
    """The trained hazard classifier (apps/api/app/hazard_model.py, built from ml/hazard/), if installed.

    It is optional: when the module or its model file is missing, alerts without
    a usable code fall back to hazard 'other'.
    """
    global _classifier
    if _classifier is _UNSET:
        try:
            from .hazard_model import classify  # type: ignore[import-not-found]

            _classifier = classify
        except Exception as exc:  # ImportError, or the model file failed to load
            log.info("hazard classifier not available (%s); using 'other' for uncoded alerts", exc)
            _classifier = None
    return _classifier  # type: ignore[return-value]


def resolve_hazard(codes: list[str | None], event: str | None, text: str | None = None,
                   classifier: Callable[[str], dict] | None | object = _UNSET) -> tuple[str, str, float | None]:
    """-> (hazard, classified_by, confidence).

    1. the first SAME/NWS event code that maps to a specific hazard ('source')
    2. the event name ('source')
    3. the classifier on headline + description, if installed and confident ('model')
    4. 'other': 'source' when the code or event name said so (e.g. LAE, CEM), else 'none'
    """
    generic = False
    for code in codes:
        hazard = hazard_from_same_code(code)
        if hazard and hazard != "other":
            return hazard, "source", None
        generic = generic or hazard == "other"
    hazard = hazard_from_event_name(event)
    if hazard and hazard != "other":
        return hazard, "source", None
    generic = generic or hazard == "other"

    classify = load_classifier() if classifier is _UNSET else classifier
    if classify and text and text.strip():
        try:
            result = classify(text)  # type: ignore[operator]
            label, confidence = result.get("hazard"), float(result.get("confidence") or 0)
            if label in HAZARD_KEYS and confidence >= MODEL_MIN_CONFIDENCE:
                return label, "model", round(confidence, 4)
        except Exception as exc:
            log.warning("hazard classifier failed: %s", exc)
    return "other", ("source" if generic else "none"), None


# ---- Earthquakes -----------------------------------------------

QUAKE_IMMEDIATE_HOURS = 6  # urgency 'Immediate' this long after the origin time, then 'Past'


def quake_severity(magnitude: float | None) -> str:
    if magnitude is None:
        return "Unknown"
    if magnitude >= 6:
        return "Extreme"
    if magnitude >= 5:
        return "Severe"
    if magnitude >= 4:
        return "Moderate"
    return "Minor"


def quake_radius_km(magnitude: float | None) -> float:
    """Rough radius of noticeable shaking: 10^(0.5 M - 0.8) km, 1 to 1000 km.

    M2.5 ~ 3 km, M4 ~ 16 km, M5 ~ 50 km, M6 ~ 160 km, M7 ~ 500 km. A coarse
    rule of thumb (shaking depends on depth and ground), not a ShakeMap.
    """
    if magnitude is None:
        return 1.0
    return round(min(1000.0, max(1.0, math.pow(10, 0.5 * float(magnitude) - 0.8))), 1)


def quake_expires_hours(magnitude: float | None) -> int:
    return 72 if (magnitude or 0) >= 6 else 24


# ---- Survival mode ---------------------------------------------

SURVIVAL_SEVERITIES = {"Extreme", "Severe"}
SURVIVAL_URGENCIES = {"Immediate", "Expected"}


def is_survival(alert: dict) -> bool:
    """Severe or Extreme, Immediate or Expected, and a real (Actual) message."""
    return (alert.get("severity") in SURVIVAL_SEVERITIES
            and alert.get("urgency") in SURVIVAL_URGENCIES
            and alert.get("status") == "Actual")


def severity_rank(severity: str | None) -> int:
    return SEVERITY_RANK.get(severity or "Unknown", 0)


# ---- Seattle Fire 911 call types ---------------------------------
# Seattle Fire `type` values are free text ("Aid Response", "Car Fire",
# "Hazardous Mat- Spill-Leak", "Water Rescue Response", ...). Only a few call
# types say anything about a wider hazard; a building, car or rubbish fire is a
# local incident, so it stays 'other'. Medical, test and admin calls are not
# shown as incidents at all (they are not a danger to people nearby).

HIDDEN_CALL_KEYWORDS = (
    "aid response", "medic resp", "med resp", "medic unit", "multiple medic", "bc aid", "low acuity",
    "medical alarm", "trans to amr", "hang-up", "crisis center", "poison control", "comed",
    "mutual aid- medic", "mutual aid- aid", "test", "investigate out of service", "special event",
)
INCIDENT_HAZARD_KEYWORDS: tuple[tuple[str, str], ...] = (
    ("hazardous mat", "hazmat"), ("hazmat", "hazmat"), ("hzmt", "hazmat"),
    ("natural gas", "hazmat"), ("fuel spill", "hazmat"), ("tank farm", "hazmat"),
    ("brush fire", "wildfire"), ("wildland", "wildfire"), ("grass fire", "wildfire"),
    ("water rescue", "flood"),
    ("scenes of violence", "crime"), ("shooting", "crime"), ("stabbing", "crime"),
)


def hide_call(call_type: str | None) -> bool:
    """True for medical, test and admin call types that Beacon does not show as incidents."""
    text = (call_type or "").lower()
    return any(k in text for k in HIDDEN_CALL_KEYWORDS)


def incident_hazard(call_type: str | None) -> str:
    text = (call_type or "").lower()
    for keyword, hazard in INCIDENT_HAZARD_KEYWORDS:
        if keyword in text:
            return hazard
    return "other"
