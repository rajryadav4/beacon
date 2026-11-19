# Backend check

Date: 2026-11-19. Verdict: the backend passes 49 of 49 curl checks.

## Test setup (read this first)

- The real MySQL (service MySQL80, port 3306) refused the login.
  The password in `db.properties` is not filled in yet (error 1045, "using password: YES").
  This is a blocker for the real database only.
- To test everything anyway, I started a private scratch MySQL 8.0.46 on port 3307
  (temporary data folder, empty root password, not part of the repo).
  I loaded the full milestone data into it with `sql/crime_radar_all.sql`
  (319,029 incidents), then ran the normal scripts against it.
- `ConnectionManager` accepts the optional environment variable `CRIMERADAR_DB_PROPERTIES`
  (a path to another properties file). Normal use does not set it.
- Everything else is the real code path: `scripts/build.ps1`, `scripts/setup-db.ps1`,
  `scripts/run-tomcat.ps1` (Tomcat 9.0.123, project-local CATALINA_BASE), `curl`.

## Exit codes

| Command | Exit code |
|---|---|
| `scripts/build.ps1` (no javac warnings, `-Xlint:all`) | 0 |
| `scripts/setup-db.ps1` against the scratch DB (run 3 times, idempotent) | 0 |
| `scripts/sql.ps1` against the real DB (password not set) | 2 (error 1045) |

## CellStats has no excluded offenses

Excluded offenses: `Not Reportable to NIBRS` (33,201 rows) and `Justifiable Homicide` (11 rows).
They have no row in `CategoryGroups`, so the view `vw_CleanIncidents` drops them.

```sql
-- 1. no excluded offense reaches the clean view
SELECT COUNT(*) FROM vw_CleanIncidents v JOIN CrimeCategories c ON c.CategoryId = v.CategoryId
WHERE c.CategoryName IN ('Not Reportable to NIBRS', 'Justifiable Homicide');          -- 0

-- 2. exactly the two excluded categories have no group
SELECT COUNT(*) FROM CrimeCategories c LEFT JOIN CategoryGroups g ON g.CategoryId = c.CategoryId
WHERE g.CategoryId IS NULL;                                                            -- 2

-- 3. CellStats total = wanted, known-time, in-grid incidents counted from the raw table
SELECT (SELECT SUM(IncidentCount) FROM CellStats),                                     -- 224730
       (SELECT COUNT(*) FROM CrimeIncidents i JOIN CategoryGroups cg ON cg.CategoryId = i.CategoryId
        WHERE TIME(i.OccurredAt) <> '00:00:00' AND i.Latitude >= 47.48 AND i.Latitude < 47.75
          AND i.Longitude >= -122.46 AND i.Longitude < -122.22);                       -- 224730
```

`api/meta` totals: incidents 285,817, located 245,920, excluded 33,212, unknownTime 24,641.

## Other checks

- Legacy SHA-256 user `user1@example.com` / `password1` logs in (200) and the stored hash becomes
  `pbkdf2$150000$...` (checked in the database).
- `api/neighborhoods`, `api/grid` and `api/meta` match the pipeline's static JSON, except where
  the static files were not yet rebuilt for the 2026-11-19 contract changes
  (`unknownTime`, no 00:00:00 times). Before those changes the grid matched in all but
  2 of 4,211 cells (one incident each, a DECIMAL(10,7) rounding at a cell edge).
- Session cookie: `Set-Cookie: JSESSIONID=...; Path=/CrimeRadar; HttpOnly; SameSite=Lax`.

## curl log

Every block shows the command, the status, and the start of the body.

Base URL: http://localhost:8080/CrimeRadar   Run: 2026-11-19T09:23:32Z   Test email: check1795080211@example.com

#### health
```
curl http://localhost:8080/CrimeRadar/api/health
-> HTTP 200 (expected 200) PASS
{"ok":true,"db":true}
```

#### me without login
```
curl http://localhost:8080/CrimeRadar/api/auth/me
-> HTTP 401 (expected 401) PASS
{"error":"Not signed in."}
```

#### places without login
```
curl http://localhost:8080/CrimeRadar/api/me/places
-> HTTP 401 (expected 401) PASS
{"error":"Please sign in."}
```

#### register without CSRF header
```
curl -X POST http://localhost:8080/CrimeRadar/api/auth/register -d displayName=A&email=check1795080211@example.com&password=longenough1
-> HTTP 403 (expected 403) PASS
{"error":"Missing X-CrimeRadar header."}
```

