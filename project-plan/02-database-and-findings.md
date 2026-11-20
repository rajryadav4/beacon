# 02 · Database & Milestone 3 Findings

Source of truth: [`sql/crime_radar_all.sql`](../sql/crime_radar_all.sql) (build script) and [`sql/milestone3_business_queries.sql`](../sql/milestone3_business_queries.sql).

## Current schema (14 tables)

| Area | Tables | Notes |
|---|---|---|
| Crime data | `CrimeIncidents`, `CrimeCategories`, `DataSources`, `EmergencyCalls` | `CrimeIncidents` is the fact table |
| Geography | `Neighborhoods`, `PolicePrecincts`, `SafetyResources` | Neighborhoods are names + precinct only |
| Routing | `Routes`, `RouteSegments`, `RouteRecommendations`, `RiskScores` | |
| Users & safety | `AppUsers`, `EmergencyContacts`, `SOSAlerts` | |

> The Milestone 2 write-up and the poster say 13 tables; the build script also creates `RiskScores` (14). Pick one and make the final report consistent.

### Facts about the schema that the plan depends on

| Question | Answer | Why it matters |
|---|---|---|
| Can we upsert daily updates? | **Yes.** `UNIQUE (SourceId, SourceOffenseId)` on `CrimeIncidents`. `SourceOffenseId = ReportNumber-OffenseId` | `INSERT … ON DUPLICATE KEY UPDATE` works today for a daily sync job |
| Do incidents have coordinates? | **Yes.** `Latitude`, `Longitude` (invalid ones set to NULL during load) | Enables grid-based scoring of real routes ([04](04-recommendation-engine.md)) |
| Do neighborhoods have boundaries? | **No.** Name + precinct only | Can't do polygon matching without importing MCPP GeoJSON |
| Do routes have street geometry? | **No.** Start/end points + 2 segments each with a neighborhood and distance | Fine for the Milestone 4 demo; real routes come from OSRM |
| Indexes | `OccurredAt`, `NeighborhoodId`, `CategoryId` | Good for 90-day and time-of-day queries |

### Real vs. generated data

| Real (SPD) | Generated sample rows |
|---|---|
| `CrimeIncidents` (150,000 newest valid offenses, Nov 2024 – Oct 2026), `CrimeCategories`, `Neighborhoods`, `PolicePrecincts`, `DataSources` | `AppUsers`, `EmergencyContacts`, `SOSAlerts`, `Routes`, `RouteSegments`, `RouteRecommendations`, `EmergencyCalls`, `SafetyResources`, `RiskScores` |

Any demo of route scoring on stored routes is running on generated routes. Say so in the Milestone 4 write-up.

## Schema additions needed for the full product

```sql
-- App-managed: CRUD lives here (Milestone 4)
CREATE TABLE SavedRoutes (
    SavedRouteId   BIGINT AUTO_INCREMENT PRIMARY KEY,
    UserId         BIGINT NOT NULL,
    Label          VARCHAR(100) NOT NULL,          -- "Home to campus"
    StartLatitude  DECIMAL(10,7) NOT NULL,
    StartLongitude DECIMAL(10,7) NOT NULL,
    EndLatitude    DECIMAL(10,7) NOT NULL,
    EndLongitude   DECIMAL(10,7) NOT NULL,
    TravelMode     ENUM('WALKING','CYCLING','DRIVING') NOT NULL DEFAULT 'WALKING',
    CreatedAt      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (UserId) REFERENCES AppUsers(UserId) ON DELETE CASCADE
);

CREATE TABLE UserPreferences (
    UserId               BIGINT PRIMARY KEY,
    DefaultMode          ENUM('WALKING','CYCLING','DRIVING') NOT NULL DEFAULT 'WALKING',
    MaxDetourPercent     DECIMAL(5,2) NOT NULL DEFAULT 25.00,
    MaxExtraMinutes      DECIMAL(5,2) NOT NULL DEFAULT 5.00,
    PrioritizePersonCrime BOOLEAN NOT NULL DEFAULT TRUE,
    FOREIGN KEY (UserId) REFERENCES AppUsers(UserId) ON DELETE CASCADE,
    CHECK (MaxDetourPercent BETWEEN 0 AND 100),
    CHECK (MaxExtraMinutes >= 0)
);

-- Source-managed: one row per sync run (for a future daily sync job)
CREATE TABLE SyncRuns (
    SyncRunId     BIGINT AUTO_INCREMENT PRIMARY KEY,
    SourceId      INT NOT NULL,
    StartedAt     DATETIME NOT NULL,
    FinishedAt    DATETIME,
    Status        ENUM('RUNNING','SUCCESS','FAILED') NOT NULL DEFAULT 'RUNNING',
    WatermarkUsed DATETIME,            -- fetched records updated after this
    RowsInserted  INT NOT NULL DEFAULT 0,
    RowsUpdated   INT NOT NULL DEFAULT 0,
    ErrorMessage  VARCHAR(1000),
    FOREIGN KEY (SourceId) REFERENCES DataSources(SourceId)
);
```

Later, `RouteRecommendations` should also store `TravelMode`, `DepartureAt`, `DurationSeconds` and the detour settings used, so a recommendation can be reproduced and explained.

## Milestone 3 key findings (real data, 150K incidents)

| Question | Finding |
|---|---|
| Where? | 10 neighborhoods hold **47%** of incidents. Capitol Hill leads (12,346). |
| Precincts | North 30%, West 27%, East 19%, South 14%, Southwest 9% |
| Time of day | **39%** of incidents occur 4 PM–midnight. Hour 00:00 holds 11%, likely a default for unknown times. |
| Season | 2025: Jun–Sep ran 12% above Jan–Mar. October peaked (7,172), February was lowest (5,356). |
| Night vs. day (crimes against people) | Night is higher in 9 of the top 10 neighborhoods. Capitol Hill 2.08×. Downtown is the exception (0.75×). |
| Weekends | Friday is busiest by volume, but Sat/Sun have the highest share against people (16.4–16.6%). |
| Report lag | 5.2 days (South) to 6.5 days (North) on average, so the newest week undercounts. |
| Route risk (Q11) | `Risk = Σ (segment km × neighborhood incidents/day, last 90 days)`. 5,000 routes ranked in ~0.28 s. |

### What these findings mean for the product

- **Time of day matters.** Score routes for the hour the user will actually walk them.
- **Report lag.** Skip or down-weight the most recent ~7 days, and show data freshness.
- **The midnight spike.** Treat 00:00 timestamps as "time unknown" in hourly calculations.
- **Raw counts favor dense areas.** Capitol Hill is busy, not necessarily the most dangerous per visitor. Present scores as *reported-incident exposure*, and normalize if population or foot-traffic data is added.
