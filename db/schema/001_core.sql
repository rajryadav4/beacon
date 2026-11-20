-- ============================================================
-- CrimeRadar Showcase: core schema (PostgreSQL 16 + PostGIS)
-- Port of the milestone 2 MySQL model in sql/crime_radar_all.sql.
--
-- Changes from the MySQL version:
--   * snake_case names (Postgres folds unquoted names to lower case)
--   * IDENTITY keys instead of AUTO_INCREMENT
--   * every point is a real PostGIS column (geography(Point, 4326)); the
--     latitude/longitude numbers are kept for the grid formula, which must match
--     the Python pipeline and the browser bit for bit
--   * times are timestamptz; SPD times are Seattle local time and are converted
--     with AT TIME ZONE 'America/Los_Angeles' when loaded
--   * the generated milestone sample rows are not created (the app never used them)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE data_sources (
    source_id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_name        varchar(150) NOT NULL,
    dataset_identifier varchar(100) UNIQUE,
    source_url         varchar(500),
    last_imported_at   timestamptz
);

CREATE TABLE police_precincts (
    precinct_id   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    precinct_name varchar(100) NOT NULL UNIQUE
);

CREATE TABLE crime_categories (
    category_id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    category_name          varchar(150) NOT NULL,
    nibrs_group            varchar(50),
    crime_against_category varchar(100),
    UNIQUE (category_name, nibrs_group, crime_against_category)
);

CREATE TABLE neighborhoods (
    neighborhood_id   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    neighborhood_name varchar(150) NOT NULL UNIQUE,
    precinct_id       integer REFERENCES police_precincts (precinct_id)
);

CREATE TABLE app_users (
    user_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    display_name  varchar(100) NOT NULL,
    email         varchar(255) NOT NULL UNIQUE,
    password_hash varchar(255) NOT NULL,
    created_at    timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE routes (
    route_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    route_name      varchar(150),
    start_point     geography(Point, 4326) NOT NULL,
    end_point       geography(Point, 4326) NOT NULL,
    path            geography(LineString, 4326),
    distance_meters integer CHECK (distance_meters IS NULL OR distance_meters >= 0)
);

CREATE TABLE crime_incidents (
    incident_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_id         integer NOT NULL REFERENCES data_sources (source_id),
    source_offense_id varchar(100),
    report_number     varchar(100),
    occurred_at       timestamptz,
    reported_at       timestamptz,
    category_id       integer NOT NULL REFERENCES crime_categories (category_id),
    neighborhood_id   integer REFERENCES neighborhoods (neighborhood_id),
    precinct_id       integer REFERENCES police_precincts (precinct_id),
    block_address     varchar(255),
    latitude          double precision,
    longitude         double precision,
    geom              geography(Point, 4326)
        GENERATED ALWAYS AS (
            CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL
                 THEN ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
            END) STORED,
    beat              varchar(50),
    UNIQUE (source_id, source_offense_id)
);
CREATE INDEX ix_crime_incidents_occurred ON crime_incidents (occurred_at);
CREATE INDEX ix_crime_incidents_neighborhood ON crime_incidents (neighborhood_id);
CREATE INDEX ix_crime_incidents_category ON crime_incidents (category_id);
CREATE INDEX ix_crime_incidents_geom ON crime_incidents USING gist (geom);

CREATE TABLE emergency_calls (
    call_id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_id       integer NOT NULL REFERENCES data_sources (source_id),
    source_call_id  varchar(100),
    call_time       timestamptz,
    call_type       varchar(150),
    neighborhood_id integer REFERENCES neighborhoods (neighborhood_id),
    geom            geography(Point, 4326),
    UNIQUE (source_id, source_call_id)
);
CREATE INDEX ix_emergency_calls_time ON emergency_calls (call_time);
CREATE INDEX ix_emergency_calls_geom ON emergency_calls USING gist (geom);

CREATE TABLE emergency_contacts (
    contact_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      bigint NOT NULL REFERENCES app_users (user_id) ON DELETE CASCADE,
    contact_name varchar(150) NOT NULL,
    phone_number varchar(30)  NOT NULL,
    relationship varchar(100)
);

CREATE TYPE sos_status AS ENUM ('ACTIVE', 'RESOLVED', 'CANCELLED');

CREATE TABLE sos_alerts (
    alert_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      bigint NOT NULL REFERENCES app_users (user_id) ON DELETE CASCADE,
    alert_time   timestamptz NOT NULL DEFAULT now(),
    geom         geography(Point, 4326),
    alert_status sos_status  NOT NULL DEFAULT 'ACTIVE'
);

CREATE TABLE route_segments (
    segment_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    route_id        bigint  NOT NULL REFERENCES routes (route_id) ON DELETE CASCADE,
    segment_order   integer NOT NULL CHECK (segment_order >= 1),
    neighborhood_id integer REFERENCES neighborhoods (neighborhood_id),
    distance_meters integer CHECK (distance_meters IS NULL OR distance_meters >= 0),
    UNIQUE (route_id, segment_order)
);

CREATE TYPE recommendation_type AS ENUM ('SAFEST', 'FASTEST', 'BALANCED');

CREATE TABLE route_recommendations (
    recommendation_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id             bigint REFERENCES app_users (user_id) ON DELETE CASCADE,
    route_id            bigint NOT NULL REFERENCES routes (route_id),
    requested_at        timestamptz NOT NULL DEFAULT now(),
    estimated_risk      numeric(8, 4) CHECK (estimated_risk IS NULL OR estimated_risk >= 0),
    recommendation_type recommendation_type NOT NULL DEFAULT 'BALANCED'
);
CREATE INDEX ix_route_recommendations_user_time ON route_recommendations (user_id, requested_at);
