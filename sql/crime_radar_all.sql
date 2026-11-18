-- ============================================================
-- CS5200: DATABASE SYSTEMS | PROJECT: CRIME RADAR
-- MILESTONE 2: RELATIONAL MODEL AND DATA (single script)
-- Requires MySQL 8.0+. Run in one session:
--   mysql --local-infile=1 -u root -p < crime_radar_all.sql
-- Safe to re-run: drops and rebuilds everything.
-- ============================================================

SET GLOBAL local_infile = 1;

CREATE DATABASE IF NOT EXISTS CrimeRadar;
USE CrimeRadar;


-- ============================================================
-- PART 1: DROP TABLES (children before parents)
-- ============================================================

DROP TABLE IF EXISTS RouteRecommendations;
DROP TABLE IF EXISTS RouteSegments;
DROP TABLE IF EXISTS SOSAlerts;
DROP TABLE IF EXISTS EmergencyContacts;
DROP TABLE IF EXISTS RiskScores;
DROP TABLE IF EXISTS SafetyResources;
DROP TABLE IF EXISTS EmergencyCalls;
DROP TABLE IF EXISTS CrimeIncidents;
DROP TABLE IF EXISTS Routes;
DROP TABLE IF EXISTS AppUsers;
DROP TABLE IF EXISTS CrimeCategories;
DROP TABLE IF EXISTS Neighborhoods;
DROP TABLE IF EXISTS PolicePrecincts;
DROP TABLE IF EXISTS DataSources;


-- ============================================================
-- PART 2: CREATE TABLES (parents before children)
-- ============================================================

CREATE TABLE DataSources (
    SourceId INT AUTO_INCREMENT,
    SourceName VARCHAR(150) NOT NULL,
    DatasetIdentifier VARCHAR(100),
    SourceURL VARCHAR(500),
    LastImportedAt DATETIME,

    PRIMARY KEY (SourceId),
    UNIQUE (DatasetIdentifier)
);

CREATE TABLE PolicePrecincts (
    PrecinctId INT AUTO_INCREMENT,
    PrecinctName VARCHAR(100) NOT NULL,

    PRIMARY KEY (PrecinctId),
    UNIQUE (PrecinctName)
);

CREATE TABLE CrimeCategories (
    CategoryId INT AUTO_INCREMENT,
    CategoryName VARCHAR(150) NOT NULL,
    NIBRSGroup VARCHAR(50),
    CrimeAgainstCategory VARCHAR(100),

    PRIMARY KEY (CategoryId),
    UNIQUE (CategoryName, NIBRSGroup, CrimeAgainstCategory)
);

CREATE TABLE AppUsers (
    UserId BIGINT AUTO_INCREMENT,
    DisplayName VARCHAR(100) NOT NULL,
    Email VARCHAR(255) NOT NULL,
    PasswordHash VARCHAR(255) NOT NULL,
    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (UserId),
    UNIQUE (Email)
);

CREATE TABLE Routes (
    RouteId BIGINT AUTO_INCREMENT,
    RouteName VARCHAR(150),
    StartLatitude DECIMAL(10,7) NOT NULL,
    StartLongitude DECIMAL(10,7) NOT NULL,
    EndLatitude DECIMAL(10,7) NOT NULL,
    EndLongitude DECIMAL(10,7) NOT NULL,
    DistanceMeters INT,

    PRIMARY KEY (RouteId),

    CHECK (DistanceMeters IS NULL OR DistanceMeters >= 0)
);

CREATE TABLE Neighborhoods (
    NeighborhoodId INT AUTO_INCREMENT,
    NeighborhoodName VARCHAR(150) NOT NULL,
    PrecinctId INT,

    PRIMARY KEY (NeighborhoodId),
    UNIQUE (NeighborhoodName),

    FOREIGN KEY (PrecinctId)
        REFERENCES PolicePrecincts(PrecinctId)
);

