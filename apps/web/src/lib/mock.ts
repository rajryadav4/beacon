// Typed fixtures for the hazard / safe-place / alert endpoints, used only when the page is
// opened with `?mock=1` (for UI work while the API endpoints are being built).
// Everything here is fake and the UI marks it "MOCK DATA".

import type {
  ActiveAlerts, AlertAreas, AlertsStatus, BBox, Hazard, HazardGrid, HazardZones, NearestPlaces, Outlook, SafeAreas,
  SafePlacesData,
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

  outlook: () => delay<Outlook>({
    location: { inRegion: true, exposure: [{ hazard: 'flood', hazardLabel: 'Flood', score: 34, level: 'moderate' }] },
    outlook: [{
      id: 'mock-rain-1', hazard: 'flood', hazardLabel: 'Flood', level: 'possible',
      title: 'Heavy rain possible Thursday night (mock)',
      summary: 'Open-Meteo forecasts 45 mm of rain in 24 h. Low-lying streets and steep slopes may be affected. (mock data)',
      validFrom: iso(60 * 20), validTo: iso(60 * 44), confidence: 'medium',
      sources: [{ name: 'Open-Meteo (mock)', url: 'https://open-meteo.com/', observed: iso(-30) }], distanceKm: 0,
    }],
    updatedAt: iso(-12),
    disclaimer: 'Mock outlook for UI work. Not an official warning.',
  }),

  /** Fake worst-to-safest grid: exposure falls with distance from the waterfront (mock). */
  hazardGrid: (hazard: string) => {
    const features: HazardGrid['features'] = [];
    for (let row = 40; row < 110; row += 1) {
      for (let col = 20; col < 70; col += 1) {
        const lat = 47.48 + row * 0.002;
        const lng = -122.46 + col * 0.003;
        const score = Math.max(0, Math.min(100, Math.round(100 - Math.hypot((lng + 122.345) * 70, (lat - 47.61) * 50) * 9)));
        if (score < 3) continue;
        features.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [[[lng, lat], [lng + 0.003, lat], [lng + 0.003, lat + 0.002], [lng, lat + 0.002], [lng, lat]]] },
          properties: { cellId: row * 100 + col, score, level: score >= 50 ? 'high' : score >= 20 ? 'moderate' : 'low' },
        });
      }
    }
    return delay<HazardGrid>({ type: 'FeatureCollection', features, note: `Mock ${hazard} exposure.` });
  },

  hazardZones: (hazard: string, [w, s, e, n]: BBox) => delay<HazardZones>({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[[Math.max(w, -122.36), Math.max(s, 47.595)], [Math.min(e, -122.335), Math.max(s, 47.595)],
        [Math.min(e, -122.345), Math.min(n, 47.625)], [Math.max(w, -122.37), Math.min(n, 47.625)], [Math.max(w, -122.36), Math.max(s, 47.595)]]] },
      properties: { id: 'mock-zone-1', hazard, kind: 'tsunami_inundation', level: 'high', name: 'Waterfront zone (mock)' },
    }],
  }),

  safeAreas: (lat: number, lng: number, hazard: string) => delay<SafeAreas>({
    hazard, hazardLabel: FALLBACK_HAZARDS.find((h) => h.key === hazard)?.label ?? hazard,
    advice: 'Go on foot to high ground away from the water. (mock)',
    location: { inRegion: true, score: 62, level: 'high' },
    areas: [
      { cellId: 1, lat: lat + 0.006, lng: lng + 0.009, distanceM: Math.round(distanceM(lat, lng, lat + 0.006, lng + 0.009)), score: 4, level: 'low', reason: 'High ground outside the mapped zones (mock)' },
      { cellId: 2, lat: lat + 0.011, lng: lng + 0.004, distanceM: Math.round(distanceM(lat, lng, lat + 0.011, lng + 0.004)), score: 6, level: 'low', reason: 'Gentle slope, ground about 60 m above sea level (mock)' },
    ],
    places: [],
    note: 'Distances are straight-line, not routes. (mock)',
    disclaimer: 'Mock data.',
  }),
};

