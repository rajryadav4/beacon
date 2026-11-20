// Beacon Simulator: hazards, presets and the shareable scenario URL.
// Everything a scenario needs lives in the URL hash, so a link replays it; nothing is stored server-side.

export type HazardKey =
  | 'earthquake' | 'tsunami' | 'flood' | 'storm' | 'winter' | 'wildfire' | 'heat'
  | 'air_quality' | 'hazmat' | 'volcano' | 'conflict' | 'crime' | 'other';

export type Mode = 'walk' | 'drive';
export type TsunamiScenario = 'cascadia' | 'seattle_fault';

export interface LatLng { lat: number; lng: number }

export interface Scenario {
  hazard: HazardKey;
  origin: LatLng | null;
  event: LatLng | null;
  size: number;
  windDeg: number;
  windKmh: number;
  tsunami: TsunamiScenario;
  depthM: number;
  mode: Mode;
}

export interface SizeSpec { label: string; min: number; max: number; step: number; def: number; unit: 'magnitude' | 'm' }

export interface HazardMeta {
  key: HazardKey;
  label: string;
  short: string;
  /** 24 x 24 stroke icon path. */
  icon: string;
  color: string;
  size: SizeSpec;
  wind: boolean;
}

const r = (label: string, min: number, max: number, step: number, def: number): SizeSpec => ({ label, min, max, step, def, unit: 'm' });

