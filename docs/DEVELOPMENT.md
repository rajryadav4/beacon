# Developing Beacon

Beacon is a small monorepo. It grew out of CrimeRadar, our CS 5200 class project ([rajryadav4/CrimeRadar](https://github.com/rajryadav4/CrimeRadar)), which is a separate project. The class-project Java app in `CrimeRadar/` stays untouched as the reference.

| Path | What it is |
|---|---|
| `apps/web` | React + TypeScript + Vite + MapLibre GL map UI |
| `apps/api` | Python FastAPI app on PostgreSQL + PostGIS |
| `db/schema` | Postgres schema, run automatically on the first start of the database container |
| `pipeline/` | Data download (`fetch_spd.py`), Postgres load (`load_postgres.py`), ML risk import (`import_risk.py`) |
| `ml/` | Risk model training and output (unchanged from the class project) |
| `docker-compose.yml` | Local PostGIS database |

## Prerequisites

- Docker Desktop (for PostGIS)
- Python 3.12+
- Node.js 20+

## First-time setup

From the repository root:

```bash
python3 -m venv .venv
```

```bash
.venv/bin/pip install -r apps/api/requirements-dev.txt
```

```bash
docker compose up -d db
```

The database listens on `localhost:5433` (user and database `beacon`, local-only password `beacon-dev`).
To change these, copy `.env.example` to `.env` (git-ignored) and edit it.

Load the data (about 72 MB download, then about 30 s to load):

```bash
.venv/bin/python pipeline/fetch_spd.py
```

```bash
.venv/bin/python pipeline/load_postgres.py
```

```bash
.venv/bin/python pipeline/import_risk.py
```

On a python.org build of Python on macOS, the download can fail with `CERTIFICATE_VERIFY_FAILED`.
Run it with the certifi bundle instead:

```bash
SSL_CERT_FILE=$(.venv/bin/python -m certifi) .venv/bin/python pipeline/fetch_spd.py
```

## Run

API on http://localhost:8000 (interactive docs at `/docs`):

```bash
.venv/bin/uvicorn app.main:app --app-dir apps/api --reload --port 8000
```

Web app on http://localhost:5173 (proxies `/api` to port 8000):

```bash
npm --prefix apps/web install
```

```bash
npm --prefix apps/web run dev
```

### Web app notes

The main page uses the CrimeRadar class app's design and features (`CrimeRadar/src/main/webapp/`), ported to React:

- **Explore**: GPU heatmap by time of day and crime type, *Play the day*, the risk grid and the **3D risk skyline**,
  stat tiles, the 58 areas ranked by danger index (click one to highlight it on the map), radar blips on the riskiest
  blocks. The map and the whole app turn to the midnight palette for evening and night.
- **Directions**: From / To with Photon place search, *My location* and *pick on map* on each field, Home / Work /
  favourites, *Nearest safe place*; walk / bike / car; leave now or at a time. Up to 3 OSRM routes scored with the risk
  grid at the time of travel (green = recommended, orange = moderate, red = most dangerous), the recommendation rules
  and a *Why?* per route. **Trip mode** gives turn-by-turn guidance and danger alerts (banner, sound, vibration);
  *Simulate* plays the trip.
- **Alerts**: official alerts with freshness, the *Upcoming* hazard outlook, the hazard map (worst to safest + zones),
  survival mode and its *DEMO*. **Safe places**: nearest places and *Where to go* safe areas, each with *Route*.
- **Survival mode** is map-first: your position, the danger area, the chosen safe place or safer area, the bold walking
  route, a direction arrow with distance and time, the next turn, and the instructions in a collapsible sheet
  (phone) or side panel (desktop). *Navigate* follows the device (watchPosition only while navigating).
- Places, preferences and trip history stay in the browser (localStorage). Location is set only by a user action and
  is rounded before it is sent to the API.
- Crime data comes from `GET /api/meta`, `/api/grid` and `/api/neighborhoods` (the class contract); if the API is down,
  the bundled copy in `public/data/` is used. Optional endpoints (the hazard outlook) are read from `/openapi.json`, so
  a missing one is hidden, never called.
- Open `http://localhost:5173/?mock=1` for typed fake alerts, safe places and outlook data (marked MOCK DATA).
- Code: `src/components/` (explore, directions, trip, alerts, places, survival, Panel), `src/hooks/`, `src/lib/`
  (risk, recommend, routing, places, plan, danger, geo, clock, storage) and `src/lib/map/` (the map engine and style).

## Test

```bash
cd apps/api && ../../.venv/bin/python -m pytest -q
```

```bash
npm --prefix apps/web run build
```

The API tests run against the local database, so start it and load the data first.
With only the schema loaded (as in CI), set `BEACON_TEST_DATA=schema` to skip the tests that need the full data.

## Deploy

One Docker image (`Dockerfile`) serves the API and the built web app; free hosting on Render and Neon, with
GitHub Actions for CI and data refresh: see [DEPLOY.md](DEPLOY.md).

## API (Phase 0)

| Endpoint | Returns |
|---|---|
| `GET /api/health` | `{"status": "ok", "database": "ok"}` |
| `GET /api/meta` | Data range, totals, grid, time bands, crime groups, travel modes, risk thresholds, active model |
| `GET /api/heatmap?band=all\|night\|morning\|afternoon\|evening&groups=violent,robbery` | GeoJSON points at grid-cell centers: `cellId`, `count`, `weight` (severity-weighted) |
| `GET /api/risk?band=evening` | GeoJSON cell polygons for the active model: `cellId`, `risk`, `level`, `neighborhood` |

The grid, time bands, crime groups and risk levels are the same as the class app ([docs/API.md](API.md), section 1).

## Safe places

When something happens, Beacon points people to the nearest suitable safe place: shelter, bomb shelter, bunker,
emergency assembly point, emergency hub, hospital, police, fire station or community centre.
Tables: `safe_places` and `hazard_place_kinds` (which kinds suit which hazard, best first) in `db/schema/003_safe_places.sql`.
The importer applies that file itself, so it also works on a database created before the file existed.

Seattle (OpenStreetMap for the crime grid box, plus the City of Seattle's open GIS layers):

```bash
.venv/bin/python pipeline/import_safe_places.py --seattle-official
```

Any other area, from OpenStreetMap (`--bbox south,west,north,east`):

```bash
.venv/bin/python pipeline/import_safe_places.py --bbox 60.10,24.80,60.30,25.20
```

An official list as GeoJSON points (a file or an http(s) URL, such as an ArcGIS query with `f=geojson`); every feature gets the one `--kind`:

```bash
.venv/bin/python pipeline/import_safe_places.py --no-osm --geojson shelters.geojson --kind bomb_shelter --source-name helsinki-civil-defence
```

- Sources:
  - **OpenStreetMap** via Overpass. Several public instances are tried in order; `--overpass-url` overrides them.
    Bus, picnic and other plain shelters, private bunkers and hospitals with `emergency=no` are skipped.
  - **City of Seattle GIS** (services.arcgis.com): emergency hubs, fire stations, police precincts, hospitals, community centres.
- Rows are upserted on `(source, source_ref)`. Places that are gone from a source are removed: for OSM only inside the `--bbox`.
- An OSM place is hidden (view `safe_places_visible`) when an official place of the same kind is within 150 m.
- Seattle emergency hubs are volunteer-run sites that open after a major disaster, not staffed buildings.
- **Attribution:** OpenStreetMap data is under the ODbL. Every map or list that shows these places must credit
  "© OpenStreetMap contributors" with a link to https://www.openstreetmap.org/copyright (the `source` field is `osm`).

| Endpoint | Returns |
|---|---|
| `GET /api/hazards` | `{"hazards": [{"key", "label", "placeKinds": [...best first]}]}` for every hazard key in `app/hazard_taxonomy.py` |
| `GET /api/safe-places?bbox=west,south,east,north&kinds=hospital,police` | GeoJSON points with `id, name, kind, kindLabel, address, phone, openingHours, source`; at most 2000, nearest the box center first, `truncated` when there were more |
| `GET /api/safe-places/nearest?lat=47.61&lng=-122.33&hazard=earthquake&limit=5` | `{"hazard", "places": [{id, name, kind, kindLabel, lat, lng, distanceM, address, phone, openingHours, source}]}`: within 2 km by suitability rank then straight-line distance, then the nearest further away. `hazard` is optional (all kinds, by distance); `limit` is 1-20 |

The caller's coordinates are never stored or logged: `/nearest` responses are `Cache-Control: no-store`, and its
query string is dropped from the uvicorn access log (a reverse proxy in front of the API must do the same).

## Hazard outlook

Beacon looks ahead about 72 hours for natural hazards in the region, shows which areas are worst and safest for each
hazard, and points people to safer ground. It uses only free, open data and open-source software; no API key is
needed. Tables are in `db/schema/005_hazard_outlook.sql`, and both scripts apply that file themselves.

Hazard zones, terrain and exposure per grid cell (run again when the sources or safe places change; about 10 min):

```bash
.venv/bin/python pipeline/import_hazard_zones.py
```

The outlook, one pass or a loop (every 30 min by default; `--bbox west,south,east,north` for another region):

```bash
.venv/bin/python pipeline/outlook_worker.py --once
```

On a python.org build of Python on macOS, prefix both with `SSL_CERT_FILE=$(.venv/bin/python -m certifi)`.
Optional: set `FIRMS_MAP_KEY` (a free NASA key) to add FIRMS satellite fire detections. Without it that source shows
as `skipped`.

### Where is worst and safest: zones and exposure

| Source | What | Level | License |
|---|---|---|---|
| WA DNR tsunami models (via City of Seattle GIS) | Seattle Fault M7.5 (2022) and Cascadia L1 inundation | > 6 ft high, 1-6 ft moderate, < 1 ft low | Public data, as is |
| City of Seattle Environmentally Critical Areas | Liquefaction-prone areas | high | City of Seattle open data, as is |
| City of Seattle ECA | Known landslides; potential slide areas; 40 %+ steep slopes (merged per ~1 km tile) | high; moderate; moderate | City of Seattle open data, as is |
| City of Seattle ECA | Flood-prone areas (FEMA zones plus 100 ft) | moderate | City of Seattle open data, as is |
| FEMA National Flood Hazard Layer | A/AE/AO/VE (1 % a year, "100-year"); shaded X (0.2 %, "500-year"); levee-protected X | high; moderate; low | US public domain |
| USGS volcano hazard zones (via WA Geological Survey, City of Seattle) | Mount Rainier lahars and post-lahar sediment (the Duwamish valley) | high; moderate | US public domain / public data |
| AWS Terrain Tiles (terrarium, zoom 13, ~13 m) | Elevation and slope per cell | | Open data; USGS 3DEP, SRTM, ETOPO1 and others ([attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)) |

Zones are clipped to the grid box and stored simplified to about 2 m; `hazard_zone_footprints` keeps one dissolved
outline per kind (about 10 m) so an outlook item can be drawn over, say, the tsunami inundation zones. Which zone kinds count for which hazard is in `hazard_zone_kinds`: landslide areas
count for `flood` (heavy rain triggers most Seattle landslides) and for `earthquake`, with liquefaction.

Exposure is scored for `tsunami`, `flood`, `earthquake` and `volcano` on every land cell (cells more than half open
water are skipped). The formula is in `pipeline/hazard_scoring.py`:

- **Zone** `Z = 1.0 × high share + 0.6 × moderate share + 0.3 × low share` of the cell. Shares are cumulative, so a
  higher level wins where zones overlap; when two sources map the same hazard (FEMA and the city's flood-prone areas),
  the larger share of one source is used, not the sum.
- **Terrain** `T`: lowland `L` is 1 at sea level and 0 at 20 m (median land elevation of the cell), and counts only
  within 500 m of a mapped zone of that hazard, fading out at 1 km. Slope `S` is 0 at 10° and 1 at 30° (90th percentile
  of pixel slopes). Tsunami and volcano use `L`, flood uses `max(L, S)`, earthquake uses `S`.
- **Access** `A`: straight-line distance to the nearest suitable safe place for the hazard (`hazard_place_kinds`),
  0 at the door and 1 at 3 km or more.
- `score = round(100 × (0.75 Z + 0.25 T) × (0.85 + 0.15 A))`; level `high` ≥ 50, `moderate` ≥ 20, otherwise `low`.
  `factors` holds every input, so the map can explain a cell.

A score compares cells with each other for one hazard. It is not a probability that anything happens there.

### What may be coming: outlook sources and thresholds

Levels: `watch` (possible), `likely` (expected, or a forecast crosses an official threshold), `imminent` (an official
warning, or already happening). A model forecast alone never goes above `likely`, and its confidence is `low`.

| Source | Rule | License |
|---|---|---|
| NASA EONET open events (last 10 days) | Wildfire within 40 km (inside the area: imminent), volcano within 350 km (ash), severe storm within 300 km, flood within 50 km: watch. Prescribed fires are skipped | NASA open data |
| GDACS | Tropical cyclone within 1000 km, flood within 100 km, volcano within 350 km, wildfire within 50 km; Orange: watch, Red: likely. Earthquakes and droughts skipped | Free public alerts, credit GDACS (EC JRC, UN OCHA) |
| NOAA tsunami.gov (NTWC Atom feed + CAP) | Warning: imminent, advisory: likely, watch: watch, when the CAP area names Washington or Puget Sound; drawn over the mapped inundation zones. Information statements never alert | US public domain |
| NWS alerts for the region's zones | Watches and outlooks: watch; advisories: likely; warnings: imminent within 12 h of onset, else likely. Only `Future`/`Expected` urgency (Beacon's alerts feed covers `Immediate`); marine-only alerts skipped | US public domain |
| NWS river forecasts (NWPS) | Gauges within ~10 km with official flood categories: observed at or above minor flood stage: imminent; forecast crest above it within 72 h: likely; at action stage: watch. Area: mapped flood zones within 6 km | US public domain |
| NOAA SPC convective outlooks, days 1-3 | Marginal and Slight: watch; Enhanced, Moderate, High: likely (general thunder skipped) | US public domain |
| NOAA WPC excessive rainfall outlooks, days 1-3 | Marginal (5 %+) and Slight (15 %+): watch; Moderate (40 %+) and High (70 %+): likely | US public domain |
| Open-Meteo forecast (9 points over the area) | Wind: NWS Western Region Wind Advisory (31 mph sustained or 46 mph gusts): watch; High Wind Warning (40 / 58 mph): likely. Heat: NWS heat index Extreme Caution (feels like 90 °F+): watch; Danger (103 °F+): likely. Landslides: USGS Seattle cumulative threshold `P3 ≥ 3.5 − 0.67 × P15` inches (Chleborad 2003): watch, plus the intensity-duration threshold `I ≥ 82.73 × D^−1.13` mm/h (Godt et al. 2006): likely; drawn over the mapped landslide areas | Data CC BY 4.0; free API for non-commercial use (self-host the AGPL server otherwise) |
| Open-Meteo air quality (CAMS) | 24-hour mean PM2.5 against the EPA AQI breakpoints: Unhealthy for Sensitive Groups (35.5 µg/m³+): watch; Unhealthy (55.5+): likely | CC BY 4.0, contains modified Copernicus Atmosphere Monitoring Service information |
| USGS earthquakes | Recent activity only (count and largest quake in `/api/outlook/sources`). After an M5+ within 150 km in the past 7 days: an "aftershocks possible" watch | US public domain |
| NASA FIRMS (optional, `FIRMS_MAP_KEY`) | VIIRS hotspots within 40 km (low-confidence pixels skipped): watch, inside the area: likely | NASA open data, free key |

Every source's last fetch, status, message and license is in `hazard_sources`. A failing source keeps its previous
items until they expire. Other free sources were checked and left out on purpose: NASA POWER (past weather only, no
forecast), NASA GIBS (imagery, nothing to detect from), NHC (tropical cyclones; GDACS covers the rare Pacific storm),
USGS Water Services (NWPS already carries the USGS gauge readings, with official flood stages).

### API

| Endpoint | Returns |
|---|---|
| `GET /api/outlook?lat&lng` | `{"location": {lat, lng, cellId, inRegion, exposure: [{hazard, hazardLabel, score, level}]}, "outlook": [{id, hazard, hazardLabel, level, title, summary, validFrom, validTo, confidence, sources: [{name, url, observed}], distanceKm}], "updatedAt", "disclaimer"}`: items whose area covers the point or lies within 25 km, most serious first |
| `GET /api/outlook/areas?bbox=w,s,e,n` | GeoJSON MultiPolygons of the current outlook items (`id, hazard, hazardLabel, level, title, summary, validFrom, validTo, confidence`) |
| `GET /api/hazard-zones?hazard=tsunami&bbox=w,s,e,n&kind=` | GeoJSON zone polygons (simplified to ~5 m) with `id, hazard, kind, level, name, source`. Pass the map viewport as `bbox`: the whole city's flood and landslide zones are about 6 MB |
| `GET /api/hazard-grid?hazard=flood` | GeoJSON cell polygons with `cellId, score, level, factors` (tsunami, flood, earthquake, volcano), for a worst-to-safest layer |
| `GET /api/safe-areas?lat&lng&hazard=flood&limit=3` | `{hazard, hazardLabel, location, advice, areas: [{cellId, lat, lng, distanceM, score, level, reason}], places: [... /safe-places/nearest fields + score, level, reason], note, disclaimer}`. Areas are the nearest cells with score ≤ 10 and no zone overlap (tsunami and volcano also 15 m+ above sea level, flood 5 m+), at least 400 m apart; places are suitable safe places inside such cells. Hazards without a grid return places only |
| `GET /api/outlook/sources` | Every zone, terrain and outlook source: last fetch, status, message, item count, license, attribution |

Point queries (`/api/outlook` and `/api/safe-areas`) are `Cache-Control: no-store`; their query strings are dropped
from the uvicorn access log and never stored.

### Honest limits

- **Earthquakes cannot be predicted.** Beacon never says one is coming. For earthquakes it shows preparedness
  (liquefaction and landslide zones, exposure) and recent USGS activity; the only earthquake outlook item is the
  aftershock notice after a large quake, which is what USGS itself publishes.
- The outlook is not an official warning. It relays official products and applies simple published thresholds to
  free model forecasts; people must follow local officials and emergency alerts.
- Exposure is relative and only as good as the maps: the city layers stop at the Seattle city limits (cells outside
  rely on FEMA, the tsunami models and terrain; `cell_terrain.in_city` marks this), zone maps are modelled scenarios,
  and 13 m terrain cannot see seawalls, levees or buildings.
- Distances are straight lines, not routes; a safe area across water or a freeway is not always reachable.
- Open-Meteo forecasts are a single model blend sampled at 9 points; heat uses apparent temperature, not the full NWS
  HeatRisk product.

## Database notes

- Port of `sql/crime_radar_all.sql` and `sql/app_tables.sql`: snake_case names, identity keys, `timestamptz`,
  and real PostGIS columns (`geography(Point)` for incidents, places and SOS alerts; `geometry(Polygon)` for grid cells).
- SPD times are Seattle local time. The loader stores them as `timestamptz` (America/Los_Angeles), and the
  `clean_incidents` view turns them back into local time for the time bands.
- `grid_cells` holds all 10,800 cells of the 135 × 80 grid with their polygons; `cell_id = row * 100 + col`.
- The API reads only the summary tables (`cell_stats`, `cell_risk_scores`, ...), never `crime_incidents` per request.
- The generated milestone sample rows (random users, routes, 911 calls) are not created.

## Alerts

Beacon picks up official alerts for the user's location, says what is happening and what to do, and turns on
survival mode when a severe alert covers them.

**Beacon is a helper. It does not replace Wireless Emergency Alerts (WEA), NOAA Weather Radio, the
Emergency Alert System or local officials.** The feeds below arrive with delays, can be missing or wrong,
and Beacon only knows where you are while the app is open. Always follow official instructions.

### Sources

| Source | Feed | Refresh (worker) | Stored as |
|---|---|---|---|
| NWS | `api.weather.gov/alerts/active?area=WA` (CAP as GeoJSON) | 2 min | `alerts` (`source = 'nws'`) |
| USGS | `earthquake.usgs.gov` summary feed, M2.5+ past day, worldwide | 1 min | `alerts` (`source = 'usgs'`) |
| FEMA IPAWS | OpenFEMA `IpawsArchivedAlerts`, last 7 days, areas intersecting a WA box | 60 min | `alerts` (`source = 'ipaws'`) |
| Seattle Fire 911 | `data.seattle.gov` `kzjm-xkqj`, last 6 hours | 5 min | `emergency_calls` (data source `kzjm-xkqj`) |

- **Hazard**: the alert's SAME code, then the NWS code, then the event name, through `apps/api/app/hazard_taxonomy.py`.
  When nothing specific matches (for example `LAE` Local Area Emergency, or a Dense Fog Advisory), the trained
  classifier is used if `apps/api/app/hazard_model.py` is installed (`classified_by = 'model'`, with `confidence`);
  otherwise the hazard is `other` (`classified_by = 'source'` when the code itself was generic, else `'none'`).
- **NWS zones**: most NWS alerts name forecast or county zones instead of a polygon. The ingest fetches each zone
  shape once (`alert_zones`, refreshed after 30 days) and stores the union as the alert's `geom`.
- **Earthquakes**: severity from magnitude (≥ 6 Extreme, ≥ 5 Severe, ≥ 4 Moderate, else Minor), urgency
  `Immediate` for 6 hours after the quake and `Past` after that, and an affected radius of
  10^(0.5 M − 0.8) km (M4 ≈ 16 km, M5 ≈ 50 km, M6 ≈ 160 km). That radius is a rule of thumb, not a ShakeMap.
  A quake row expires 24 hours after the origin time (72 hours from M6).
- **IPAWS freshness**: OpenFEMA publishes the IPAWS archive with roughly a day's delay (in testing, the newest
  message was about 24 hours old), so most IPAWS alerts have already expired when they arrive. They are kept as
  history and context; NWS and USGS are the real-time sources. NWS-originated IPAWS messages are skipped
  because the NWS feed already has them.
- **Seattle Fire**: all dispatches are stored. Medical, test and admin call types are not shown as incidents.
  A few call types map to a hazard (hazmat and natural gas → `hazmat`, brush fire → `wildfire`, water rescue →
  `flood`, scenes of violence → `crime`); building, car and rubbish fires stay `other`, since they are local incidents.
- **Lifecycle**: rows are never deleted. `ended_at` / `end_reason` record why an alert ended: `expired`,
  `superseded` (an Update referenced it), `cancelled` (a Cancel referenced it), or `gone` (no longer in the NWS
  feed it came from). Test, draft, keep-alive and monthly test messages are not stored.

### Run

One-shot ingest of every source (also applies `db/schema/004_alerts.sql` to an existing database):

```bash
SSL_CERT_FILE=$(.venv/bin/python -m certifi) .venv/bin/python pipeline/ingest_alerts.py
```

Options: `--sources nws,usgs,ipaws,seattle_fire`, `--area OR` (NWS state or marine area), `--point 47.61,-122.33`
(NWS alerts for one point), `--ipaws-days 7`, `--fire-hours 6`.

Worker that keeps everything fresh (Ctrl+C to stop; a failing feed backs off up to 30 min without blocking the
others; intervals can be changed with `--every-nws`, `--every-usgs`, `--every-seattle-fire`, `--every-ipaws`):

```bash
SSL_CERT_FILE=$(.venv/bin/python -m certifi) .venv/bin/python pipeline/alerts_worker.py
```

Requests send the User-Agent `beacon-dev/0.1 (+https://github.com/rajryadav4/beacon)`, which NWS requires.

### API

| Endpoint | Returns |
|---|---|
| `GET /api/alerts/active?lat=47.61&lng=-122.33` | `location`, `alerts` (the alerts that cover the point), `incidents` (Seattle Fire calls within 1 km in the last 2 hours), `survival`, `topHazard`, `updatedAt` |
| `GET /api/alerts?bbox=west,south,east,north` | GeoJSON FeatureCollection of active alerts (polygons, or epicenter points for earthquakes) with `id`, `event`, `hazard`, `severity`, `headline`, `expires` |
| `GET /api/alerts/status` | Per source: last attempt and success, last error, items in the last fetch, newest item time, active and stored counts |

- An alert applies when its polygon covers the point, or for an earthquake when the point is within its radius.
  Only `status = 'Actual'` alerts that have not ended are returned (exercises are left out).
- Each alert: `id, source, event, hazard, hazardLabel, severity, urgency, certainty, headline, description,
  instruction, areaDesc, sender, effective, expires, url, magnitude, distanceKm` (0 inside a polygon, the
  distance to the epicenter for a quake). Sorted by severity (Extreme first), then by onset.
- `survival` is true when an applying alert is Extreme or Severe, Immediate or Expected, and Actual.
  `topHazard` is the hazard of the first alert, or `null`.
- Each incident: `id, type, hazard, time, distanceKm`.
- The caller's coordinates are used for one query and are never stored. The `/api/alerts/active` response is sent
  with `Cache-Control: no-store`, and uvicorn's access log shows `lat=redacted&lng=redacted`.
