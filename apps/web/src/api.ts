// Typed client for the Beacon API (apps/api). In dev, Vite proxies /api to uvicorn.

import type { FeatureCollection, Geometry, Point, Polygon } from 'geojson';
import { MOCK, mockApi } from './lib/mock';
import type { GridFile, HoodsFile, MapMeta } from './lib/risk';

// ---- Hazards, safe places and alerts (Beacon) ----

export interface Hazard { key: string; label: string; placeKinds: string[] }

export interface SafePlaceProps {
  id: string | number; name: string; kind: string; kindLabel: string;
  address: string | null; phone: string | null; openingHours: string | null; source: string | null;
}
export type SafePlacesData = FeatureCollection<Point, SafePlaceProps>;
export interface NearestPlace extends SafePlaceProps { lat: number; lng: number; distanceM: number }
export interface NearestPlaces { hazard: string; places: NearestPlace[] }

export interface Alert {
  id: string | number; source: string; event: string; hazard: string; hazardLabel: string;
  severity: string; urgency: string | null; certainty: string | null;
  headline: string | null; description: string | null; instruction: string | null;
  areaDesc: string | null; sender: string | null;
  effective: string | null; expires: string | null; url: string | null;
  magnitude: number | null; distanceKm: number | null;
  /** Set only on locally simulated alerts (never from the API). */
  demo?: boolean;
}
export interface Incident { id: string | number; type: string; hazard: string; time: string | null; distanceKm: number | null }
export interface ActiveAlerts {
  location: { lat: number; lng: number } | null;
  alerts: Alert[];
  incidents: Incident[];
  survival: boolean;
  topHazard: string | null;
  updatedAt: string | null;
}
export type AlertAreas = FeatureCollection<Geometry, {
  id: string; event: string; hazard: string; severity: string; headline: string | null; expires: string | null;
}>;

/** Per-source freshness. The shape is normalised by `sourceFreshness()` in the alerts view. */
export type AlertsStatus = Record<string, unknown>;

// ---- Hazard outlook (apps/api/app/routers/outlook.py) ----

export interface OutlookItem {
  id: string | number; hazard: string; hazardLabel: string; level: string; title: string; summary: string | null;
  validFrom: string | null; validTo: string | null; confidence: string | null;
  sources: { name: string | null; url: string | null; observed: string | null }[]; distanceKm: number;
}
export interface Outlook {
  location: { inRegion: boolean; exposure: { hazard: string; hazardLabel: string; score: number; level: string }[] };
  outlook: OutlookItem[];
  updatedAt: string | null;
  disclaimer: string;
}
export type HazardGrid = FeatureCollection<Polygon, { cellId: number; score: number; level: string }> & { note?: string };
export type HazardZones = FeatureCollection<Geometry, { id: string | number; hazard: string; kind: string; level: string; name: string | null }>;
export interface SafeArea { cellId: number; lat: number; lng: number; distanceM: number; score: number; level: string; reason: string }
export interface SafeAreaPlace extends NearestPlace { reason: string }
export interface SafeAreas {
  hazard: string; hazardLabel: string; advice: string | null;
  location: { inRegion: boolean; score: number | null; level: string | null };
  areas: SafeArea[]; places: SafeAreaPlace[]; note: string; disclaimer: string;
}
/** Hazards with an exposure grid (worst-to-safest layer). */
export const SCORED_HAZARDS = ['tsunami', 'flood', 'earthquake', 'volcano'];

/** Bounding box [west, south, east, north]. */
export type BBox = [number, number, number, number];

export class ApiError extends Error {
  constructor(message: string, readonly status: number | null) { super(message); }
  /** True when the endpoint does not exist yet or the API cannot be reached. */
  get unavailable() { return this.status === null || this.status === 404 || this.status === 501 || this.status >= 502; }
}

/** A short user-facing message for a failed request. */
export function errorMessage(e: unknown, what: string): string {
  if (e instanceof ApiError && e.unavailable) {
    return e.status === null ? `Can't reach the Beacon server for ${what}.` : `${what[0].toUpperCase()}${what.slice(1)} service is not available right now.`;
  }
  return `Could not load ${what}${e instanceof Error && e.message ? ` (${e.message})` : ''}.`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (e) {
    if (init.signal?.aborted) throw e;
    throw new ApiError('network error', null);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new ApiError(`${response.status} ${response.statusText} ${detail.slice(0, 200)}`.trim(), response.status);
  }
  return response.json() as Promise<T>;
}

const getJson = <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal });

let paths: Promise<Set<string> | null> | null = null;
/**
 * Does the API have this endpoint? Read once from FastAPI's /openapi.json, so optional features
 * (the hazard outlook, built separately) are hidden instead of calling a missing endpoint.
 * If the list cannot be read, assume yes and let the request fail gracefully.
 */
