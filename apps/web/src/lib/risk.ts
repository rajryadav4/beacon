// The risk model in the browser: grid lookups, levels, area ranking and route scoring.
// Ported from the class app (CrimeRadar/.../assets/js/risk.js). The numbers come from the ML model
// output (grid risk) and the incident counts (grid counts), served by /api/grid and /api/neighborhoods.

import { densify, haversine, type Pt } from './geo';
import type { Band, BandSel } from './clock';

export type Level = 'low' | 'elevated' | 'high';
export type Mode = 'walk' | 'bike' | 'car';
export const MODES: Mode[] = ['walk', 'bike', 'car'];

export interface MapMeta {
  dataRange: { from: string | null; to: string | null; years?: number };
  totals: { incidents?: number };
  grid: { lat0: number; lng0: number; dLat: number; dLng: number; rows: number; cols: number };
  bands: { id: number; key: string; label: string; hours: string }[];
  groups: { id: number; key: string; label: string; severity: number }[];
  modes: Record<string, { label: string; vulnerability: number }>;
  risk: { quantiles: Record<string, number> | null; levels: { elevated: number; high: number } | null };
  model: {
    version: string;
    metrics?: { hotspotCapture10?: number; spearman?: number } | null;
    baseline?: { hotspotCapture10?: number; spearman?: number } | null;
  } | null;
  source?: { url?: string } | null;
}
export interface Hood {
  key: string; name: string; precinct: string | null; lat: number; lng: number;
  cells: number; areaKm2: number; counts: number[]; unlocated: number;
}
export interface GridFile { cells: [number, number, number[], number[]][] }
export interface HoodsFile { neighborhoods: Hood[] }

export interface Cell { id: number; nb: number; c: number[]; r: number[]; lat: number; lng: number }

export const STREET_GROUPS = [0, 1, 2, 6]; // assault, robbery, theft, drugs/weapons/disorder
export const ALL_GROUPS = [0, 1, 2, 3, 4, 5, 6, 7];
/** Crime types that matter for each travel mode (counts and the "Why?" breakdown). */
export const MODE_GROUPS: Record<Mode, number[]> = { walk: STREET_GROUPS, bike: STREET_GROUPS, car: [0, 1, 3] };

export interface TopGroup { g: number; n: number; label: string; share: number }
export interface RankRow {
  i: number; hood: Hood; count: number; perYear: number; density: number;
  top: TopGroup | undefined; index: number; level: Level;
}
export interface RouteScore {
  intensity: number;
  adjusted: number;
  level: Level;
  score: number;
  incidentsPerYear: number;
  topGroups: TopGroup[];
  hotspots: { lat: number; lng: number; nb: number; risk: number }[];
  riskiestHood: string | null;
  byBand: { band: Band; adjusted: number; level: Level; score: number }[];
  safestBand: { band: Band; adjusted: number; level: Level; score: number };
  inCar: Level;
  onFoot: Level;
}

export class RiskModel {
  readonly meta: MapMeta;
  readonly g: MapMeta['grid'];
  readonly years: number;
  readonly groups: MapMeta['groups'];
  readonly bands: MapMeta['bands'];
  readonly modes: MapMeta['modes'];
  readonly levels: { elevated: number; high: number };
  readonly hoods: Hood[];
  readonly cells = new Map<number, Cell>();
  private readonly logMax: number;

  constructor(meta: MapMeta, grid: GridFile, hoods: HoodsFile) {
    this.meta = meta;
    this.g = meta.grid;
    const years = meta.dataRange.years ?? yearsBetween(meta.dataRange.from, meta.dataRange.to);
    this.years = Math.max(0.25, years || 4);
    this.groups = meta.groups;
    this.bands = meta.bands;
    this.modes = meta.modes;
    this.levels = meta.risk.levels ?? { elevated: 7.16, high: 23.76 };
    this.hoods = hoods.neighborhoods ?? [];
    let maxRisk = 0;
    for (const [id, nb, counts, risk] of grid.cells) {
      const { lat, lng } = this.center(id);
      this.cells.set(id, { id, nb, c: counts, r: risk, lat, lng });
      for (const v of risk) if (v > maxRisk) maxRisk = v;
    }
    this.logMax = Math.log1p(Math.max(maxRisk, meta.risk.quantiles?.q99 ?? 1));
  }

