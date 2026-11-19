# CrimeRadar app contract

This file is the contract between the three parts of the app:

```
Python pipeline (pipeline/, ml/)  --writes-->  MySQL tables + webapp/assets/data/*.json
Java backend (Tomcat 9, /api/*)   --reads-->   MySQL tables
Browser UI (webapp/)              --reads-->   /api/*  (falls back to assets/data/*.json)
```

Change this file first when a shape changes. All three parts follow it.

## 1. Shared constants

### Map grid

The risk model and the heatmap use one fixed grid over Seattle. A cell is about 223 m x 225 m.

| Constant | Value |
|---|---|
| `lat0` (south edge) | `47.48` |
| `lng0` (west edge) | `-122.46` |
| `dLat` | `0.002` |
| `dLng` | `0.003` |
| `rows` | `135` (north edge 47.75) |
| `cols` | `80` (east edge -122.22) |

```
row    = floor((lat - lat0) / dLat)        valid: 0 <= row < 135
col    = floor((lng - lng0) / dLng)        valid: 0 <= col < 80
cellId = row * 100 + col
center = (lat0 + (row + 0.5) * dLat,  lng0 + (col + 0.5) * dLng)
```

### Time bands

`band = floor(hour / 6)` with the local Seattle hour (0-23).

| id | key | label | hours |
|---|---|---|---|
| 0 | `night` | Night | 12 AM - 6 AM |
| 1 | `morning` | Morning | 6 AM - 12 PM |
| 2 | `afternoon` | Afternoon | 12 PM - 6 PM |
| 3 | `evening` | Evening | 6 PM - 12 AM |

### Crime groups

Every NIBRS offense description maps to one group in
[`pipeline/category_groups.csv`](../pipeline/category_groups.csv). Rows with
`exclude` (NOT_A_CRIME) are ignored everywhere. A description that is not in
the file maps to `other`.

| id | key | label | severity |
|---|---|---|---|
| 0 | `violent` | Assault & violence | 3.0 |
| 1 | `robbery` | Robbery | 4.0 |
| 2 | `theft` | Theft | 1.0 |
| 3 | `vehicle` | Vehicle crime | 1.0 |
| 4 | `burglary` | Burglary & trespass | 1.5 |
| 5 | `vandalism` | Vandalism & arson | 1.0 |
| 6 | `drugs` | Drugs, weapons & disorder | 1.5 |
| 7 | `other` | Other offenses | 0.25 |

### Travel modes

| key | label | vulnerability |
|---|---|---|
| `walk` | Walk | 1.0 |
| `bike` | Bike | 0.7 |
| `car` | Car | 0.3 |

### Unwanted data (ignored by the app)

- Offenses in the `exclude` group (NOT_A_CRIME).
- Neighborhoods `-`, `UNKNOWN`, `OOJ` (out of jurisdiction), `FK ERROR`: not ranked.
- Incidents without coordinates (`REDACTED`) or outside the grid: not on the map.
  They still count in their neighborhood's totals.
- Offenses with an `OccurredAt` time of exactly `00:00:00` (8.6%): the time of day is unknown
  (they would make Night look 40% worse). They are left out of every time-of-day count
  (`counts`, `CellStats`, `NeighborhoodStats`) and of the risk model. `meta.totals.incidents`
  still includes them, and `meta.totals.unknownTime` gives their number.
- Generated sample tables from milestone 2 (`RiskScores`, `EmergencyCalls`,
  `SafetyResources`, `SOSAlerts`, the 5,000 random `Routes`): not used by the app.

### Risk

- Unit of cell risk: **expected severity-weighted incidents per year in that cell during that 6-hour band**, from the ML model.
- Levels use one global set of thresholds for all bands, so evening and night show more red cells than morning:
  `LOW < q90 <= ELEVATED < q97 <= HIGH`, where `qNN` is a quantile of all cell-band risks of cells in `grid.json`.
  (Changed from q75/q90 on 2026-11-19: the risk is very skewed, and with q90 almost all of downtown was "high",
  so routes inside downtown could not be told apart.)

## 2. Map data: static files and matching endpoints

The UI first calls the endpoint. If it fails, it loads the static file from
`webapp/assets/data/`. Both return the same JSON.