#### register: short password
```
curl -X POST -H 'X-CrimeRadar: 1' http://localhost:8080/CrimeRadar/api/auth/register -d displayName=A&email=check1795080211@example.com&password=short
-> HTTP 400 (expected 400) PASS
{"error":"Password must have at least 8 characters."}
```

#### register: bad email
```
curl -X POST -H 'X-CrimeRadar: 1' http://localhost:8080/CrimeRadar/api/auth/register -d displayName=A&email=notanemail&password=longenough1
-> HTTP 400 (expected 400) PASS
{"error":"Enter a valid email address."}
```

#### register
```
curl -c <tmp>/a.jar -X POST -H 'X-CrimeRadar: 1' http://localhost:8080/CrimeRadar/api/auth/register --data-urlencode 'displayName=Check User' --data-urlencode email=check1795080211@example.com --data-urlencode password=Pa55word!check
-> HTTP 201 (expected 201) PASS
{"user":{"id":1027,"displayName":"Check User","email":"check1795080211@example.com","createdAt":"2026-11-19T09:23:34Z","preferences":{"mode":"walk","safetyWeight":0.7,"alerts":true}}}
```

#### register again (duplicate email)
```
curl -X POST -H 'X-CrimeRadar: 1' http://localhost:8080/CrimeRadar/api/auth/register --data-urlencode 'displayName=Check User' --data-urlencode email=check1795080211@example.com --data-urlencode password=Pa55word!check
-> HTTP 409 (expected 409) PASS
{"error":"An account with this email already exists."}
```

#### me after register
```
curl -b <tmp>/a.jar http://localhost:8080/CrimeRadar/api/auth/me
-> HTTP 200 (expected 200) PASS
{"user":{"id":1027,"displayName":"Check User","email":"check1795080211@example.com","createdAt":"2026-11-19T09:23:34Z","preferences":{"mode":"walk","safetyWeight":0.7,"alerts":true}}}
```

#### logout
```
curl -b <tmp>/a.jar -c <tmp>/a.jar -X POST -H 'X-CrimeRadar: 1' http://localhost:8080/CrimeRadar/api/auth/logout
-> HTTP 204 (expected 204) PASS

```

#### me after logout
```
curl -b <tmp>/a.jar http://localhost:8080/CrimeRadar/api/auth/me
-> HTTP 401 (expected 401) PASS
{"error":"Not signed in."}
```

#### login wrong password
```
curl -X POST -H 'X-CrimeRadar: 1' http://localhost:8080/CrimeRadar/api/auth/login --data-urlencode email=check1795080211@example.com --data-urlencode password=wrong-password
-> HTTP 401 (expected 401) PASS
{"error":"Email or password is incorrect."}
```

#### login unknown email (same generic error)
```
curl -X POST -H 'X-CrimeRadar: 1' http://localhost:8080/CrimeRadar/api/auth/login --data-urlencode email=nobodycheck1795080211@example.com --data-urlencode password=wrong-password
-> HTTP 401 (expected 401) PASS
{"error":"Email or password is incorrect."}
```

#### login without CSRF header
```
curl -X POST http://localhost:8080/CrimeRadar/api/auth/login --data-urlencode email=check1795080211@example.com --data-urlencode password=Pa55word!check
-> HTTP 403 (expected 403) PASS
{"error":"Missing X-CrimeRadar header."}
```

#### login
```
curl -b <tmp>/b.jar -c <tmp>/b.jar -X POST -H 'X-CrimeRadar: 1' http://localhost:8080/CrimeRadar/api/auth/login --data-urlencode email=check1795080211@example.com --data-urlencode password=Pa55word!check
-> HTTP 200 (expected 200) PASS
{"user":{"id":1027,"displayName":"Check User","email":"check1795080211@example.com","createdAt":"2026-11-19T09:23:34Z","preferences":{"mode":"walk","safetyWeight":0.7,"alerts":true}}}
```

#### login again with the same cookie jar (session id must change)
```
curl -b <tmp>/b.jar -c <tmp>/b.jar -X POST -H 'X-CrimeRadar: 1' http://localhost:8080/CrimeRadar/api/auth/login --data-urlencode email=check1795080211@example.com --data-urlencode password=Pa55word!check
-> HTTP 200 (expected 200) PASS
{"user":{"id":1027,"displayName":"Check User","email":"check1795080211@example.com","createdAt":"2026-11-19T09:23:34Z","preferences":{"mode":"walk","safetyWeight":0.7,"alerts":true}}}
```

