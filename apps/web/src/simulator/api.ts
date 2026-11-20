// Client for POST /api/simulate (apps/api/app/routers/simulate.py).

import type { Feature, FeatureCollection, LineString, MultiPolygon, Polygon } from 'geojson';
import type { LatLng, Scenario } from './scenario';

export type Level = 'severe' | 'moderate';
export type UserStatus = 'inside_severe' | 'inside_moderate' | 'outside';
export type Action =
  | 'evacuate' | 'go_to_high_ground' | 'move_to_open_ground' | 'go_underground'
  | 'shelter_in_place' | 'go_indoors' | 'stay_away';

export interface Place {
  id: string | number; name: string; kind: string; kindLabel: string; lat: number; lng: number; distanceM: number;
  address: string | null; phone: string | null; openingHours: string | null; source: string | null;
}
export interface Area { kind: string; name: string; lat: number; lng: number; distanceM: number; elevationM?: number }
export interface Destination { type: 'place' | 'area'; place?: Place; area?: Area; reason: string }

export interface SimRoute {
  engine: 'valhalla' | 'osrm' | 'straight_line';
  geometry: LineString;
  distanceM: number;
  durationS: number;
  steps: { instruction: string; distanceM: number }[];
  avoidsDanger: boolean;
  dangerM: { severe: number; moderate: number };
  candidates: number;
}

export type ZoneGeometry = Polygon | MultiPolygon;

export interface SimResult {
  scenario: {
    hazard: string; hazardLabel: string; origin: LatLng; event: LatLng & { size: number; params: Record<string, unknown> };
    mode: 'walk' | 'drive'; simulated: true; label: string; model: string; sources: string[]; details: Record<string, unknown>;
  };
  disclaimer: string;
  affected: FeatureCollection<ZoneGeometry, { level: Level }>;
  growth: { tMinutes: number; geometry: ZoneGeometry }[];
  cells: { severe: number[]; moderate: number[] };
  userStatus: UserStatus;
  action: Action;
  actionLabel: string;
  headline: string;
  now: string;
  guidance: string[];
  destination: Destination | null;
  alternatives: Destination[];
  route: SimRoute | null;
  timeline: { tMinutes: number; label: string }[];
}

export const destPoint = (d: Destination) => (d.place ?? d.area)!;

export function zoneOf(result: SimResult, level: Level): Feature<ZoneGeometry> | undefined {
  return result.affected.features.find((f) => f.properties.level === level);
}

export async function runSimulation(s: Scenario, signal?: AbortSignal): Promise<SimResult> {
  if (!s.origin || !s.event) throw new Error('Place yourself and the event on the map first.');
  const params: Record<string, unknown> = {};
  if (['wildfire', 'hazmat', 'storm', 'air_quality', 'volcano'].includes(s.hazard)) {
    params.windDeg = s.windDeg;
    params.windKmh = s.windKmh;
  }
  if (s.hazard === 'tsunami') params.scenario = s.tsunami;
  if (s.hazard === 'flood') params.depthM = s.depthM;
  const res = await fetch('/api/simulate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hazard: s.hazard, origin: s.origin, mode: s.mode,
      event: { lat: s.event.lat, lng: s.event.lng, size: s.size, params },
    }),
    signal,
  });
  if (!res.ok) {
    let message = `The simulator returned ${res.status}.`;
    try {
      const body = await res.json() as { detail?: unknown };
      if (typeof body.detail === 'string') message = body.detail;
      else if (Array.isArray(body.detail)) message = 'Some scenario settings are out of range.';
    } catch { /* not JSON */ }
    throw new Error(message);
  }
  return res.json() as Promise<SimResult>;
}