export async function supports(path: string): Promise<boolean> {
  if (MOCK) return true;
  paths ??= fetch('/openapi.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { paths?: Record<string, unknown> } | null) => (j?.paths ? new Set(Object.keys(j.paths)) : null))
    .catch(() => null);
  const known = await paths;
  return known === null || known.has(path);
}

/** GET an optional endpoint: a 404 without a request when the API does not have it. */
async function optional<T>(path: string, query: string, signal?: AbortSignal): Promise<T> {
  if (!(await supports(path))) throw new ApiError('not available', 404);
  return getJson<T>(`${path}?${query}`, signal);
}

/** Round coordinates before sending them: alerts only need ~100 m, nearest places ~10 m. */
const round = (v: number, digits: number) => v.toFixed(digits);
const bboxParam = (bbox: BBox, digits = 4) => bbox.map((v) => v.toFixed(digits)).join(',');

export interface MapData { meta: MapMeta; grid: GridFile; hoods: HoodsFile; live: boolean }
export interface Landmark { name: string; category?: string; lat: number; lng: number }

export const api = {
  /**
   * Crime map data in the class-app shape. The three parts must come from ONE source (the grid's nbIndex
   * points into the neighborhoods list), so if any API call fails, all three come from the bundled copies.
   */
  async mapData(signal?: AbortSignal): Promise<MapData> {
    try {
      const [meta, grid, hoods] = await Promise.all([
        getJson<MapMeta>('/api/meta', signal), getJson<GridFile>('/api/grid', signal), getJson<HoodsFile>('/api/neighborhoods', signal),
      ]);
      if (!grid.cells?.length || !meta.risk?.levels) throw new Error('empty map data');
      return { meta, grid, hoods, live: true };
    } catch (e) {
      if (signal?.aborted) throw e;
      const [meta, grid, hoods] = await Promise.all([
        getJson<MapMeta>('/data/meta.json', signal), getJson<GridFile>('/data/grid.json', signal), getJson<HoodsFile>('/data/neighborhoods.json', signal),
      ]);
      return { meta, grid, hoods, live: false };
    }
  },
  landmarks: (signal?: AbortSignal) => getJson<{ places: Landmark[] }>('/data/places.json', signal)
    .then((d) => d.places ?? []).catch(() => [] as Landmark[]),

  hazards: (signal?: AbortSignal) => MOCK ? mockApi.hazards()
    : getJson<{ hazards: Hazard[] }>('/api/hazards', signal),
  safePlaces: (bbox: BBox, kinds: string[], signal?: AbortSignal) => {
    if (MOCK) return mockApi.safePlaces(bbox, kinds);
    const params = new URLSearchParams({ bbox: bboxParam(bbox, 5) });
    if (kinds.length) params.set('kinds', kinds.join(','));
    return getJson<SafePlacesData>(`/api/safe-places?${params}`, signal);
  },
  nearestSafePlaces: (lat: number, lng: number, hazard: string, limit = 5, signal?: AbortSignal) => {
    if (MOCK) return mockApi.nearest(lat, lng, hazard, limit);
    const params = new URLSearchParams({ lat: round(lat, 4), lng: round(lng, 4), hazard, limit: String(limit) });
    return getJson<NearestPlaces>(`/api/safe-places/nearest?${params}`, signal);
  },
  activeAlerts: (lat: number, lng: number, signal?: AbortSignal) => {
    if (MOCK) return mockApi.activeAlerts(lat, lng);
    const params = new URLSearchParams({ lat: round(lat, 3), lng: round(lng, 3) });
    return getJson<ActiveAlerts>(`/api/alerts/active?${params}`, signal);
  },
  alertAreas: (bbox: BBox, signal?: AbortSignal) => MOCK ? mockApi.alertAreas(bbox)
    : getJson<AlertAreas>(`/api/alerts?bbox=${bboxParam(bbox)}`, signal),
  alertsStatus: (signal?: AbortSignal) => MOCK ? mockApi.alertsStatus()
    : getJson<AlertsStatus>('/api/alerts/status', signal),

  outlook: (lat: number, lng: number, signal?: AbortSignal) => MOCK ? mockApi.outlook()
    : optional<Outlook>('/api/outlook', `lat=${round(lat, 3)}&lng=${round(lng, 3)}`, signal),
  hazardGrid: (hazard: string, signal?: AbortSignal) => MOCK ? mockApi.hazardGrid(hazard)
    : optional<HazardGrid>('/api/hazard-grid', `hazard=${encodeURIComponent(hazard)}`, signal),
  hazardZones: (hazard: string, bbox: BBox, signal?: AbortSignal) => MOCK ? mockApi.hazardZones(hazard, bbox)
    : optional<HazardZones>('/api/hazard-zones', `hazard=${encodeURIComponent(hazard)}&bbox=${bboxParam(bbox)}`, signal),
  safeAreas: (lat: number, lng: number, hazard: string, signal?: AbortSignal) => MOCK ? mockApi.safeAreas(lat, lng, hazard)
    : optional<SafeAreas>('/api/safe-areas', `lat=${round(lat, 4)}&lng=${round(lng, 4)}&hazard=${encodeURIComponent(hazard)}`, signal),
};
