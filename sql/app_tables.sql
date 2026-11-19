-- ============================================================
-- CrimeRadar app tables
-- Run AFTER sql/crime_radar_all.sql. Needs MySQL 8.0.16+.
--   java -cp ... crimeradar.tools.SetupAppSchema        (or scripts/setup-db.ps1)
-- This file has no DELIMITER blocks, so a plain runner can split it on ';'.
--
-- Safe to re-run:
--   * Summary tables (lookups, grid, stats, model) are dropped and rebuilt.
--   * User tables (UserPreferences, UserPlaces, TripDetails) use
--     CREATE TABLE IF NOT EXISTS, so saved places and trips survive a re-run.
--     To wipe them too, run SetupAppSchema with --reset.
--
-- The app never scans CrimeIncidents per request. This script reads it once
-- and writes small summary tables. The API reads only those tables.
-- ============================================================

USE CrimeRadar;

-- ------------------------------------------------------------
-- PART 1: DROP derived tables (children before parents)
-- ------------------------------------------------------------

DROP VIEW IF EXISTS vw_CleanIncidents;
DROP TABLE IF EXISTS CellRiskScores;
DROP TABLE IF EXISTS ModelRuns;
DROP TABLE IF EXISTS NeighborhoodStats;
DROP TABLE IF EXISTS NeighborhoodPrecincts;
DROP TABLE IF EXISTS CellStats;
DROP TABLE IF EXISTS GridCells;
DROP TABLE IF EXISTS CategoryGroups;
DROP TABLE IF EXISTS AppMeta;

-- CrimeGroups, TimeBands, TravelModes and the user tables are kept on a
-- normal re-run (the lookup rows are refreshed with upserts below).

-- ------------------------------------------------------------
-- PART 2: LOOKUP TABLES (values from docs/API.md section 1)
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS CrimeGroups (
    GroupId   TINYINT UNSIGNED NOT NULL,
    GroupKey  VARCHAR(20)      NOT NULL,
    Label     VARCHAR(60)      NOT NULL,
    Severity  DECIMAL(4,2)     NOT NULL,

    PRIMARY KEY (GroupId),
    UNIQUE (GroupKey),
    CHECK (Severity > 0)
);

CREATE TABLE IF NOT EXISTS TimeBands (
    BandId     TINYINT UNSIGNED NOT NULL,
    BandKey    VARCHAR(20)      NOT NULL,
    Label      VARCHAR(40)      NOT NULL,
    HoursLabel VARCHAR(40)      NOT NULL,

    PRIMARY KEY (BandId),
    UNIQUE (BandKey),
    CHECK (BandId < 4)
);

CREATE TABLE IF NOT EXISTS TravelModes (
    ModeKey       VARCHAR(10)  NOT NULL,
    Label         VARCHAR(40)  NOT NULL,
    Vulnerability DECIMAL(3,2) NOT NULL,

    PRIMARY KEY (ModeKey),
    CHECK (Vulnerability > 0 AND Vulnerability <= 1)
);

INSERT INTO CrimeGroups (GroupId, GroupKey, Label, Severity) VALUES
    (0, 'violent',   'Assault & violence',        3.00),
    (1, 'robbery',   'Robbery',                   4.00),
    (2, 'theft',     'Theft',                     1.00),
    (3, 'vehicle',   'Vehicle crime',             1.00),
    (4, 'burglary',  'Burglary & trespass',       1.50),
    (5, 'vandalism', 'Vandalism & arson',         1.00),
    (6, 'drugs',     'Drugs, weapons & disorder', 1.50),
    (7, 'other',     'Other offenses',            0.25)
ON DUPLICATE KEY UPDATE GroupKey = VALUES(GroupKey), Label = VALUES(Label),
                        Severity = VALUES(Severity);

INSERT INTO TimeBands (BandId, BandKey, Label, HoursLabel) VALUES
    (0, 'night',     'Night',     '12 AM - 6 AM'),
    (1, 'morning',   'Morning',   '6 AM - 12 PM'),
    (2, 'afternoon', 'Afternoon', '12 PM - 6 PM'),
    (3, 'evening',   'Evening',   '6 PM - 12 AM')
