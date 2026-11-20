"""Shared hazard taxonomy for Beacon: one set of hazard keys for alerts, the
hazard classifier, safe places and survival mode.

Official sources win: an alert's EAS/SAME event code or NWS event name maps to
a hazard here. The trained classifier (ml/hazard) is only for free text that has
no usable code.
"""

from __future__ import annotations

# Hazard keys, in display order. `label` is shown to users.
HAZARDS: dict[str, dict[str, str]] = {
    "earthquake": {"label": "Earthquake"},
    "tsunami": {"label": "Tsunami"},
    "flood": {"label": "Flood"},
    "storm": {"label": "Severe storm, tornado or hurricane"},
    "winter": {"label": "Winter storm or extreme cold"},
    "wildfire": {"label": "Wildfire"},
    "heat": {"label": "Extreme heat"},
    "air_quality": {"label": "Air quality or smoke"},
    "hazmat": {"label": "Hazardous materials, chemical or radiological"},
    "volcano": {"label": "Volcano"},
    "conflict": {"label": "Conflict, attack or civil danger"},
    "crime": {"label": "Crime or police activity"},
    "other": {"label": "Other emergency"},
}
HAZARD_KEYS = tuple(HAZARDS)

# EAS / SAME event codes (used by IPAWS and NWS CAP `eventCode` SAME values).
# Test and administrative codes map to None: they are not real hazards.
SAME_CODE_HAZARD: dict[str, str | None] = {
    # geophysical
    "EQW": "earthquake",
    "TSW": "tsunami", "TSA": "tsunami",
    "VOW": "volcano",
    "AVW": "winter", "AVA": "winter",
    # water
    "FFW": "flood", "FFA": "flood", "FFS": "flood",
    "FLW": "flood", "FLA": "flood", "FLS": "flood",
    "CFW": "flood", "CFA": "flood", "SSW": "flood", "SSA": "flood",
    # wind and storms
    "TOR": "storm", "TOA": "storm", "SVR": "storm", "SVA": "storm", "SVS": "storm",
    "HUW": "storm", "HUA": "storm", "HLS": "storm", "TRW": "storm", "TRA": "storm",
    "EWW": "storm", "HWW": "storm", "HWA": "storm", "DSW": "storm", "SMW": "storm", "SQW": "storm",
    # winter
    "BZW": "winter", "WSW": "winter", "WSA": "winter", "ISW": "winter", "WCW": "winter",
    # fire, heat, air
    "FRW": "wildfire", "FWW": "wildfire",
    "EHW": "heat", "EHA": "heat",
    "AQA": "air_quality",
    # hazmat, radiological, nuclear
    "HMW": "hazmat", "RHW": "hazmat", "NUW": "hazmat", "BHW": "hazmat",
    # civil danger, attack, national emergency
    "CDW": "conflict", "EAN": "conflict", "NAT": "conflict", "NIC": "conflict",
    # law enforcement
    "LEW": "crime", "CAE": "crime", "BLU": "crime",
    # generic emergencies: the text decides (classifier), default "other"
    "CEM": "other", "LAE": "other", "SPW": "other", "EVI": "other", "TOE": "other",
    "ADR": None, "DMO": None, "RWT": None, "RMT": None, "NPT": None, "NMN": None,
}

# NWS CAP `event` names -> hazard, matched on lower-case keywords in order.
NWS_EVENT_KEYWORDS: tuple[tuple[str, str], ...] = (
    ("tsunami", "tsunami"),
    ("earthquake", "earthquake"),
    ("volcan", "volcano"), ("ashfall", "volcano"),
    ("flood", "flood"), ("storm surge", "flood"), ("hydrologic", "flood"), ("high surf", "flood"),
    ("tornado", "storm"), ("thunderstorm", "storm"), ("hurricane", "storm"), ("tropical", "storm"),
    ("typhoon", "storm"), ("wind", "storm"), ("dust", "storm"), ("marine", "storm"), ("gale", "storm"),
    ("blizzard", "winter"), ("winter", "winter"), ("ice", "winter"), ("snow", "winter"),
    ("freez", "winter"), ("frost", "winter"), ("cold", "winter"), ("avalanche", "winter"),
    ("red flag", "wildfire"), ("fire", "wildfire"),
    ("heat", "heat"),
    ("air quality", "air_quality"), ("smoke", "air_quality"), ("air stagnation", "air_quality"),
    ("hazardous materials", "hazmat"), ("radiological", "hazmat"), ("nuclear", "hazmat"),
    ("civil danger", "conflict"), ("civil emergency", "other"),
    ("law enforcement", "crime"), ("child abduction", "crime"), ("blue alert", "crime"),
    ("shelter in place", "other"), ("evacuation", "other"), ("local area emergency", "other"),
    ("911 telephone outage", "other"),
)

# CAP severity, most severe first.
SEVERITY_RANK = {"Extreme": 4, "Severe": 3, "Moderate": 2, "Minor": 1, "Unknown": 0}


def hazard_from_same_code(code: str | None) -> str | None:
    """'EQW' -> 'earthquake'; test/admin codes and unknown codes -> None."""
    if not code:
        return None
    return SAME_CODE_HAZARD.get(code.strip().upper())


def hazard_from_event_name(event: str | None) -> str | None:
    """NWS event name, e.g. 'Flash Flood Warning' -> 'flood'. None when nothing matches."""
    if not event:
        return None
    text = event.lower()
    if "test" in text.split() or "administrative" in text:
        return None
    for keyword, hazard in NWS_EVENT_KEYWORDS:
        if keyword in text:
            return hazard
    return None
