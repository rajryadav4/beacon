# CrimeRadar Showcase

**Safer times, places and routes in Seattle, from public police data.**

CrimeRadar recommends **the safest reasonable route** for walking, cycling or driving. It never sends you on a long detour for a tiny gain, it accounts for the time of day you'll travel, and it explains every choice. This repo is the showcase version: it grows the CS 5200 database class project into a full public app with advanced safety features.

- **Roadmap and features:** [ROADMAP.md](ROADMAP.md)
- **Where it started (class project):** [docs/CLASS_PROJECT.md](docs/CLASS_PROJECT.md) and the original repo [rajryadav4/CrimeRadar](https://github.com/rajryadav4/CrimeRadar)

## What's here now

The repo starts as a copy of the class project, with its history:

| Path | What it is |
|---|---|
| `CrimeRadar/` | Current web app: Java servlets on Tomcat 9, MySQL, plain-JS UI with heatmap, safe routes and danger alerts. The reference while we move to the new stack. |
| `pipeline/` | Downloads SPD crime data and builds the map data |
| `ml/` | Risk model training, output and [model card](ml/MODEL_CARD.md) |
| `sql/`, `scripts/`, `tools/` | Class-project database scripts and helpers |
| `docs/` | Architecture, API, database, user guide, class-project write-ups |
| `project-plan/`, `poster/` | Class-project plan and showcase poster |

## Where it's going

New app on **React + TypeScript + MapLibre**, a **Python FastAPI** API, and **PostgreSQL + PostGIS**, with these features first:

1. Live incident layer with an "Is this normal?" alert
2. Walk-me-home check-in timer with automatic SOS
3. Event-aware risk (games, concerts, festivals)
4. Lighting-aware night routing

The full list of 12 features and the phases are in [ROADMAP.md](ROADMAP.md).

## Running the new app

Phase 0 of the new stack is in `apps/web` (React + MapLibre) and `apps/api` (FastAPI), on PostgreSQL + PostGIS from `docker-compose.yml`. It serves the crime heatmap and the ML risk grid. Setup, data load and test commands: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Running the class app

See [docs/CLASS_PROJECT.md](docs/CLASS_PROJECT.md) for the database setup and how to run the Java app, or run the UI on its own data without a server:

```bash
python3 tools/serve_ui.py
```

Then open http://localhost:5500/.

## Team

Raj Ranjit Yadav, Trevor Kkhaya, Purvesha Kolhe, with contributions from Shushruth Vijay Kallutla.

Data: [Seattle Police Department Open Data](https://data.seattle.gov). Risk scores show reported crime, not all crime. They are a decision aid, not a guarantee, and must not be used to stigmatize neighborhoods.
