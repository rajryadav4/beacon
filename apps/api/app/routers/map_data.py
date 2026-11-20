"""Map data: meta, crime heatmap and ML risk grid.

GeoJSON is built inside Postgres (json_agg + ST_AsGeoJSON) and returned as-is,
so a request never builds thousands of Python objects.
"""

from __future__ import annotations

from datetime import date
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response

from ..db import pool

router = APIRouter(tags=["map"])

GRID = {"lat0": 47.48, "lng0": -122.46, "dLat": 0.002, "dLng": 0.003, "rows": 135, "cols": 80}
RISK_UNIT = "expected severity-weighted incidents per year in the cell during the band"
BAND_KEYS = {"night": 0, "morning": 1, "afternoon": 2, "evening": 3}
GROUP_KEYS = ["violent", "robbery", "theft", "vehicle", "burglary", "vandalism", "drugs", "other"]
CACHE = {"Cache-Control": "public, max-age=300"}
# SPD neighborhood names that are not real areas: never ranked (docs/API.md section 1).
UNRANKED = {"-", "UNKNOWN", "OOJ", "FK ERROR"}
CELL_KM2 = 0.0501
# Human-readable names, as in the class pipeline (pipeline/crime_data.py NAME_FIXES).
NAME_FIXES = {
    "SLU/CASCADE": "South Lake Union / Cascade",
    "LAKECITY": "Lake City",
    "BITTERLAKE": "Bitter Lake",
    "SANDPOINT": "Sand Point",
    "DOWNTOWN COMMERCIAL": "Downtown",
    "CHINATOWN/INTERNATIONAL DISTRICT": "Chinatown-International District",
    "UNIVERSITY": "University District",
    "SODO": "SODO",
    "COMMERCIAL DUWAMISH": "Duwamish (Industrial)",
    "COMMERCIAL HARBOR ISLAND": "Harbor Island",
    "FAUNTLEROY SW": "Fauntleroy",
    "NEW HOLLY": "NewHolly",
    "EASTLAKE - EAST": "Eastlake East",
    "EASTLAKE - WEST": "Eastlake West",
    "MORGAN": "Morgan Junction",
}


def display_name(key: str) -> str:
    """SPD neighborhood key -> display name ("ROOSEVELT/RAVENNA" -> "Roosevelt / Ravenna")."""
    if key in NAME_FIXES:
        return NAME_FIXES[key]
    return " / ".join(part.strip().title() for part in key.split("/"))


def data_years(start: str | None, end: str | None) -> float:
    """Length of the data range in years (at least 0.25), as meta.json `dataRange.years`."""
    try:
        days = (date.fromisoformat(end) - date.fromisoformat(start)).days  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 4.0
    return max(0.25, round(days / 365.25, 2))


def parse_band(value: str, allow_all: bool) -> int | None:
    """'evening' or '3' -> 3; 'all' -> None (heatmap only)."""
    value = value.strip().lower()
    if allow_all and value == "all":
        return None
    if value in BAND_KEYS:
        return BAND_KEYS[value]
    if value.isdigit() and int(value) in BAND_KEYS.values():
        return int(value)
    choices = ("all, " if allow_all else "") + ", ".join(BAND_KEYS) + " or 0-3"
    raise HTTPException(422, f"band must be {choices}")


def parse_groups(value: str | None) -> list[int]:
    if not value:
        return list(range(len(GROUP_KEYS)))
    ids = []
    for part in value.split(","):
        part = part.strip().lower()
        if part in GROUP_KEYS:
            ids.append(GROUP_KEYS.index(part))
        elif part.isdigit() and int(part) < len(GROUP_KEYS):
            ids.append(int(part))
        elif part:
            raise HTTPException(422, f"unknown crime group '{part}'; use {', '.join(GROUP_KEYS)}")
    return sorted(set(ids))


def json_response(text: str) -> Response:
    return Response(content=text, media_type="application/json", headers=CACHE)


