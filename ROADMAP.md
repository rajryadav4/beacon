# Beacon: Roadmap

**Goal:** grow the CrimeRadar CS 5200 class project into **Beacon**, a polished, public safety app that recommends **the safest reasonable route** day to day and, in a disaster or conflict, picks up official alerts and guides people to a safe place. It helps people act, not panic.

> *Citizen shows you every siren in the city. Beacon tells you what matters to you, when it matters, and the safest way to get home.*

## Starting point (from the CrimeRadar class project)

| Already working | Where |
|---|---|
| Crime heatmap by time of day and crime type, 58 neighborhoods ranked | `CrimeRadar/src/main/webapp` (Purvesha) |
| ML risk model: gradient boosting per ~225 m cell × 4 time bands, beats the history baseline | `ml/`, [model card](ml/MODEL_CARD.md) |
| SPD data pipeline (last 4 years, ~286K offenses) | `pipeline/` |
| Safe routes (OSRM), danger alerts, sign-in, saved places, trips | `CrimeRadar/` web app + Java API |
| Route recommendation rules: detour cap + 15% minimum gain + explanations | `CrimeRadar/src/main/java/crimeradar/service` (Trevor), plus the combined version in progress in the class repo |

## Advanced features

Ranked by value for Beacon. ★ = build first.

| # | Feature | What it does | Data |
|---|---|---|---|
| 1 ★ | **Live layer + "Is this normal?"** | Live dispatches on the map, and today's activity compared with the usual level for that place and time ("40% busier than a typical Friday night") | Seattle Real Time Fire 911 Calls (`kzjm-xkqj`, ~5-min updates) + history |
| 2 ★ | **Walk-me-home timer** | Set destination and ETA; contacts get an alert with your last location if you don't check in. Off-route warning; timer keeps running while you move | Trips, contacts, SOS |
| 3 ★ | **Event-aware risk** | Higher risk near permitted events around start and end times | Special Events Permits (`dm95-f8w5`) + Street Closures |
| 4 ★ | **Lighting-aware night routing** | At night, extra exposure on blocks with few streetlights or reported outages | Seattle City Light poles + Streetlight Repair Status |
| 5 | **Safe havens** | Open police/fire stations, clinics and 24-hour places along the route; "nearest safe place" button | Real safety-resource locations |
| 6 | **Personal risk profiles** | Crime types weighted by who travels: car prowls for drivers, bike theft for cyclists, person crime for night walkers | Per-group counts already in the data |
| 7 | **Safest departure time** | "Leave 30 min earlier: 25% lower exposure" | ML risk per time band |
| 8 | **Saved-place watch** | Alert when risk around Home or Work rises well above normal; weekly summary | Saved places + recent vs. 1-year counts |
| 9 | **Neighborhood report card** | Year-over-year trends, crime per resident (not raw counts), fairness note | Census population (ACS) |
| 10 | **Model health dashboard** | Monthly predicted vs. actual, data freshness, model versions | Model runs + risk scores |
| 11 | **Ask Beacon** | Plain-English questions answered from the database | LLM API (paid; optional) |
| 12 | **Accessibility + multilingual** | Screen-reader route summaries, translated alerts for tourists | — |

Not planned: community crime reports. Moderating crowd accusations is where competitors got into trouble.

## Tech stack (modern web)

| Layer | Choice | Why |
|---|---|---|
| Frontend | **React + TypeScript + Vite**, **MapLibre GL** | The current UI already uses MapLibre; components make the many new screens manageable |
| API | **Python + FastAPI** | The pipeline and ML model are already Python; the model can be served directly; easy background jobs |
| Database | **PostgreSQL + PostGIS** | Real spatial queries: route-to-block matching, streetlights near a route, events within a radius, nearest safe place |
| Background jobs | Scheduled workers (APScheduler or cron) | SPD daily, Fire 911 every 5 min, events weekly, streetlights monthly |
| Routing | OSRM public server for development, self-hosted OSRM or Valhalla later | Free, no key; self-hosting avoids rate limits at the showcase |
| Alerts | Web Push; SMS optional (paid, e.g. Twilio) | Check-in timer and saved-place alerts |
| Hosting | Free tiers to start (static frontend host, container API host, managed Postgres with PostGIS) | Check current free-tier limits before choosing |

The Java/JSP/MySQL app stays in `CrimeRadar/` as the working reference until each part is ported.

## Phases

| Phase | Scope | Done when |
|---|---|---|
| 0 | **Foundation:** monorepo layout (`apps/web`, `apps/api`, `pipeline`, `ml`), Postgres + PostGIS schema, port the data load and ML risk import | Heatmap and risk grid served by the new API |
| 1 | **Port core features:** heatmap, safe routes with the recommendation rules and explanations, sign-in, saved places, danger alerts | Feature parity with the class app |
| 2 | **★ Features 1–4:** live layer + "Is this normal?", walk-me-home timer, events, lighting | Each feature demoable end to end |
| 3 | **Features 5–8:** safe havens, personal profiles, safest departure time, saved-place watch | |
| 4 | **Features 9–12** and polish: report card, model dashboard, optional "Ask Beacon", accessibility | |
| 5 | **Showcase:** deploy, demo script, poster/slides update, load test of routing | Public URL works on a phone |

## Principles

- **Safest reasonable route:** never switch travel mode; never suggest a detour beyond the user's limit; detour only for a meaningful gain; always explain why.
- **Honest data:** show data freshness; never treat missing data as safe; scores are reported-crime exposure, not a guarantee.
- **Fair:** normalize by population or foot traffic where possible; never label neighborhoods "dangerous" from raw counts.
- **Private:** location used only for the feature in use; no selling data; no account data sent to routing or search services.
