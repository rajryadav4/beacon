"""Official alerts for a location, an alerts map layer and feed freshness.

Filled by pipeline/ingest_alerts.py / pipeline/alerts_worker.py (db/schema/004_alerts.sql).
The caller's coordinates are used for one query and never stored or logged:
uvicorn's access log line for these requests has lat/lng redacted.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response

from ..alerts_rules import hide_call, incident_hazard, is_survival, severity_rank
from ..db import pool
from ..hazard_taxonomy import HAZARDS

router = APIRouter(tags=["alerts"])

INCIDENT_RADIUS_M = 1000
INCIDENT_HOURS = 2
SEATTLE_FIRE_DATASET = "kzjm-xkqj"
FEEDS = {
    "nws": "National Weather Service alerts",
    "usgs": "USGS earthquakes (M2.5+, past day)",
    "ipaws": "FEMA IPAWS alert archive (OpenFEMA, delayed)",
    "seattle_fire": "Seattle Fire real-time 911 dispatches",
}
# An alert is active until it ends; a message without `expires` counts for a day
# after it was sent (the same rule as pipeline/ingest_alerts.py END_TIME_SQL).
ACTIVE_SQL = """a.ended_at IS NULL AND a.status = 'Actual' AND a.msg_type IS DISTINCT FROM 'Cancel'
    AND coalesce(a.expires, a.sent + interval '1 day', a.fetched_at + interval '1 day') > now()"""


# ---- never log the caller's location ------------------------------

_COORD_PARAM = re.compile(r"((?:^|[?&])(?:lat|lng|lon|latitude|longitude)=)[^&\s]*", re.IGNORECASE)


class _RedactLocation(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple) and record.args:
            record.args = tuple(_COORD_PARAM.sub(r"\1redacted", a) if isinstance(a, str) else a
                                for a in record.args)
        return True


def redact(text: str) -> str:
    return _COORD_PARAM.sub(r"\1redacted", text)


logging.getLogger("uvicorn.access").addFilter(_RedactLocation())


# ---- helpers ---------------------------------------------------

def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _updated_at(conn) -> str | None:
    row = conn.execute("SELECT max(last_success_at) FROM alert_feed_status").fetchone()
    return _iso(row[0]) if row else None


def sort_alerts(alerts: list[dict]) -> list[dict]:
    """Most severe first, then by onset (earliest first; missing onset last)."""
    latest = datetime.max.replace(tzinfo=timezone.utc)
    return sorted(alerts, key=lambda a: (-severity_rank(a["severity"]), a["_onset"] or latest))


def parse_bbox(value: str) -> tuple[float, float, float, float]:
    try:
        west, south, east, north = (float(v) for v in value.split(","))
    except ValueError:
        raise HTTPException(422, "bbox must be west,south,east,north in degrees")
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise HTTPException(422, "bbox must be west,south,east,north with west < east and south < north")
    return west, south, east, north


# ---- endpoints -------------------------------------------------

ACTIVE_FOR_POINT = f"""
WITH p AS (SELECT ST_SetSRID(ST_MakePoint(%(lng)s, %(lat)s), 4326) AS g)
SELECT a.alert_id, a.source, a.event, a.hazard, a.severity, a.urgency, a.certainty, a.status,
       a.headline, a.description, a.instruction, a.area_desc, a.sender, a.effective, a.expires,
       a.url, a.magnitude::float8,
       CASE WHEN a.geom IS NULL AND a.point IS NOT NULL
            THEN ST_Distance(a.point, p.g::geography) / 1000 ELSE 0 END AS distance_km,
       coalesce(a.onset, a.effective, a.sent) AS onset
FROM alerts a, p
WHERE {ACTIVE_SQL}
  AND ((a.geom IS NOT NULL AND ST_Covers(a.geom, p.g))
       OR (a.geom IS NULL AND a.point IS NOT NULL
           AND ST_DWithin(a.point, p.g::geography, a.radius_km * 1000)))
"""

INCIDENTS_NEAR = f"""
WITH p AS (SELECT ST_SetSRID(ST_MakePoint(%(lng)s, %(lat)s), 4326)::geography AS g)
SELECT e.call_id, e.call_type, e.call_time, ST_Distance(e.geom, p.g) / 1000 AS distance_km
FROM emergency_calls e
JOIN data_sources d ON d.source_id = e.source_id AND d.dataset_identifier = '{SEATTLE_FIRE_DATASET}'
CROSS JOIN p
WHERE e.call_time > now() - interval '{INCIDENT_HOURS} hours'
  AND ST_DWithin(e.geom, p.g, {INCIDENT_RADIUS_M})