@router.get("/meta")
def meta() -> dict:
    """Data range, totals, grid, lookups, risk thresholds and the active model (docs/API.md `api/meta`)."""
    with pool.connection() as conn:
        app_meta = dict(conn.execute("SELECT meta_key, meta_value FROM app_meta").fetchall())
        bands = conn.execute(
            "SELECT band_id, band_key, label, hours_label FROM time_bands ORDER BY band_id").fetchall()
        groups = conn.execute(
            "SELECT group_id, group_key, label, severity FROM crime_groups ORDER BY group_id").fetchall()
        modes = conn.execute(
            "SELECT mode_key, label, vulnerability FROM travel_modes ORDER BY vulnerability DESC").fetchall()
        model = conn.execute(
            "SELECT model_version, trained_at, algorithm, metrics FROM model_runs WHERE is_active").fetchone()
        source = conn.execute(
            "SELECT source_name, dataset_identifier, source_url, last_imported_at FROM data_sources"
            " WHERE dataset_identifier = 'tazs-3rd5'").fetchone()

    metrics = (model[3] if model else None) or {}
    meta_model = metrics.get("metaModel", {})
    return {
        "version": 1,
        "generatedAt": app_meta.get("builtAt"),
        "source": source and {"name": source[0], "id": source[1], "url": source[2],
                              "importedAt": source[3].isoformat() if source[3] else None},
        "dataRange": {"from": app_meta.get("dataFrom"), "to": app_meta.get("dataTo"),
                      "years": data_years(app_meta.get("dataFrom"), app_meta.get("dataTo"))},
        "totals": {k: int(app_meta[k]) for k in ("incidents", "located", "excluded", "unknownTime")
                   if k in app_meta},
        "grid": GRID,
        "bands": [{"id": b[0], "key": b[1], "label": b[2], "hours": b[3]} for b in bands],
        "groups": [{"id": g[0], "key": g[1], "label": g[2], "severity": float(g[3])} for g in groups],
        "modes": {m[0]: {"label": m[1], "vulnerability": float(m[2])} for m in modes},
        "risk": {"unit": RISK_UNIT, "quantiles": metrics.get("quantiles"), "levels": metrics.get("levels")},
        "model": model and {
            "version": model[0],
            "trainedAt": model[1].isoformat(),
            "algorithm": model[2],
            "trainedOn": meta_model.get("trainedOn"),
            "metrics": meta_model.get("metrics"),
            "baseline": meta_model.get("baseline"),
        },
    }


@router.get("/heatmap")
def heatmap(
    band: Annotated[str, Query(description="all, night, morning, afternoon, evening or 0-3")] = "all",
    groups: Annotated[str | None, Query(description="comma-separated crime groups; default all")] = None,
) -> Response:
    """Located incidents per grid cell as GeoJSON points at the cell centers.

    `count` = incidents over the whole data range; `weight` = severity-weighted count.
    Offenses with no known time of day are not included (docs/API.md section 1).
    """
    band_id = parse_band(band, allow_all=True)
    group_ids = parse_groups(groups)
    sql = """
        SELECT json_build_object(
            'type', 'FeatureCollection',
            'features', COALESCE(json_agg(json_build_object(
                'type', 'Feature',
                'geometry', ST_AsGeoJSON(g.center, 6)::json,
                'properties', json_build_object('cellId', s.cell_id, 'count', s.cnt,
                                                'weight', round(s.weighted, 2))
            ) ORDER BY s.cell_id), '[]'::json)
        )::text
        FROM (
            SELECT cs.cell_id, sum(cs.incident_count) AS cnt,
                   sum(cs.incident_count * cg.severity) AS weighted
            FROM cell_stats cs
            JOIN crime_groups cg ON cg.group_id = cs.group_id
            WHERE cs.group_id = ANY(%(groups)s)
              AND (%(band)s::smallint IS NULL OR cs.time_band = %(band)s::smallint)
            GROUP BY cs.cell_id
        ) s
        JOIN grid_cells g ON g.cell_id = s.cell_id
    """
    with pool.connection() as conn:
        text = conn.execute(sql, {"groups": group_ids, "band": band_id}).fetchone()[0]
    return json_response(text)


@router.get("/risk")
def risk(
    band: Annotated[str, Query(description="night, morning, afternoon, evening or 0-3")] = "evening",
) -> Response:
    """ML risk of every scored grid cell for one time band, as GeoJSON cell polygons (active model)."""
    band_id = parse_band(band, allow_all=False)
    sql = """
        SELECT json_build_object(
            'type', 'FeatureCollection',
            'model', (SELECT model_version FROM model_runs WHERE is_active),
            'band', %(band)s::int,
            'features', COALESCE(json_agg(json_build_object(
                'type', 'Feature',
                'id', r.cell_id,
                'geometry', ST_AsGeoJSON(g.cell, 6)::json,
                'properties', json_build_object(
                    'cellId', r.cell_id,
                    'risk', round(r.expected_risk, 2),
                    'level', r.level,
                    'neighborhood', n.neighborhood_name)
            ) ORDER BY r.cell_id), '[]'::json)
        )::text
        FROM cell_risk_scores r
        JOIN model_runs m ON m.model_version = r.model_version AND m.is_active
        JOIN grid_cells g ON g.cell_id = r.cell_id
        LEFT JOIN neighborhoods n ON n.neighborhood_id = g.neighborhood_id
        WHERE r.time_band = %(band)s::smallint
    """
    with pool.connection() as conn:
        text = conn.execute(sql, {"band": band_id}).fetchone()[0]
    return json_response(text)


# ---- Class-app contract: grid.json and neighborhoods.json (docs/API.md section 2) ----

