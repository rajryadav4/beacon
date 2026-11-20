"""Hazard classifier endpoints: classify free-text emergency messages.

Request text is never logged or stored.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..hazard_model import HazardModelUnavailable, classify, model_info

router = APIRouter(tags=["hazard"])


class ClassifyRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000, description="Free-text emergency message")


def _unavailable(exc: HazardModelUnavailable) -> HTTPException:
    return HTTPException(503, f"Hazard classifier is not available: {exc}")


@router.post("/hazard/classify")
def classify_text(body: ClassifyRequest) -> dict:
    """Hazard type and CAP severity for a message that has no official alert code."""
    if not body.text.strip():
        raise HTTPException(422, "text must not be blank")
    try:
        return classify(body.text)
    except HazardModelUnavailable as exc:
        raise _unavailable(exc) from None


@router.get("/hazard/model")
def hazard_model() -> dict:
    """Model version, trained date, abstain threshold and the test metrics summary."""
    try:
        info = model_info()
    except HazardModelUnavailable as exc:
        raise _unavailable(exc) from None
    summary = info["summary"]
    return {
        "version": info["version"],
        "trainedAt": info["trainedAt"],
        "threshold": info["threshold"],
        "classes": summary.get("classes"),
        "metrics": summary.get("test"),
        "checkSet": summary.get("checkSet"),
    }
