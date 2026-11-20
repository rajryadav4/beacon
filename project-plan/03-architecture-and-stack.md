# 03 · Architecture & Tech Stack

## Stack (all free)

| Component | Technology | Why |
|---|---|---|
| Frontend | JSP, HTML, CSS, JavaScript | Matches the course and the existing Eclipse project |
| Backend | Java 17 Servlets on **Tomcat 9** | Handles requests, calls services (matches the merged app) |
| Database | MySQL 8 | Keeps all Milestone 2 and 3 work |
| Data access | JDBC + DAOs | Required for Milestone 4 |
| Map | Leaflet + OpenStreetMap tiles | Free, open source |
| Route generation | OSRM at routing.openstreetmap.de (no key); openrouteservice optional with `ORS_API_KEY` | Walking / cycling / driving routes with alternatives |
| Recommendation logic | Java service + SQL | Explainable, cheap, testable ([04](04-recommendation-engine.md)) |
| Daily data updates | Java importer (`HttpClient` + JDBC) | Same language, no extra infrastructure |
| Scheduling | macOS `launchd` (or run manually) | Free. A paid server isn't needed. |
| Optional ML | Python + pandas + scikit-learn, offline | Only if it beats a historical-average baseline |
| Tests | JUnit 5 via `CrimeRadar/pom.xml` (`mvn test`) + `node tools/check_route_rules.mjs` | Rules and scoring are tested without a database |

> **The app targets Tomcat 9 and Java 17**, as set up in the merged Eclipse project (PR #1). Servlets import `javax.servlet.*`. Moving to Tomcat 10.1 later means switching every import to `jakarta.servlet.*` and swapping the JSTL jars, so do it all at once, not file by file.

## Request flow (route recommendations)

```
Safe routes screen (directions.js): OSRM routes in the browser, instant decision (recommend.js)
  → POST api/routes/recommend          RouteRecommendServlet
       ├─ MlRouteRiskScorer (JDBC)     exposure from the ML risk grid (MapDataDao, cached)
       └─ RecommendationService         mode, detour cap, minimum gain, explanation
  → the server's decision replaces the browser's; offline mode keeps the browser's
```

SQL and the ML model say how risky each block is. Java decides which route fits the user. Details: [04](04-recommendation-engine.md).

## Java packages (as built)

```
crimeradar.model     One class per table (PR #1); route models (RouteOption, RouteRiskScore, ...)
crimeradar.dal       ConnectionManager, one CRUD DAO per table (PR #1), MapDataDao and app DAOs (PR #2)
crimeradar.service   Route rules, ML route scorer, OSRM/ORS routing, map data cache
crimeradar.api       JSON API under /api (PR #2), including POST /api/routes/recommend
crimeradar.servlet   FindIncidents, RecommendRoutes (GET /recommendroutes), RouteServicesListener
crimeradar.tools     Inserter, SetupAppSchema, SyncIncidents and other command-line tools
src/main/webapp      index.html + assets/ (the app), FindIncidents.jsp
```

## Configuration and secrets

- MySQL login: `src/main/java/db.properties` (git-ignored, copied from `db.properties.example`).
- Optional openrouteservice key: the `ORS_API_KEY` environment variable. Without it, OSRM is used.
- The repo is public, so never commit keys or passwords.

## Two kinds of data

| Source-managed | Application-managed |
|---|---|
| `CrimeIncidents`, `CrimeCategories`, `Neighborhoods`, `PolicePrecincts`, `DataSources`, `SyncRuns` | `AppUsers`, `SavedRoutes`, `UserPreferences`, `RouteRecommendations`, `EmergencyContacts`, `SOSAlerts` |
| Written only by `DataSync` | CRUD through the web app |
