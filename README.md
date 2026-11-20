# Beacon

**Know what's happening. Get to safety.**

Beacon is a personal safety app for everyday risks and emergencies. Day to day, it recommends **the safest reasonable route** for walking, cycling or driving: it never sends you on a long detour for a tiny gain, it accounts for the time of day you'll travel, and it explains every choice. When something serious happens (an earthquake, flood, storm, wildfire or conflict), it picks up official alerts, tells you what is going on and what to do, and guides you to the nearest suitable safe place.

Beacon grew out of **CrimeRadar**, our CS 5200 database class project, which stays a separate project. This repo started as a copy of it.

- **Roadmap and features:** [ROADMAP.md](ROADMAP.md)
- **Where it started (CrimeRadar class project):** [docs/CLASS_PROJECT.md](docs/CLASS_PROJECT.md) and its own repo [rajryadav4/CrimeRadar](https://github.com/rajryadav4/CrimeRadar)

## What's here now

The repo started as a copy of the CrimeRadar class project, with its history:

| Path | What it is |
|---|---|
| `CrimeRadar/` | The CrimeRadar class app: Java servlets on Tomcat 9, MySQL, plain-JS UI with heatmap, safe routes and danger alerts. The reference while we move to the new stack. |
| `pipeline/` | Downloads SPD crime data and builds the map data |
| `ml/` | Risk model training, output and [model card](ml/MODEL_CARD.md) |
| `sql/`, `scripts/`, `tools/` | Class-project database scripts and helpers |
| `docs/` | Architecture, API, database, user guide, class-project write-ups |
| `project-plan/`, `poster/` | Class-project plan and poster |

## Where it's going

New app on **React + TypeScript + MapLibre**, a **Python FastAPI** API, and **PostgreSQL + PostGIS**, with these features first:

1. **Official alerts and survival mode:** government alerts (National Weather Service, USGS earthquakes, FEMA IPAWS) matched to your location; when a severe one covers you, the app switches to a survival screen with what is happening, the official instructions and the way to safety
2. **Safe places:** shelters, bunkers, assembly points, hospitals, police and fire stations, chosen for the hazard, with a walking route to the nearest one
3. **Hazard classifier:** a model trained on real FEMA alerts that reads free-text reports and tells which kind of calamity it is and how severe
4. Live incident layer with an "Is this normal?" alert
5. Walk-me-home check-in timer with automatic SOS

The full feature list and the phases are in [ROADMAP.md](ROADMAP.md). Beacon is a helper, not a replacement for official emergency alerts: always follow instructions from local authorities.

## Running the new app

Phase 0 of the new stack is in `apps/web` (React + MapLibre) and `apps/api` (FastAPI), on PostgreSQL + PostGIS from `docker-compose.yml`. It serves the crime heatmap and the ML risk grid. Setup, data load and test commands: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Running the CrimeRadar class app

See [docs/CLASS_PROJECT.md](docs/CLASS_PROJECT.md) for the database setup and how to run the Java app, or run the UI on its own data without a server:

```bash
python3 tools/serve_ui.py
```

Then open http://localhost:5500/.

## Team

Raj Ranjit Yadav, Trevor Kkhaya, Purvesha Kolhe.

Data: [Seattle Police Department Open Data](https://data.seattle.gov). Risk scores show reported crime, not all crime. They are a decision aid, not a guarantee, and must not be used to stigmatize neighborhoods.
