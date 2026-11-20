-- ============================================================
-- Beacon: safe places (shelters, hubs, hospitals, police, ...)
--
-- Filled by pipeline/import_safe_places.py from OpenStreetMap (any area) and
-- official lists (GeoJSON files or URLs, e.g. a city's emergency hubs).
-- Read by apps/api/app/routers/safe_places.py.
--
-- Idempotent: runs on the first start of an empty volume, and the importer
-- applies it again to an existing database before every import.
-- Hazard keys are the shared ones in apps/api/app/hazard_taxonomy.py.
-- ============================================================

CREATE TABLE IF NOT EXISTS safe_places (
    place_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source        varchar(60)  NOT NULL,          -- 'osm', 'seattle-emergency-hubs', ...
    source_ref    varchar(120) NOT NULL,          -- 'node/123', an official id, ...
    kind          varchar(30)  NOT NULL
        CHECK (kind IN ('shelter', 'bomb_shelter', 'bunker', 'underground_station', 'assembly_point',
                        'emergency_hub', 'hospital', 'police', 'fire_station', 'community_centre',
                        'social_shelter')),
    name          varchar(255) NOT NULL,
    address       varchar(255),
    phone         varchar(60),
    opening_hours varchar(255),
    capacity      integer CHECK (capacity IS NULL OR capacity >= 0),
    wheelchair    varchar(20),                    -- OSM values: yes, limited, no
    tags          jsonb        NOT NULL DEFAULT '{}'::jsonb,  -- raw source attributes
    geom          geography(Point, 4326) NOT NULL,
    updated_at    timestamptz  NOT NULL DEFAULT now(),
    UNIQUE (source, source_ref)
);
CREATE INDEX IF NOT EXISTS ix_safe_places_geom ON safe_places USING gist (geom);
-- Bounding-box queries (map viewport) on the planar geometry.
CREATE INDEX IF NOT EXISTS ix_safe_places_geom_planar ON safe_places USING gist ((geom::geometry));
CREATE INDEX IF NOT EXISTS ix_safe_places_kind ON safe_places (kind);

-- Upgrade a database created before underground_station and social_shelter existed.
ALTER TABLE safe_places DROP CONSTRAINT IF EXISTS safe_places_kind_check;
ALTER TABLE safe_places ADD CONSTRAINT safe_places_kind_check CHECK (kind IN ('shelter', 'bomb_shelter', 'bunker', 'underground_station', 'assembly_point',
                        'emergency_hub', 'hospital', 'police', 'fire_station', 'community_centre',
                        'social_shelter'));
-- Homeless and supportive-housing shelters are not public refuges in a disaster.
UPDATE safe_places SET kind = 'social_shelter'
WHERE source = 'osm' AND kind = 'shelter'
  AND tags ->> 'social_facility' = 'shelter'
  AND coalesce(tags ->> 'emergency', '') <> 'shelter'
  AND coalesce(tags ->> 'amenity', '') <> 'refugee_site';

-- The same place often comes from OpenStreetMap and from an official list.
-- An OSM place is hidden when an official place of the same kind (assembly
-- points and emergency hubs count as one) lies within 150 m (a campus centroid and an
-- official entrance point can be that far apart).
CREATE OR REPLACE VIEW safe_places_visible AS
SELECT p.*
FROM safe_places p
WHERE p.source <> 'osm'
   OR NOT EXISTS (
        SELECT 1
        FROM safe_places o
        WHERE o.source <> 'osm'
          AND (o.kind = p.kind
               OR (o.kind IN ('assembly_point', 'emergency_hub')
                   AND p.kind IN ('assembly_point', 'emergency_hub')))
          AND ST_DWithin(o.geom, p.geom, 150)
   );

-- Which kinds of place to go to for each hazard; rank 1 = most suitable.
-- The API ranks by this first, then by distance, and falls back to lower
-- ranks when no better place is within a few km.
CREATE TABLE IF NOT EXISTS hazard_place_kinds (
    hazard varchar(20) NOT NULL
        CHECK (hazard IN ('earthquake', 'tsunami', 'flood', 'storm', 'winter', 'wildfire', 'heat',
                          'air_quality', 'hazmat', 'volcano', 'conflict', 'crime', 'other')),
    kind   varchar(30) NOT NULL
        CHECK (kind IN ('shelter', 'bomb_shelter', 'bunker', 'underground_station', 'assembly_point',
                        'emergency_hub', 'hospital', 'police', 'fire_station', 'community_centre',
                        'social_shelter')),
    rank   smallint    NOT NULL CHECK (rank > 0),
    PRIMARY KEY (hazard, kind),
    UNIQUE (hazard, rank)
);

ALTER TABLE hazard_place_kinds DROP CONSTRAINT IF EXISTS hazard_place_kinds_kind_check;
ALTER TABLE hazard_place_kinds ADD CONSTRAINT hazard_place_kinds_kind_check CHECK (kind IN ('shelter', 'bomb_shelter', 'bunker', 'underground_station', 'assembly_point',
                        'emergency_hub', 'hospital', 'police', 'fire_station', 'community_centre',
                        'social_shelter'));

-- Guidance is re-seeded on every run so it always matches this file.
BEGIN;
DELETE FROM hazard_place_kinds;
INSERT INTO hazard_place_kinds (hazard, kind, rank) VALUES
    -- Open ground away from buildings first; hubs have volunteers and supplies.
    ('earthquake',  'assembly_point',   1),
    ('earthquake',  'emergency_hub',    2),
    ('earthquake',  'hospital',         3),
    ('earthquake',  'fire_station',     4),
    -- High ground or inland is better than any building; these are where
    -- help gathers once people are out of the inundation zone.
    ('tsunami',     'emergency_hub',    1),
    ('tsunami',     'shelter',          2),
    ('tsunami',     'assembly_point',   3),
    ('flood',       'emergency_hub',    1),
    ('flood',       'shelter',          2),
    ('flood',       'assembly_point',   3),
    ('flood',       'community_centre', 4),
    -- Sturdy building, lowest floor or underground for tornadoes.
    ('storm',       'shelter',          1),
    ('storm',       'bomb_shelter',     2),
    ('storm',       'community_centre', 3),
    ('storm',       'emergency_hub',    4),
    ('storm',       'hospital',         5),
    -- Warming centres.
    ('winter',      'shelter',          1),
    ('winter',      'community_centre', 2),
    ('winter',      'emergency_hub',    3),
    ('winter',      'hospital',         4),
    -- Evacuation shelters, clean-air centres.
    ('wildfire',    'shelter',          1),
    ('wildfire',    'community_centre', 2),
    ('wildfire',    'emergency_hub',    3),
    ('wildfire',    'hospital',         4),
    -- Cooling and clean-air centres are usually community centres.
    ('heat',        'community_centre', 1),
    ('heat',        'shelter',          2),
    ('heat',        'hospital',         3),
    ('air_quality', 'community_centre', 1),
    ('air_quality', 'shelter',          2),
    ('air_quality', 'hospital',         3),
    -- Shelter in place first; go only if told to evacuate.
    ('hazmat',      'shelter',          1),
    ('hazmat',      'hospital',         2),
    ('hazmat',      'emergency_hub',    3),
    -- Ashfall: stay indoors.
    ('volcano',     'shelter',          1),
    ('volcano',     'emergency_hub',    2),
    ('volcano',     'community_centre', 3),
    ('volcano',     'hospital',         4),
    -- Underground first: purpose-built shelters, then deep stations (where
    -- there are no public bomb shelters, as in Seattle, underground transit
    -- stations are the usual civil-defence advice). Social-service shelters
    -- (social_shelter) are never offered as disaster refuges.
    ('conflict',    'bomb_shelter',        1),
    ('conflict',    'bunker',              2),
    ('conflict',    'underground_station', 3),
    ('conflict',    'shelter',             4),
    ('conflict',    'hospital',            5),
    -- Staffed around the clock.
    ('crime',       'police',           1),
    ('crime',       'fire_station',     2),
    ('crime',       'hospital',         3),
    ('other',       'emergency_hub',    1),
    ('other',       'shelter',          2),
    ('other',       'hospital',         3),
    ('other',       'police',           4),
    ('other',       'fire_station',     5);
COMMIT;