  // ---- grid ----
  cellId(lat: number, lng: number): number {
    const row = Math.floor((lat - this.g.lat0) / this.g.dLat);
    const col = Math.floor((lng - this.g.lng0) / this.g.dLng);
    if (row < 0 || row >= this.g.rows || col < 0 || col >= this.g.cols) return -1;
    return row * 100 + col;
  }
  center(id: number) {
    const row = Math.floor(id / 100);
    const col = id % 100;
    return { lat: this.g.lat0 + (row + 0.5) * this.g.dLat, lng: this.g.lng0 + (col + 0.5) * this.g.dLng };
  }
  /** [[south, west], [north, east]] */
  bounds(id: number): [Pt, Pt] {
    const row = Math.floor(id / 100);
    const col = id % 100;
    const s = this.g.lat0 + row * this.g.dLat;
    const w = this.g.lng0 + col * this.g.dLng;
    return [[s, w], [s + this.g.dLat, w + this.g.dLng]];
  }
  cellAt(lat: number, lng: number): Cell | null {
    return this.cells.get(this.cellId(lat, lng)) ?? null;
  }
  hoodName(nb: number): string | null {
    return nb >= 0 && this.hoods[nb] ? this.hoods[nb].name : null;
  }
  /** Name of the area around a point (the cell's area, or the nearest area center). */
  areaName(lat: number, lng: number): string | null {
    const cell = this.cellAt(lat, lng);
    if (cell && cell.nb >= 0) return this.hoodName(cell.nb);
    let best: Hood | null = null;
    let bestD = Infinity;
    for (const h of this.hoods) {
      const d = (h.lat - lat) ** 2 + ((h.lng - lng) * 0.67) ** 2;
      if (d < bestD) { bestD = d; best = h; }
    }
    return best && bestD < 0.0004 ? best.name : null;
  }
  bandLabel(band: BandSel): string {
    return band === 'all' ? 'All day' : this.bands[band]?.label ?? '';
  }
  bandHours(band: BandSel): string {
    return band === 'all' ? '24 hours' : this.bands[band]?.hours ?? '';
  }

  // ---- levels ----
  riskAt(cell: Cell | null | undefined, band: BandSel): number {
    if (!cell) return 0;
    if (band === 'all') return (cell.r[0] + cell.r[1] + cell.r[2] + cell.r[3]) / 4;
    return cell.r[band];
  }
  level(value: number): Level {
    if (value >= this.levels.high) return 'high';
    if (value >= this.levels.elevated) return 'elevated';
    return 'low';
  }
  /** 0-100 score on a log scale: 100 = the riskiest block-time in Seattle. */
  score(value: number): number {
    if (!(value > 0)) return 0;
    return Math.min(100, (100 * Math.log1p(value)) / this.logMax);
  }
  vulnerability(mode: Mode): number {
    return this.modes[mode]?.vulnerability ?? 1;
  }

  // ---- counts ----
  bandList(band: BandSel): Band[] {
    return band === 'all' ? [0, 1, 2, 3] : [band];
  }
  countCell(cell: Cell, band: BandSel, groups: number[]): number {
    let n = 0;
    for (const b of this.bandList(band)) for (const g of groups) n += cell.c[b * 8 + g];
    return n;
  }
  topGroups(counts: number[], band: BandSel, groups: number[], k = 3): TopGroup[] {
    const totals = groups.map((g) => {
      let n = 0;
      for (const b of this.bandList(band)) n += counts[b * 8 + g];
      return { g, n };
    }).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
    const sum = totals.reduce((s, x) => s + x.n, 0) || 1;
    return totals.slice(0, k).map((x) => ({ ...x, label: this.groups[x.g].label, share: x.n / sum }));
  }

  /** Neighborhoods ranked by severity-weighted incidents per year per km². */
  rankHoods(band: BandSel, groups: number[]): RankRow[] {
    const rows = this.hoods.map((h, i) => {
      let weighted = 0;
      let count = 0;
      for (const b of this.bandList(band)) {
        for (const g of groups) {
          const n = h.counts[b * 8 + g];
          weighted += n * this.groups[g].severity;
          count += n;
        }
      }
      const area = Math.max(h.areaKm2 || 0, 0.5);
      return {
        i, hood: h, count, perYear: count / this.years,
        density: weighted / this.years / area,
        top: this.topGroups(h.counts, band, groups, 1)[0],
        index: 0, level: 'low' as Level,
      };
    }).filter((r) => r.count > 0);
    rows.sort((a, b) => b.density - a.density);
    const max = rows.length ? rows[0].density : 1;
    const n = rows.length;
    rows.forEach((r, idx) => {
      r.index = Math.round((r.density / max) * 100);
      r.level = idx < Math.ceil(n * 0.15) ? 'high' : idx < Math.ceil(n * 0.4) ? 'elevated' : 'low';
    });
    return rows;
  }

