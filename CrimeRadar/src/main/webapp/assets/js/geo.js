// Geometry, place search (Photon, Nominatim fallback), routing (OSRM) and the device location.
// All services are free and need no API key. Requests carry no personal data.

import { fetchWithTimeout } from './ui.js';

export const SEATTLE_BOX = { s: 47.48, w: -122.46, n: 47.75, e: -122.22 };
/** Start point when the device location is unknown or outside Seattle. */
export const DEMO_START = { name: 'Pike Place Market', detail: 'Demo start point', lat: 47.60948, lng: -122.34215, kind: 'demo' };

const M_PER_DEG_LAT = 111320;
const mPerDegLng = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

/** Distance in meters between [lat, lng] points. */
export function haversine(a, b) {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toRad;
  const dLng = (b[1] - a[1]) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export const inSeattle = (lat, lng) =>
  lat >= SEATTLE_BOX.s && lat <= SEATTLE_BOX.n && lng >= SEATTLE_BOX.w && lng <= SEATTLE_BOX.e;

/** Points every `step` meters along a polyline of [lat, lng]. Keeps the first and last point. */
export function densify(coords, step = 25) {
  if (!coords || coords.length < 2) return coords ? coords.slice() : [];
  const out = [coords[0]];
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
export function cumulative(coords) {
  const acc = [0];
  for (let i = 1; i < coords.length; i++) acc.push(acc[i - 1] + haversine(coords[i - 1], coords[i]));
  return acc;
}

/** Position at distance `d` (m) along a polyline with its cumulative array. */
export function pointAt(coords, acc, d) {
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

// ---------------- Routing ----------------

const OSRM = {
  walk: 'https://routing.openstreetmap.de/routed-foot',
  bike: 'https://routing.openstreetmap.de/routed-bike',
  car: 'https://routing.openstreetmap.de/routed-car',
};
const routeCache = new Map();

async function osrm(base, points, alternatives, signal) {
  const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const url = `${base}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false&alternatives=${alternatives ? 3 : 'false'}`;
  const r = await fetchWithTimeout(url, { signal }, 15000);
  if (!r.ok) throw new Error(r.status === 429 ? 'The routing service is busy. Try again in a moment.' : `The routing service failed (HTTP ${r.status}).`);
  const j = await r.json();
  if (j.code !== 'Ok' || !j.routes) throw new Error('No route was found between these places.');
  return j.routes.map((rt) => ({
    coords: rt.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    duration: rt.duration,
    distance: rt.distance,
  }));
}

/** Two detour points, one on each side of the straight line, to find more route options. */
function viaPoints(from, to, straight) {
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

function keySet(coords) {
  const s = new Set();
  for (const [lat, lng] of densify(coords, 20)) {
    const ky = Math.round(lat / 0.0003);
    const kx = Math.round(lng / 0.0004);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) s.add(`${ky + a}:${kx + b}`);
  }
  return s;
}

/** Share of route `a` that runs along route `b` (0..1). */
export function similarity(a, b) {
  const keys = keySet(b);
  const pts = densify(a, 40);
  let hit = 0;
  for (const [lat, lng] of pts) if (keys.has(`${Math.round(lat / 0.0003)}:${Math.round(lng / 0.0004)}`)) hit++;
  return hit / pts.length;
}

/** Up to 3 distinct routes for a travel mode. */
export async function fetchRoutes(from, to, mode, signal) {
  const key = [mode, from.lat.toFixed(5), from.lng.toFixed(5), to.lat.toFixed(5), to.lng.toFixed(5)].join('|');
  if (routeCache.has(key)) return routeCache.get(key);
  const base = OSRM[mode] || OSRM.walk;
  const routes = await osrm(base, [from, to], true, signal);
  const straight = haversine([from.lat, from.lng], [to.lat, to.lng]);
  if (routes.length < 3 && straight > 350) {
    const extra = await Promise.allSettled(viaPoints(from, to, straight).map((v) => osrm(base, [from, v, to], false, signal)));
    if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    for (const r of extra) if (r.status === 'fulfilled' && r.value.length) routes.push(r.value[0]);
  }
  const fastest = Math.min(...routes.map((r) => r.duration));
  const unique = [];
  for (const r of routes.sort((a, b) => a.duration - b.duration)) {
    if (r.duration > fastest * 1.7 + 120) continue;
    if (unique.some((u) => similarity(r.coords, u.coords) > 0.85)) continue;
    unique.push(r);
  }
  const result = unique.slice(0, 3);
  routeCache.set(key, result);
  return result;
}

// ---------------- Place search ----------------

function fromPhoton(f) {
  const p = f.properties || {};
  const [lng, lat] = f.geometry.coordinates;
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const name = p.name || street || p.district || p.city || 'Unnamed place';
  const detail = [p.name && street ? street : null, p.district || p.locality, p.city].filter(Boolean).join(', ');
  return { name, detail, lat, lng, kind: 'search' };
}

async function nominatim(q, signal) {
  const b = SEATTLE_BOX;
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&bounded=1&viewbox=${b.w},${b.n},${b.e},${b.s}&q=${encodeURIComponent(q)}`;
  const r = await fetchWithTimeout(url, { signal, headers: { 'Accept-Language': 'en' } }, 8000);
  if (!r.ok) throw new Error('Place search is not available right now.');
  const j = await r.json();
  return j.map((x) => {
    const parts = String(x.display_name || '').split(',').map((s) => s.trim());
    return { name: x.name || parts[0], detail: parts.slice(1, 3).join(', '), lat: Number(x.lat), lng: Number(x.lon), kind: 'search' };
  });
}

/** Search places inside Seattle. Photon first (built for typing), Nominatim if Photon fails. */
export async function searchPlaces(q, signal) {
  const b = SEATTLE_BOX;
  try {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=7&lang=en&lat=47.6145&lon=-122.334&bbox=${b.w},${b.s},${b.e},${b.n}`;
    const r = await fetchWithTimeout(url, { signal }, 6000);
    if (!r.ok) throw new Error(`Photon HTTP ${r.status}`);
    const j = await r.json();
    return (j.features || []).map(fromPhoton).filter((p) => inSeattle(p.lat, p.lng));
  } catch (e) {
    if (signal && signal.aborted) throw e;
    return nominatim(q, signal);
  }
}

// ---------------- Device location ----------------

export function getPosition(timeout = 7000) {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('This browser cannot share its location.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(e),
      { enableHighAccuracy: true, timeout, maximumAge: 60000 },
    );
  });
}

export async function locationPermission() {
  try {
    if (!navigator.permissions) return 'unknown';
    const s = await navigator.permissions.query({ name: 'geolocation' });
    return s.state;
  } catch {
    return 'unknown';
  }
}
