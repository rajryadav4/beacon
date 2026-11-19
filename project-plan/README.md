# CrimeRadar: Project Plan

Everything the team has decided about CrimeRadar so far, in one place. This folder is the reference for building the full product. The course milestones are checkpoints along the way, not the goal.

**Team 6:** Raj Ranjit Yadav, Trevor Kkhaya, Purvesha Kolhe · **Advisor:** Professor Bruce Chhay · CS 5200

## The one-line direction

> Build CrimeRadar as a practical navigation assistant that recommends **the safest reasonable route**, not the route with the lowest crime score at any cost. Keep it in Java + JSP + JDBC + MySQL, keep it free, and keep every recommendation explainable.

## Files

| # | File | What it covers |
|---|---|---|
| 01 | [Project overview](01-project-overview.md) | Problem, users, value proposition, feature list |
| 02 | [Database & Milestone 3 findings](02-database-and-findings.md) | Actual schema, real vs. generated data, key results, schema gaps |
| 03 | [Architecture & tech stack](03-architecture-and-stack.md) | Layers, Java packages, free tools, Tomcat 9 notes |
| 04 | [Recommendation engine](04-recommendation-engine.md) | How the built engine decides, scores and explains routes; how to run and test it |

## Decisions made so far

1. **Stay in the course stack:** Java 17, Servlets/JSP on Tomcat 9, JDBC DAOs, MySQL 8. No React, no separate Python backend, no paid AI APIs.
2. **Recommendations are rule-based and data-driven** (Java service + SQL), not a trained model. ML is optional later and only if it beats a simple baseline.
3. **Respect the user's choices:** never switch travel mode, never pick a route that's unreasonably longer, and recommend a detour only when it buys a meaningful safety improvement.
4. **Two kinds of data:** *source-managed* (Seattle crime data, kept fresh by a sync job) and *application-managed* (users, saved routes, preferences, which is where CRUD happens).
5. **Map and routing are free:** Leaflet + OpenStreetMap for the map, openrouteservice for real route alternatives.
6. **Be honest in the UI:** scores are *relative historical exposure*, not the chance of being harmed. Always show when the data was last updated.
