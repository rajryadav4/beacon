"""One-shot ingest of official alerts and Seattle Fire 911 dispatches into Postgres.

    .venv/bin/python pipeline/ingest_alerts.py                       # all sources, NWS area WA
    .venv/bin/python pipeline/ingest_alerts.py --sources nws,usgs --area OR
    .venv/bin/python pipeline/ingest_alerts.py --sources nws --point 47.61,-122.33

Applies db/schema/004_alerts.sql first (idempotent), so it works on a database
created before the alerts tables existed. pipeline/alerts_worker.py runs the
same steps on a schedule.
"""

from __future__ import annotations

import argparse
import json
import logging
import time
from datetime import datetime

from pg import ROOT, connect

import alerts_sources as src

log = logging.getLogger("beacon.alerts")

SCHEMA_FILE = ROOT / "db" / "schema" / "004_alerts.sql"
SOURCES = ("nws", "usgs", "ipaws", "seattle_fire")
DATA_SOURCES = {
    # dataset_identifier: (name, url)
    "nws-alerts": ("NWS active alerts (api.weather.gov)", src.NWS_ALERTS_URL),
    "usgs-2.5_day": ("USGS earthquakes M2.5+, past day", src.USGS_FEED_URL),
    "ipaws-archive": ("FEMA IPAWS archived alerts (OpenFEMA)", src.IPAWS_URL),
    src.SEATTLE_FIRE_DATASET: ("Seattle Fire Real-Time 911 Dispatch", "https://data.seattle.gov/d/kzjm-xkqj"),
}
FEED_DATASET = {"nws": "nws-alerts", "usgs": "usgs-2.5_day", "ipaws": "ipaws-archive",
                "seattle_fire": src.SEATTLE_FIRE_DATASET}
ZONE_RETRY_DAYS = 1      # retry zones that had no shape after a day
ZONE_REFRESH_DAYS = 30   # zone shapes rarely change
MAX_ZONE_FETCHES = 300   # per run, to stay polite to api.weather.gov
# When an alert ends; a message without `expires` counts for a day after it was sent
# (the same rule as the API's ACTIVE_SQL).
END_TIME_SQL = "coalesce(expires, sent + interval '1 day', fetched_at + interval '1 day')"

GEOM_SQL = """CASE WHEN {p}::text IS NOT NULL THEN (
    SELECT CASE WHEN ST_IsEmpty(g) THEN NULL ELSE ST_Multi(g) END
    FROM (SELECT ST_UnaryUnion(ST_CollectionExtract(ST_MakeValid(
              ST_SetSRID(ST_GeomFromGeoJSON({p}::text), 4326)), 3)) AS g) s) END"""


def apply_schema(conn) -> None:
    conn.execute(SCHEMA_FILE.read_text())
    for dataset, (name, url) in DATA_SOURCES.items():
        conn.execute(
            "INSERT INTO data_sources (source_name, dataset_identifier, source_url)"
            " SELECT %s, %s, %s WHERE NOT EXISTS"
            " (SELECT 1 FROM data_sources WHERE dataset_identifier = %s)",
            (name, dataset, url, dataset))
    conn.commit()


# ---- writes ----------------------------------------------------

