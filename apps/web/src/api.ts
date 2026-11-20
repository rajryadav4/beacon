// Typed client for the CrimeRadar API (apps/api). In dev, Vite proxies /api to uvicorn.

import type { FeatureCollection, Point, Polygon } from 'geojson';

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

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`${response.status} ${response.statusText} ${detail}`.trim());
  }
  return response.json() as Promise<T>;
}

export const api = {
  meta: (signal?: AbortSignal) => getJson<Meta>('/api/meta', signal),
  heatmap: (band: BandKey | 'all', groups: string[], signal?: AbortSignal) => {
    const params = new URLSearchParams({ band });
    if (groups.length) params.set('groups', groups.join(','));
    return getJson<HeatmapData>(`/api/heatmap?${params}`, signal);
  },
  risk: (band: BandKey, signal?: AbortSignal) => getJson<RiskData>(`/api/risk?band=${band}`, signal),
};