ON DUPLICATE KEY UPDATE BandKey = VALUES(BandKey), Label = VALUES(Label),
                        HoursLabel = VALUES(HoursLabel);

INSERT INTO TravelModes (ModeKey, Label, Vulnerability) VALUES
    ('walk', 'Walk', 1.00),
    ('bike', 'Bike', 0.70),
    ('car',  'Car',  0.30)
ON DUPLICATE KEY UPDATE Label = VALUES(Label), Vulnerability = VALUES(Vulnerability);

CREATE TABLE AppMeta (
    MetaKey   VARCHAR(40)  NOT NULL,
    MetaValue VARCHAR(255) NOT NULL,

    PRIMARY KEY (MetaKey)
);

-- ------------------------------------------------------------
-- PART 3: OFFENSE -> CRIME GROUP
-- The inline rows below are a copy of pipeline/category_groups.csv.
-- 'exclude' rows get NO row in CategoryGroups, so every inner join on
-- CategoryGroups drops those offenses. A description that is not listed
-- maps to 'other' (GroupId 7).
-- ------------------------------------------------------------

CREATE TABLE CategoryGroups (
    CategoryId INT              NOT NULL,
    GroupId    TINYINT UNSIGNED NOT NULL,

    PRIMARY KEY (CategoryId),
    INDEX ix_CategoryGroups_Group (GroupId),

    FOREIGN KEY (CategoryId) REFERENCES CrimeCategories(CategoryId),
    FOREIGN KEY (GroupId)    REFERENCES CrimeGroups(GroupId)
);

