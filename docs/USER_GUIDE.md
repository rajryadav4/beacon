# CrimeRadar user guide

CrimeRadar shows where and when crime happens in Seattle, and suggests the safer route for the time you travel and how you travel.

## 1. Sign in

- **Explore with the demo account**: one click. The demo account has a saved Home (Capitol Hill) and Work (Northeastern University Seattle).
- **Create an account**: name, email and a password of 8 or more characters.
- Your saved places, travel mode, route choice and alert settings stay with your account.

## 2. Explore the map

| Control | What it does |
|---|---|
| **Time of day** | All day, Morning (6 AM-12 PM), Afternoon, Evening, Night (12-6 AM). **Now** picks the current Seattle time. For Evening and Night the whole app and the map turn dark. |
| **Crime types** | Turn crime groups on or off. **Street safety** keeps assault, robbery, theft, and drugs/weapons/disorder. |
| **Play the day** | A time-lapse: Morning, Afternoon, Evening, Night, again and again. The heatmap glides from one time to the next, and the map turns dark after sunset. Click **Stop**, a time, or **Now** to stop it. |
| **Map layer** | **Heatmap** = where crime was reported. **Risk grid** = the ML model's prediction for each block (about 225 m x 225 m). |
| **3D** (button on the map) | Tilts the map. With **Risk grid**, every risky block becomes a column whose height is its predicted risk: a "risk skyline". Buildings show in 3D. Click again for 2D. Right-drag (or Ctrl-drag) also tilts and turns the map. |
| Red pulsing rings | Radar blips on the 6 riskiest blocks for the selected time. |
| **Areas, most to least dangerous** | Neighborhoods ranked by the danger index. Click a row to zoom to it. |
| Hover or tap the map | Shows the area, reports a year, the main crime types and the predicted risk of that block. |

**Danger index** = severity-weighted incidents per year per km², for the selected time and crime types. 100 = the most dangerous area for that selection.

## 3. Plan a safer trip

1. Open **Directions**, or click **Where to?** in Explore.
2. **From** starts at your location. If the location is off or you are outside Seattle, the trip starts at Pike Place Market. Type to choose another start.
3. **To**: type a place, or pick **Home**, **Work**, a saved place, a recent trip or a popular place.
4. Pick the travel mode: **Walk**, **Bike** or **Car**.
5. Pick **Leave now**, or **Leave at…** a time.

CrimeRadar compares up to 3 routes (R1-R3):

| On the card | Meaning |
|---|---|
| **Recommended** (green) | The route with the least crime exposure that stays within your detour limit, or the fastest route when a detour is not worth it. The **Why this route?** line above the cards says which. |
| **Moderate risk** (orange) | The middle option. |
| **Most dangerous** (red) | The riskiest of the options. With only 2 routes, the other one is red only when it is riskier than the recommended one. |
| **Safest** / **Fastest** | The route with the lowest risk / the shortest time. |
| **Score ring** + **Lower / Elevated / High risk** | Risk of the route at your departure time, adjusted for the travel mode. The score uses a log scale: 0 = no reported crime, 100 = the riskiest block in Seattle at its worst time. High = the route runs mostly through the top 3% of Seattle's block-times. |
| **Street crimes a year along it** | Reports a year on the blocks along the route at that time of day (assault, robbery, theft, drugs/weapons/disorder; for a car: assault, robbery, vehicle crime). |
| **Arrive** | The arrival time for the departure time you picked. |
| **Why?** | The main crime types along the route, the riskiest stretch, the same route at other times of day, and the effect of the travel mode. |

On the map, all routes show at the same time: **green = recommended, orange = moderate, red = most dangerous**. Each route has a label such as "R1 · 31 min" in its color. Click a line, a label or a card to select a route; the selected route is thicker and glows. Red dots are the high-risk blocks on the selected route.

The colors compare the routes with each other. The badge on each card (Lower / Elevated / High risk) shows the route's own risk, so a green route at night downtown can still be "High risk": it is only the best of the options.

## 4. Danger alerts

- **Start trip** follows your location (in Seattle) and warns you **before** you enter a high-risk block. The alert shows the area, the main crime types and a safety tip. The phone vibrates and plays a short sound.
- **Simulate** plays the trip on the map at high speed. Use it to see the alerts when you are not in Seattle (for example at the exhibition).
- With **Danger alerts** on in the account menu, CrimeRadar also warns you when no trip runs (only after you allowed location access).

## 5. Account menu (top-right circle)

- **How I usually travel**: the default travel mode.
- **Route choice**: a slider from Fastest to Safest. Fastest never detours; the middle allows a walk 25% or 5 minutes longer (whichever is less) for at least 15% less crime exposure; the safe end (the default) allows 50% or 10 minutes for at least 10% less.
- **Danger alerts**: on or off.
- **Saved places**: remove a place (you can undo for a few seconds). To save a place, choose it as the destination and tap the star.
- **Sign out**.

## 6. Exhibition demo script (5 minutes)

| Step | Do | Say |
|---|---|---|
| 1 | Login screen | "CrimeRadar reads about 286,000 Seattle Police reports from the last 4 years." Click **Explore with the demo account**. |
| 2 | Explore, **All day**, Heatmap | "This is where crime was reported." |
| 3 | Click **Play the day** and let it run one cycle | "Risk moves with the clock. Watch the city go dark after sunset and the hotspots shift." Point at the ranking: the top area changes. |
| 4 | **Street safety**, then click the first area in the ranking | "We rank 58 neighborhoods by severity-weighted crime per km²." |
| 5 | **Risk grid**, then **3D**; scroll to "ML model accuracy" | "A machine-learning model predicts next year's risk for each block. Here it is as a skyline: the taller the block, the riskier. In a test on the last year, its top 10% of blocks held 63% of the weighted crime, and it beats simple history on every measure." |
| 6 | **Directions** → **Home** | "Three routes on the map: green is recommended, orange is moderate, red is the most dangerous. Each has a risk score for this time and this travel mode." Open **Why?** on R1. |
| 7 | Switch **Walk** → **Car**, then **Leave at…** 9:00 AM | "In a car, or in the morning, the same trip is safer." |
| 8 | **Simulate** on a route with red dots | "CrimeRadar warns you before you enter a high-risk block." |
| 9 | Account menu → **Route choice** slider | "Each user decides how long a detour they accept. CrimeRadar never sends you on a long detour for a tiny gain, and the Why line says so." |

## 7. Privacy

- Route requests send the start and end points to the free routing service (routing.openstreetmap.de). Place searches send the typed text to Photon or Nominatim. No name, email or account data goes to these services.
- The demo account is shared by all visitors. Its saved places and trips reset at each demo sign-in, so the next visitor does not see yours.
- In offline mode (no server), an account you create lasts only until the browser tab closes.

## 8. Limits (say them if asked)

- Police reports show reported crime, not all crime.
- About half of the crimes against persons have no location in the public data (the city hides it for privacy), and 8.6% of reports have no time of day. Both are left out of the map's time-of-day view.
- New reports arrive 1-3 weeks late, so the last weeks look calmer than they were.
- A high score is not a guarantee of danger, and a low score is not a guarantee of safety. CrimeRadar is a decision aid.
