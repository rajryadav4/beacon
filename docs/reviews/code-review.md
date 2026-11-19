# Code review: uncommitted changes on `purvesha/my-changes`

Date: 2026-11-19. Independent, read-only review. No file was changed except this report.

Scope: everything that `git status` shows as changed or new. That is the Java API, DAOs, service, util and
tools; `webapp/index.html` and `assets/js/*.js`; `sql/app_tables.sql` and the diff to
`sql/crime_radar_all.sql`; the scripts; the docs. I only skimmed `pipeline/` and `ml/`.

Other workers changed files while this review ran (for example `SyncIncidents.java`, `sql/app_tables.sql` and
`explore.js`). The line numbers match the files at about 02:00. In the middle of the review I saw a bug in how
`SyncIncidents` found the REFRESH markers. The current files already fix it, so it is not in the table.

## Verdict

0 critical, 1 high, 6 medium, 12 low. 2 of the low findings are marked "unverified".

I found no XSS, no SQL injection, no IDOR and no secret in the repo (see "Checked and found OK").
The main risks are:

- One request can keep a CPU core busy for about a minute (H1).
- Visitors who use the shared demo account can see each other's data (M1).
- Four UI bugs that a visitor can hit in normal use (M3 to M6).

## Findings

| ID | Severity | Where | Defect | Failure scenario | Suggested fix |
|---|---|---|---|---|---|
| H1 | High | `api/ApiServlet.java:192` (used by `TripsServlet.java:29`, `:51`, `:52`) | `integer()` runs `new BigDecimal(v).setScale(0, ...)` on input it has not checked. The 12-character limit still allows a huge exponent, and `setScale` then computes 10^exponent. | Anyone signs in with the public demo login and sends `GET api/me/trips?limit=1e99999999`. One request keeps a core busy for about 56 s, holds tens of megabytes of heap, and then returns a normal 400. A small loop stops the server (CPU, the thread pool, then OutOfMemory). Measured on this machine: `1e20000000` took 7.3 s and `1e99999999` took 56 s. | Check the text before you parse it, for example with `^-?\d{1,9}(\.\d{1,6})?$`. Or use `Double.parseDouble`, check that the number is finite and in range, then call `Math.round`. Never call `setScale` on a BigDecimal you have not checked. |
| M1 | Medium | `api/PlacesServlet.java:30-52`, `api/TripsServlet.java:38-59`; shown by `directions.js:372-383`, `account.js:150-161` | All visitors share `demo@crimeradar.app`, and the server lets the demo account save and delete places and trips like any other user. | Visitor A uses the demo, searches their real home and taps star, then Home. Visitor B opens the demo and sees A's Home address in the account menu, a "Home" button that routes to it, and A's recent destinations. After 50 favorites, the star fails for everyone with 409 "You can save up to 50 places". The note "The demo account has a saved Home and Work" is then false. | Make the demo read-only on the server: for the demo user id, do not write, and answer with the echoed object or a friendly 403. Keep the demo's changes in `sessionStorage` in the browser. In `SetupAppSchema.seedDemo`, also delete the demo's SAVED places and trips. |
| M2 | Medium | `api.js:100-109`, `:180-185`, `:164` | Offline mode stores every account in `localStorage`: the email and an unsalted SHA-256 of `crimeradar\|email\|password`. On a non-HTTPS LAN address the hash is a 32-bit FNV-1a. The session (`db.session`) also stays after the visitor leaves. | The server is down, so the exhibition laptop runs in offline mode. Visitors create accounts and many of them reuse a real password. The next person at the laptop opens DevTools, copies the emails and hashes, and cracks them offline. With FNV, any password with the same 32-bit hash also signs in. A visitor who does not sign out leaves their places open to the next person. | In offline mode, offer only the demo, or keep local accounts in `sessionStorage`. If you keep accounts, use PBKDF2 through `crypto.subtle` with a random salt and remove the FNV fallback. Say "stored only in this browser" on the form. |
| M3 | Medium | `directions.js:228`, `:292-309` | The automatic GPS lookup that runs when Directions opens does not check whether the visitor chose a start in the meantime. | The visitor opens Directions and ignores the location prompt. They type "Space Needle" as the start, pick a destination, and see routes. Later they click Block on the prompt, or the GPS fix arrives. The start then changes silently to "Pike Place Market" (on error) or "Your location", and the routes are planned again from there. | Count each change of the start, for example `this.fromSeq++` in `setFrom`. After `await getPosition(...)`, return if the start changed. When `userAsked` is false, never replace a start the visitor chose. |
| M4 | Medium | `directions.js:108`, `:279` | In the From box, Enter picks `items[0]` when nothing is highlighted. `items[0]` is always "Your location", because the GPS row is added even when there is a query. | The visitor types "Capitol Hill" in From and presses Enter. CrimeRadar asks for the device location instead, and on failure uses Pike Place Market. The typed place is ignored. | Add the GPS row only when the query is empty, or put it last. When there is text, Enter should choose the first row that is not GPS. |
| M5 | Medium | `main.js:100-102`; `directions.js:210-214`, `:241-263`, `:480-503` | `AccountMenu.update()` sends the full preferences object on every change. `Directions.setPrefs` then (a) resets the Directions travel mode to the saved mode, and (b) runs `drawContext()` and `draw()` even when Directions is not on screen. | On Explore, the visitor opens the account menu and moves the "Route choice" slider. The Explore legend changes to "Risk on your trip", the time badge changes to "Leaving now…", and the theme (and the risk grid, if shown) follow Directions. If routes were planned earlier, their lines come back on the Explore map. If the mode is also reset, the markers come back too and the map jumps to the route. On Directions, a visitor who chose "Car" toggles alerts, and the mode quietly goes back to "Walk" and the routes are planned again. | Send only the field that changed. Change the mode only when the mode was edited. Keep an `active` flag in Directions (set it in `activate`/`deactivate`) and do not draw on the map while it is false. Score again in `activate()`. |
| M6 | Medium | `account.js:87` with `api.js:207`, `:123`; read at `trip.js:306`, `account.js:114` | `persist()` sends `alerts: "false"` and `safetyWeight: "0.70"` as strings. Offline mode stores them unchanged. After a reload, `"false"` is truthy. | In offline mode the visitor turns Danger alerts off and reloads. The toggle shows on again, and `PassiveWatcher` starts watching the location and showing alerts that the visitor turned off. | In the offline branch of `savePreferences`, convert the values: `alerts === true \|\| alerts === 'true'` and `Number(safetyWeight)`. Or have `persist()` pass booleans and numbers, because `call()` already converts them to strings for the server. |
| L1 | Low | `api/AuthServlet.java:102-119`, `api/LoginThrottle.java:28-54` | The throttle checks the count and records the failure in two separate steps. Many requests in parallel all pass the check before any failure is counted. | An attacker sends 200 wrong passwords for one email at the same moment. All 200 are tried, not 5, in each 10-minute window. | Make it one step under the queue lock: prune, refuse when there are already 5, otherwise count the attempt now. Remove that count when the login succeeds. |
| L2 | Low | `api/AuthServlet.java:100-106` | The demo account is throttled like a private account, but its password is public. | Someone types `demo@crimeradar.app` with a wrong password 5 times on the exhibition laptop. For 10 minutes, the "Explore with the demo account" button on that laptop gets 429. | Do not throttle the demo email. Throttling it protects nothing. |
| L3 | Low | `directions.js:410-417` | `choose()` saves the place, waits, and then sets `this.to = { ...to, kind }` from the old destination it captured. | The visitor taps star, then Favorite, and picks a new destination while the save is still running. `this.to` goes back to the old place, but the box and the routes show the new one. "Start trip" then saves and shows the old destination name. | After the await, change only `this.to.kind`, and only if `this.to` is still the same place (same lat/lng). |
| L4 | Low | `directions.js:452-458` (same pattern at `:444-450`) | The "same place" early return in `plan()` does not increase `this.req` and does not abort the request that is still running. | A route request for A to B is running. The visitor changes the start to B, and the panel says "Start and destination are the same place". Then the old A to B routes arrive and replace that message. "Start trip" then uses the new labels with the old route. | In those branches, also run `++this.req` and `this.ctrl?.abort()`. |
| L5 | Low (unverified) | `trip.js:303-316` (called from `main.js:102`); same pattern at `trip.js:228-236` | `PassiveWatcher.start()` and `TripView.startLive()` call `watchPosition` after `await locationPermission()`, and they do not check the state again. Two `start()` calls that overlap each create a watch, and the first watch id is lost. `startLive()` can also start a watch after the trip has ended. | Location permission is granted and alerts are on. Quick changes in the account menu, for example dragging the slider, can leave a watch that is never cleared. If the visitor then turns alerts off, that watch keeps showing danger banners. The window is only as long as `permissions.query` (usually milliseconds), so I did not reproduce it. | Use a sequence number: after the await, `if (seq !== this.seq) return`, and for the trip also check `this.active`. Check `getPrefs().alerts` inside the passive watch callback. |
| L6 | Low | `directions.js:347-369` | `isoToday()` takes the date from the browser's own time zone, and it does not move "Leave at" times that are already past to tomorrow. | At 11 PM the visitor chooses "Leave at 1:00". The saved trip says today at 01:00, which is in the past. A browser that is not on Seattle time saves the wrong date near midnight. | Take the date from `Intl.DateTimeFormat` with `timeZone: 'America/Los_Angeles'`. Add one day when the chosen time is earlier than now. |
| L7 | Low (unverified) | `api.js:32-57` | Each map file falls back to the static copy on its own. | `api/grid` loads from the server but `api/neighborhoods` times out and loads the static file. The grid's `nbIndex` values then point into a different list, so the area names in tooltips, alerts and "riskiest stretch" can be wrong. This is likely only after `SyncIncidents` adds or renames a neighborhood. | Load all three from one source. If any server call fails, load all three static files. |
| L8 | Low | `main.js:204-221` | `render()` calls `directions.deactivate()` only for a direct change from directions to explore. | During a trip, the visitor opens the browser's history list (long-press Back) and jumps straight to Explore. The trip stops, but the route lines and start and end markers stay on the Explore map. | Call `app.directions.deactivate()` whenever the new route is `explore` and the old one is `directions` or `trip`. |
| L9 | Low | `directions.js:567-574`, `:627-638` | "Start trip" and "Simulate" have no guard against a double click. | A double click saves two identical trips to `api/me/trips` and starts the trip twice. | Disable the buttons after the first click, or ignore a click while `app.trip.active` is true. |
| L10 | Low | `sql/crime_radar_all.sql:6`, `:19-32` | The header says "Safe to re-run". After `app_tables.sql` has run, `DROP TABLE RouteRecommendations` and `DROP TABLE AppUsers` fail, because `TripDetails`, `UserPlaces` and `UserPreferences` reference them. | A team member re-runs the milestone script as its header says, and it stops at the first DROP. If the tool continues after errors, it loads duplicate sample rows. `docs/DATABASE.md` explains the fix, but the script does not. | Update the header: "if the app tables exist, run `scripts\setup-db.ps1 --drop-only` first". |
| L11 | Low | `docs/ARCHITECTURE.md:95` (the code is `geo.js:83-85`, `:166`, `:180`) | The docs say "No request to these services carries personal data". But route requests send the exact start and end, which can be the GPS position or the saved Home and Work. Typed addresses go to Photon and Nominatim. | A visitor trusts the privacy statement. Their live location and home coordinates still go to routing.openstreetmap.de and their typed text to komoot or OSM. | Correct the sentence and say the same in `USER_GUIDE.md`. |
| L12 | Low | `index.html:12-14`, `:186-189`; `main.js:30`, `:44` | Leaflet, leaflet.heat and the font come from unpkg and Google at start-up. If they do not load, `L` is undefined, `new MapView` throws, and the start screen says "Could not load the crime data". | The exhibition Wi-Fi blocks or loses the CDN. The app does not start, and the error blames the data, which is local. | Put `leaflet.js`, `leaflet.css` and `leaflet-heat.js` in `assets/vendor/`. Show "The map library did not load" when `window.L` is missing. |