CREATE TABLE CrimeIncidents (
    IncidentId BIGINT AUTO_INCREMENT,
    SourceId INT NOT NULL,
    SourceOffenseId VARCHAR(100),
    ReportNumber VARCHAR(100),
    OccurredAt DATETIME,
    ReportedAt DATETIME,
    CategoryId INT NOT NULL,
    NeighborhoodId INT,
    PrecinctId INT,
    BlockAddress VARCHAR(255),
    Latitude DECIMAL(10,7),
    Longitude DECIMAL(10,7),
    Beat VARCHAR(50),

    PRIMARY KEY (IncidentId),

    FOREIGN KEY (SourceId)
        REFERENCES DataSources(SourceId),

    FOREIGN KEY (CategoryId)
        REFERENCES CrimeCategories(CategoryId),

    FOREIGN KEY (NeighborhoodId)
        REFERENCES Neighborhoods(NeighborhoodId),

    FOREIGN KEY (PrecinctId)
        REFERENCES PolicePrecincts(PrecinctId),

    UNIQUE (SourceId, SourceOffenseId),

    INDEX (OccurredAt),
    INDEX (NeighborhoodId),
    INDEX (CategoryId)
);

CREATE TABLE EmergencyCalls (
    CallId BIGINT AUTO_INCREMENT,
    SourceId INT NOT NULL,
    SourceCallId VARCHAR(100),
    CallTime DATETIME,
    CallType VARCHAR(150),
    NeighborhoodId INT,
    Latitude DECIMAL(10,7),
    Longitude DECIMAL(10,7),

    PRIMARY KEY (CallId),

    FOREIGN KEY (SourceId)
        REFERENCES DataSources(SourceId),

    FOREIGN KEY (NeighborhoodId)
        REFERENCES Neighborhoods(NeighborhoodId),

    UNIQUE (SourceId, SourceCallId),

    INDEX (CallTime)
);

CREATE TABLE SafetyResources (
    ResourceId INT AUTO_INCREMENT,
    NeighborhoodId INT,
    ResourceName VARCHAR(150) NOT NULL,
    ResourceType VARCHAR(100) NOT NULL,
    ContactInfo VARCHAR(255),
    ResourceURL VARCHAR(500),

    PRIMARY KEY (ResourceId),

    FOREIGN KEY (NeighborhoodId)
        REFERENCES Neighborhoods(NeighborhoodId)
);

CREATE TABLE RiskScores (
    RiskScoreId BIGINT AUTO_INCREMENT,
    NeighborhoodId INT NOT NULL,
    RiskDate DATE NOT NULL,
    HourOfDay TINYINT NOT NULL,
    IncidentCount INT NOT NULL DEFAULT 0,
    RiskScore DECIMAL(8,4) NOT NULL,
    ModelVersion VARCHAR(50) NOT NULL,

    PRIMARY KEY (RiskScoreId),

    FOREIGN KEY (NeighborhoodId)
        REFERENCES Neighborhoods(NeighborhoodId),

    UNIQUE (NeighborhoodId, RiskDate, HourOfDay, ModelVersion),

    CHECK (HourOfDay BETWEEN 0 AND 23),
    CHECK (IncidentCount >= 0),
    CHECK (RiskScore >= 0)
);

CREATE TABLE EmergencyContacts (
    ContactId BIGINT AUTO_INCREMENT,
    UserId BIGINT NOT NULL,
    ContactName VARCHAR(150) NOT NULL,
    PhoneNumber VARCHAR(30) NOT NULL,
    Relationship VARCHAR(100),

    PRIMARY KEY (ContactId),

    FOREIGN KEY (UserId)
        REFERENCES AppUsers(UserId)
);

