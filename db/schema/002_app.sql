-- ============================================================
-- CrimeRadar Showcase: app layer (port of sql/app_tables.sql)
--
-- The API never scans crime_incidents per request: pipeline/load_postgres.py
-- reads it once and fills the small summary tables (cell_stats, ...).
--
-- Grid (docs/API.md section 1), the same as the class app:
--   lat0 47.48, lng0 -122.46, dLat 0.002, dLng 0.003, 135 rows x 80 cols
--   row = floor((lat - lat0) / dLat), col = floor((lng - lng0) / dLng)
--   cell_id = row * 100 + col
-- ============================================================

-- ---- Lookups -------------------------------------------------

CREATE TABLE crime_groups (
    group_id  smallint PRIMARY KEY,
    group_key varchar(20)  NOT NULL UNIQUE,
    label     varchar(60)  NOT NULL,
    severity  numeric(4, 2) NOT NULL CHECK (severity > 0)
);

INSERT INTO crime_groups (group_id, group_key, label, severity) VALUES
    (0, 'violent',   'Assault & violence',        3.00),
    (1, 'robbery',   'Robbery',                   4.00),
    (2, 'theft',     'Theft',                     1.00),
    (3, 'vehicle',   'Vehicle crime',             1.00),
    (4, 'burglary',  'Burglary & trespass',       1.50),
    (5, 'vandalism', 'Vandalism & arson',         1.00),
    (6, 'drugs',     'Drugs, weapons & disorder', 1.50),
    (7, 'other',     'Other offenses',            0.25);

CREATE TABLE time_bands (
    band_id     smallint PRIMARY KEY CHECK (band_id BETWEEN 0 AND 3),
    band_key    varchar(20) NOT NULL UNIQUE,
    label       varchar(40) NOT NULL,
    hours_label varchar(40) NOT NULL
);

INSERT INTO time_bands (band_id, band_key, label, hours_label) VALUES
    (0, 'night',     'Night',     '12 AM - 6 AM'),
    (1, 'morning',   'Morning',   '6 AM - 12 PM'),
    (2, 'afternoon', 'Afternoon', '12 PM - 6 PM'),
    (3, 'evening',   'Evening',   '6 PM - 12 AM');

CREATE TABLE travel_modes (
    mode_key      varchar(10) PRIMARY KEY,
    label         varchar(40) NOT NULL,
    vulnerability numeric(3, 2) NOT NULL CHECK (vulnerability > 0 AND vulnerability <= 1)
);

INSERT INTO travel_modes (mode_key, label, vulnerability) VALUES
    ('walk', 'Walk', 1.00),
    ('bike', 'Bike', 0.70),
    ('car',  'Car',  0.30);

CREATE TABLE app_meta (
    meta_key   varchar(40)  PRIMARY KEY,
    meta_value varchar(255) NOT NULL
);

-- NIBRS offense description -> crime group key, loaded from pipeline/category_groups.csv.
-- group_key 'exclude' drops the offense everywhere; a description that is not listed maps to 'other'.
CREATE TABLE offense_groups (
    code_description varchar(150) PRIMARY KEY,
    group_key        varchar(20)  NOT NULL
        CHECK (group_key IN ('violent', 'robbery', 'theft', 'vehicle', 'burglary',
                             'vandalism', 'drugs', 'other', 'exclude'))
);

-- ---- Grid ----------------------------------------------------

CREATE TABLE grid_cells (
    cell_id         integer  PRIMARY KEY,
    row_idx         smallint NOT NULL CHECK (row_idx BETWEEN 0 AND 134),
    col_idx         smallint NOT NULL CHECK (col_idx BETWEEN 0 AND 79),
    center          geography(Point, 4326) NOT NULL,
    cell            geometry(Polygon, 4326) NOT NULL,
    neighborhood_id integer REFERENCES neighborhoods (neighborhood_id),
    UNIQUE (row_idx, col_idx),
    CHECK (cell_id = row_idx * 100 + col_idx)
);
CREATE INDEX ix_grid_cells_cell ON grid_cells USING gist (cell);
CREATE INDEX ix_grid_cells_neighborhood ON grid_cells (neighborhood_id);

-- All 10,800 cells, so every point in the grid box has a cell.
INSERT INTO grid_cells (cell_id, row_idx, col_idx, center, cell)
SELECT r * 100 + c, r, c,
       ST_SetSRID(ST_MakePoint(-122.46 + (c + 0.5) * 0.003, 47.48 + (r + 0.5) * 0.002), 4326)::geography,
       ST_MakeEnvelope(-122.46 + c * 0.003, 47.48 + r * 0.002,
                       -122.46 + (c + 1) * 0.003, 47.48 + (r + 1) * 0.002, 4326)
FROM generate_series(0, 134) AS r
CROSS JOIN generate_series(0, 79) AS c;

-- Wanted incidents with group, Seattle-local time band and grid cell
-- (cell_id NULL when there are no coordinates or the point is off the grid).
-- known_time is false when the local time is exactly 00:00:00 (= time of day unknown).
CREATE VIEW clean_incidents AS
SELECT x.incident_id,
       x.occurred_at,
       x.local_time,
       x.category_id,
       x.neighborhood_id,
       x.precinct_id,
       x.latitude,
       x.longitude,
       x.group_id,
       (extract(hour FROM x.local_time)::int / 6)::smallint AS time_band,
       (x.local_time::time <> time '00:00:00')                AS known_time,
       CASE WHEN x.row_idx BETWEEN 0 AND 134 AND x.col_idx BETWEEN 0 AND 79
            THEN (x.row_idx * 100 + x.col_idx)::int
       END AS cell_id