INSERT INTO CategoryGroups (CategoryId, GroupId)
SELECT c.CategoryId, COALESCE(g.GroupId, 7)
FROM CrimeCategories c
LEFT JOIN (
    SELECT 'Simple Assault' AS CodeDescription, 'violent' AS GroupKey
    UNION ALL SELECT 'Aggravated Assault', 'violent'
    UNION ALL SELECT 'Intimidation', 'violent'
    UNION ALL SELECT 'Kidnapping/Abduction', 'violent'
    UNION ALL SELECT 'Rape', 'violent'
    UNION ALL SELECT 'Sodomy', 'violent'
    UNION ALL SELECT 'Sexual Assault With An Object', 'violent'
    UNION ALL SELECT 'Fondling', 'violent'
    UNION ALL SELECT 'Statutory Rape', 'violent'
    UNION ALL SELECT 'Incest', 'violent'
    UNION ALL SELECT 'Murder & Nonnegligent Manslaughter', 'violent'
    UNION ALL SELECT 'Negligent Manslaughter', 'violent'
    UNION ALL SELECT 'Human Trafficking, Commercial Sex Acts', 'violent'
    UNION ALL SELECT 'Human Trafficking, Involuntary Servitude', 'violent'
    UNION ALL SELECT 'Robbery', 'robbery'
    UNION ALL SELECT 'All Other Larceny', 'theft'
    UNION ALL SELECT 'Shoplifting', 'theft'
    UNION ALL SELECT 'Theft From Building', 'theft'
    UNION ALL SELECT 'Pocket-picking', 'theft'
    UNION ALL SELECT 'Purse-snatching', 'theft'
    UNION ALL SELECT 'Theft From Coin-Operated Machine or Device', 'theft'
    UNION ALL SELECT 'Stolen Property Offenses', 'theft'
    UNION ALL SELECT 'Theft From Motor Vehicle', 'vehicle'
    UNION ALL SELECT 'Motor Vehicle Theft', 'vehicle'
    UNION ALL SELECT 'Theft of Motor Vehicle Parts or Accessories', 'vehicle'
    UNION ALL SELECT 'Burglary/Breaking & Entering', 'burglary'
    UNION ALL SELECT 'Trespass of Real', 'burglary'
    UNION ALL SELECT 'Destruction/Damage/Vandalism of Property', 'vandalism'
    UNION ALL SELECT 'Arson', 'vandalism'
    UNION ALL SELECT 'Drug/Narcotic Violations', 'drugs'
    UNION ALL SELECT 'Drug Equipment Violations', 'drugs'
    UNION ALL SELECT 'Weapon Law Violations', 'drugs'
    UNION ALL SELECT 'Disorderly Conduct', 'drugs'
    UNION ALL SELECT 'Curfew/Loitering/Vagrancy Violations', 'drugs'
    UNION ALL SELECT 'Drunkenness', 'drugs'
    UNION ALL SELECT 'Liquor Law Violations', 'drugs'
    UNION ALL SELECT 'Prostitution', 'drugs'
    UNION ALL SELECT 'Purchasing Prostitution', 'drugs'
    UNION ALL SELECT 'Assisting or Promoting Prostitution', 'drugs'
    UNION ALL SELECT 'All Other Offenses', 'other'
    UNION ALL SELECT 'Driving Under the Influence', 'other'
    UNION ALL SELECT 'Violation of No Contact Orders', 'other'
    UNION ALL SELECT 'Family Offenses, Nonviolent', 'other'
    UNION ALL SELECT 'Pornography/Obscene Material', 'other'
    UNION ALL SELECT 'Animal Cruelty', 'other'
    UNION ALL SELECT 'Peeping Tom', 'other'
    UNION ALL SELECT 'Betting/Wagering', 'other'
    UNION ALL SELECT 'Gambling Equipment Violation', 'other'
    UNION ALL SELECT 'Operating/Promoting/Assisting Gambling', 'other'
    UNION ALL SELECT 'Credit Card/Automated Teller Machine Fraud', 'other'
    UNION ALL SELECT 'Identity Theft', 'other'
    UNION ALL SELECT 'False Pretenses/Swindle/Confidence Game', 'other'
    UNION ALL SELECT 'Wire Fraud', 'other'
    UNION ALL SELECT 'Counterfeiting/Forgery', 'other'
    UNION ALL SELECT 'Impersonation', 'other'
    UNION ALL SELECT 'Extortion/Blackmail', 'other'
    UNION ALL SELECT 'Hacking/Computer Invasion', 'other'
    UNION ALL SELECT 'Embezzlement', 'other'
    UNION ALL SELECT 'Bad Checks', 'other'
    UNION ALL SELECT 'Welfare Fraud', 'other'
    UNION ALL SELECT 'Bribery', 'other'
    UNION ALL SELECT 'UNKNOWN', 'other'
    UNION ALL SELECT '-', 'other'
    UNION ALL SELECT 'Not Reportable to NIBRS', 'exclude'
    UNION ALL SELECT 'Justifiable Homicide', 'exclude'
) m ON m.CodeDescription = c.CategoryName
LEFT JOIN CrimeGroups g ON g.GroupKey = m.GroupKey
WHERE m.GroupKey IS NULL OR m.GroupKey <> 'exclude';

-- ------------------------------------------------------------
-- PART 4: CLEAN INCIDENT VIEW
-- Wanted incidents only (inner join drops 'exclude' offenses), with
-- group, time band and grid cell (NULL when no coordinates or off the grid).
-- Grid: lat0 47.48, lng0 -122.46, dLat 0.002, dLng 0.003, 135 x 80 cells.
-- ------------------------------------------------------------

CREATE VIEW vw_CleanIncidents AS
SELECT x.IncidentId,
       x.OccurredAt,
       x.CategoryId,
       x.NeighborhoodId,
       x.PrecinctId,
       x.Latitude,
       x.Longitude,
       x.GroupId,
       x.TimeBand,
       CASE WHEN x.RowIdx BETWEEN 0 AND 134 AND x.ColIdx BETWEEN 0 AND 79
            THEN CAST(x.RowIdx * 100 + x.ColIdx AS UNSIGNED)
       END AS CellId
