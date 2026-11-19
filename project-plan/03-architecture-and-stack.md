# 03 · Architecture & Tech Stack

## Stack (all free)

| Component | Technology | Why |
|---|---|---|
| Frontend | JSP, HTML, CSS, JavaScript | Matches the course and the existing Eclipse project |
| Backend | Java 17 Servlets on **Tomcat 9** | Handles requests, calls services (matches the merged app) |
| Database | MySQL 8 | Keeps all Milestone 2 and 3 work |
| Data access | JDBC + DAOs | Required for Milestone 4 |
| Map | Leaflet + OpenStreetMap tiles | Free, open source |
| Route generation | openrouteservice (hosted, free tier) | Walking / cycling / driving routes with alternatives |
| Recommendation logic | Java service + SQL | Explainable, cheap, testable ([04](04-recommendation-engine.md)) |
| Daily data updates | Java importer (`HttpClient` + JDBC) | Same language, no extra infrastructure |
| Scheduling | macOS `launchd` (or run manually) | Free. A paid server isn't needed. |
| Optional ML | Python + pandas + scikit-learn, offline | Only if it beats a historical-average baseline |
| Tests | Plain Java test runner (`crimeradar.tools.RecommendationEngineTest`) | Service logic is tested without a database or extra jars |

> **The app targets Tomcat 9 and Java 17**, as set up in the merged Eclipse project (PR #1). Servlets import `javax.servlet.*`. Moving to Tomcat 10.1 later means switching every import to `jakarta.servlet.*` and swapping the JSTL jars, so do it all at once, not file by file.

## Request flow

```
RecommendRoute.jsp (start, destination, mode, departure time, detour limits)
  → RecommendRoute servlet       validate input, build RecommendationSettings
  → RouteRecommender
       ├─ OpenRouteServiceClient  up to 3 route alternatives (geometry, distance, duration)
       ├─ CrimeStatsDao (JDBC)    incident counts per grid cell + citywide time pattern
       └─ RecommendationService   mode, detour, exposure and time rules
  → RecommendRoute.jsp + Leaflet map
```

SQL calculates what the data says about each route. Java decides which route fits the user. Each layer has one job, which is what makes it testable.

## Java packages (as built)

```
crimeradar.model           One class per table (PR #1)
crimeradar.dal             ConnectionManager, one CRUD DAO per table (PR #1), CrimeStatsDao (recommender)
crimeradar.recommendation  TravelMode, CrimeGrid, ExposureCalculator, RecommendationService,
                           RouteRecommender, OpenRouteServiceClient, ... (see 04)
crimeradar.servlet         FindIncidents, RecommendRoute
crimeradar.tools           Inserter (data-layer test), RecommendationEngineTest (recommender tests)
src/main/webapp            FindIncidents.jsp, RecommendRoute.jsp
```

Later additions (not built yet): `SavedRoutes` / `UserPreferences` DAOs and pages, and a daily Seattle data sync job.

## Configuration and secrets

- MySQL login: `src/main/java/db.properties` (git-ignored, copied from `db.properties.example`).
- openrouteservice key: `src/main/java/routing.properties` (git-ignored, copied from `routing.properties.example`), or the `ORS_API_KEY` environment variable.
- The repo is public, so never commit keys or passwords.

## Two kinds of data

| Source-managed | Application-managed |
|---|---|
| `CrimeIncidents`, `CrimeCategories`, `Neighborhoods`, `PolicePrecincts`, `DataSources`, `SyncRuns` | `AppUsers`, `SavedRoutes`, `UserPreferences`, `RouteRecommendations`, `EmergencyContacts`, `SOSAlerts` |
| Written only by `DataSync` | CRUD through the web app |