  // ---- routes ----
  /**
   * Total crime exposure of a route: the sum over 25 m steps of (step km x model risk of the step's block,
   * in the time band when the traveller reaches it). Below 50% on the grid the exposure is unknown (null).
   */
  routeExposure(coords: Pt[], durationSec: number, hour: number, minute: number): { exposure: number | null; matched: number } {
    let total = 0;
    for (let i = 1; i < coords.length; i++) total += haversine(coords[i - 1], coords[i]);
    if (!(total > 0) || !(durationSec > 0)) return { exposure: null, matched: 0 };
    const startSec = hour * 3600 + minute * 60;
    let exposure = 0;
    let matchedM = 0;
    let travelled = 0;
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1];
      const b = coords[i];
      const seg = haversine(a, b);
      if (seg <= 0) continue;
      const steps = Math.max(1, Math.ceil(seg / 25));
      const step = seg / steps;
      for (let s = 0; s < steps; s++) {
        const f = (s + 0.5) / steps;
        const id = this.cellId(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f);
        if (id < 0) continue;
        const atSec = startSec + Math.round((durationSec * (travelled + seg * f)) / total);
        const band = Math.floor((Math.floor(atSec / 3600) % 24) / 6);
        const cell = this.cells.get(id);
        exposure += (step / 1000) * (cell ? cell.r[band] : 0);
        matchedM += step;
      }
      travelled += seg;
    }
    const matched = Math.min(1, matchedM / total);
    return { exposure: matched >= 0.5 ? exposure : null, matched };
  }

  scoreRoute(coords: Pt[], mode: Mode, band: Band): RouteScore {
    const pts = densify(coords, 25);
    const vul = this.vulnerability(mode);
    const perBand = [0, 0, 0, 0];
    let sum = 0;
    const seen = new Map<number, Cell>();
    const hoodRisk = new Map<number, number>();
    const hot = new Map<number, { lat: number; lng: number; nb: number; risk: number }>();
    for (const p of pts) {
      const id = this.cellId(p[0], p[1]);
      const cell = this.cells.get(id);
      const v = this.riskAt(cell, band);
      sum += v;
      if (cell) {
        for (let b = 0; b < 4; b++) perBand[b] += cell.r[b];
        if (!seen.has(id)) seen.set(id, cell);
        if (cell.nb >= 0) hoodRisk.set(cell.nb, (hoodRisk.get(cell.nb) ?? 0) + v);
        if (this.level(v * vul) === 'high' && !hot.has(id)) hot.set(id, { lat: p[0], lng: p[1], nb: cell.nb, risk: v });
      }
    }
    const n = Math.max(1, pts.length);
    const intensity = sum / n;
    const adjusted = intensity * vul;

    const counts = new Array<number>(32).fill(0);
    for (const cell of seen.values()) for (let k = 0; k < 32; k++) counts[k] += cell.c[k];
    const relevant = MODE_GROUPS[mode] ?? STREET_GROUPS;
    let incidents = 0;
    for (const b of this.bandList(band)) for (const g of relevant) incidents += counts[b * 8 + g];

    let riskiest: number | null = null;
    let riskiestV = 0;
    for (const [nb, v] of hoodRisk) if (v > riskiestV) { riskiestV = v; riskiest = nb; }

    const byBand = perBand.map((v, b) => {
      const adj = (v / n) * vul;
      return { band: b as Band, adjusted: adj, level: this.level(adj), score: this.score(adj) };
    });
    const safestBand = byBand.reduce((a, b) => (b.adjusted < a.adjusted ? b : a));

    return {
      intensity,
      adjusted,
      level: this.level(adjusted),
      score: Math.round(this.score(adjusted)),
      incidentsPerYear: incidents / this.years,
      topGroups: this.topGroups(counts, band, relevant, 3),
      hotspots: [...hot.values()],
      riskiestHood: riskiest != null ? this.hoodName(riskiest) : null,
      byBand,
      safestBand,
      inCar: this.level(intensity * this.vulnerability('car')),
      onFoot: this.level(intensity * this.vulnerability('walk')),
    };
  }
}

function yearsBetween(from: string | null, to: string | null): number {
  if (!from || !to) return 4;
  const days = (new Date(to).getTime() - new Date(from).getTime()) / 86400000;
  return Number.isFinite(days) ? days / 365.25 : 4;
}