CREATE TABLE SOSAlerts (
    AlertId BIGINT AUTO_INCREMENT,
    UserId BIGINT NOT NULL,
    AlertTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    Latitude DECIMAL(10,7),
    Longitude DECIMAL(10,7),
    AlertStatus ENUM('ACTIVE', 'RESOLVED', 'CANCELLED') NOT NULL DEFAULT 'ACTIVE',

    PRIMARY KEY (AlertId),

    FOREIGN KEY (UserId)
        REFERENCES AppUsers(UserId)
);

CREATE TABLE RouteSegments (
    SegmentId BIGINT AUTO_INCREMENT,
    RouteId BIGINT NOT NULL,
    SegmentOrder INT NOT NULL,
    NeighborhoodId INT,
    DistanceMeters INT,

    PRIMARY KEY (SegmentId),

    FOREIGN KEY (RouteId)
        REFERENCES Routes(RouteId),

    FOREIGN KEY (NeighborhoodId)
        REFERENCES Neighborhoods(NeighborhoodId),

    UNIQUE (RouteId, SegmentOrder),

    CHECK (SegmentOrder >= 1),
    CHECK (DistanceMeters IS NULL OR DistanceMeters >= 0)
);

CREATE TABLE RouteRecommendations (
    RecommendationId BIGINT AUTO_INCREMENT,
    UserId BIGINT,
    RouteId BIGINT NOT NULL,
    RequestedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    EstimatedRisk DECIMAL(8,4),
    RecommendationType ENUM('SAFEST', 'FASTEST', 'BALANCED') NOT NULL DEFAULT 'BALANCED',

    PRIMARY KEY (RecommendationId),

    FOREIGN KEY (UserId)
        REFERENCES AppUsers(UserId),

    FOREIGN KEY (RouteId)
        REFERENCES Routes(RouteId),

    CHECK (EstimatedRisk IS NULL OR EstimatedRisk >= 0)
);


-- ============================================================
-- PART 3: LOAD SPD CRIME DATA (last 4 years, newest 150,000)
-- ============================================================

DROP TEMPORARY TABLE IF EXISTS stg;
DROP TEMPORARY TABLE IF EXISTS sel;

-- 3a. Staging table: raw text, one column per CSV column
CREATE TEMPORARY TABLE stg (
    rpt_num       VARCHAR(255),
    rdt_txt       VARCHAR(255),
    off_id        VARCHAR(255),
    off_dt_txt    VARCHAR(255),
    grp_ab        VARCHAR(255),
    against       VARCHAR(255),
    subcat        VARCHAR(255),
    shoot         VARCHAR(255),
    block         VARCHAR(255),
    lat_txt       VARCHAR(255),
    lng_txt       VARCHAR(255),
    beat_txt      VARCHAR(255),
    precinct_txt  VARCHAR(255),
    sector        VARCHAR(255),
    nbhd_txt      VARCHAR(255),
    rep_area      VARCHAR(255),
    off_category  VARCHAR(255),
    code_desc     VARCHAR(255),
    code_txt      VARCHAR(255),
    census        VARCHAR(255)
);

-- 3b. Load the CSV (skips the header row). Path is relative to where you run mysql;
--     download the file into data/ first (see data/README.md).
LOAD DATA LOCAL INFILE 'data/SPD_Crime_Data_Last4Yrs_150k.csv'
INTO TABLE stg
FIELDS TERMINATED BY ','
ENCLOSED BY '"'
LINES TERMINATED BY '\n'
IGNORE 1 LINES;

SELECT COUNT(*) AS StagingRows FROM stg;

-- 3c. Clean, dedupe, filter, and keep the newest 150,000
CREATE TEMPORARY TABLE sel AS
SELECT
    x.rpt,
    CONCAT(x.rpt, '-', x.oid)  AS source_offense,
    x.occ,
    x.rdt,
    x.cat,
    x.grp,
    x.against,
    x.precinct,
    x.nbhd,
    x.block,
    IF(x.lat_raw BETWEEN 47 AND 48, x.lat_raw, NULL)      AS lat,
    IF(x.lng_raw BETWEEN -123 AND -122, x.lng_raw, NULL)  AS lng,
    x.beat
