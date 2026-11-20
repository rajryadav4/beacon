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

## Test

```bash
cd apps/api && ../../.venv/bin/python -m pytest -q
```

```bash
npm --prefix apps/web run build
```

The API tests run against the local database, so start it and load the data first.

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