#### me after login
```
curl -b <tmp>/b.jar http://localhost:8080/CrimeRadar/api/auth/me
-> HTTP 200 (expected 200) PASS
{"user":{"id":1027,"displayName":"Check User","email":"check1795080211@example.com","createdAt":"2026-11-19T09:23:34Z","preferences":{"mode":"walk","safetyWeight":0.7,"alerts":true}}}
```

#### preferences
```
curl -b <tmp>/b.jar -X POST -H 'X-CrimeRadar: 1' http://localhost:8080/CrimeRadar/api/me/preferences -d mode=bike&safetyWeight=0.4&alerts=false
-> HTTP 200 (expected 200) PASS
{"preferences":{"mode":"bike","safetyWeight":0.4,"alerts":false}}
```

#### preferences: bad mode
```
curl -b <tmp>/b.jar -X POST -H 'X-CrimeRadar: 1' http://localhost:8080/CrimeRadar/api/me/preferences -d mode=rocket
-> HTTP 400 (expected 400) PASS
{"error":"Field 'mode' must be one of: walk, bike, car."}
```

#### preferences without CSRF header
```
curl -b <tmp>/b.jar -X POST http://localhost:8080/CrimeRadar/api/me/preferences -d mode=bike
-> HTTP 403 (expected 403) PASS
{"error":"Missing X-CrimeRadar header."}
```

#### me shows saved preferences
```
curl -b <tmp>/b.jar http://localhost:8080/CrimeRadar/api/auth/me
-> HTTP 200 (expected 200) PASS
{"user":{"id":1027,"displayName":"Check User","email":"check1795080211@example.com","createdAt":"2026-11-19T09:23:34Z","preferences":{"mode":"bike","safetyWeight":0.4,"alerts":false}}}
```

#### places: empty list
```
curl -b <tmp>/b.jar http://localhost:8080/CrimeRadar/api/me/places
-> HTTP 200 (expected 200) PASS
{"places":[]}
```

#### places: create home
```
curl -b <tmp>/b.jar -X POST -H 'X-CrimeRadar: 1' http://localhost:8080/CrimeRadar/api/me/places -d kind=home&label=Home&address=Capitol+Hill&lat=47.6235&lng=-122.32
-> HTTP 201 (expected 201) PASS
{"place":{"id":17,"kind":"home","label":"Home","address":"Capitol Hill","lat":47.6235,"lng":-122.32}}
```

#### places: create home again (replaces)
```
curl -b <tmp>/b.jar -X POST -H 'X-CrimeRadar: 1' http://localhost:8080/CrimeRadar/api/me/places -d 'kind=home&label=Home 2&address=Fremont&lat=47.65&lng=-122.35'
-> HTTP 201 (expected 201) PASS
{"place":{"id":18,"kind":"home","label":"Home 2","address":"Fremont","lat":47.65,"lng":-122.35}}
```

#### places: create saved
```
curl -b <tmp>/b.jar -X POST -H 'X-CrimeRadar: 1' http://localhost:8080/CrimeRadar/api/me/places --data-urlencode kind=saved --data-urlencode 'label=Cafe <b>x</b>' -d address=Pike+St&lat=47.61&lng=-122.33
-> HTTP 201 (expected 201) PASS
{"place":{"id":19,"kind":"saved","label":"Cafe <b>x</b>","address":"Pike St","lat":47.61,"lng":-122.33}}
```

#### places: bad latitude
```
curl -b <tmp>/b.jar -X POST -H 'X-CrimeRadar: 1' http://localhost:8080/CrimeRadar/api/me/places -d kind=saved&label=x&lat=999&lng=-122.33
-> HTTP 400 (expected 400) PASS
{"error":"Field 'lat' must be between -90.0 and 90.0."}
```

#### places: bad kind
```
curl -b <tmp>/b.jar -X POST -H 'X-CrimeRadar: 1' http://localhost:8080/CrimeRadar/api/me/places -d kind=other&label=x&lat=47&lng=-122
-> HTTP 400 (expected 400) PASS
{"error":"Field 'kind' must be one of: home, work, saved."}
```