### `GET api/meta` = `assets/data/meta.json`

```json
{
  "version": 1,
  "generatedAt": "2026-11-19T09:30:00Z",
  "source": { "name": "SPD Crime Data: 2008-Present", "id": "tazs-3rd5", "url": "https://data.seattle.gov/d/tazs-3rd5" },
  "dataRange": { "from": "2022-11-19", "to": "2026-11-17", "years": 3.99 },
  "totals": { "incidents": 285000, "located": 250000, "excluded": 33212, "unknownTime": 24500 },
  "grid": { "lat0": 47.48, "lng0": -122.46, "dLat": 0.002, "dLng": 0.003, "rows": 135, "cols": 80 },
  "bands": [ { "id": 0, "key": "night", "label": "Night", "hours": "12 AM - 6 AM" } ],
  "groups": [ { "id": 0, "key": "violent", "label": "Assault & violence", "severity": 3.0 } ],
  "modes": { "walk": { "label": "Walk", "vulnerability": 1.0 } },
  "risk": {
    "unit": "expected severity-weighted incidents per year in the cell during the band",
    "quantiles": { "q50": 1.1, "q75": 2.7, "q90": 7.8, "q97": 25.7, "q99": 47.0 },
    "levels": { "elevated": 7.8, "high": 25.7 }
  },
  "model": {
    "version": "risk-2026-11-19",
    "algorithm": "HistGradientBoostingRegressor (Poisson loss)",
    "trainedOn": "2022-11-19 to 2025-11-18, tested on 2025-11-19 to 2026-11-17",
    "metrics": { "hotspotCapture10": 0.61, "spearman": 0.74, "poissonDeviance": 1.23 },
    "baseline": { "name": "last-year counts", "hotspotCapture10": 0.55, "spearman": 0.69, "poissonDeviance": 1.41 }
  }
}
```

`bands`, `groups` and `modes` hold every row of the tables in section 1.
`hotspotCapture10` = share of the test year's severity-weighted incidents that fall in the 10% of
cell-bands the model ranks highest. `totals.unknownTime` = offenses with no time of day (section 1).
`totals.located` counts every offense with coordinates, unknown-time ones too; the grid `counts`
leave unknown-time offenses out, so they sum to less than `totals.located`.

### `GET api/grid` = `assets/data/grid.json`

```json
{ "version": 1, "cells": [ [12345, 7, [/* 32 counts */], [0.4, 1.2, 2.5, 3.1]] ] }
```

Each cell is `[cellId, nbIndex, counts, risk]`:

- `nbIndex`: index into `neighborhoods.json` `neighborhoods` (the neighborhood with the most incidents in the cell), or `-1`.
- `counts`: 32 integers, located incidents over the whole data range, `index = band * 8 + groupId`.
- `risk`: 4 numbers (2 decimals), model risk per band (section 1).

Include each cell that has at least one located incident (a Poisson model never predicts 0, so
"risk above 0" would add every cell, water too).

### `GET api/neighborhoods` = `assets/data/neighborhoods.json`

```json
{ "version": 1, "neighborhoods": [ {
  "key": "CAPITOL HILL", "name": "Capitol Hill", "precinct": "East",
  "lat": 47.6205, "lng": -122.3193, "cells": 85, "areaKm2": 4.26,
  "counts": [/* 32 integers, located + unlocated, index = band * 8 + groupId */],
  "unlocated": 1234
} ] }
```

Sorted by `name`. `lat`/`lng` = mean of located incidents. `cells` = grid cells whose dominant
neighborhood is this one. `areaKm2 = cells * 0.0501`.

### `assets/data/places.json` (static only)

Seattle landmarks for the destination suggestions:
`{ "places": [ { "name": "Space Needle", "category": "Landmark", "lat": 47.6205, "lng": -122.3493 } ] }`

## 3. Account API (server only)

