// Geometry helpers (ported from the class app, CrimeRadar/.../assets/js/geo.js).
// Points are [lat, lng] pairs unless a type says LatLng.

export type Pt = [number, number];
export interface LatLng { lat: number; lng: number }

export const SEATTLE_BOX = { s: 47.48, w: -122.46, n: 47.75, e: -122.22 };
export const SEATTLE_CENTER: LatLng = { lat: 47.6145, lng: -122.334 };

/** Start point when the device location is unknown or outside Seattle (as in the class app). */
export const DEMO_START = { name: 'Pike Place Market', detail: 'Demo start point', lat: 47.60948, lng: -122.34215 };

const M_PER_DEG_LAT = 111320;
export const mPerDegLng = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);

/** Distance in meters between [lat, lng] points. */
export function haversine(a: Pt, b: Pt): number {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toRad;
  const dLng = (b[1] - a[1]) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export const distM = (a: LatLng, b: LatLng) => haversine([a.lat, a.lng], [b.lat, b.lng]);

export const inSeattle = (lat: number, lng: number) =>
  lat >= SEATTLE_BOX.s && lat <= SEATTLE_BOX.n && lng >= SEATTLE_BOX.w && lng <= SEATTLE_BOX.e;

/** Points every `step` meters along a polyline. Keeps the first and last point. */
export function densify(coords: Pt[], step = 25): Pt[] {
  if (coords.length < 2) return coords.slice();
  const out: Pt[] = [coords[0]];
  let carry = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const d = haversine(a, b);
    if (d === 0) continue;
    let t = step - carry;
    while (t <= d) {
      const f = t / d;
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
      t += step;
    }
    carry = d - (t - step);
  }
  out.push(coords[coords.length - 1]);
  return out;
}

/** Cumulative distance (m) for each vertex of a polyline. */
export function cumulative(coords: Pt[]): number[] {
  const acc = [0];
  for (let i = 1; i < coords.length; i++) acc.push(acc[i - 1] + haversine(coords[i - 1], coords[i]));
  return acc;
}

/** Position at distance `d` (m) along a polyline with its cumulative array. */
export function pointAt(coords: Pt[], acc: number[], d: number): Pt {
  if (d <= 0) return coords[0];
  const total = acc[acc.length - 1];
  if (d >= total) return coords[coords.length - 1];
  let lo = 0;
  let hi = acc.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (acc[mid] <= d) lo = mid; else hi = mid;
  }
  const seg = acc[hi] - acc[lo] || 1;
  const f = (d - acc[lo]) / seg;
  const a = coords[lo];
  const b = coords[hi];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

/**
 * Distance along the route of the point nearest to `pos` (projected onto the segments),
 * and how far `pos` is from the route. Used to follow a live location along a route.
 */
export function project(coords: Pt[], acc: number[], pos: Pt): { along: number; off: number } {
  let best = { along: 0, off: Infinity };
  const k = mPerDegLng(pos[0]);
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const ax = (a[1] - pos[1]) * k;
    const ay = (a[0] - pos[0]) * M_PER_DEG_LAT;
    const bx = (b[1] - pos[1]) * k;
    const by = (b[0] - pos[0]) * M_PER_DEG_LAT;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
    const px = ax + dx * t;
    const py = ay + dy * t;
    const off = Math.hypot(px, py);
    if (off < best.off) best = { along: acc[i - 1] + (acc[i] - acc[i - 1]) * t, off };
  }
  return best;
}

/** Initial compass bearing (degrees, 0 = north, clockwise) from a to b. */
export function bearing(a: Pt, b: Pt): number {
  const toRad = Math.PI / 180;
  const y = Math.sin((b[1] - a[1]) * toRad) * Math.cos(b[0] * toRad);
  const x = Math.cos(a[0] * toRad) * Math.sin(b[0] * toRad)
    - Math.sin(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.cos((b[1] - a[1]) * toRad);
  return ((Math.atan2(y, x) / toRad) + 360) % 360;
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export const compassWord = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

/** A circle polygon (GeoJSON ring of [lng, lat]) around a point. */
export function circleRing(center: LatLng, radiusM: number, n = 48): [number, number][] {
  const ring: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI;
    ring.push([center.lng + (Math.sin(a) * radiusM) / mPerDegLng(center.lat), center.lat + (Math.cos(a) * radiusM) / M_PER_DEG_LAT]);
  }
  return ring;
}

/** Two detour points, one on each side of the straight line, to find more route options. */
export function viaPoints(from: LatLng, to: LatLng, straight: number): LatLng[] {
  const midLat = (from.lat + to.lat) / 2;
  const midLng = (from.lng + to.lng) / 2;
  const kx = mPerDegLng(midLat);
  const dx = (to.lng - from.lng) * kx;
  const dy = (to.lat - from.lat) * M_PER_DEG_LAT;
  const len = Math.hypot(dx, dy) || 1;
  const off = Math.min(1200, Math.max(160, straight * 0.22));
  const px = (-dy / len) * off;
  const py = (dx / len) * off;
  return [1, -1].map((s) => ({ lat: midLat + (s * py) / M_PER_DEG_LAT, lng: midLng + (s * px) / kx }));
}

function keySet(coords: Pt[]): Set<string> {
  const s = new Set<string>();
  for (const [lat, lng] of densify(coords, 20)) {
    const ky = Math.round(lat / 0.0003);
    const kx = Math.round(lng / 0.0004);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) s.add(`${ky + a}:${kx + b}`);
  }
  return s;
}

/** Share of route `a` that runs along route `b` (0..1). */
export function similarity(a: Pt[], b: Pt[]): number {
  const keys = keySet(b);
  const pts = densify(a, 40);
  let hit = 0;
  for (const [lat, lng] of pts) if (keys.has(`${Math.round(lat / 0.0003)}:${Math.round(lng / 0.0004)}`)) hit++;
  return hit / pts.length;
}