#### places: list (home replaced, 2 rows)
```
curl -b <tmp>/b.jar http://localhost:8080/CrimeRadar/api/me/places
-> HTTP 200 (expected 200) PASS
{"places":[{"id":18,"kind":"home","label":"Home 2","address":"Fremont","lat":47.65,"lng":-122.35},{"id":19,"kind":"saved","label":"Cafe <b>x</b>","address":"Pike St","lat":47.61,"lng":-122.33}]}
```

#### places: delete without CSRF header
```
curl -b <tmp>/b.jar -X DELETE http://localhost:8080/CrimeRadar/api/me/places/19
-> HTTP 403 (expected 403) PASS
{"error":"Missing X-CrimeRadar header."}
```

#### places: delete
```
curl -b <tmp>/b.jar -X DELETE -H 'X-CrimeRadar: 1' http://localhost:8080/CrimeRadar/api/me/places/19
-> HTTP 204 (expected 204) PASS

```

#### places: delete again
```
curl -b <tmp>/b.jar -X DELETE -H 'X-CrimeRadar: 1' http://localhost:8080/CrimeRadar/api/me/places/19
-> HTTP 404 (expected 404) PASS
{"error":"Place not found."}
```

#### places: delete bad id
```
curl -b <tmp>/b.jar -X DELETE -H 'X-CrimeRadar: 1' http://localhost:8080/CrimeRadar/api/me/places/abc
-> HTTP 404 (expected 404) PASS
{"error":"Place not found."}
```

#### login as demo
```
curl -c <tmp>/demo.jar -X POST -H 'X-CrimeRadar: 1' http://localhost:8080/CrimeRadar/api/auth/login --data-urlencode email=demo@crimeradar.app --data-urlencode password=CrimeRadar2026!
-> HTTP 200 (expected 200) PASS
{"user":{"id":1024,"displayName":"Demo User","email":"demo@crimeradar.app","createdAt":"2026-11-19T09:12:18Z","preferences":{"mode":"walk","safetyWeight":0.7,"alerts":true}}}
```

#### places: other user cannot delete my place
```
curl -b <tmp>/demo.jar -X DELETE -H 'X-CrimeRadar: 1' http://localhost:8080/CrimeRadar/api/me/places/18
-> HTTP 404 (expected 404) PASS
{"error":"Place not found."}
```

#### demo places (Home and Work)
```
curl -b <tmp>/demo.jar http://localhost:8080/CrimeRadar/api/me/places
-> HTTP 200 (expected 200) PASS
{"places":[{"id":15,"kind":"home","label":"Home","address":"Capitol Hill, Seattle, WA","lat":47.6235,"lng":-122.32},{"id":16,"kind":"work","label":"Northeastern University Seattle","address":"401 Terry Ave N, Seattle, WA 98109","lat":47.6226,"lng":-122.3375}]}
```

#### demo me
```
curl -b <tmp>/demo.jar http://localhost:8080/CrimeRadar/api/auth/me
-> HTTP 200 (expected 200) PASS
{"user":{"id":1024,"displayName":"Demo User","email":"demo@crimeradar.app","createdAt":"2026-11-19T09:12:18Z","preferences":{"mode":"walk","safetyWeight":0.7,"alerts":true}}}
```

#### trips: create
```
curl -b <tmp>/b.jar -X POST -H 'X-CrimeRadar: 1' http://localhost:8080/CrimeRadar/api/me/trips --data-urlencode 'fromLabel=Capitol Hill' -d fromLat=47.6235&fromLng=-122.32 --data-urlencode 'toLabel=Northeastern University Seattle' -d toLat=47.6226&toLng=-122.3375&mode=walk&departAt=2026-11-19T21:30&distanceMeters=1450&durationSeconds=1100&riskScore=42.5&riskLevel=elevated&choice=safest
-> HTTP 201 (expected 201) PASS
{"trip":{"id":8196,"fromLabel":"Capitol Hill","toLabel":"Northeastern University Seattle","toLat":47.6226,"toLng":-122.3375,"mode":"walk","departAt":"2026-11-19T21:30","riskScore":42.5,"riskLevel":"elevated","choice":"safest","createdAt":"2026-11-19T09:23:44Z"}}
```