## Evidence and notes

- H1 was measured with a small local Java program (in the session scratch folder, not in the repo). It runs the
  same expression as `ApiServlet.integer()`. Results: `1e1000000` 0.4 s, `1e5000000` 2.6 s, `1e20000000` 7.3 s,
  `1e99999999` 56.4 s. `1e2147483647` fails fast with an overflow, so the worst inputs are exponents around 10^8.
  The `api/me/*` paths need a login, but the demo login is public and registration is open.
- M5 needs no race: any change in the account menu calls `Directions.setPrefs`.
- Small doc mismatch with no runtime effect: `docs/API.md` section 4, step 7 says "groups 0-6", but
  `risk.js:181-183` counts only the groups for the travel mode (`MODE_GROUPS`). The build log says this was
  intended, so update API.md.

## Checked and found OK

- XSS: all user, server and geocoder text goes through `h()` or `textContent`. `innerHTML` and
  `insertAdjacentHTML` only get static SVG or numbers and constant colors (`ui.js:102`, `icons.js:46`,
  `explore.js:40`, `directions.js:178-180`). Leaflet popups get DOM nodes. Tooltips and `divIcon` HTML are
  constants. Marker titles are set as a DOM property. No `href` or inline handler takes user data.
- SQL injection: every DAO uses `PreparedStatement` with parameters. Table and column names in the tools are
  constants.