UPSERT_ALERT = f"""
INSERT INTO alerts (source, source_id, feed, event, event_code, hazard, severity, urgency, certainty,
    status, msg_type, headline, description, instruction, area_desc, sender, sent, effective, onset,
    expires, ends, url, magnitude, radius_km, geom, geom_source, zones, point, refs, raw,
    classified_by, confidence, fetched_at)
VALUES (%(source)s, %(source_id)s, %(feed)s, %(event)s, %(event_code)s, %(hazard)s, %(severity)s,
    %(urgency)s, %(certainty)s, %(status)s, %(msg_type)s, %(headline)s, %(description)s,
    %(instruction)s, %(area_desc)s, %(sender)s, %(sent)s, %(effective)s, %(onset)s, %(expires)s,
    %(ends)s, %(url)s, %(magnitude)s, %(radius_km)s, {GEOM_SQL.format(p="%(geojson)s")},
    CASE WHEN %(geojson)s::text IS NOT NULL THEN 'alert' END, %(zones)s,
    CASE WHEN %(lng)s::float8 IS NOT NULL
         THEN ST_SetSRID(ST_MakePoint(%(lng)s::float8, %(lat)s::float8), 4326)::geography END,
    %(refs)s, %(raw)s::jsonb, %(classified_by)s, %(confidence)s, now())
ON CONFLICT (source, source_id) DO UPDATE SET
    feed = EXCLUDED.feed, event = EXCLUDED.event, event_code = EXCLUDED.event_code,
    hazard = EXCLUDED.hazard, severity = EXCLUDED.severity, urgency = EXCLUDED.urgency,
    certainty = EXCLUDED.certainty, status = EXCLUDED.status, msg_type = EXCLUDED.msg_type,
    headline = EXCLUDED.headline, description = EXCLUDED.description,
    instruction = EXCLUDED.instruction, area_desc = EXCLUDED.area_desc, sender = EXCLUDED.sender,
    sent = EXCLUDED.sent, effective = EXCLUDED.effective, onset = EXCLUDED.onset,
    expires = EXCLUDED.expires, ends = EXCLUDED.ends, url = EXCLUDED.url,
    magnitude = EXCLUDED.magnitude, radius_km = EXCLUDED.radius_km,
    geom = COALESCE(EXCLUDED.geom, alerts.geom),
    geom_source = COALESCE(EXCLUDED.geom_source, alerts.geom_source),
    zones = EXCLUDED.zones, point = EXCLUDED.point, refs = EXCLUDED.refs, raw = EXCLUDED.raw,
    classified_by = EXCLUDED.classified_by, confidence = EXCLUDED.confidence, fetched_at = now(),
    ended_at = CASE WHEN alerts.end_reason = 'gone' THEN NULL ELSE alerts.ended_at END,
    end_reason = CASE WHEN alerts.end_reason = 'gone' THEN NULL ELSE alerts.end_reason END
"""


def _json_default(value):
    if isinstance(value, datetime):
        return value.isoformat()
    raise TypeError(type(value))


def upsert_alerts(conn, rows: list[dict]) -> int:
    for row in rows:
        params = dict(row)
        geometry = params.pop("geometry")
        point = params.pop("point")
        params["geojson"] = json.dumps(geometry) if geometry else None
        params["lng"], params["lat"] = point if point else (None, None)
        params["raw"] = json.dumps(params["raw"], default=_json_default)
        conn.execute(UPSERT_ALERT, params)
    # Updates and cancels end the messages they reference.
    for row in rows:
        if row["refs"] and row["msg_type"] in ("Update", "Cancel"):
            conn.execute(
                "UPDATE alerts SET ended_at = now(), end_reason = %s"
                " WHERE source = %s AND source_id = ANY(%s::text[]) AND ended_at IS NULL",
                ("cancelled" if row["msg_type"] == "Cancel" else "superseded", row["source"], row["refs"]))
        if row["msg_type"] == "Cancel":
            conn.execute(
                "UPDATE alerts SET ended_at = coalesce(ended_at, now()), end_reason = coalesce(end_reason, 'cancelled')"
                " WHERE source = %s AND source_id = %s", (row["source"], row["source_id"]))
    return len(rows)


def mark_expired(conn) -> int:
    cur = conn.execute(
        f"UPDATE alerts SET ended_at = {END_TIME_SQL}, end_reason = 'expired'"
        f" WHERE ended_at IS NULL AND {END_TIME_SQL} <= now()")
    return cur.rowcount


def mark_gone(conn, source: str, feed: str, seen_ids: list[str]) -> int:
    """Open alerts from the same feed that are no longer in it have ended."""
    cur = conn.execute(
        "UPDATE alerts SET ended_at = now(), end_reason = 'gone'"
        " WHERE source = %s AND feed = %s AND ended_at IS NULL AND NOT (source_id = ANY(%s::text[]))",
        (source, feed, seen_ids))
    return cur.rowcount