ORDER BY e.call_time DESC
LIMIT 200
"""


@router.get("/alerts/active")
def active_alerts(
    response: Response,
    lat: Annotated[float, Query(ge=-90, le=90)],
    lng: Annotated[float, Query(ge=-180, le=180)],
) -> dict:
    """Alerts that cover the point, nearby Seattle Fire incidents, and whether survival mode applies."""
    response.headers["Cache-Control"] = "no-store"
    point = {"lat": lat, "lng": lng}
    with pool.connection() as conn:
        rows = conn.execute(ACTIVE_FOR_POINT, point).fetchall()
        calls = conn.execute(INCIDENTS_NEAR, point).fetchall()
        updated_at = _updated_at(conn)

    alerts = []
    survival = False
    for (alert_id, source, event, hazard, severity, urgency, certainty, status, headline, description,
         instruction, area_desc, sender, effective, expires, url, magnitude, distance_km, onset) in rows:
        survival = survival or is_survival({"severity": severity, "urgency": urgency, "status": status})
        alerts.append({
            "id": alert_id, "source": source, "event": event, "hazard": hazard,
            "hazardLabel": HAZARDS.get(hazard, HAZARDS["other"])["label"],
            "severity": severity, "urgency": urgency, "certainty": certainty,
            "headline": headline, "description": description, "instruction": instruction,
            "areaDesc": area_desc, "sender": sender,
            "effective": _iso(effective), "expires": _iso(expires), "url": url,
            "magnitude": magnitude, "distanceKm": round(distance_km, 1),
            "_onset": onset,
        })
    alerts = sort_alerts(alerts)
    for a in alerts:
        del a["_onset"]

    incidents = [
        {"id": call_id, "type": call_type, "hazard": incident_hazard(call_type),
         "time": _iso(call_time), "distanceKm": round(distance_km, 2)}
        for call_id, call_type, call_time, distance_km in calls
        if not hide_call(call_type)
    ]
    return {
        "location": point,
        "alerts": alerts,
        "incidents": incidents,
        "survival": survival,
        "topHazard": alerts[0]["hazard"] if alerts else None,
        "updatedAt": updated_at,
    }


ALERTS_IN_BBOX = f"""
WITH b AS (SELECT ST_MakeEnvelope(%s, %s, %s, %s, 4326) AS env)
SELECT json_build_object('type', 'FeatureCollection', 'features', coalesce(json_agg(json_build_object(
    'type', 'Feature',
    'id', a.alert_id,
    'geometry', ST_AsGeoJSON(coalesce(ST_Multi(ST_SimplifyPreserveTopology(a.geom, 0.001)), a.point::geometry), 5)::json,
    'properties', json_build_object('id', a.alert_id, 'event', a.event, 'hazard', a.hazard,
                                    'severity', a.severity, 'headline', a.headline, 'expires', a.expires)
) ORDER BY a.alert_id), '[]'::json))::text
FROM alerts a, b
WHERE {ACTIVE_SQL}
  AND ((a.geom IS NOT NULL AND ST_Intersects(a.geom, b.env))
       OR (a.geom IS NULL AND a.point IS NOT NULL
           AND ST_DWithin(a.point, b.env::geography, a.radius_km * 1000)))
"""


@router.get("/alerts")
def alerts_layer(bbox: Annotated[str, Query(description="west,south,east,north")]) -> Response:
    """Active alerts in a bounding box as GeoJSON (polygons, or epicenter points for earthquakes)."""
    west, south, east, north = parse_bbox(bbox)
    with pool.connection() as conn:
        text = conn.execute(ALERTS_IN_BBOX, (west, south, east, north)).fetchone()[0]
    return Response(content=text, media_type="application/geo+json",
                    headers={"Cache-Control": "public, max-age=60"})


@router.get("/alerts/status")
def alerts_status() -> dict:
    """Per-source freshness: last fetch, last error, items in the last fetch, active and stored counts."""
    with pool.connection() as conn:
        status = {r[0]: r[1:] for r in conn.execute(
            "SELECT feed, last_attempt_at, last_success_at, last_error, last_count, newest_item_at"
            " FROM alert_feed_status").fetchall()}
        counts = {r[0]: (r[1], r[2]) for r in conn.execute(
            f"SELECT a.source, count(*) FILTER (WHERE {ACTIVE_SQL}), count(*) FROM alerts a GROUP BY a.source"
        ).fetchall()}
        calls = conn.execute(
            f"SELECT count(*) FILTER (WHERE e.call_time > now() - interval '{INCIDENT_HOURS} hours'), count(*)"
            " FROM emergency_calls e JOIN data_sources d ON d.source_id = e.source_id"
            f" WHERE d.dataset_identifier = '{SEATTLE_FIRE_DATASET}'").fetchone()
        updated_at = _updated_at(conn)
    counts["seattle_fire"] = calls
    sources = []
    for feed, name in FEEDS.items():
        attempt, success, error, last_count, newest = status.get(feed, (None,) * 5)
        active, total = counts.get(feed, (0, 0))
        sources.append({
            "source": feed, "name": name,
            "lastAttemptAt": _iso(attempt), "lastSuccessAt": _iso(success), "lastError": error,
            "lastCount": last_count, "newestItemAt": _iso(newest),
            "active": active, "total": total,
        })
    return {"sources": sources, "updatedAt": updated_at}