#### trips: create second
```
curl -b <tmp>/b.jar -X POST -H 'X-CrimeRadar: 1' http://localhost:8080/CrimeRadar/api/me/trips --data-urlencode fromLabel=A -d fromLat=47.61&fromLng=-122.33 --data-urlencode toLabel=B -d toLat=47.65&toLng=-122.30&mode=car&departAt=2026-11-20T08:00&distanceMeters=9000&durationSeconds=900&riskScore=10&riskLevel=low&choice=fastest
-> HTTP 201 (expected 201) PASS
{"trip":{"id":8197,"fromLabel":"A","toLabel":"B","toLat":47.65,"toLng":-122.3,"mode":"car","departAt":"2026-11-20T08:00","riskScore":10,"riskLevel":"low","choice":"fastest","createdAt":"2026-11-19T09:23:45Z"}}
```

#### trips: bad riskLevel
```
curl -b <tmp>/b.jar -X POST -H 'X-CrimeRadar: 1' http://localhost:8080/CrimeRadar/api/me/trips --data-urlencode fromLabel=A -d fromLat=47.61&fromLng=-122.33 --data-urlencode toLabel=B -d toLat=47.65&toLng=-122.30&mode=car&departAt=2026-11-20T08:00&distanceMeters=9000&durationSeconds=900&riskScore=10&riskLevel=extreme&choice=fastest
-> HTTP 400 (expected 400) PASS
{"error":"Field 'riskLevel' must be one of: low, elevated, high."}
```

#### trips: bad date
```
curl -b <tmp>/b.jar -X POST -H 'X-CrimeRadar: 1' http://localhost:8080/CrimeRadar/api/me/trips --data-urlencode fromLabel=A -d fromLat=47.61&fromLng=-122.33 --data-urlencode toLabel=B -d toLat=47.65&toLng=-122.30&mode=car&departAt=tomorrow&distanceMeters=9000&durationSeconds=900&riskScore=10&riskLevel=low&choice=fastest
-> HTTP 400 (expected 400) PASS
{"error":"Field 'departAt' must look like 2026-11-19T21:30."}
```

#### trips: list (newest first)
```
curl -b <tmp>/b.jar http://localhost:8080/CrimeRadar/api/me/trips?limit=10
-> HTTP 200 (expected 200) PASS
{"trips":[{"id":8197,"fromLabel":"A","toLabel":"B","toLat":47.65,"toLng":-122.3,"mode":"car","departAt":"2026-11-20T08:00","riskScore":10,"riskLevel":"low","choice":"fastest","createdAt":"2026-11-19T09:23:45Z"},{"id":8196,"fromLabel":"Capitol Hill","toLabel":"Northeastern University Seattle","toLat":47.6226,"toLng":-122.3375,"mode":"walk","departAt":"2026-11-19T21:30","riskScore":42.5,"riskLevel":
```

#### trips: bad limit
```
curl -b <tmp>/b.jar http://localhost:8080/CrimeRadar/api/me/trips?limit=abc
-> HTTP 400 (expected 400) PASS
{"error":"Field 'limit' must be a whole number."}
```

#### trips: demo user sees none of them
```
curl -b <tmp>/demo.jar http://localhost:8080/CrimeRadar/api/me/trips
-> HTTP 200 (expected 200) PASS
{"trips":[]}
```

#### legacy SHA-256 user login (user1@example.com)
```
curl -X POST -H 'X-CrimeRadar: 1' http://localhost:8080/CrimeRadar/api/auth/login --data-urlencode email=user1@example.com --data-urlencode password=password1
-> HTTP 200 (expected 200) PASS
{"user":{"id":1,"displayName":"User 1","email":"user1@example.com","createdAt":"2025-07-17T08:11:47Z","preferences":{"mode":"walk","safetyWeight":0.7,"alerts":true}}}
```

#### meta
```
curl http://localhost:8080/CrimeRadar/api/meta
-> HTTP 200 (expected 200) PASS
{"version":1,"generatedAt":"2026-11-19T09:22:56Z","source":{"name":"SPD Crime Data: 2008-Present","id":"tazs-3rd5","url":"https://data.seattle.gov/d/tazs-3rd5"},"dataRange":{"from":"2022-11-19","to":"2026-11-17","years":3.99},"totals":{"incidents":285817,"located":245920,"excluded":33212,"unknownTime":24641},"grid":{"lat0":47.48,"lng0":-122.46,"dLat":0.002,"dLng":0.003,"rows":135,"cols":80},"bands
```