- Base path: `api/` under the web app root, for example `http://localhost:8080/CrimeRadar/api/auth/me`.
- Request bodies: `application/x-www-form-urlencoded`. Responses: JSON, UTF-8.
- Errors: `{"error": "Human-readable message"}` with a 4xx or 5xx status.
- Every `POST` and `DELETE` must send the header `X-CrimeRadar: 1`, else `403` (CSRF guard).
- Session: `JSESSIONID` cookie, `HttpOnly`, `SameSite=Lax`. Login changes the session id.
- `api/me/*` returns `401` without a login.

| Method and path | Form fields | Success |
|---|---|---|
| `POST api/auth/register` | `displayName`, `email`, `password` (8+ chars) | `201 {"user": User}` and logged in. `409` if the email exists |
| `POST api/auth/login` | `email`, `password` | `200 {"user": User}`. `401 {"error": "Email or password is incorrect."}`. `429` after 5 failures in 10 minutes |
| `POST api/auth/logout` | - | `204` |
| `GET api/auth/me` | - | `200 {"user": User}` or `401` |
| `POST api/me/preferences` | `mode`, `safetyWeight` (0-1), `alerts` (`true`/`false`) | `200 {"preferences": Preferences}` |
| `GET api/me/places` | - | `200 {"places": [Place]}` |
| `POST api/me/places` | `kind` (`home`/`work`/`saved`), `label`, `address`, `lat`, `lng` | `201 {"place": Place}`. A new home or work replaces the old one |
| `DELETE api/me/places/{id}` | - | `204`. `404` if it is not the user's place |
| `POST api/me/trips` | `fromLabel`, `fromLat`, `fromLng`, `toLabel`, `toLat`, `toLng`, `mode`, `departAt` (local ISO, `2026-11-19T21:30`), `distanceMeters`, `durationSeconds`, `riskScore` (0-100), `riskLevel` (`low`/`elevated`/`high`), `choice` (`safest`/`fastest`/`balanced`) | `201 {"trip": Trip}` |
| `GET api/me/trips?limit=10` | - | `200 {"trips": [Trip]}`, newest first |
| `GET api/health` | - | `200 {"ok": true, "db": true}` |

```
User        = { "id": 12, "displayName": "Demo User", "email": "demo@crimeradar.app",
                "createdAt": "2026-11-19T09:30:00Z", "preferences": Preferences }
Preferences = { "mode": "walk", "safetyWeight": 0.7, "alerts": true }
Place       = { "id": 5, "kind": "home", "label": "Home", "address": "...", "lat": 47.61, "lng": -122.33 }
Trip        = { "id": 9, "fromLabel": "...", "toLabel": "...", "toLat": 47.6, "toLng": -122.3, "mode": "walk",
                "departAt": "2026-11-19T21:30", "riskScore": 42.5, "riskLevel": "elevated",
                "choice": "safest", "createdAt": "2026-11-19T09:31:00Z" }
```

Demo account (seeded by the backend setup): `demo@crimeradar.app` / `CrimeRadar2026!`,
with a Home and a Work place. It is a public test login for the exhibition, not a secret.

## 4. Route scoring (done in the browser)

1. Get up to 3 routes from OSRM (`routing.openstreetmap.de`, profiles `foot`, `bike`, `car`).
2. Walk each route every 25 m and look up the grid cell of each point.
3. `intensity` = time-weighted mean of `risk[band]` over the points.
4. `adjusted = intensity * vulnerability[mode]`. The level uses the thresholds in `meta.risk.levels`.
5. `score` (0-100) = `100 * ln(1 + adjusted) / ln(1 + maxCellRisk)`, where `maxCellRisk` is the largest
   risk value in `grid.json`. (A quantile scale capped at q99 gave every downtown evening route 100.)
6. Ranking: `w * normRisk + (1 - w) * normDuration`, with `w = preferences.safetyWeight`.
   Map colors: rank 1 = green (recommended); of the others, the riskiest = red (most dangerous), the rest = orange
   (moderate). With 2 routes, the other one is red only if it is riskier than rank 1.
7. "Incidents along the route": sum of `counts[band*8 + g]` over the unique cells, divided by `dataRange.years`,
   for the groups that matter for the travel mode: walk and bike = 0, 1, 2, 6 (street crime);
   car = 0, 1, 3 (assault, robbery, vehicle crime).
8. Demo account: the server resets its saved places, trips and preferences at each demo login (shared login).