def ranked_neighborhoods(conn) -> list[dict]:
    """Real neighborhoods sorted by display name; their list index is the grid's `nbIndex`."""
    rows = conn.execute(
        """SELECT n.neighborhood_id, n.neighborhood_name, p.precinct_name
           FROM neighborhoods n LEFT JOIN police_precincts p ON p.precinct_id = n.precinct_id""").fetchall()
    hoods = [{"id": r[0], "key": r[1], "name": display_name(r[1]), "precinct": r[2]}
             for r in rows if r[1] and r[1].strip().upper() not in UNRANKED]
    hoods.sort(key=lambda h: h["name"].casefold())
    return hoods


@router.get("/grid")
def grid() -> dict:
    """Every grid cell with at least one located incident: `[cellId, nbIndex, counts[32], risk[4]]`.

    `counts[band * 8 + group]` = located incidents over the data range; `risk` = active model risk per band.
    `nbIndex` points into `GET /api/neighborhoods` (-1 = none).
    """
    with pool.connection() as conn:
        hoods = ranked_neighborhoods(conn)
        stats = conn.execute("SELECT cell_id, time_band, group_id, incident_count FROM cell_stats").fetchall()
        risks = conn.execute(
            """SELECT r.cell_id, r.time_band, r.expected_risk FROM cell_risk_scores r
               JOIN model_runs m ON m.model_version = r.model_version AND m.is_active""").fetchall()
        owners = dict(conn.execute(
            "SELECT cell_id, neighborhood_id FROM grid_cells WHERE neighborhood_id IS NOT NULL").fetchall())
    index = {h["id"]: i for i, h in enumerate(hoods)}
    counts: dict[int, list[int]] = {}
    for cell_id, band, group, n in stats:
        if 0 <= band < 4 and 0 <= group < 8:
            counts.setdefault(cell_id, [0] * 32)[band * 8 + group] += int(n)
    risk: dict[int, list[float]] = {}
    for cell_id, band, value in risks:
        if 0 <= band < 4:
            risk.setdefault(cell_id, [0.0] * 4)[band] = round(float(value), 2)
    cells = [[cell_id, index.get(owners.get(cell_id), -1), c, risk.get(cell_id, [0.0] * 4)]
             for cell_id, c in sorted(counts.items()) if any(c)]
    return {"version": 1, "cells": cells}


@router.get("/neighborhoods")
def neighborhoods() -> dict:
    """The ranked neighborhoods, sorted by name, with 32 counts (located + unlocated) each."""
    with pool.connection() as conn:
        hoods = ranked_neighborhoods(conn)
        stats = conn.execute(
            "SELECT neighborhood_id, time_band, group_id, incident_count, located_count FROM neighborhood_stats"
        ).fetchall()
        # Center: incident-weighted mean of the neighborhood's cell centers (located incidents per cell).
        centers = conn.execute(
            """SELECT g.neighborhood_id, count(*) AS cells,
                      sum(ST_Y(g.center::geometry) * COALESCE(s.n, 0)) / NULLIF(sum(COALESCE(s.n, 0)), 0),
                      sum(ST_X(g.center::geometry) * COALESCE(s.n, 0)) / NULLIF(sum(COALESCE(s.n, 0)), 0),
                      avg(ST_Y(g.center::geometry)), avg(ST_X(g.center::geometry))
               FROM grid_cells g
               LEFT JOIN (SELECT cell_id, sum(incident_count) AS n FROM cell_stats GROUP BY cell_id) s
                      ON s.cell_id = g.cell_id
               WHERE g.neighborhood_id IS NOT NULL
               GROUP BY g.neighborhood_id""").fetchall()
    by_id: dict[int, dict] = {h["id"]: {"counts": [0] * 32, "unlocated": 0} for h in hoods}
    for hood_id, band, group, n, located in stats:
        row = by_id.get(hood_id)
        if row is None or not (0 <= band < 4 and 0 <= group < 8):
            continue
        row["counts"][band * 8 + group] += int(n)
        row["unlocated"] += int(n) - int(located or 0)
    geo = {r[0]: r[1:] for r in centers}
    out = []
    for h in hoods:
        cells, wlat, wlng, alat, alng = geo.get(h["id"], (0, None, None, None, None))
        lat, lng = (wlat, wlng) if wlat is not None else (alat, alng)
        if lat is None:
            continue
        out.append({
            "key": h["key"], "name": h["name"], "precinct": h["precinct"],
            "lat": round(float(lat), 5), "lng": round(float(lng), 5),
            "cells": int(cells), "areaKm2": round(int(cells) * CELL_KM2, 2),
            "counts": by_id[h["id"]]["counts"], "unlocated": by_id[h["id"]]["unlocated"],
        })
    return {"version": 1, "neighborhoods": out}