#### neighborhoods
```
curl http://localhost:8080/CrimeRadar/api/neighborhoods
-> HTTP 200 (expected 200) PASS
{"version":1,"neighborhoods":[{"key":"ALASKA JUNCTION","name":"Alaska Junction","precinct":"Southwest","lat":47.56163,"lng":-122.38338,"cells":73,"areaKm2":3.66,"counts":[110,44,82,227,197,72,3,89,97,12,155,199,105,80,16,120,228,47,255,365,138,102,52,188,225,49,177,552,156,153,26,151],"unlocated":633},{"key":"ALKI","name":"Alki","precinct":"Southwest","lat":47.57905,"lng":-122.40363,"cells":55,"ar
```

#### grid
```
curl http://localhost:8080/CrimeRadar/api/grid
-> HTTP 200 (expected 200) PASS
{"version":1,"cells":[[71,-1,[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0],[0.08,0.07,0.09,0.08]],[141,-1,[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0.09,0.07,0.1,0.1]],[143,-1,[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0],[0.08,0.07,0.1,0.1]],[152,-1,[0,0,1,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0.08,0.06,0.09,0.
```

#### grid shape
```
cells: 4211  cells with wrong counts/risk length: 0
first cell: [71, -1, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0], [0.08, 0.07, 0.09, 0.08]]
```

#### gzip
```
curl -s -D - -o grid.gz -H 'Accept-Encoding: gzip' http://localhost:8080/CrimeRadar/api/grid   -> HTTP 200
Cache-Control: public, max-age=300
ETag: "3be9773a09df8cc9d881"
Vary: Accept-Encoding
X-Content-Type-Options: nosniff
Content-Encoding: gzip
Content-Type: application/json;charset=UTF-8
Content-Length: 104429
bytes gzip: 104429   bytes plain: 417428  (plain request -> HTTP 200, Content-Encoding: )
gunzip parses, cells: 4211
```

#### grid with If-None-Match
```
curl -H 'If-None-Match: "3be9773a09df8cc9d881"' -H 'Accept-Encoding: gzip' http://localhost:8080/CrimeRadar/api/grid
-> HTTP 304 (expected 304) PASS
{"version":1,"cells":[[71,-1,[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0],[0.08,0.07,0.09,0.08]],[141,-1,[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0.09,0.07,0.1,0.1]],[143,-1,[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0],[0.08,0.07,0.1,0.1]],[152,-1,[0,0,1,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0.08,0.06,0.09,0.
```

#### headers
```
register response:
Cache-Control: no-store
Set-Cookie: JSESSIONID=B44043EA614D2CA79FD2D65C5CF4C844; Path=/CrimeRadar; HttpOnly; SameSite=Lax
X-Content-Type-Options: nosniff
Content-Type: application/json;charset=UTF-8
me response:
Cache-Control: no-store
X-Content-Type-Options: nosniff
Content-Type: application/json;charset=UTF-8
session id before login: C4CA814FCBD4F2CD46B5EE18619A7836
session id after login:  DBCEE7564C9FB63F5F0BB08D7A3269F7  (changed)
```

#### login attempt 6 after 5 failures (lock-out)
```
curl -X POST -H 'X-CrimeRadar: 1' http://localhost:8080/CrimeRadar/api/auth/login -d email=lock1795080231@example.com&password=nope-6
-> HTTP 429 (expected 429) PASS
{"error":"Too many failed attempts. Try again in a few minutes."}
```

Retry-After header: Retry-After: 599

TOTAL PASS=49 FAIL=0

## Review fixes (H1, M1, L1, L2, L10), 2026-11-19

Run against the test MySQL (port 3307) with the rebuilt Tomcat on port 8080.
`scripts/build.ps1` exit code: 0 (60 files).

- H1: numbers from requests must match a short plain-number pattern before any BigDecimal
  work (`^-?[0-9]{1,9}` for whole numbers, `^-?[0-9]{1,6}(.[0-9]{1,15})?` for decimals, no exponent).
  `limit=1e99999999` now gives 400 in 0.03 s (it burned about 56 s before).
- M1: every successful demo login runs `DemoAccount.reset` in one transaction: deletes places and
  trips (TripDetails, RouteRecommendations and the Routes rows of those trips), restores Home and
  Work, and resets preferences to walk / 0.70 / alerts on. `SetupAppSchema` uses the same code.
- L1: `LoginThrottle.tryAttempt` prunes, refuses at 5, or counts the attempt, all under one lock.
  A successful login clears the count.
