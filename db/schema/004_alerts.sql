-- ============================================================
-- Beacon: official alerts (NWS, USGS, FEMA IPAWS)
--
-- Filled by pipeline/ingest_alerts.py and pipeline/alerts_worker.py, read by
-- apps/api/app/routers/alerts.py. Idempotent: the ingest applies this file to
-- a running database too (db/schema only runs on a fresh volume).
--
-- An alert covers a point when its polygon covers it, or for earthquakes when
-- the point is within radius_km of the epicenter. NWS zone-based alerts have
-- no polygon of their own: the ingest fills geom from the cached zone shapes.
-- Rows are never deleted: ended alerts keep ended_at / end_reason as history.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS alerts (
    alert_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source        varchar(10)  NOT NULL CHECK (source IN ('nws', 'usgs', 'ipaws')),
    source_id     varchar(300) NOT NULL,
    feed          varchar(100),                 -- e.g. 'area=WA': which fetch saw it (NWS "gone" check)
    event         varchar(200),
    event_code    varchar(20),                  -- SAME / NWS code
    hazard        varchar(20)  NOT NULL,        -- key in apps/api/app/hazard_taxonomy.py
    severity      varchar(20),                  -- CAP: Extreme, Severe, Moderate, Minor, Unknown
    urgency       varchar(20),                  -- CAP: Immediate, Expected, Future, Past, Unknown
    certainty     varchar(20),                  -- CAP: Observed, Likely, Possible, Unlikely, Unknown
    status        varchar(20),                  -- CAP: Actual, Exercise, System, ...
    msg_type      varchar(20),                  -- CAP: Alert, Update, Cancel
    headline      text,
    description   text,
    instruction   text,
    area_desc     text,
    sender        varchar(300),
    sent          timestamptz,
    effective     timestamptz,
    onset         timestamptz,
    expires       timestamptz,
    ends          timestamptz,
    url           varchar(500),
    magnitude     numeric(4, 2),
    radius_km     real,                         -- earthquakes: affected radius around the epicenter
    geom          geometry(MultiPolygon, 4326),
    geom_source   varchar(10) CHECK (geom_source IN ('alert', 'zones')),
    zones         text[],                       -- NWS affectedZones URLs
    point         geography(Point, 4326),
    refs          text[],                       -- identifiers this message updates or cancels
    raw           jsonb,
    classified_by varchar(10)  NOT NULL CHECK (classified_by IN ('source', 'model', 'none')),
    confidence    real,
    first_seen_at timestamptz  NOT NULL DEFAULT now(),
    fetched_at    timestamptz  NOT NULL DEFAULT now(),
    ended_at      timestamptz,
    end_reason    varchar(20) CHECK (end_reason IN ('expired', 'superseded', 'cancelled', 'gone')),
    UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS ix_alerts_geom ON alerts USING gist (geom);
CREATE INDEX IF NOT EXISTS ix_alerts_point ON alerts USING gist (point);
CREATE INDEX IF NOT EXISTS ix_alerts_open ON alerts (source, expires) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_alerts_sent ON alerts (sent);

-- NWS zone shapes (forecast, county, fire, marine), cached by zone URL.
-- geom is NULL when the zone has no shape; fetched_at decides when to retry.
CREATE TABLE IF NOT EXISTS alert_zones (
    zone_url   varchar(300) PRIMARY KEY,
    zone_id    varchar(20),
    zone_type  varchar(30),
    name       varchar(200),
    state      varchar(10),
    geom       geometry(MultiPolygon, 4326),
    fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_alert_zones_geom ON alert_zones USING gist (geom);

-- Last fetch per feed, for GET /api/alerts/status (data freshness).
CREATE TABLE IF NOT EXISTS alert_feed_status (
    feed            varchar(20) PRIMARY KEY,    -- nws, usgs, ipaws, seattle_fire
    last_attempt_at timestamptz,
    last_success_at timestamptz,
    last_error      text,
    last_count      integer,
    newest_item_at  timestamptz                 -- newest sent/call time in the last successful fetch
);
