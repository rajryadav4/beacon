-- ============================================================
-- Beacon: hazard outlook (where is worst / safest, and what may be coming)
--
--   hazard_zones          official hazard-zone polygons (tsunami inundation,
--                         liquefaction, landslide, FEMA flood zones, lahar ...)
--   hazard_zone_kinds     which zone kinds count for which hazard
--   cell_terrain          elevation and slope per grid cell (AWS Terrain Tiles)
--   cell_hazard_exposure  relative exposure score 0-100 per grid cell and hazard
--   hazard_outlook        what may be coming in the next ~72 h, from free sources
--   hazard_sources        per-source last fetch, status, license and attribution
--
-- Filled by pipeline/import_hazard_zones.py and pipeline/outlook_worker.py,
-- read by apps/api/app/routers/outlook.py. Both scripts apply this file first,
-- so it also works on a database created before the file existed.
-- Hazard keys are the shared ones in apps/api/app/hazard_taxonomy.py.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS hazard_zones (
    zone_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    hazard     varchar(20)  NOT NULL,            -- primary shared hazard key
    kind       varchar(30)  NOT NULL,            -- tsunami_inundation, liquefaction, landslide, flood_zone, lahar
    source     varchar(60)  NOT NULL,            -- 'seattle-eca-liquefaction', 'fema-nfhl', ...
    source_ref varchar(120) NOT NULL,            -- id within the source
    name       varchar(255) NOT NULL,
    level      varchar(10)  NOT NULL CHECK (level IN ('high', 'moderate', 'low')),
    geom       geometry(MultiPolygon, 4326) NOT NULL,
    properties jsonb        NOT NULL DEFAULT '{}'::jsonb,
    license    varchar(255) NOT NULL,
    updated_at timestamptz  NOT NULL DEFAULT now(),
    UNIQUE (source, source_ref)
);
CREATE INDEX IF NOT EXISTS ix_hazard_zones_geom ON hazard_zones USING gist (geom);
CREATE INDEX IF NOT EXISTS ix_hazard_zones_kind ON hazard_zones (kind);

-- Which zone kinds feed which hazard (a landslide slope matters in heavy rain
-- and in an earthquake). Re-seeded on every run so it matches this file.
CREATE TABLE IF NOT EXISTS hazard_zone_kinds (
    hazard varchar(20) NOT NULL,
    kind   varchar(30) NOT NULL,
    PRIMARY KEY (hazard, kind)
);
BEGIN;
DELETE FROM hazard_zone_kinds;
INSERT INTO hazard_zone_kinds (hazard, kind) VALUES
    ('tsunami',    'tsunami_inundation'),
    ('earthquake', 'liquefaction'),
    ('earthquake', 'landslide'),
    ('flood',      'flood_zone'),
    ('flood',      'landslide'),
    ('volcano',    'lahar');
COMMIT;

CREATE TABLE IF NOT EXISTS cell_terrain (
    cell_id     integer PRIMARY KEY REFERENCES grid_cells (cell_id),
    elev_median real,                -- metres above sea level, land pixels
    elev_min    real,
    slope_p90   real,                -- degrees, 90th percentile of pixel slopes
    water_share real NOT NULL,       -- share of the cell that is open water (0..1)
    in_city     boolean NOT NULL,    -- inside Seattle city limits (city hazard layers cover only the city)
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cell_hazard_exposure (
    cell_id    integer     NOT NULL REFERENCES grid_cells (cell_id),
    hazard     varchar(20) NOT NULL,
    score      smallint    NOT NULL CHECK (score BETWEEN 0 AND 100),
    level      varchar(10) NOT NULL CHECK (level IN ('high', 'moderate', 'low')),
    factors    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (hazard, cell_id)
);
CREATE INDEX IF NOT EXISTS ix_cell_hazard_exposure_level ON cell_hazard_exposure (hazard, level);

CREATE TABLE IF NOT EXISTS hazard_outlook (
    outlook_id  varchar(120) PRIMARY KEY,        -- stable: '<source>:<id>'
    hazard      varchar(20)  NOT NULL,
    level       varchar(10)  NOT NULL CHECK (level IN ('watch', 'likely', 'imminent')),
    title       varchar(255) NOT NULL,
    summary     text         NOT NULL,
    area        geometry(MultiPolygon, 4326) NOT NULL,
    valid_from  timestamptz  NOT NULL,
    valid_to    timestamptz  NOT NULL,
    sources     jsonb        NOT NULL DEFAULT '[]'::jsonb,   -- [{name, url, observed}]
    confidence  varchar(10)  NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
    source      varchar(40)  NOT NULL,                       -- hazard_sources.source_key that produced it
    updated_at  timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_hazard_outlook_area ON hazard_outlook USING gist (area);
CREATE INDEX IF NOT EXISTS ix_hazard_outlook_valid ON hazard_outlook (valid_to);

CREATE TABLE IF NOT EXISTS hazard_sources (
    source_key   varchar(40)  PRIMARY KEY,
    name         varchar(150) NOT NULL,
    category     varchar(10)  NOT NULL CHECK (category IN ('zones', 'terrain', 'outlook')),
    url          varchar(500) NOT NULL,
    license      varchar(500) NOT NULL,
    attribution  varchar(500),
    last_fetch   timestamptz,
    last_success timestamptz,
    status       varchar(10)  NOT NULL DEFAULT 'never' CHECK (status IN ('ok', 'error', 'skipped', 'never')),
    message      text,
    item_count   integer
);