- L2: the demo email is never throttled.
- L10: the header of `sql/crime_radar_all.sql` now says to run `scripts\setup-db.ps1 --drop-only` first
  once `app_tables.sql` has run.
- After the demo trip was reset, SQL shows 0 leftover `Routes` rows named `ZZ demo trip%` and 0 demo `TripDetails`.

```
- register normal test user -> HTTP 201 0.400519s
curl -b jar 'http://localhost:8080/CrimeRadar/api/me/trips?limit=1e99999999'
- limit=1e99999999 (expect 400, under 1 s) -> HTTP 400 0.031027s
  body: {"error":"Field 'limit' must be a whole number."}
- limit=99999999999999999999 (expect 400) -> HTTP 400 0.005213s
- limit=5 (expect 200) -> HTTP 200 0.040487s
- place with lat=1e99999999 (expect 400) -> HTTP 400 0.023633s
- trip with distanceMeters=1e99999999 (expect 400) -> HTTP 400 0.020983s
- preferences safetyWeight=1e99999999 (expect 400) -> HTTP 400 0.024048s

Demo account reset:
- demo login 1 -> HTTP 200 0.262219s
- demo: save a favorite -> HTTP 201 0.050944s
- demo: replace Home -> HTTP 201 0.028736s
- demo: save a trip -> HTTP 201 0.018485s
- demo: preferences bike/0.2/alerts off -> HTTP 200 0.039251s
- demo places before login 2 -> HTTP 200 0.029488s
  {"places":[{"id":7,"kind":"home","label":"Moved","address":"Elsewhere","lat":47.7,"lng":-122.4},{"id":5,"kind":"work","label":"Work","address":"Northeastern University Seattle, 401 Terry Ave N, Seattle, WA 98109","lat":47.6226,"lng":-122.3375},{"id":6,"kind":"saved","label":"ZZ Visitor Favorite","address":"x","lat":47.6,"lng":-122.3}]}
- demo trips before login 2 -> HTTP 200 0.038219s
  {"trips":[{"id":8197,"fromLabel":"ZZ demo trip from","toLabel":"ZZ demo trip to","toLat":47.65,"toLng":-122.3,"mode":"car","departAt":"2026-11-20T08:00","riskScore":10,"riskLevel":"low","choice":"fast
- demo login 2 (new cookie jar) -> HTTP 200 0.221734s
  {"user":{"id":1024,"displayName":"Demo User","email":"demo@crimeradar.app","createdAt":"2026-11-19T09:29:02Z","preferences":{"mode":"walk","safetyWeight":0.7,"alerts":true}}}
- demo places after login 2 -> HTTP 200 0.023368s
  {"places":[{"id":8,"kind":"home","label":"Home","address":"Capitol Hill, Seattle, WA","lat":47.6235,"lng":-122.32},{"id":9,"kind":"work","label":"Work","address":"Northeastern University Seattle, 401 Terry Ave N, Seattle, WA 98109","lat":47.6226,"lng":-122.3375}]}
- demo trips after login 2 -> HTTP 200 0.021424s
  {"trips":[]}

Demo throttle:
- demo wrong password 1 (expect 401, never 429) -> HTTP 401 0.201312s
- demo wrong password 2 (expect 401, never 429) -> HTTP 401 0.197601s
- demo wrong password 3 (expect 401, never 429) -> HTTP 401 0.318780s
- demo wrong password 4 (expect 401, never 429) -> HTTP 401 0.251902s
- demo wrong password 5 (expect 401, never 429) -> HTTP 401 0.198112s
- demo wrong password 6 (expect 401, never 429) -> HTTP 401 0.208488s
- demo correct password after 6 wrong (expect 200) -> HTTP 200 0.214972s

Normal account throttle (fix1795083032@example.com):
- wrong password 1 (expect 401 x5, then 429) -> HTTP 401 0.184093s
- wrong password 2 (expect 401 x5, then 429) -> HTTP 401 0.224112s
- wrong password 3 (expect 401 x5, then 429) -> HTTP 401 0.197006s
- wrong password 4 (expect 401 x5, then 429) -> HTTP 401 0.205768s
- wrong password 5 (expect 401 x5, then 429) -> HTTP 401 0.175710s
- wrong password 6 (expect 401 x5, then 429) -> HTTP 429 0.024557s
- correct password while locked (expect 429) -> HTTP 429 0.026389s
```
