// Walking routes from the public OSRM foot server (FOSSGIS), called from the browser.
// The path segment is literally `driving` even on the foot server.

import type { LineString } from 'geojson';

export interface LatLng { lat: number; lng: number }

export interface RouteStep { instruction: string; distanceM: number }

export interface WalkingRoute {
  geometry: LineString;
  distanceM: number;
  durationS: number;
  steps: RouteStep[];
}

const FOOT_SERVER = 'https://routing.openstreetmap.de/routed-foot/route/v1/driving';

interface OsrmManeuver { type: string; modifier?: string; bearing_after?: number; exit?: number }
interface OsrmStep { distance: number; name: string; ref?: string; maneuver: OsrmManeuver }
interface OsrmResponse {
  code: string;
  message?: string;
  routes?: { distance: number; duration: number; geometry: LineString; legs: { steps: OsrmStep[] }[] }[];
}

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const compass = (bearing = 0) => COMPASS[Math.round(bearing / 45) % 8];

/** Plain-English instruction for one OSRM step. */
export function describeStep(step: OsrmStep): string {
  const { type, modifier, bearing_after: bearing, exit } = step.maneuver;
  const road = step.name || step.ref || '';
  const onto = road ? ` onto ${road}` : '';
  const on = road ? ` on ${road}` : '';
  const turn = modifier === 'straight' ? 'Go straight' : modifier === 'uturn' ? 'Make a U-turn' : `Turn ${modifier ?? ''}`.trim();
  switch (type) {
    case 'depart': return `Head ${compass(bearing)}${on}`;
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

export async function walkingRoute(from: LatLng, to: LatLng, signal?: AbortSignal): Promise<WalkingRoute> {
  const coords = `${from.lng.toFixed(5)},${from.lat.toFixed(5)};${to.lng.toFixed(5)},${to.lat.toFixed(5)}`;
  const response = await fetch(`${FOOT_SERVER}/${coords}?overview=full&geometries=geojson&steps=true`, { signal });
  if (!response.ok) throw new Error(`Routing server answered ${response.status}`);
  const data = (await response.json()) as OsrmResponse;
  const route = data.routes?.[0];
  if (data.code !== 'Ok' || !route) throw new Error(data.message ?? 'No walking route found');
  const steps = route.legs.flatMap((leg) => leg.steps)
    .map((s) => ({ instruction: describeStep(s), distanceM: s.distance }));
  return { geometry: route.geometry, distanceM: route.distance, durationS: route.duration, steps };
}

/** Link that opens the same walking route on openstreetmap.org. */
export function osmDirectionsUrl(from: LatLng, to: LatLng): string {
  const route = `${from.lat.toFixed(5)},${from.lng.toFixed(5)};${to.lat.toFixed(5)},${to.lng.toFixed(5)}`;
  return `https://www.openstreetmap.org/directions?engine=fossgis_osrm_foot&route=${encodeURIComponent(route)}`;
}
