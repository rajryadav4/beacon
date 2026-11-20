"""Map data: meta, crime heatmap and ML risk grid.

GeoJSON is built inside Postgres (json_agg + ST_AsGeoJSON) and returned as-is,
so a request never builds thousands of Python objects.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response

from ..db import pool

router = APIRouter(tags=["map"])

GRID = {"lat0": 47.48, "lng0": -122.46, "dLat": 0.002, "dLng": 0.003, "rows": 135, "cols": 80}
RISK_UNIT = "expected severity-weighted incidents per year in the cell during the band"
BAND_KEYS = {"night": 0, "morning": 1, "afternoon": 2, "evening": 3}
GROUP_KEYS = ["violent", "robbery", "theft", "vehicle", "burglary", "vandalism", "drugs", "other"]
CACHE = {"Cache-Control": "public, max-age=300"}


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
        "dataRange": {"from": app_meta.get("dataFrom"), "to": app_meta.get("dataTo")},
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