- IDOR: `DELETE api/me/places/{id}` filters by `PlaceId` and the session `UserId` (`UserPlacesDao.java:120`).
  Every list filters by the session user. `AuthFilter` and `requireUserId` guard `api/me/*`.
- CSRF: the `X-CrimeRadar: 1` header is required on every non-GET API request, the cookie is `SameSite=Lax`, and
  there are no CORS headers. A cross-site POST therefore fails, and so does a login CSRF.
- Sessions: the session id changes at login (`AuthServlet.java:137`). Logout invalidates the session. The cookie is
  `HttpOnly`.
- Passwords: PBKDF2-HMAC-SHA256, 150,000 iterations, a 16-byte random salt and a constant-time compare. Legacy
  SHA-256 hashes are upgraded at login. An unknown email costs the same time as a real check.
- Error messages: `ApiServlet.service` sends only generic text. Stack traces go to the server log.
- Secrets: `db.properties` is git-ignored (`.gitignore`) and not tracked. A search of all tracked and untracked
  files found no copy of its password value; the search did not print the value, which is empty or the
  placeholder now. `build.ps1` copies the file only into the ignored `CrimeRadar/build/`. Tomcat does not serve
  `WEB-INF/`. The only password in the code is the public demo password, which is meant to be public.
- JDBC: connections are closed with try-with-resources or `finally`. Saving a trip (3 tables) and saving a place
  each run in one transaction with rollback.
