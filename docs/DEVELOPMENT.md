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