def fill_zone_geometries(conn, client) -> tuple[int, int]:
    """Fetch missing NWS zone shapes and set geom on zone-based alerts. -> (zones fetched, alerts filled)."""
    missing = [r[0] for r in conn.execute(f"""
        SELECT DISTINCT z.url
        FROM alerts a, unnest(a.zones) AS z(url)
        LEFT JOIN alert_zones c ON c.zone_url = z.url
        WHERE a.source = 'nws' AND a.geom IS NULL AND a.ended_at IS NULL
          AND (c.zone_url IS NULL
               OR (c.geom IS NULL AND c.fetched_at < now() - interval '{ZONE_RETRY_DAYS} days')
               OR c.fetched_at < now() - interval '{ZONE_REFRESH_DAYS} days')
        LIMIT {MAX_ZONE_FETCHES}""").fetchall()]
    fetched = 0
    for url in missing:
        try:
            zone = src.parse_zone(url, src.fetch_zone(client, url))
        except Exception as exc:
            log.warning("zone %s: %s", url, exc)
            continue
        geometry = zone.pop("geometry")
        zone["geojson"] = json.dumps(geometry) if geometry else None
        conn.execute(f"""
            INSERT INTO alert_zones (zone_url, zone_id, zone_type, name, state, geom, fetched_at)
            VALUES (%(zone_url)s, %(zone_id)s, %(zone_type)s, %(name)s, %(state)s,
                    {GEOM_SQL.format(p="%(geojson)s")}, now())
            ON CONFLICT (zone_url) DO UPDATE SET zone_id = EXCLUDED.zone_id, zone_type = EXCLUDED.zone_type,
                name = EXCLUDED.name, state = EXCLUDED.state, geom = EXCLUDED.geom, fetched_at = now()""",
                     zone)
        fetched += 1
    cur = conn.execute("""
        UPDATE alerts a SET geom = s.g, geom_source = 'zones'
        FROM (SELECT a2.alert_id, ST_Multi(ST_CollectionExtract(ST_UnaryUnion(ST_Collect(z.geom)), 3)) AS g
              FROM alerts a2 JOIN alert_zones z ON z.zone_url = ANY(a2.zones)
              WHERE a2.source = 'nws' AND a2.geom IS NULL AND a2.ended_at IS NULL AND z.geom IS NOT NULL
              GROUP BY a2.alert_id) s
        WHERE a.alert_id = s.alert_id AND NOT ST_IsEmpty(s.g)""")
    return fetched, cur.rowcount


def upsert_calls(conn, calls: list[dict]) -> int:
    source_id = conn.execute("SELECT source_id FROM data_sources WHERE dataset_identifier = %s",
                             (src.SEATTLE_FIRE_DATASET,)).fetchone()[0]
    for c in calls:
        conn.execute(
            """INSERT INTO emergency_calls (source_id, source_call_id, call_time, call_type, geom)
               VALUES (%s, %s, %s, %s, CASE WHEN %s::float8 IS NOT NULL
                       THEN ST_SetSRID(ST_MakePoint(%s::float8, %s::float8), 4326)::geography END)
               ON CONFLICT (source_id, source_call_id) DO UPDATE SET
                   call_time = EXCLUDED.call_time, call_type = EXCLUDED.call_type, geom = EXCLUDED.geom""",
            (source_id, c["source_call_id"], c["call_time"], c["call_type"], c["lng"], c["lng"], c["lat"]))
    return len(calls)


def record_status(conn, feed: str, ok: bool, count: int | None = None,
                  newest: datetime | None = None, error: str | None = None) -> None:
    if ok:
        conn.execute(
            """INSERT INTO alert_feed_status (feed, last_attempt_at, last_success_at, last_error, last_count, newest_item_at)
               VALUES (%s, now(), now(), NULL, %s, %s)
               ON CONFLICT (feed) DO UPDATE SET last_attempt_at = now(), last_success_at = now(),
                   last_error = NULL, last_count = EXCLUDED.last_count, newest_item_at = EXCLUDED.newest_item_at""",
            (feed, count, newest))
        conn.execute("UPDATE data_sources SET last_imported_at = now() WHERE dataset_identifier = %s",
                     (FEED_DATASET[feed],))
    else:
        conn.execute(
            """INSERT INTO alert_feed_status (feed, last_attempt_at, last_error) VALUES (%s, now(), %s)
               ON CONFLICT (feed) DO UPDATE SET last_attempt_at = now(), last_error = EXCLUDED.last_error""",
            (feed, (error or "")[:500]))