- JSON contract: User, Preferences, Place and Trip, and the `meta`, `grid` and `neighborhoods` shapes, match
  `docs/API.md` and the fields the UI reads.
- Math: `band = floor(hour / 6)`, the grid formula, the q90/q97 levels, the log score and the ranking match
  `docs/API.md` in JS, SQL and Python.
- Navigation: tabs, Back, trip start and end, and the account-menu layer all work in the normal flows. L8 is the
  one edge case.

## Fix status (same day)

| ID | Status | Evidence |
|---|---|---|
| H1 | Fixed | Numbers must match a plain-number regex before parsing. `limit=1e99999999` now returns 400 in 0.014 s (checked by the lead, not only by the author). |
| M1 | Fixed | `DemoAccount` resets the demo's places, trips and preferences at each demo login. A favorite saved after login 1 is gone after login 2 (checked by the lead). |
| M2 | Fixed | Offline accounts live in `sessionStorage` with salted PBKDF2 (120,000 rounds); no FNV fallback; nothing in `localStorage`. Headless regression check passes. |
| M3 | Fixed | `fromSeq` counts start changes; an automatic GPS answer never replaces a start the visitor chose. Code fix only (timing is hard to test). |
| M4 | Fixed | The GPS row shows only for an empty From box. Regression check: Enter after "Space Needle" keeps "Space Needle". |
| M5 | Fixed | Directions draws only while active; the travel mode changes only when the usual mode is edited. Regression check: the Explore legend and time badge stay the same after a settings change. |
| M6 | Fixed | Preferences keep real types; offline mode normalizes them. Regression check: alerts stay off after a reload. |
| L1, L2 | Fixed | One atomic throttle step; the public demo email is not throttled (results in `backend-check.md`). |
| L3, L4, L5, L6, L8, L9 | Fixed | Same-place guard after the save; route requests cancelled on early returns; watch sequence numbers; Seattle date and next-day departure; deactivate on any jump to Explore; one trip at a time. Code fixes; the full headless walk still passes. |
| L7 | Fixed | The three map files load from one source (all server or all static). |
| L10 | Fixed | Header of `crime_radar_all.sql` explains `setup-db.ps1 --drop-only`. |
| L11 | Fixed | ARCHITECTURE.md and USER_GUIDE.md now say what goes to the routing and search services. |
| L12 | Partly fixed | A clear "map library did not load" message. The libraries still come from unpkg: the map tiles need the internet anyway, so a local copy adds little. |

## Not covered

- I ran no browser, Tomcat or MySQL. All findings come from reading the code, except the H1 timing.
- I only skimmed `pipeline/` and `ml/`. I did not review the committed milestone code (`FindIncidents`,
  `Inserter`, the older DAOs).
