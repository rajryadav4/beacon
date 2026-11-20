// Routes from the public OSRM servers run by FOSSGIS (routing.openstreetmap.de): free, no API key.
// Up to 3 distinct routes per trip (OSRM alternatives plus two via-point detours, as in the class app's
// geo.js), each with turn-by-turn steps. The path segment is literally `driving` on every profile.

import { cumulative, haversine, similarity, viaPoints, type LatLng, type Pt } from './geo';
import { fetchWithTimeout } from './format';
import type { Mode } from './risk';

export interface RouteStep {
  instruction: string;
  /** Length of the step (m). */
  distanceM: number;
  /** Distance along the whole route where the step's maneuver happens (m). */
  at: number;
  type: string;
  modifier?: string;
  location: Pt;
}

export interface RawRoute { coords: Pt[]; duration: number; distance: number; steps: RouteStep[] }

const OSRM: Record<Mode, string> = {
  walk: 'https://routing.openstreetmap.de/routed-foot',
  bike: 'https://routing.openstreetmap.de/routed-bike',
  car: 'https://routing.openstreetmap.de/routed-car',
};

interface OsrmManeuver { type: string; modifier?: string; bearing_after?: number; exit?: number; location: [number, number] }
interface OsrmStep { distance: number; name: string; ref?: string; maneuver: OsrmManeuver }
interface OsrmRoute { distance: number; duration: number; geometry: { coordinates: [number, number][] }; legs: { steps: OsrmStep[] }[] }
interface OsrmResponse { code: string; message?: string; routes?: OsrmRoute[] }

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const compass = (b = 0) => COMPASS[Math.round(b / 45) % 8];

/** Plain-English instruction for one OSRM step. */
export function describeStep(step: OsrmStep): string {
  const { type, modifier, bearing_after: bearingAfter, exit } = step.maneuver;
  const road = step.name || step.ref || '';
  const onto = road ? ` onto ${road}` : '';
  const on = road ? ` on ${road}` : '';
  const turn = modifier === 'straight' ? 'Go straight' : modifier === 'uturn' ? 'Make a U-turn' : `Turn ${modifier ?? ''}`.trim();
  switch (type) {
    case 'depart': return `Head ${compass(bearingAfter)}${on}`;
    case 'arrive': return modifier && modifier !== 'straight' ? `Arrive at the destination, on the ${modifier}` : 'Arrive at the destination';
    case 'turn': return `${turn}${onto}`;
    case 'new name': case 'continue': return `Continue${onto || ' straight'}`;
    case 'end of road': return `At the end of the road, ${turn.toLowerCase()}${onto}`;
    case 'fork': return `At the fork, keep ${modifier?.replace('slight ', '') ?? 'straight'}${onto}`;
    case 'merge': return `Merge${onto}`;
    case 'on ramp': case 'off ramp': return `Take the ramp${onto}`;
    case 'roundabout': case 'rotary': case 'exit roundabout': case 'exit rotary':
      return exit ? `At the roundabout, take exit ${exit}${onto}` : `Go through the roundabout${onto}`;
    case 'roundabout turn': return `At the roundabout, ${turn.toLowerCase()}${onto}`;
    default: return `${turn}${onto}`;
  }
}

function toRoute(rt: OsrmRoute): RawRoute {
  const coords = rt.geometry.coordinates.map(([lng, lat]) => [lat, lng] as Pt);
  const legs = rt.legs ?? [];
  const steps: RouteStep[] = [];
  let at = 0;
  legs.forEach((leg, li) => {
    for (const s of leg.steps ?? []) {
      const t = s.maneuver.type;
      // A via point adds an "arrive" + "depart" pair in the middle: not a real turn.
      const viaJoin = (t === 'arrive' && li < legs.length - 1) || (t === 'depart' && li > 0);
      if (!viaJoin) {
        steps.push({
          instruction: describeStep(s), distanceM: s.distance, at, type: t, modifier: s.maneuver.modifier,
          location: [s.maneuver.location[1], s.maneuver.location[0]],
        });
      }
      at += s.distance;
    }
  });
  // Re-base step positions on the geometry length (OSRM step lengths are rounded).
  const total = cumulative(coords).at(-1) ?? rt.distance;
  const k = at > 0 ? total / at : 1;
  for (const s of steps) s.at *= k;
  return { coords, duration: rt.duration, distance: rt.distance, steps };
}

async function osrm(mode: Mode, points: LatLng[], alternatives: boolean, signal?: AbortSignal): Promise<RawRoute[]> {
  const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const url = `${OSRM[mode]}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true&alternatives=${alternatives ? 3 : 'false'}`;
  const r = await fetchWithTimeout(url, { signal }, 15000);
  if (!r.ok) throw new Error(r.status === 429 ? 'The routing service is busy. Try again in a moment.' : `The routing service failed (HTTP ${r.status}).`);
  const j = (await r.json()) as OsrmResponse;
  if (j.code !== 'Ok' || !j.routes?.length) throw new Error('No route was found between these places.');
  return j.routes.map(toRoute);
}

const routeCache = new Map<string, RawRoute[]>();

/** Up to 3 distinct routes for a travel mode, quickest first. */
export async function fetchRoutes(from: LatLng, to: LatLng, mode: Mode, signal?: AbortSignal): Promise<RawRoute[]> {
  const key = [mode, from.lat.toFixed(5), from.lng.toFixed(5), to.lat.toFixed(5), to.lng.toFixed(5)].join('|');
  const cached = routeCache.get(key);
  if (cached) return cached;
  const routes = await osrm(mode, [from, to], true, signal);
  const straight = haversine([from.lat, from.lng], [to.lat, to.lng]);
  if (routes.length < 3 && straight > 350) {
    const extra = await Promise.allSettled(viaPoints(from, to, straight).map((v) => osrm(mode, [from, v, to], false, signal)));
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    for (const r of extra) if (r.status === 'fulfilled' && r.value.length) routes.push(r.value[0]);
  }
  const fastest = Math.min(...routes.map((r) => r.duration));
  const unique: RawRoute[] = [];
  for (const r of routes.sort((a, b) => a.duration - b.duration)) {
    if (r.duration > fastest * 1.7 + 120) continue;
    if (unique.some((u) => similarity(r.coords, u.coords) > 0.85)) continue;
    unique.push(r);
  }
  const result = unique.slice(0, 3);
  routeCache.set(key, result);
  return result;
}

/** One route (the quickest), for survival guidance where speed matters most. */
export async function fetchRoute(from: LatLng, to: LatLng, mode: Mode = 'walk', signal?: AbortSignal): Promise<RawRoute> {
  return (await osrm(mode, [from, to], false, signal))[0];
}

/** Link that opens the same walking route on openstreetmap.org. */
export function osmDirectionsUrl(from: LatLng, to: LatLng): string {
  const route = `${from.lat.toFixed(5)},${from.lng.toFixed(5)};${to.lat.toFixed(5)},${to.lng.toFixed(5)}`;
  return `https://www.openstreetmap.org/directions?engine=fossgis_osrm_foot&route=${encodeURIComponent(route)}`;
}
