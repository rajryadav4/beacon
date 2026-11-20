// Typed client for the Beacon API (apps/api). In dev, Vite proxies /api to uvicorn.

import type { FeatureCollection, Geometry, Point, Polygon } from 'geojson';
import { MOCK, mockApi } from './lib/mock';

export type BandKey = 'night' | 'morning' | 'afternoon' | 'evening';
export type RiskLevel = 'low' | 'elevated' | 'high';

export interface Band { id: number; key: BandKey; label: string; hours: string }
export interface CrimeGroup { id: number; key: string; label: string; severity: number }

export interface Meta {
  generatedAt: string | null;
  source: { name: string; id: string; url: string; importedAt: string | null } | null;
  dataRange: { from: string | null; to: string | null };
  totals: { incidents?: number; located?: number; excluded?: number; unknownTime?: number };
  bands: Band[];
  groups: CrimeGroup[];
  risk: { unit: string; quantiles: Record<string, number> | null; levels: { elevated: number; high: number } | null };
  model: {
    version: string;
    algorithm: string;
    trainedOn: string | null;
    metrics: { hotspotCapture10: number; spearman: number; poissonDeviance: number } | null;
  } | null;
}

export type HeatmapData = FeatureCollection<Point, { cellId: number; count: number; weight: number }>;
export type RiskData = FeatureCollection<Polygon, {
  cellId: number; risk: number; level: RiskLevel; neighborhood: string | null;
}> & { model: string | null; band: number };

// ---- Hazards, safe places and alerts (Beacon) ----

export interface Hazard { key: string; label: string; placeKinds: string[] }

export interface SafePlaceProps {
  id: string; name: string; kind: string; kindLabel: string;
  address: string | null; phone: string | null; openingHours: string | null; source: string | null;
}
export type SafePlacesData = FeatureCollection<Point, SafePlaceProps>;
export interface NearestPlace extends SafePlaceProps { lat: number; lng: number; distanceM: number }
export interface NearestPlaces { hazard: string; places: NearestPlace[] }

export interface Alert {
  id: string; source: string; event: string; hazard: string; hazardLabel: string;
  severity: string; urgency: string | null; certainty: string | null;
  headline: string | null; description: string | null; instruction: string | null;
  areaDesc: string | null; sender: string | null;
  effective: string | null; expires: string | null; url: string | null;
  magnitude: number | null; distanceKm: number | null;
  /** Set only on locally simulated alerts (never from the API). */
  demo?: boolean;
}
export interface Incident { id: string; type: string; hazard: string; time: string | null; distanceKm: number | null }
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

/** Per-source freshness. The shape is normalised by `sourceFreshness()` in AlertsPanel. */
export type AlertsStatus = Record<string, unknown>;

export interface HazardClassification {
  hazard: string; hazardLabel: string; confidence: number; severity: string | null;
  scores: Record<string, number>; model: string;
}

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
    return e.status === null ? `Can't reach the Beacon server for ${what}.` : `${what[0].toUpperCase()}${what.slice(1)} service is not available yet.`;
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

/** Round coordinates before sending them: alerts only need ~100 m, nearest places ~10 m. */
const round = (v: number, digits: number) => v.toFixed(digits);

export const api = {
  meta: (signal?: AbortSignal) => getJson<Meta>('/api/meta', signal),
  heatmap: (band: BandKey | 'all', groups: string[], signal?: AbortSignal) => {
    const params = new URLSearchParams({ band });
    if (groups.length) params.set('groups', groups.join(','));
    return getJson<HeatmapData>(`/api/heatmap?${params}`, signal);
  },
  risk: (band: BandKey, signal?: AbortSignal) => getJson<RiskData>(`/api/risk?band=${band}`, signal),

  hazards: (signal?: AbortSignal) => MOCK ? mockApi.hazards()
    : getJson<{ hazards: Hazard[] }>('/api/hazards', signal),
  safePlaces: (bbox: BBox, kinds: string[], signal?: AbortSignal) => {
    if (MOCK) return mockApi.safePlaces(bbox, kinds);
    const params = new URLSearchParams({ bbox: bbox.map((v) => v.toFixed(5)).join(',') });
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
    : getJson<AlertAreas>(`/api/alerts?bbox=${bbox.map((v) => v.toFixed(4)).join(',')}`, signal),
  alertsStatus: (signal?: AbortSignal) => MOCK ? mockApi.alertsStatus()
    : getJson<AlertsStatus>('/api/alerts/status', signal),
  classifyHazard: (text: string, signal?: AbortSignal) => request<HazardClassification>('/api/hazard/classify', {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  }),
};
