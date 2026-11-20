"""Relative hazard exposure of one grid cell (0-100). Pure functions, no I/O.

The score says how exposed a cell is compared with other cells for the same
hazard. It is NOT a probability that anything happens there.

    zone    Z = 1.0 * s_high + 0.6 * s_moderate + 0.3 * s_low
            s_* = share of the cell covered by official hazard zones of that
            level. Shares are cumulative (s_high <= s_high+moderate <= s_any)
            so a higher level wins where zones overlap and Z <= 1. Where two
            sources map the same hazard (FEMA and the city's flood-prone areas),
            the larger share of any one source is used, not the sum.
    terrain T (0..1), per hazard:
            lowland L = 1 at sea level, falling linearly to 0 at 20 m (median
                        land elevation of the cell). Counts in full within 500 m
                        of a mapped zone of the hazard, fading to 0 at 1 km
                        (zone edges are modelled, so equally low ground right
                        next to a zone is also at risk; far from any zone, low
                        ground alone means nothing, e.g. a lakeshore and a tsunami).
            slope   S = 0 at 10 degrees, rising linearly to 1 at 30 degrees
                        (90th percentile of pixel slopes in the cell).
            tsunami, volcano (lahar): T = gated L
            flood (incl. rain-triggered landslides): T = max(gated L, S)
            earthquake (liquefaction, landslides): T = S
    hazard  H = 0.75 * Z + 0.25 * T
    access  A = distance to the nearest suitable safe place for the hazard,
            0 at the door, 1 at 3 km or more (none known: 1).
    score   = round(100 * H * (0.85 + 0.15 * A))
            so a far-away shelter raises exposure by at most 15 %, and a cell
            with no hazard footprint scores 0 however far the shelter is.
    level   high >= 50, moderate >= 20, low below.
"""

from __future__ import annotations

LEVEL_WEIGHTS = {"high": 1.0, "moderate": 0.6, "low": 0.3}
ZONE_WEIGHT, TERRAIN_WEIGHT = 0.75, 0.25
ACCESS_SHARE = 0.15
LOWLAND_ZERO_M = 20.0
SLOPE_FROM_DEG, SLOPE_FULL_DEG = 10.0, 30.0
GATE_FULL_M, GATE_ZERO_M = 500.0, 1000.0
ACCESS_FULL_M = 3000.0
LEVEL_HIGH, LEVEL_MODERATE = 50, 20
SCORED_HAZARDS = ("tsunami", "flood", "earthquake", "volcano")
TERRAIN_RULE = {"tsunami": "lowland", "volcano": "lowland", "flood": "lowland+slope", "earthquake": "slope"}


def clamp01(x: float) -> float:
    return 0.0 if x < 0 else 1.0 if x > 1 else x


def zone_factor(s_high: float, s_high_mod: float, s_all: float) -> float:
    """Shares are cumulative: s_high <= s_high_mod (high or moderate) <= s_all (any level)."""
    s_high, s_high_mod, s_all = clamp01(s_high), clamp01(s_high_mod), clamp01(s_all)
    s_high_mod, s_all = max(s_high_mod, s_high), max(s_all, s_high_mod, s_high)
    return clamp01(LEVEL_WEIGHTS["high"] * s_high
                   + LEVEL_WEIGHTS["moderate"] * (s_high_mod - s_high)
                   + LEVEL_WEIGHTS["low"] * (s_all - s_high_mod))


def lowland_factor(elev_m: float | None) -> float:
    if elev_m is None:
        return 0.0
    return clamp01(1.0 - elev_m / LOWLAND_ZERO_M)


def slope_factor(slope_deg: float | None) -> float:
    if slope_deg is None:
        return 0.0
    return clamp01((slope_deg - SLOPE_FROM_DEG) / (SLOPE_FULL_DEG - SLOPE_FROM_DEG))


def zone_gate(zone_dist_m: float | None) -> float:
    """1 within 500 m of a mapped zone, 0 beyond 1 km (or when the hazard has no zones)."""
    if zone_dist_m is None:
        return 0.0
    if zone_dist_m <= GATE_FULL_M:
        return 1.0
    return clamp01(1.0 - (zone_dist_m - GATE_FULL_M) / (GATE_ZERO_M - GATE_FULL_M))


def access_factor(place_dist_m: float | None) -> float:
    if place_dist_m is None:
        return 1.0
    return clamp01(place_dist_m / ACCESS_FULL_M)


def level_for(score: int) -> str:
    if score >= LEVEL_HIGH:
        return "high"
    if score >= LEVEL_MODERATE:
        return "moderate"
    return "low"


def exposure(hazard: str, s_high: float, s_high_mod: float, s_all: float, elev_m: float | None,
             slope_deg: float | None, zone_dist_m: float | None, place_dist_m: float | None) -> dict:
    """Score, level and the factors behind them for one cell and hazard."""
    rule = TERRAIN_RULE[hazard]
    z = zone_factor(s_high, s_high_mod, s_all)
    lowland = lowland_factor(elev_m) * zone_gate(zone_dist_m) if "lowland" in rule else 0.0
    slope = slope_factor(slope_deg) if "slope" in rule else 0.0
    t = max(lowland, slope)
    h = ZONE_WEIGHT * z + TERRAIN_WEIGHT * t
    a = access_factor(place_dist_m)
    score = round(100 * clamp01(h) * (1 - ACCESS_SHARE + ACCESS_SHARE * a))
    return {
        "score": score,
        "level": level_for(score),
        "factors": {
            "zone": round(z, 3),
            "zoneShare": {"high": round(s_high, 3), "moderate": round(max(s_high_mod - s_high, 0), 3),
                          "low": round(max(s_all - s_high_mod, 0), 3)},
            "terrain": round(t, 3),
            "lowland": round(lowland, 3),
            "slope": round(slope, 3),
            "access": round(a, 3),
            "elevationM": None if elev_m is None else round(elev_m, 1),
            "slopeDeg": None if slope_deg is None else round(slope_deg, 1),
            "zoneDistanceM": None if zone_dist_m is None else round(zone_dist_m),
            "placeDistanceM": None if place_dist_m is None else round(place_dist_m),
        },
    }
