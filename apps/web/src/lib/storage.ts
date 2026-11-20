// Personal data kept in this browser only (localStorage), like the class app's offline mode.
// Beacon has no server accounts yet: places, preferences and trip history never leave the device.

import type { Mode } from './risk';
import type { Level } from './risk';

export interface Prefs { mode: Mode; safetyWeight: number; alerts: boolean }
export type SavedKind = 'home' | 'work' | 'saved';
export interface SavedPlace { id: string; kind: SavedKind; label: string; address: string; lat: number; lng: number }
export interface TripRecord {
  id: string; fromLabel: string; toLabel: string; toLat: number; toLng: number; mode: Mode;
  departAt: string; distanceMeters: number; durationSeconds: number; riskScore: number; riskLevel: Level;
  choice: 'safest' | 'fastest' | 'balanced' | 'safety'; createdAt: string;
}

const KEY = { prefs: 'beacon.prefs.v1', places: 'beacon.places.v1', trips: 'beacon.trips.v1' };
export const DEFAULT_PREFS: Prefs = { mode: 'walk', safetyWeight: 0.7, alerts: true };

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage blocked or full: the setting lasts for this visit only
  }
}

export function loadPrefs(): Prefs {
  const p = { ...DEFAULT_PREFS, ...readJson<Partial<Prefs>>(KEY.prefs, {}) };
  return {
    mode: (['walk', 'bike', 'car'] as const).includes(p.mode) ? p.mode : 'walk',
    safetyWeight: Number.isFinite(p.safetyWeight) ? Math.min(1, Math.max(0, p.safetyWeight)) : 0.7,
    alerts: p.alerts !== false,
  };
}
export const savePrefs = (p: Prefs) => writeJson(KEY.prefs, p);

export const loadPlaces = (): SavedPlace[] => readJson<SavedPlace[]>(KEY.places, []).filter((p) => p && Number.isFinite(p.lat));
export const savePlaces = (list: SavedPlace[]) => writeJson(KEY.places, list);

export const loadTrips = (): TripRecord[] => readJson<TripRecord[]>(KEY.trips, []);
export const saveTrips = (list: TripRecord[]) => writeJson(KEY.trips, list.slice(0, 20));

export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** A new home or work replaces the old one (as on the class server). */
export function upsertPlace(list: SavedPlace[], place: Omit<SavedPlace, 'id'>): SavedPlace[] {
  const rest = place.kind === 'saved' ? list : list.filter((p) => p.kind !== place.kind);
  return [...rest, { ...place, id: newId() }];
}