FROM (
    SELECT i.IncidentId,
           i.OccurredAt,
           i.CategoryId,
           i.NeighborhoodId,
           i.PrecinctId,
           i.Latitude,
           i.Longitude,
           cg.GroupId,
           CAST(HOUR(i.OccurredAt) DIV 6 AS UNSIGNED) AS TimeBand,
           -- DOUBLE math, the same formula and order as the Python pipeline and the browser,
           -- so a point exactly on a cell edge lands in the same cell everywhere.
           FLOOR((CAST(i.Latitude AS DOUBLE) - 47.48e0) / 0.002e0)   AS RowIdx,
           FLOOR((CAST(i.Longitude AS DOUBLE) + 122.46e0) / 0.003e0) AS ColIdx
    FROM CrimeIncidents i
    JOIN CategoryGroups cg ON cg.CategoryId = i.CategoryId
    WHERE i.OccurredAt IS NOT NULL
) x;

-- ------------------------------------------------------------
-- PART 5: SUMMARY TABLES
-- ------------------------------------------------------------

CREATE TABLE GridCells (
    CellId         SMALLINT UNSIGNED NOT NULL,
    RowIdx         TINYINT UNSIGNED  NOT NULL,
    ColIdx         TINYINT UNSIGNED  NOT NULL,
    CenterLat      DECIMAL(9,6)      NOT NULL,
    CenterLng      DECIMAL(10,6)     NOT NULL,
    NeighborhoodId INT               NULL,

    PRIMARY KEY (CellId),
    UNIQUE (RowIdx, ColIdx),
    INDEX ix_GridCells_Neighborhood (NeighborhoodId),

    FOREIGN KEY (NeighborhoodId) REFERENCES Neighborhoods(NeighborhoodId),

    CHECK (RowIdx < 135 AND ColIdx < 80 AND CellId = RowIdx * 100 + ColIdx)
);

-- The precinct that reports most of a neighborhood's incidents.
CREATE TABLE NeighborhoodPrecincts (
    NeighborhoodId INT NOT NULL,
    PrecinctId     INT NOT NULL,

    PRIMARY KEY (NeighborhoodId),
    INDEX ix_NeighborhoodPrecincts_Precinct (PrecinctId),

    FOREIGN KEY (NeighborhoodId) REFERENCES Neighborhoods(NeighborhoodId),
    FOREIGN KEY (PrecinctId)     REFERENCES PolicePrecincts(PrecinctId)
);

CREATE TABLE CellStats (
    CellId        SMALLINT UNSIGNED NOT NULL,
    TimeBand      TINYINT UNSIGNED  NOT NULL,
    GroupId       TINYINT UNSIGNED  NOT NULL,
    IncidentCount INT UNSIGNED      NOT NULL,

    PRIMARY KEY (CellId, TimeBand, GroupId),
    INDEX ix_CellStats_Group (GroupId),
    INDEX ix_CellStats_Band (TimeBand),

    FOREIGN KEY (CellId)   REFERENCES GridCells(CellId),
    FOREIGN KEY (TimeBand) REFERENCES TimeBands(BandId),
    FOREIGN KEY (GroupId)  REFERENCES CrimeGroups(GroupId),

    CHECK (IncidentCount > 0)
);

CREATE TABLE NeighborhoodStats (
    NeighborhoodId INT               NOT NULL,
    TimeBand       TINYINT UNSIGNED  NOT NULL,
    GroupId        TINYINT UNSIGNED  NOT NULL,
    IncidentCount  INT UNSIGNED      NOT NULL,
    LocatedCount   INT UNSIGNED      NOT NULL,
    SumLat         DOUBLE            NOT NULL DEFAULT 0,
    SumLng         DOUBLE            NOT NULL DEFAULT 0,

    PRIMARY KEY (NeighborhoodId, TimeBand, GroupId),
    INDEX ix_NeighborhoodStats_Band (TimeBand),
    INDEX ix_NeighborhoodStats_Group (GroupId),

    FOREIGN KEY (NeighborhoodId) REFERENCES Neighborhoods(NeighborhoodId),
    FOREIGN KEY (TimeBand)       REFERENCES TimeBands(BandId),
    FOREIGN KEY (GroupId)        REFERENCES CrimeGroups(GroupId),

    CHECK (LocatedCount <= IncidentCount)
);

