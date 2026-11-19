# 04 · Recommendation Engine

**Goal:** recommend the *safest reasonable* route. That means not a long detour for a tiny safety gain, never a different travel mode, and always the time of day you'll actually be travelling.

Owner: Raj. Code: `CrimeRadar/src/main/java/crimeradar/recommendation/`, plus `dal/CrimeStatsDao.java`, `servlet/RecommendRoute.java` and `webapp/RecommendRoute.jsp`.

## How a recommendation is made

```
RecommendRoute.jsp     user clicks start + destination, picks mode, departure time, detour limits
  → RecommendRoute     servlet: validates input (Seattle only), builds RecommendationSettings
  → RouteRecommender   the whole flow:
       1. OpenRouteServiceClient  up to 3 real street routes for the chosen mode
       2. CrimeStatsDao           incident counts per grid cell from MySQL (one query) + citywide time pattern
       3. CrimeGrid               crime density per ~270 m cell and 4-hour time block
       4. ExposureCalculator      walks each route in 50 m steps → exposure score
       5. RecommendationService   applies the rules below → RecommendationResult + "why" sentence
  → map with all routes (recommended in red), comparison table, explanation, data notes
```

SQL summarizes what the data says about each place. Java decides what fits the user.

## The decision rules (`RecommendationService`)

1. **Same mode only.** A walker is only shown walking routes.
2. **Find the fastest route.**
3. **Time limit** = fastest + the *smaller* of (fastest × max detour %) and max extra minutes. Routes slower than that are never recommended, however safe.
4. **Among routes within the limit**, take the one with the lowest exposure.
5. **Only switch if it's worth it:** recommend that route only if its exposure is at least **15% lower** than the fastest route's. Otherwise recommend the fastest.
6. **Ties go to the faster route.**

| Mode | Max detour | Max extra time | Crime weights (person / property / other) |
|---|---|---|---|
| Walking | 25% | 5 min | 1.0 / 0.4 / 0.3 |
| Cycling | 20% | 6 min | 1.0 / 0.5 / 0.3 (bike theft) |
| Driving | 20% | 8 min | 0.4 / 1.0 / 0.2 (car prowls) |

These are product defaults, not validated safety thresholds. Users can change the detour limits on the page. The 15% threshold is `RecommendationSettings.DEFAULT_MIN_IMPROVEMENT_PERCENT`.

### Worked example (from the plan)

Walking, fastest route 12 min. Limit = 12 + min(25% × 12 = 3, 5) = **15 min**.

| Route | Time | Exposure | Result |
|---|---|---|---|
| A | 12 min | 80 | Fastest |
| B | 14 min | 45 | **Recommended**: 44% lower, within 15 min |
| C | 22 min | 20 | Lowest exposure, but over the limit, so never recommended |

*"This walking route adds 2 min to the fastest option (14 min instead of 12 min) and has 44% lower crime exposure."*

### Every outcome has a reason

| Reason | When | What the user sees |
|---|---|---|
| `SAFER_ALTERNATIVE` | A route within the limit is ≥15% lower | "…adds 2 min … has 44% lower crime exposure." |
| `FASTEST_IS_LOWEST` | The fastest route is also the lowest | "The fastest route also has the lowest crime exposure…" |
| `ALTERNATIVES_TOO_SLOW` | Lower routes exist but break the limit | "…A route with 75% lower crime exposure exists, but it takes 22 min, over your limit of 15 min." |
| `IMPROVEMENT_TOO_SMALL` | Within the limit, but <15% lower | "…only 8% lower in crime exposure, below the 15% needed…" |
| `ONLY_ONE_ROUTE` | The routing service found one route | "Only one walking route was found…" |
| `NO_REPORTED_INCIDENTS` | All options score 0 | "No incidents were reported along any of these routes…" |

## How exposure is scored

**Why a grid:** `Neighborhoods` has names but no boundaries, while every incident has latitude/longitude. A grid of cells (0.0025° lat × 0.0035° lng, about 270 m square) lets *any* route be scored by exactly the streets it uses.

For each cell and 4-hour time block:

```
rate        = weighted incidents per day in the last 90 days (blended 50/50 with the 3×3 neighbor average)
time share  = share of the area's incidents in this time block (last 365 days, 3×3 cells),
              blended with the citywide pattern: trust = incidents / (incidents + 20)
density     = rate × time share × 6
exposure    = Σ over 50 m steps of (step km × density of that step's cell at the time you reach it)
```

- **Weighted by mode.** The crime weights in the table above decide how much each incident counts.
- **Arrival time per step.** A trip leaving at 7:50 PM is scored with evening patterns at the start and night patterns after 8 PM.
- **Late reports.** The data window is anchored to the newest incident in the database and skips its last 7 days, because reports arrive 5 to 6.5 days late (Milestone 3, Q7).
- **The midnight spike.** Incidents stamped exactly 00:00:00 (11% of the data, usually an unknown time) count toward a cell's level but not its time-of-day pattern.
- **Outside Seattle.** If less than 80% of the recommended route is inside Seattle, the result is flagged as low confidence. Missing data is never treated as "safe".

Exposure is a **relative** score for comparing routes on the same trip, not the chance that something happens to you. The page says so.

## Running it

1. Build the database (`sql/crime_radar_all.sql`) and set up `db.properties` as in the main README.
2. Get a free openrouteservice key: <https://openrouteservice.org/dev/#/signup>.
3. Copy `CrimeRadar/src/main/java/routing.properties.example` to `routing.properties` in the same folder and paste the key. The file is git-ignored. Alternatively, set the `ORS_API_KEY` environment variable.
4. Run on Tomcat 9 and open <http://localhost:8080/CrimeRadar/recommend>.
5. Click the map (or use the place lists) to set the start and destination, choose a mode and time, then select **Recommend a route**.

### Tests (no database or API key needed)

Right-click `crimeradar.tools.RecommendationEngineTest` > **Run As > Java Application**. It runs 19 tests: the decision rules and every reason above, mode filtering, detour limits, ties, the hotspot grid, time-of-day, crossing time blocks, mode weights, outside-Seattle confidence, openrouteservice response parsing and the data window.

## Known limits and next steps

- **Raw counts favor busy areas.** Dense nightlife areas score high partly because more people are there. Present scores as reported-incident exposure, and normalize if foot-traffic or population data is added (Milestone 5 ETL).
- **The openrouteservice free tier has daily quotas.** Check the current limits before a demo. Every page request makes one routing call.
- **Not saved yet.** Recommendations aren't written to `RouteRecommendations`. The result already carries a `RecommendationType` matching that column, so saving it is a small addition with `RoutesDao` and `RouteRecommendationsDao`.
- **No transit yet.** It needs schedules and transfers. Walking, cycling and driving are supported.
- **Speed.** Adding an index on `CrimeIncidents(Latitude, Longitude)` would speed up the cell query if the table grows well past 150K rows.