FROM (
    SELECT c.*,
           ROW_NUMBER() OVER (PARTITION BY c.rpt, c.oid ORDER BY c.occ DESC) AS rn
    FROM (
        SELECT
            NULLIF(TRIM(rpt_num), '')                                    AS rpt,
            NULLIF(TRIM(off_id), '')                                     AS oid,
            STR_TO_DATE(TRIM(off_dt_txt), '%Y %b %d %h:%i:%s %p')        AS occ,
            STR_TO_DATE(TRIM(rdt_txt),    '%Y %b %d %h:%i:%s %p')        AS rdt,
            LEFT(COALESCE(NULLIF(NULLIF(TRIM(code_desc), '-'), ''), 'UNKNOWN'), 150)     AS cat,
            LEFT(COALESCE(NULLIF(NULLIF(TRIM(grp_ab), '-'), ''), 'UNKNOWN'), 50)         AS grp,
            LEFT(COALESCE(NULLIF(NULLIF(TRIM(against), '-'), ''), 'UNKNOWN'), 100)       AS against,
            LEFT(COALESCE(NULLIF(NULLIF(TRIM(precinct_txt), '-'), ''), 'UNKNOWN'), 100)  AS precinct,
            LEFT(COALESCE(NULLIF(NULLIF(TRIM(nbhd_txt), '-'), ''), 'UNKNOWN'), 150)      AS nbhd,
            NULLIF(NULLIF(TRIM(block), '-'), '')                         AS block,
            IF(TRIM(lat_txt) REGEXP '^-?[0-9]+([.][0-9]+)?$',
               CAST(TRIM(lat_txt) AS DOUBLE), NULL)                      AS lat_raw,
            IF(TRIM(lng_txt) REGEXP '^-?[0-9]+([.][0-9]+)?$',
               CAST(TRIM(lng_txt) AS DOUBLE), NULL)                      AS lng_raw,
            LEFT(NULLIF(NULLIF(TRIM(beat_txt), '-'), ''), 50)            AS beat
        FROM stg
    ) c
    WHERE c.rpt IS NOT NULL
      AND c.oid IS NOT NULL
      AND c.occ IS NOT NULL
) x
WHERE x.rn = 1
  AND x.occ >= DATE_SUB(CURDATE(), INTERVAL 4 YEAR)
ORDER BY x.occ DESC
LIMIT 150000;

SELECT COUNT(*) AS SelectedRows FROM sel;

-- 3d. Lookup tables
INSERT INTO DataSources (SourceName, DatasetIdentifier, SourceURL, LastImportedAt)
VALUES ('SPD Crime Data: 2008-Present', 'tazs-3rd5',
        'https://data.seattle.gov/d/tazs-3rd5', NOW());

INSERT INTO PolicePrecincts (PrecinctName)
SELECT DISTINCT precinct FROM sel;

INSERT INTO Neighborhoods (NeighborhoodName, PrecinctId)
SELECT x.nbhd, p.PrecinctId
FROM (SELECT nbhd, MIN(precinct) AS prc FROM sel GROUP BY nbhd) x
JOIN PolicePrecincts p ON p.PrecinctName = x.prc;

INSERT INTO CrimeCategories (CategoryName, NIBRSGroup, CrimeAgainstCategory)
SELECT DISTINCT cat, grp, against FROM sel;

-- 3e. Fact table
INSERT INTO CrimeIncidents
    (SourceId, SourceOffenseId, ReportNumber, OccurredAt, ReportedAt,
     CategoryId, NeighborhoodId, PrecinctId, BlockAddress, Latitude, Longitude, Beat)
SELECT ds.SourceId,
       s.source_offense,
       s.rpt,
       s.occ,
       s.rdt,
       c.CategoryId,
       n.NeighborhoodId,
       p.PrecinctId,
       s.block,
       s.lat,
       s.lng,
       s.beat
