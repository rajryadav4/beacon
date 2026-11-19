# 01 · Project Overview

## Problem

Seattle residents, tourists and newcomers can't easily tell which areas are risky, at what times, or how to get around safely. Seattle publishes every police-reported offense, but the raw data portal is hard to read, only shows the past, and gives no personal guidance.

## Value proposition

**CrimeRadar is a** Seattle crime-safety and navigation app **that provides** an easy-to-read crime map, safer route recommendations that respect your time and travel mode, and alerts plus a one-tap SOS **for** Seattle residents, tourists and newcomers **who are unhappy with** raw police data portals, static crime maps, and alert apps that flood them with noise and no guidance.

## Who it's for

| User | What they need |
|---|---|
| Resident / commuter | A safer way home that doesn't add 20 minutes |
| Tourist / newcomer | Guidance for areas they've never been to |
| Night-shift worker / student | Late-night routes and transit stops |
| Driver / cyclist | Where cars get broken into and bikes get stolen |
| Renter / home buyer | Long-term neighborhood trends |

## Features (full product)

1. **Crime map:** interactive map of SPD incidents, filterable by type, neighborhood, date and hour.
2. **Route recommendations (advanced feature):** Fastest / Balanced (recommended) / Lowest exposure, for walking, cycling or driving, at the chosen departure time, within a detour limit, with a "Why this route?" explanation. See [04](04-recommendation-engine.md).
3. **Personal relevance:** risk weighted by what matters to the user (crimes against people, car prowls, bike theft) and by time of day.
4. **Saved places and routes:** home, work, hotel. Alert when risk near a saved place changes.
5. **Alerts:** only when something affects *you* (your route, saved place or time window), not everything within a radius.
6. **Emergency (SOS):** one tap shares location with trusted contacts. Later: a "walk me home" timer that alerts contacts automatically if you don't check in.
7. **Data freshness:** "Crime data last synced: Nov 18" shown everywhere scores appear.

## Future additions

Transit routing, native mobile app with background alerts, live 911 dispatch layer, multilingual support, events-aware risk, expansion beyond Seattle.