FROM (
    SELECT i.incident_id,
           i.occurred_at,
           i.occurred_at AT TIME ZONE 'America/Los_Angeles'                 AS local_time,
           i.category_id,
           i.neighborhood_id,
           i.precinct_id,
           i.latitude,
           i.longitude,
           g.group_id,
           -- Same double-precision formula and order as the Python pipeline and the browser.
           floor((i.latitude - 47.48::double precision) / 0.002::double precision)   AS row_idx,
           floor((i.longitude + 122.46::double precision) / 0.003::double precision) AS col_idx
    FROM crime_incidents i
    JOIN crime_categories c ON c.category_id = i.category_id
    LEFT JOIN offense_groups og ON og.code_description = c.category_name
    JOIN crime_groups g ON g.group_key = COALESCE(og.group_key, 'other')
    WHERE i.occurred_at IS NOT NULL
) x;

-- ---- Summary tables (rebuilt by pipeline/load_postgres.py) ----

CREATE TABLE cell_stats (
    cell_id        integer  NOT NULL REFERENCES grid_cells (cell_id),
    time_band      smallint NOT NULL REFERENCES time_bands (band_id),
    group_id       smallint NOT NULL REFERENCES crime_groups (group_id),
    incident_count integer  NOT NULL CHECK (incident_count > 0),
    PRIMARY KEY (cell_id, time_band, group_id)
);
CREATE INDEX ix_cell_stats_band_group ON cell_stats (time_band, group_id);

CREATE TABLE neighborhood_stats (
    neighborhood_id integer  NOT NULL REFERENCES neighborhoods (neighborhood_id),
    time_band       smallint NOT NULL REFERENCES time_bands (band_id),
    group_id        smallint NOT NULL REFERENCES crime_groups (group_id),
    incident_count  integer  NOT NULL,
    located_count   integer  NOT NULL CHECK (located_count <= incident_count),
    PRIMARY KEY (neighborhood_id, time_band, group_id)
);

-- ---- ML model output (pipeline/import_risk.py) -----------------

CREATE TABLE model_runs (
    model_version varchar(50)  PRIMARY KEY,
    trained_at    timestamptz  NOT NULL,
    algorithm     varchar(150) NOT NULL,
    metrics       jsonb,
    is_active     boolean      NOT NULL DEFAULT false
);
-- Only one active run.
CREATE UNIQUE INDEX uq_model_runs_one_active ON model_runs (is_active) WHERE is_active;

CREATE TYPE risk_level AS ENUM ('low', 'elevated', 'high');

CREATE TABLE cell_risk_scores (
    model_version varchar(50)   NOT NULL REFERENCES model_runs (model_version) ON DELETE CASCADE,
    cell_id       integer       NOT NULL REFERENCES grid_cells (cell_id),
    time_band     smallint      NOT NULL REFERENCES time_bands (band_id),
    expected_risk numeric(10, 4) NOT NULL CHECK (expected_risk >= 0),
    level         risk_level    NOT NULL,
    PRIMARY KEY (model_version, cell_id, time_band)
);
CREATE INDEX ix_cell_risk_scores_band ON cell_risk_scores (model_version, time_band);

-- ---- User tables ---------------------------------------------

CREATE TABLE user_preferences (
    user_id       bigint PRIMARY KEY REFERENCES app_users (user_id) ON DELETE CASCADE,
    mode_key      varchar(10)  NOT NULL DEFAULT 'walk' REFERENCES travel_modes (mode_key),
    safety_weight numeric(3, 2) NOT NULL DEFAULT 0.70 CHECK (safety_weight BETWEEN 0 AND 1),
    alerts_on     boolean      NOT NULL DEFAULT true,
    updated_at    timestamptz  NOT NULL DEFAULT now()
);

CREATE TYPE place_kind AS ENUM ('HOME', 'WORK', 'SAVED');

CREATE TABLE user_places (
    place_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    bigint       NOT NULL REFERENCES app_users (user_id) ON DELETE CASCADE,
    kind       place_kind   NOT NULL,
    label      varchar(100) NOT NULL,
    address    varchar(255) NOT NULL DEFAULT '',
    geom       geography(Point, 4326) NOT NULL,
    created_at timestamptz  NOT NULL DEFAULT now()
);
-- One HOME and one WORK per user.
CREATE UNIQUE INDEX uq_user_places_one_per_kind ON user_places (user_id, kind) WHERE kind <> 'SAVED';
CREATE INDEX ix_user_places_user_created ON user_places (user_id, created_at);

CREATE TABLE trip_details (
    recommendation_id bigint PRIMARY KEY
        REFERENCES route_recommendations (recommendation_id) ON DELETE CASCADE,
    from_label        varchar(150) NOT NULL,
    to_label          varchar(150) NOT NULL,
    mode_key          varchar(10)  NOT NULL REFERENCES travel_modes (mode_key),
    depart_at         timestamptz  NOT NULL,
    duration_seconds  integer      NOT NULL CHECK (duration_seconds >= 0),
    risk_score        numeric(5, 2) NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
    level             risk_level   NOT NULL
);