FROM sel s
JOIN DataSources ds    ON ds.DatasetIdentifier = 'tazs-3rd5'
JOIN CrimeCategories c ON c.CategoryName = s.cat
                      AND c.NIBRSGroup = s.grp
                      AND c.CrimeAgainstCategory = s.against
JOIN Neighborhoods n   ON n.NeighborhoodName = s.nbhd
JOIN PolicePrecincts p ON p.PrecinctName = s.precinct;

SELECT COUNT(*) AS IncidentsLoaded FROM CrimeIncidents;


-- ============================================================
-- PART 4: GENERATE SAMPLE ROWS FOR THE OTHER NINE TABLES
-- (generated data, not real; state this in the submission)
-- ============================================================

SET SESSION cte_max_recursion_depth = 200000;

INSERT INTO DataSources (SourceName, DatasetIdentifier, SourceURL, LastImportedAt)
VALUES ('Seattle 911 Calls (generated sample)', 'SAMPLE-911-CALLS',
        'https://data.seattle.gov', NOW());

INSERT INTO AppUsers (DisplayName, Email, PasswordHash, CreatedAt)
WITH RECURSIVE seq AS (
    SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 1000
)
SELECT CONCAT('User ', n), CONCAT('user', n, '@example.com'),
       SHA2(CONCAT('password', n), 256),
       NOW() - INTERVAL FLOOR(RAND() * 730) DAY
FROM seq;

INSERT INTO EmergencyContacts (UserId, ContactName, PhoneNumber, Relationship)
WITH RECURSIVE seq AS (
    SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 2000
)
SELECT FLOOR((n - 1) / 2) + 1, CONCAT('Contact ', n),
       CONCAT('206-555-', LPAD(n, 4, '0')),
       ELT(1 + FLOOR(RAND() * 4), 'Parent', 'Partner', 'Friend', 'Sibling')
FROM seq;

INSERT INTO SOSAlerts (UserId, AlertTime, Latitude, Longitude, AlertStatus)
WITH RECURSIVE seq AS (
    SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 2000
)
SELECT 1 + FLOOR(RAND() * 1000),
       NOW() - INTERVAL FLOOR(RAND() * 525600) MINUTE,
       47.50 + RAND() * 0.20, -122.42 + RAND() * 0.10,
       ELT(1 + FLOOR(RAND() * 3), 'ACTIVE', 'RESOLVED', 'CANCELLED')
FROM seq;

INSERT INTO Routes (RouteName, StartLatitude, StartLongitude,
                    EndLatitude, EndLongitude, DistanceMeters)
WITH RECURSIVE seq AS (
    SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 5000
)
SELECT CONCAT('Route ', n),
       47.50 + RAND() * 0.20, -122.42 + RAND() * 0.10,
       47.50 + RAND() * 0.20, -122.42 + RAND() * 0.10,
       FLOOR(500 + RAND() * 9500)
FROM seq;

INSERT INTO RouteSegments (RouteId, SegmentOrder, NeighborhoodId, DistanceMeters)
WITH RECURSIVE seq AS (
    SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 10000
)
SELECT FLOOR((n - 1) / 2) + 1, MOD(n - 1, 2) + 1,
       1 + FLOOR(RAND() * (SELECT COUNT(*) FROM Neighborhoods)),
       FLOOR(100 + RAND() * 5000)
FROM seq;

INSERT INTO RouteRecommendations (UserId, RouteId, RequestedAt, EstimatedRisk, RecommendationType)
WITH RECURSIVE seq AS (
    SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 5000
)
SELECT 1 + FLOOR(RAND() * 1000), n,
       NOW() - INTERVAL FLOOR(RAND() * 525600) MINUTE,
       ROUND(RAND() * 100, 4),
       ELT(1 + FLOOR(RAND() * 3), 'SAFEST', 'FASTEST', 'BALANCED')
FROM seq;

