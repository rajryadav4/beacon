# 04 · Route Recommender (combined)

**Goal:** recommend the *safest reasonable* route. That means no long detour for a small safety gain, never a different travel mode, and risk for the time of day you'll actually be on each street.

This is one recommender built from three pieces of team work:

| From | What it brings |
|---|---|
| **Trevor** (PR #3) | The backbone: `RouteRiskScorer` / `RoutingService` interfaces, `RecommendationService` rules, `RouteRecommendationEngine`, missing scores never treated as zero |
| **Purvesha** (PR #2) | The ML risk model (`CellRiskScores` on ~225 m blocks × 4 time bands), OSRM routing, and the Safe routes screen |
| **Raj** (Person 1) | `MlRouteRiskScorer`: total exposure with arrival-time bands on the ML grid; readable explanations; presets; the API endpoint and the browser copy of the rules |

## How a recommendation is made

```
Safe routes screen (directions.js)
  1. OSRM in the browser: up to 3 routes for the chosen mode (+ detour candidates)
  2. Browser decision at once (recommend.js + risk.js)          ← offline mode stops here
  3. POST api/routes/recommend {mode, departAt, preference, routes}
Server (Java, Tomcat 9)
  4. MlRouteRiskScorer      exposure per route from the active ML model (MySQL, cached)
  5. RecommendationService  mode filter → detour cap → lowest exposure → minimum gain → explanation
  6. JSON back; the server's decision replaces the browser's (same rules)
```

`GET /recommendroutes` runs the same engine with routing on the server (openrouteservice when `ORS_API_KEY` is set, otherwise OSRM, no key). Useful for testing with `curl`.

## The decision rules (`crimeradar.service.RecommendationService`)

1. **Same mode only.** A walker is only compared against walking routes.
2. **Find the fastest route.**
3. **Time limit** = fastest + the *smaller* of (fastest × max detour %) and max extra minutes. Slower routes are never recommended, however safe.
4. **Among routes within the limit**, take the lowest crime exposure.
5. **Only switch if it's worth it:** the exposure must be at least the preset's minimum gain lower than the fastest route's. Otherwise the fastest route.
6. **Ties go to the faster route.** Unknown exposure is never treated as zero.

### Presets (the user's "Route choice")

`UserPreferences.SafetyWeight` (0–1) picks a preset (`RecommendationSettings.Preference`):

| SafetyWeight | Preset | Walking | Cycling | Driving | Min. gain |
|---|---|---|---|---|---|
| below 0.34 | Fastest | no detour | no detour | no detour | — |
| 0.34 to 0.66 | Balanced | 25% or 5 min | 20% or 6 min | 20% or 8 min | 15% |
| 0.67 and above (default 0.70) | Safer | 50% or 10 min | 40% or 12 min | 40% or 15 min | 10% |

These are product defaults, not validated safety thresholds. Tune them after testing real trips.

### Worked example

Walking, Balanced, fastest route 12 min. Limit = 12 + min(25% × 12 = 3, 5) = **15 min**.

| Route | Time | Exposure | Result |
|---|---|---|---|
| A | 12 min | 80 | Fastest |
| B | 14 min | 45 | **Recommended:** 44% lower, within 15 min |
| C | 22 min | 20 | Lowest exposure, but over the limit, so never recommended |

*"This walking route adds 2 min to the fastest option (14 min instead of 12 min) and has 44% lower crime exposure."*

The old app ranking (`0.7 × risk + 0.3 × time`, no limit) picked C here.

### Every outcome is explained

| When | Explanation |
|---|---|
| A route within the limit is lower by at least the minimum gain | "This walking route adds 2 min … has 44% lower crime exposure." |
| The fastest route is also the lowest | "The fastest route also has the lowest crime exposure, so there is no reason to detour." |
| Lower routes exist but break the limit | "… A route with 75% lower crime exposure exists, but it takes 22 min, over your limit of 15 min." |
| Within the limit, but below the minimum gain | "… only 8% lower in crime exposure, below the 15% needed to be worth a detour." |
| Some alternatives could not be scored | "… Some other routes within your time limit could not be scored …" |
| One route only / all zero / fastest unscored | "Only one walking route …" / "No crime is predicted …" / "… could not be evaluated." |

## How exposure is scored (`crimeradar.service.MlRouteRiskScorer`)

```
exposure = Σ over 25 m steps of (step km × ExpectedRisk of the step's grid cell,
           in the time band when the traveller reaches that step)
```

- **Risk source:** the active ML model (`ModelRuns` + `CellRiskScores`), read through `MapDataDao`. It beats the history baseline on all four metrics ([ml/MODEL_CARD.md](../ml/MODEL_CARD.md)).
- **Grid:** the app's grid (lat0 47.48, lng0 −122.46, 0.002° × 0.003°, 135 × 80, `cellId = row × 100 + col`). Bands: night 0–6, morning 6–12, afternoon 12–18, evening 18–24.
- **Total, not average.** The app's old route score averaged risk per point, which rewarded long detours through quiet streets.
- **Arrival time per step.** A walk leaving at 5:55 PM is scored with afternoon risk at first and evening risk after 6 PM.
- **Outside Seattle.** The share of the route on the grid is returned as `matchedGeometryFraction`. Below 50%, the score is `null` (unknown), never 0. Below 95%, a warning is added.
- **Fresh data.** The model snapshot is cached and reloaded when `MapDataDao.signature()` changes (new model or re-import), checked at most once a minute. If MySQL goes down after loading, the last good snapshot keeps working. With no model at all, the engine falls back to travel time with a warning.
- **Registration.** `RouteServicesListener` puts the scorer in ServletContext attribute `crimeradar.routeRiskScorer`, where both endpoints find it.

The browser copy (`RiskModel.routeExposure` in `risk.js`) does the same on `grid.json`. Both give 44.478 for the Capitol Hill test route.

## Files

| Layer | Files |
|---|---|
| Models | `crimeradar/model/{RouteOption, RouteRiskScore, DataQuality, RouteRequest, RoutingResponse, RecommendationResult, Coordinate, TravelMode}.java` |
| Rules | `service/{RecommendationService, RecommendationSettings, RouteRecommendationEngine}.java` |
| Scoring (Person 1) | `service/{MlRouteRiskScorer, RiskGrid}.java`, `servlet/RouteServicesListener.java` |
| Routing | `service/{OsrmRoutingService, OpenRouteServiceClient, RoutingService}.java` |
| Endpoints | `api/RouteRecommendServlet.java` (POST `api/routes/recommend`), `servlet/RecommendRoutes.java` (GET `recommendroutes`), `service/RecommendationJson.java` |
| Browser | `assets/js/recommend.js` (rules), `risk.js` (`routeExposure`), `directions.js` (`rescore`, `applyDecision`), `api.js` (`routing.recommend`) |
| Tests | `src/test/java/...` (JUnit), `tests/route-rules-cases.json`, `tools/check_route_rules.mjs` |

No extra jars: JSON goes through `crimeradar.util.Json`. The code targets Java 17 and Tomcat 9 (`javax.servlet`), like the rest of the app.

## Tests

- **Shared cases:** `tests/route-rules-cases.json` (15 trips) runs against the Java rules (`RouteRulesSharedCasesTest`) and the browser rules (`node tools/check_route_rules.mjs`), so the two cannot drift apart unnoticed.
- **JUnit** (`mvn test` in `CrimeRadar/`, or run the classes in Eclipse): rules, presets, the scorer (hotspot, arrival band, total vs. average, off-grid, reload, outages), OSRM and ORS parsing, the endpoint's JSON contract, and Trevor's original tests. `RecommendRoutesWebTest` runs the servlet on embedded Tomcat 9 and needs Maven to download Tomcat.

## Known limits (say them in the demo)

- **Fresh crime.** The ML risk is a yearly prediction. New crime changes it only after the pipeline runs and the risk is re-imported (`scripts/setup-db.ps1 --risk-only`).
- **One risk number per block.** The model predicts severity-weighted risk over all crime types, so walkers and drivers are ranked on the same risk. Per-mode crime mixes, like car prowls for drivers, would need per-group model output.
- **Reported crime only.** Busy areas score higher partly because more people are there. Scores are a relative decision aid, not a probability, and must not be used to stigmatize neighborhoods.
- **Recommendations are not saved yet.** Trips are saved (`TripDetails` → `RouteRecommendations`), but the decision's exposure and preset are not stored with them.