# ---- one source ------------------------------------------------

def _newest(rows: list[dict], key: str) -> datetime | None:
    times = [r[key] for r in rows if r.get(key)]
    return max(times) if times else None


def ingest_source(conn, client, name: str, area: str = "WA", point: tuple[float, float] | None = None,
                  ipaws_days: int = 7, fire_hours: int = 6) -> dict:
    """Fetch, parse and store one feed in its own transaction. -> summary dict. Raises on failure."""
    summary: dict = {"source": name}
    if name == "nws":
        feed = src.nws_feed_key(area, point)
        rows = src.parse_nws(src.fetch_nws(client, area, point), feed)
        summary["alerts"] = upsert_alerts(conn, rows)
        summary["gone"] = mark_gone(conn, "nws", feed, [r["source_id"] for r in rows])
        summary["zones_fetched"], summary["zone_filled"] = fill_zone_geometries(conn, client)
        newest = _newest(rows, "sent")
    elif name == "usgs":
        rows = src.parse_usgs(src.fetch_usgs(client))
        summary["alerts"] = upsert_alerts(conn, rows)
        newest = _newest(rows, "sent")
    elif name == "ipaws":
        records = src.fetch_ipaws(client, days=ipaws_days)
        rows = src.parse_ipaws(records)
        summary["records"] = len(records)
        summary["alerts"] = upsert_alerts(conn, rows)
        newest = max([src.parse_time(r.get("sent")) for r in records if r.get("sent")], default=None)
    elif name == "seattle_fire":
        calls = src.parse_seattle_fire(src.fetch_seattle_fire(client, hours=fire_hours))
        summary["calls"] = upsert_calls(conn, calls)
        summary["shown"] = sum(1 for c in calls if not c["hidden"])
        newest = _newest(calls, "call_time")
        rows = calls
    else:
        raise ValueError(f"unknown source {name}")
    summary["expired"] = mark_expired(conn)
    record_status(conn, name, True, count=len(rows), newest=newest)
    conn.commit()
    return summary


def run_once(conn, client, sources, **kwargs) -> list[dict]:
    results = []
    for name in sources:
        started = time.monotonic()
        try:
            summary = ingest_source(conn, client, name, **kwargs)
        except Exception as exc:
            conn.rollback()
            record_status(conn, name, False, error=f"{type(exc).__name__}: {exc}")
            conn.commit()
            summary = {"source": name, "error": f"{type(exc).__name__}: {exc}"}
        summary["seconds"] = round(time.monotonic() - started, 1)
        log.info("%s", summary)
        results.append(summary)
    return results


def parse_point(value: str | None) -> tuple[float, float] | None:
    if not value:
        return None
    lat, lng = (float(v) for v in value.split(","))
    return lat, lng


def build_parser(description: str) -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=description)
    ap.add_argument("--sources", default=",".join(SOURCES), help=f"comma list of {', '.join(SOURCES)}")
    ap.add_argument("--area", default="WA", help="NWS state/marine area code (default WA)")
    ap.add_argument("--point", help="NWS alerts for one point 'lat,lng' instead of an area")
    ap.add_argument("--ipaws-days", type=int, default=7, help="IPAWS archive window in days (default 7)")
    ap.add_argument("--fire-hours", type=int, default=6, help="Seattle Fire window in hours (default 6)")
    return ap


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # request URLs can carry a --point
    args = build_parser(__doc__.splitlines()[0]).parse_args()
    sources = [s.strip() for s in args.sources.split(",") if s.strip()]
    bad = set(sources) - set(SOURCES)
    if bad:
        raise SystemExit(f"unknown sources: {', '.join(sorted(bad))}")
    with connect() as conn, src.http_client() as client:
        apply_schema(conn)
        results = run_once(conn, client, sources, area=args.area, point=parse_point(args.point),
                           ipaws_days=args.ipaws_days, fire_hours=args.fire_hours)
    for r in results:
        print(json.dumps(r, default=str))
    if all("error" in r for r in results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