INSERT INTO EmergencyCalls (SourceId, SourceCallId, CallTime, CallType,
                            NeighborhoodId, Latitude, Longitude)
WITH RECURSIVE seq AS (
    SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 30000
)
SELECT (SELECT SourceId FROM DataSources WHERE DatasetIdentifier = 'SAMPLE-911-CALLS'),
       CONCAT('911-', n),
       NOW() - INTERVAL FLOOR(RAND() * 2102400) MINUTE,
       ELT(1 + FLOOR(RAND() * 5), 'Assault', 'Burglary', 'Medical Emergency',
           'Traffic Collision', 'Disturbance'),
       1 + FLOOR(RAND() * (SELECT COUNT(*) FROM Neighborhoods)),
       47.50 + RAND() * 0.20, -122.42 + RAND() * 0.10
FROM seq;

INSERT INTO SafetyResources (NeighborhoodId, ResourceName, ResourceType,
                             ContactInfo, ResourceURL)
WITH RECURSIVE seq AS (
    SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 50
)
SELECT MOD(n - 1, (SELECT COUNT(*) FROM Neighborhoods)) + 1,
       CONCAT('Safety Resource ', n),
       ELT(1 + FLOOR(RAND() * 4), 'Community Center', 'Clinic', 'Library', 'Fire Station'),
       '206-555-0100', 'https://example.org/safety-resource'
FROM seq;

INSERT INTO RiskScores (NeighborhoodId, RiskDate, HourOfDay,
                        IncidentCount, RiskScore, ModelVersion)
WITH RECURSIVE days AS (
    SELECT 0 AS d UNION ALL SELECT d + 1 FROM days WHERE d < 29
),
hours AS (
    SELECT 0 AS h UNION ALL SELECT h + 1 FROM hours WHERE h < 23
)
SELECT n.NeighborhoodId, CURDATE() - INTERVAL days.d DAY, hours.h,
       FLOOR(RAND() * 20), ROUND(RAND() * 100, 4), 'v1.0'
FROM Neighborhoods n
CROSS JOIN days
CROSS JOIN hours;


-- ============================================================
-- PART 5: VERIFICATION (screenshot section A for the submission)
-- ============================================================

-- A. Row counts for all 14 tables
SELECT 'DataSources' AS TableName, COUNT(*) AS RowCount FROM DataSources
UNION ALL SELECT 'PolicePrecincts', COUNT(*) FROM PolicePrecincts
UNION ALL SELECT 'CrimeCategories', COUNT(*) FROM CrimeCategories
UNION ALL SELECT 'Neighborhoods', COUNT(*) FROM Neighborhoods
UNION ALL SELECT 'CrimeIncidents', COUNT(*) FROM CrimeIncidents
UNION ALL SELECT 'AppUsers', COUNT(*) FROM AppUsers
UNION ALL SELECT 'EmergencyContacts', COUNT(*) FROM EmergencyContacts
UNION ALL SELECT 'SOSAlerts', COUNT(*) FROM SOSAlerts
UNION ALL SELECT 'Routes', COUNT(*) FROM Routes
UNION ALL SELECT 'RouteSegments', COUNT(*) FROM RouteSegments
UNION ALL SELECT 'RouteRecommendations', COUNT(*) FROM RouteRecommendations
UNION ALL SELECT 'EmergencyCalls', COUNT(*) FROM EmergencyCalls
UNION ALL SELECT 'SafetyResources', COUNT(*) FROM SafetyResources
UNION ALL SELECT 'RiskScores', COUNT(*) FROM RiskScores;

-- B. Orphan check (should be 0)
SELECT COUNT(*) AS OrphanIncidents
FROM CrimeIncidents i
LEFT JOIN CrimeCategories c ON c.CategoryId = i.CategoryId
WHERE c.CategoryId IS NULL;

-- C. Date range of the crime data
SELECT MIN(OccurredAt) AS EarliestIncident, MAX(OccurredAt) AS LatestIncident
FROM CrimeIncidents;