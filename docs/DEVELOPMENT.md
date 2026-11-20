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