export const HAZARDS: HazardMeta[] = [
  { key: 'earthquake', label: 'Earthquake', short: 'Quake', color: '#f59e0b', wind: false,
    icon: 'M2 12h4l2-5 3 10 3-12 2 7h6', size: { label: 'Magnitude', min: 4, max: 9, step: 0.1, def: 6.8, unit: 'magnitude' } },
  { key: 'tsunami', label: 'Tsunami', short: 'Tsunami', color: '#38bdf8', wind: false,
    icon: 'M2 16c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M2 20c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M6 11c0-4 4-7 9-7-3 2-3 5 0 7',
    size: r('Wave reach', 2000, 30000, 500, 15000) },
  { key: 'flood', label: 'Flood', short: 'Flood', color: '#60a5fa', wind: false,
    icon: 'M4 11l8-6 8 6M6 10v4M18 10v4M2 19c2.5 0 2.5-1.5 5-1.5s2.5 1.5 5 1.5 2.5-1.5 5-1.5 2.5 1.5 5 1.5',
    size: r('Flood reach', 500, 8000, 250, 3000) },
  { key: 'wildfire', label: 'Wildfire', short: 'Fire', color: '#f97316', wind: true,
    icon: 'M12 22c4 0 7-3 7-7 0-4-3-6-4-9-1 2-2 3-3 3 0-2-1-4-3-6 0 4-4 6-4 12 0 4 3 7 7 7z',
    size: r('Starting fire size', 100, 2000, 50, 400) },
  { key: 'hazmat', label: 'Chemical leak', short: 'Hazmat', color: '#a3e635', wind: true,
    icon: 'M12 3l10 18H2zM12 10v5M12 18h.01', size: r('Isolation radius', 100, 1500, 50, 400) },
  { key: 'conflict', label: 'Air raid / attack', short: 'Air raid', color: '#ef4444', wind: false,
    icon: 'M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5zM12 8v4M12 15h.01', size: r('Target radius', 200, 3000, 50, 800) },
  { key: 'storm', label: 'Severe storm', short: 'Storm', color: '#a78bfa', wind: true,
    icon: 'M7 15a4 4 0 1 1 .8-7.9A5 5 0 0 1 17.5 8 3.5 3.5 0 0 1 17 15M12 13l-2 4h4l-2 4', size: r('Storm size', 300, 5000, 100, 1500) },
  { key: 'heat', label: 'Extreme heat', short: 'Heat', color: '#fb7185', wind: false,
    icon: 'M10 14V5a2 2 0 1 1 4 0v9a4 4 0 1 1-4 0zM12 9v6', size: r('Heat area', 2000, 15000, 500, 6000) },
  { key: 'winter', label: 'Winter storm', short: 'Winter', color: '#bae6fd', wind: false,
    icon: 'M12 2v20M4 7l16 10M4 17L20 7M9 3l3 2 3-2M9 21l3-2 3 2', size: r('Storm area', 2000, 15000, 500, 5000) },
  { key: 'air_quality', label: 'Smoke / air quality', short: 'Smoke', color: '#94a3b8', wind: true,
    icon: 'M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8', size: r('Smoke source size', 1000, 10000, 250, 4000) },
  { key: 'volcano', label: 'Volcano', short: 'Volcano', color: '#e11d48', wind: true,
    icon: 'M2 21l7-11h6l7 11zM10 7L9 4M14 7l1-3M12 6V2', size: r('Blast radius', 500, 8000, 250, 3000) },
  { key: 'crime', label: 'Police incident', short: 'Police', color: '#818cf8', wind: false,
    icon: 'M12 2l2.5 5 5.5.8-4 3.9 1 5.5-5-2.7-5 2.7 1-5.5-4-3.9 5.5-.8z', size: r('Cordon radius', 100, 1500, 50, 300) },
  { key: 'other', label: 'Other emergency', short: 'Other', color: '#fbbf24', wind: false,
    icon: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 7v6M12 16h.01', size: r('Incident radius', 200, 5000, 100, 1000) },
];

export const HAZARD_BY_KEY = Object.fromEntries(HAZARDS.map((h) => [h.key, h])) as Record<HazardKey, HazardMeta>;

export function defaultScenario(hazard: HazardKey = 'earthquake'): Scenario {
  return { hazard, origin: null, event: null, size: HAZARD_BY_KEY[hazard].size.def, windDeg: 225, windKmh: 20,
           tsunami: 'cascadia', depthM: 4, mode: 'walk' };
}

export interface Preset { id: string; title: string; blurb: string; scenario: Scenario }

const preset = (id: string, title: string, blurb: string, s: Partial<Scenario> & Pick<Scenario, 'hazard' | 'origin' | 'event'>): Preset =>
  ({ id, title, blurb, scenario: { ...defaultScenario(s.hazard), ...s } });

export const PRESETS: Preset[] = [
  preset('quake', 'M6.8 Seattle Fault earthquake', 'Strong shaking under SODO; you are downtown.', {
    hazard: 'earthquake', origin: { lat: 47.6062, lng: -122.3321 }, event: { lat: 47.588, lng: -122.345 }, size: 6.8 }),
  preset('tsunami', 'Tsunami after a Cascadia quake', 'Waves reach Elliott Bay; you are by the water in SODO.', {
    hazard: 'tsunami', origin: { lat: 47.5868, lng: -122.3400 }, event: { lat: 47.6050, lng: -122.3750 }, size: 15000, tsunami: 'cascadia' }),
  preset('fire', 'Wildfire at Discovery Park', 'A wind-driven fire and smoke; you are in Magnolia.', {
    hazard: 'wildfire', origin: { lat: 47.6500, lng: -122.3990 }, event: { lat: 47.6575, lng: -122.4150 }, size: 400, windDeg: 260, windKmh: 30 }),
  preset('hazmat', 'Chemical leak in SODO', 'A toxic plume drifts north-east toward the stadiums.', {
    hazard: 'hazmat', origin: { lat: 47.5925, lng: -122.3290 }, event: { lat: 47.5800, lng: -122.3350 }, size: 400, windDeg: 200, windKmh: 15 }),
  preset('raid', 'Air raid downtown', 'Sirens over Westlake; get underground fast.', {
    hazard: 'conflict', origin: { lat: 47.6080, lng: -122.3400 }, event: { lat: 47.6110, lng: -122.3375 }, size: 800 }),
  preset('flood', 'Duwamish River flood', 'The river rises 4 m; you are in Georgetown.', {
    hazard: 'flood', origin: { lat: 47.5450, lng: -122.3200 }, event: { lat: 47.5350, lng: -122.3150 }, size: 3000, depthM: 4 }),
];

// ---- Share URL ----

const fix = (n: number) => n.toFixed(5).replace(/\.?0+$/, '');
const pt = (p: LatLng) => `${fix(p.lat)},${fix(p.lng)}`;

export function encodeScenario(s: Scenario, play = false): string {
  const q = new URLSearchParams();
  q.set('h', s.hazard);
  if (s.origin) q.set('o', pt(s.origin));
  if (s.event) q.set('e', pt(s.event));
  q.set('s', String(s.size));
  q.set('m', s.mode);
  if (HAZARD_BY_KEY[s.hazard].wind) { q.set('wd', String(Math.round(s.windDeg))); q.set('wk', String(Math.round(s.windKmh))); }
  if (s.hazard === 'tsunami') q.set('sc', s.tsunami);
  if (s.hazard === 'flood') q.set('d', String(s.depthM));
  if (play) q.set('play', '1');
  return q.toString();
}

function parsePoint(v: string | null): LatLng | null {
  if (!v) return null;
  const [lat, lng] = v.split(',').map(Number);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Scenario from a URL hash (`#h=...`), or null when there is none or it is invalid. */
export function decodeScenario(hash: string): { scenario: Scenario; play: boolean } | null {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const hazard = q.get('h') as HazardKey | null;
  if (!hazard || !(hazard in HAZARD_BY_KEY)) return null;
  const s = defaultScenario(hazard);
  const spec = HAZARD_BY_KEY[hazard].size;
  s.origin = parsePoint(q.get('o'));
  s.event = parsePoint(q.get('e'));
  const size = Number(q.get('s'));
  if (Number.isFinite(size) && q.get('s')) s.size = clamp(size, spec.min, spec.max);
  if (q.get('m') === 'drive') s.mode = 'drive';
  const wd = Number(q.get('wd'));
  const wk = Number(q.get('wk'));
  if (q.get('wd') && Number.isFinite(wd)) s.windDeg = ((wd % 360) + 360) % 360;
  if (q.get('wk') && Number.isFinite(wk)) s.windKmh = clamp(wk, 0, 120);
  if (q.get('sc') === 'seattle_fault') s.tsunami = 'seattle_fault';
  const d = Number(q.get('d'));
  if (q.get('d') && Number.isFinite(d)) s.depthM = clamp(d, 1, 10);
  return { scenario: s, play: q.get('play') === '1' };
}

export const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compass = (deg: number) => COMPASS[Math.round(deg / 45) % 8];

export function formatSize(s: Scenario): string {
  const spec = HAZARD_BY_KEY[s.hazard].size;
  if (spec.unit === 'magnitude') return `M${s.size.toFixed(1)}`;
  return s.size >= 1000 ? `${(s.size / 1000).toFixed(s.size % 1000 ? 1 : 0)} km` : `${s.size} m`;
}
