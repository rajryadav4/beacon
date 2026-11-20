// Typed fixtures for the hazard / safe-place / alert endpoints, used only when the page is
// opened with `?mock=1` (for UI work while the API endpoints are being built).
// Everything here is fake and the UI marks it "MOCK DATA".

import type {
  ActiveAlerts, AlertAreas, AlertsStatus, BBox, Hazard, NearestPlaces, SafePlacesData,
} from '../api';
import { FALLBACK_HAZARDS, KIND_LABEL } from './hazards';

export const MOCK = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('mock');

// Seeded PRNG so the fake places stay put between reloads.
function prng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

const KINDS = Object.keys(KIND_LABEL);
const SEATTLE: BBox = [-122.44, 47.49, -122.24, 47.74];

const PLACES = (() => {
  const rand = prng(42);
  return Array.from({ length: 160 }, (_, i) => {
    const kind = KINDS[Math.floor(rand() * KINDS.length)];
    return {
      id: `mock-${i}`,
      name: `${KIND_LABEL[kind]} ${i + 1} (mock)`,
      kind,
      kindLabel: KIND_LABEL[kind],
      lng: SEATTLE[0] + rand() * (SEATTLE[2] - SEATTLE[0]),
      lat: SEATTLE[1] + rand() * (SEATTLE[3] - SEATTLE[1]),
      address: `${100 + i * 7} Example St (mock)`,
      phone: i % 3 === 0 ? null : '+1 206 555 0100',
      openingHours: i % 4 === 0 ? '24/7' : null,
      source: 'mock',
    };
  });
})();

function distanceM(lat1: number, lng1: number, lat2: number, lng2: number) {
  const r = Math.PI / 180;
  const x = (lng2 - lng1) * r * Math.cos(((lat1 + lat2) / 2) * r);
  const y = (lat2 - lat1) * r;
  return Math.sqrt(x * x + y * y) * 6371000;
}

const delay = <T>(value: T, ms = 250) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
const iso = (offsetMin: number) => new Date(Date.now() + offsetMin * 60000).toISOString();

export const mockApi = {
  hazards: () => delay<{ hazards: Hazard[] }>({ hazards: FALLBACK_HAZARDS }),

  safePlaces: ([w, s, e, n]: BBox, kinds: string[]) => delay<SafePlacesData>({
    type: 'FeatureCollection',
    features: PLACES
      .filter((p) => p.lng >= w && p.lng <= e && p.lat >= s && p.lat <= n && (!kinds.length || kinds.includes(p.kind)))
      .map(({ lat, lng, ...props }) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: props })),
  }),

  nearest: (lat: number, lng: number, hazard: string, limit: number) => {
    const kinds = FALLBACK_HAZARDS.find((h) => h.key === hazard)?.placeKinds ?? [];
    const places = PLACES
      .filter((p) => !kinds.length || kinds.includes(p.kind))
      .map((p) => ({ ...p, distanceM: Math.round(distanceM(lat, lng, p.lat, p.lng)) }))
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, limit);
    return delay<NearestPlaces>({ hazard, places });
  },

  activeAlerts: (lat: number, lng: number) => delay<ActiveAlerts>({
    location: { lat, lng },
    alerts: [{
      id: 'mock-wind-1', source: 'nws', event: 'Wind Advisory', hazard: 'storm',
      hazardLabel: 'Severe storm, tornado or hurricane', severity: 'Moderate', urgency: 'Expected', certainty: 'Likely',
      headline: 'Wind Advisory until 6 PM (mock)', description: 'South winds 20 to 30 mph with gusts up to 45 mph. (mock data)',
      instruction: 'Use extra caution when driving, especially in a high-profile vehicle. Secure outdoor objects.',
      areaDesc: 'Seattle and vicinity (mock)', sender: 'NWS Seattle WA (mock)',
      effective: iso(-40), expires: iso(200), url: 'https://www.weather.gov/sew/', magnitude: null, distanceKm: 0,
    }],
    incidents: [],
    survival: false,
    topHazard: 'storm',
    updatedAt: iso(0),
  }),

  alertAreas: ([w, s, e, n]: BBox) => {
    const cx = (w + e) / 2;
    const cy = (s + n) / 2;
    const dx = (e - w) / 4;
    const dy = (n - s) / 4;
    return delay<AlertAreas>({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[cx - dx, cy - dy], [cx + dx, cy - dy], [cx + dx, cy + dy], [cx - dx, cy + dy], [cx - dx, cy - dy]]] },
        properties: { id: 'mock-wind-1', event: 'Wind Advisory', hazard: 'storm', severity: 'Moderate', headline: 'Wind Advisory until 6 PM (mock)', expires: iso(200) },
      }],
    });
  },

  alertsStatus: () => delay<AlertsStatus>({
    sources: [
      { source: 'nws', label: 'NWS (mock)', ok: true, lastSuccess: iso(-2), count: 1 },
      { source: 'usgs', label: 'USGS earthquakes (mock)', ok: true, lastSuccess: iso(-1), count: 0 },
      { source: 'ipaws', label: 'FEMA IPAWS (mock)', ok: false, lastSuccess: iso(-95), error: 'timeout (mock)' },
    ],
  }),
};