-- @@REFRESH-BEGIN
-- Everything between the REFRESH-BEGIN and REFRESH-END marker lines rebuilds the summary data from
-- CrimeIncidents. crimeradar.tools.SyncIncidents runs only this part (in one transaction)
-- after it loads new incidents. On a fresh build the DELETEs below do nothing.
DELETE FROM CellStats;
DELETE FROM NeighborhoodStats;
DELETE FROM NeighborhoodPrecincts;
DELETE FROM AppMeta WHERE MetaKey IN
    ('incidents', 'located', 'excluded', 'unknownTime', 'dataFrom', 'dataTo', 'builtAt');

-- Read the big table once into a small working copy.
-- NbId is NULL for the unranked neighborhoods: '-', UNKNOWN, OOJ, FK ERROR.
DROP TEMPORARY TABLE IF EXISTS tmp_clean;
DROP TEMPORARY TABLE IF EXISTS tmp_cell_nb;

CREATE TEMPORARY TABLE tmp_clean AS
SELECT v.CellId, v.TimeBand, v.GroupId, v.OccurredAt, v.Latitude, v.Longitude,
       CASE WHEN UPPER(n.NeighborhoodName) IN ('-', 'UNKNOWN', 'OOJ', 'FK ERROR')
            THEN NULL ELSE v.NeighborhoodId END AS NbId,
       CASE WHEN UPPER(p.PrecinctName) IN ('-', 'UNKNOWN', 'OOJ')
            THEN NULL ELSE v.PrecinctId END AS PrecinctId,
       -- OccurredAt exactly 00:00:00 means the time of day is unknown (docs/API.md):
       -- those rows are left out of every time-of-day count.
       (TIME(v.OccurredAt) <> '00:00:00') AS KnownTime
FROM vw_CleanIncidents v
LEFT JOIN Neighborhoods n ON n.NeighborhoodId = v.NeighborhoodId
LEFT JOIN PolicePrecincts p ON p.PrecinctId = v.PrecinctId;

-- Dominant valid neighborhood of each cell (most incidents; ties: name A-Z by bytes).
CREATE TEMPORARY TABLE tmp_cell_nb AS
SELECT t.CellId, t.NbId, n.NeighborhoodName AS NbName, COUNT(*) AS Cnt
FROM tmp_clean t
LEFT JOIN Neighborhoods n ON n.NeighborhoodId = t.NbId
WHERE t.CellId IS NOT NULL AND t.KnownTime
GROUP BY t.CellId, t.NbId, n.NeighborhoodName;

INSERT INTO GridCells (CellId, RowIdx, ColIdx, CenterLat, CenterLng, NeighborhoodId)
SELECT r.CellId,
       r.CellId DIV 100,
       r.CellId MOD 100,
       ROUND(47.48 + (r.CellId DIV 100 + 0.5) * 0.002, 6),
       ROUND(-122.46 + (r.CellId MOD 100 + 0.5) * 0.003, 6),
       r.NbId
FROM (
    SELECT CellId, NbId,
           ROW_NUMBER() OVER (PARTITION BY CellId
                              ORDER BY (NbId IS NULL), Cnt DESC, CAST(NbName AS BINARY)) AS rn
    FROM tmp_cell_nb
) r
WHERE r.rn = 1
ON DUPLICATE KEY UPDATE NeighborhoodId = r.NbId;

INSERT INTO CellStats (CellId, TimeBand, GroupId, IncidentCount)
SELECT CellId, TimeBand, GroupId, COUNT(*)
FROM tmp_clean
WHERE CellId IS NOT NULL AND KnownTime
GROUP BY CellId, TimeBand, GroupId;

INSERT INTO NeighborhoodStats
    (NeighborhoodId, TimeBand, GroupId, IncidentCount, LocatedCount, SumLat, SumLng)
SELECT NbId, TimeBand, GroupId, COUNT(*),
       SUM(CellId IS NOT NULL),
       SUM(IF(CellId IS NOT NULL, Latitude, 0)),
       SUM(IF(CellId IS NOT NULL, Longitude, 0))
