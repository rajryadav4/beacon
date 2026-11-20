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

## Hazard classifier

Tells what kind of calamity a free-text emergency message is about (13 hazard keys in
`apps/api/app/hazard_taxonomy.py`) and how severe it is (CAP severity).
Official alert codes always win; the model is only for text with no usable code.
Model card: [ml/hazard/MODEL_CARD.md](../ml/hazard/MODEL_CARD.md).

Fetch real alerts from the OpenFEMA IPAWS archive (about 20 minutes, longer when OpenFEMA is busy and
answers 503; about 11 MB, saved to the git-ignored `data/ipaws/`; an interrupted run resumes, and a rerun
retries plans that failed):

```bash
SSL_CERT_FILE=$(.venv/bin/python -m certifi) .venv/bin/python ml/hazard/fetch_ipaws.py
```

Train and evaluate (about 15 minutes; it fits four models). Writes `ml/hazard/output/metrics.json` (committed) and
`ml/hazard/output/hazard_model.joblib` (git-ignored):

```bash
.venv/bin/python ml/hazard/train_hazard_model.py
```

Serve: the API loads `ml/hazard/output/hazard_model.joblib` on the first request.
Set `HAZARD_MODEL_PATH` to load it from somewhere else. Without the file, the endpoints return 503.

| Endpoint | Returns |
|---|---|
| `POST /api/hazard/classify` with `{"text": "..."}` (1 to 5000 characters) | `hazard`, `hazardLabel`, `confidence`, `severity`, top-3 `scores`, `model` |
| `GET /api/hazard/model` | Model version, trained date, abstain threshold, test metrics summary |

Below the confidence threshold the answer is `other`. Request text is not logged.
From Python (for example the alert ingest): `from app.hazard_model import classify`.

## Database notes

- Port of `sql/crime_radar_all.sql` and `sql/app_tables.sql`: snake_case names, identity keys, `timestamptz`,
  and real PostGIS columns (`geography(Point)` for incidents, places and SOS alerts; `geometry(Polygon)` for grid cells).
- SPD times are Seattle local time. The loader stores them as `timestamptz` (America/Los_Angeles), and the
  `clean_incidents` view turns them back into local time for the time bands.
- `grid_cells` holds all 10,800 cells of the 135 × 80 grid with their polygons; `cell_id = row * 100 + col`.
- The API reads only the summary tables (`cell_stats`, `cell_risk_scores`, ...), never `crime_incidents` per request.
- The generated milestone sample rows (random users, routes, 911 calls) are not created.