FROM tmp_clean
WHERE NbId IS NOT NULL AND KnownTime
GROUP BY NbId, TimeBand, GroupId;

INSERT INTO NeighborhoodPrecincts (NeighborhoodId, PrecinctId)
SELECT r.NbId, r.PrecinctId
FROM (
    SELECT g.NbId, g.PrecinctId,
           ROW_NUMBER() OVER (PARTITION BY g.NbId ORDER BY g.Cnt DESC, g.PrecinctId) AS rn
    FROM (
        SELECT NbId, PrecinctId, COUNT(*) AS Cnt
        FROM tmp_clean
        WHERE NbId IS NOT NULL AND PrecinctId IS NOT NULL
        GROUP BY NbId, PrecinctId
    ) g
) r
WHERE r.rn = 1;

INSERT INTO AppMeta (MetaKey, MetaValue)
SELECT 'incidents', COUNT(*) FROM tmp_clean;
INSERT INTO AppMeta (MetaKey, MetaValue)
SELECT 'unknownTime', COALESCE(SUM(NOT KnownTime), 0) FROM tmp_clean;
INSERT INTO AppMeta (MetaKey, MetaValue)
SELECT 'located', COALESCE(SUM(CellId IS NOT NULL), 0) FROM tmp_clean;
INSERT INTO AppMeta (MetaKey, MetaValue)
SELECT 'excluded', (SELECT COUNT(*) FROM CrimeIncidents) - COUNT(*) FROM tmp_clean;
INSERT INTO AppMeta (MetaKey, MetaValue)
SELECT 'dataFrom', DATE_FORMAT(MIN(OccurredAt), '%Y-%m-%d') FROM tmp_clean;
INSERT INTO AppMeta (MetaKey, MetaValue)
SELECT 'dataTo', DATE_FORMAT(MAX(OccurredAt), '%Y-%m-%d') FROM tmp_clean;
-- A cell that lost all its incidents (old ones dropped) no longer belongs to a neighborhood.
UPDATE GridCells SET NeighborhoodId = NULL
WHERE CellId NOT IN (SELECT CellId FROM CellStats);
INSERT INTO AppMeta (MetaKey, MetaValue)
VALUES ('builtAt', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%sZ'));

DROP TEMPORARY TABLE IF EXISTS tmp_cell_nb;
DROP TEMPORARY TABLE IF EXISTS tmp_clean;
-- @@REFRESH-END

-- ------------------------------------------------------------
-- PART 6: ML MODEL OUTPUT (filled by SetupAppSchema from ml/output/)
-- Only one run can be active: ActiveKey is 1 when active, else NULL,
-- and NULLs do not collide in a UNIQUE index.
-- ------------------------------------------------------------

CREATE TABLE ModelRuns (
    ModelVersion VARCHAR(50)  NOT NULL,
    TrainedAt    DATETIME     NOT NULL,
    Algorithm    VARCHAR(150) NOT NULL,
    MetricsJson  JSON         NULL,
    IsActive     BOOLEAN      NOT NULL DEFAULT FALSE,
    ActiveKey    TINYINT GENERATED ALWAYS AS (IF(IsActive, 1, NULL)) STORED,

    PRIMARY KEY (ModelVersion),
    UNIQUE KEY uq_ModelRuns_OneActive (ActiveKey)
);

CREATE TABLE CellRiskScores (
    ModelVersion VARCHAR(50)       NOT NULL,
    CellId       SMALLINT UNSIGNED NOT NULL,
    TimeBand     TINYINT UNSIGNED  NOT NULL,
    ExpectedRisk DECIMAL(10,4)     NOT NULL,
    RiskLevel    ENUM('low', 'elevated', 'high') NOT NULL,

    PRIMARY KEY (ModelVersion, CellId, TimeBand),
    INDEX ix_CellRiskScores_Cell (CellId),
    INDEX ix_CellRiskScores_Band (TimeBand),

    FOREIGN KEY (ModelVersion) REFERENCES ModelRuns(ModelVersion),
    FOREIGN KEY (CellId)       REFERENCES GridCells(CellId),
    FOREIGN KEY (TimeBand)     REFERENCES TimeBands(BandId),

    CHECK (ExpectedRisk >= 0)
);

-- ------------------------------------------------------------
-- PART 7: USER TABLES (kept on re-run)
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS UserPreferences (
    UserId       BIGINT       NOT NULL,
    ModeKey      VARCHAR(10)  NOT NULL DEFAULT 'walk',
    SafetyWeight DECIMAL(3,2) NOT NULL DEFAULT 0.70,
    AlertsOn     BOOLEAN      NOT NULL DEFAULT TRUE,
    UpdatedAt    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (UserId),

    FOREIGN KEY (UserId)  REFERENCES AppUsers(UserId) ON DELETE CASCADE,
    FOREIGN KEY (ModeKey) REFERENCES TravelModes(ModeKey),

    CHECK (SafetyWeight BETWEEN 0 AND 1)
);

-- One HOME and one WORK per user: SingleKind is NULL for SAVED places
-- (NULLs do not collide), so the unique index only limits HOME and WORK.
CREATE TABLE IF NOT EXISTS UserPlaces (
    PlaceId    BIGINT AUTO_INCREMENT,
    UserId     BIGINT                       NOT NULL,
    Kind       ENUM('HOME', 'WORK', 'SAVED') NOT NULL,
    Label      VARCHAR(100)                 NOT NULL,
    Address    VARCHAR(255)                 NOT NULL DEFAULT '',
    Latitude   DECIMAL(9,6)                 NOT NULL,
    Longitude  DECIMAL(10,6)                NOT NULL,
    CreatedAt  DATETIME                     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    SingleKind VARCHAR(4) GENERATED ALWAYS AS (IF(Kind = 'SAVED', NULL, Kind)) STORED,

    PRIMARY KEY (PlaceId),
    UNIQUE KEY uq_UserPlaces_OnePerKind (UserId, SingleKind),
    INDEX ix_UserPlaces_UserCreated (UserId, CreatedAt),

    FOREIGN KEY (UserId) REFERENCES AppUsers(UserId) ON DELETE CASCADE,

    CHECK (Latitude BETWEEN -90 AND 90 AND Longitude BETWEEN -180 AND 180)
);

-- 1:1 extension of RouteRecommendations. A trip save writes
-- Routes + RouteRecommendations + TripDetails in one transaction.
CREATE TABLE IF NOT EXISTS TripDetails (
    RecommendationId BIGINT        NOT NULL,
    FromLabel        VARCHAR(150)  NOT NULL,
    ToLabel          VARCHAR(150)  NOT NULL,
    ModeKey          VARCHAR(10)   NOT NULL,
    DepartAt         DATETIME      NOT NULL,
    DurationSeconds  INT UNSIGNED  NOT NULL,
    RiskScore        DECIMAL(5,2)  NOT NULL,
    RiskLevel        ENUM('low', 'elevated', 'high') NOT NULL,

    PRIMARY KEY (RecommendationId),

    FOREIGN KEY (RecommendationId) REFERENCES RouteRecommendations(RecommendationId)
        ON DELETE CASCADE,
    FOREIGN KEY (ModeKey) REFERENCES TravelModes(ModeKey),

    CHECK (RiskScore BETWEEN 0 AND 100)
);

-- "My newest trips" reads RouteRecommendations by user, newest first.
-- Create the index only if it is missing (no DELIMITER needed).
SET @ix_sql = (
    SELECT IF(COUNT(*) = 0,
              'CREATE INDEX ix_RouteRecommendations_UserTime ON RouteRecommendations (UserId, RequestedAt)',
              'DO 0')
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'RouteRecommendations'
      AND index_name = 'ix_RouteRecommendations_UserTime'
);
PREPARE ix_stmt FROM @ix_sql;
EXECUTE ix_stmt;
DEALLOCATE PREPARE ix_stmt;
