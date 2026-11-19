// The risk model in the browser: grid lookups, levels, area ranking and route scoring.
// The numbers come from the ML model output (grid.json risk) and the incident counts (grid.json counts).

import { densify } from './geo.js';

export const STREET_GROUPS = [0, 1, 2, 6]; // assault, robbery, theft, drugs/weapons/disorder: what a person on the street meets
/** Crime types that matter for each travel mode (used for the counts and the "Why?" breakdown). */
export const MODE_GROUPS = {
  walk: STREET_GROUPS,
  bike: STREET_GROUPS,
  car: [0, 1, 3], // assault, robbery (carjacking), vehicle crime
};

export class RiskModel {
  constructor(meta, grid, hoods) {
    this.meta = meta;
    this.g = meta.grid;
    this.years = Math.max(0.25, (meta.dataRange && meta.dataRange.years) || 4);
    this.groups = meta.groups;
    this.bands = meta.bands;
    this.modes = meta.modes;
    this.levels = meta.risk.levels;
    this.q = meta.risk.quantiles;
    this.hoods = hoods.neighborhoods || [];
    this.cells = new Map();
    let maxRisk = 0;
    for (const [id, nb, counts, risk] of grid.cells) {
      const { lat, lng } = this.center(id);
      this.cells.set(id, { id, nb, c: counts, r: risk, lat, lng });
      for (const v of risk) if (v > maxRisk) maxRisk = v;
    }
    this.logMax = Math.log1p(Math.max(maxRisk, this.q.q99 || 1));
  }

  // ---- grid ----
  cellId(lat, lng) {
    const row = Math.floor((lat - this.g.lat0) / this.g.dLat);
    const col = Math.floor((lng - this.g.lng0) / this.g.dLng);
    if (row < 0 || row >= this.g.rows || col < 0 || col >= this.g.cols) return -1;
    return row * 100 + col;
  }
  center(id) {
    const row = Math.floor(id / 100);
    const col = id % 100;
    return { lat: this.g.lat0 + (row + 0.5) * this.g.dLat, lng: this.g.lng0 + (col + 0.5) * this.g.dLng };
  }
  bounds(id) {
    const row = Math.floor(id / 100);
    const col = id % 100;
    const s = this.g.lat0 + row * this.g.dLat;
    const w = this.g.lng0 + col * this.g.dLng;
    return [[s, w], [s + this.g.dLat, w + this.g.dLng]];
  }
  cellAt(lat, lng) {
    return this.cells.get(this.cellId(lat, lng)) || null;
  }
  hoodName(nb) {
    return nb >= 0 && this.hoods[nb] ? this.hoods[nb].name : null;
  }
  /** Name of the area around a point (the cell's area, or the nearest cell with data). */
  areaName(lat, lng) {
    const cell = this.cellAt(lat, lng);
    if (cell && cell.nb >= 0) return this.hoodName(cell.nb);
    let best = null;
    let bestD = Infinity;
    for (const h of this.hoods) {
      const d = (h.lat - lat) ** 2 + ((h.lng - lng) * 0.67) ** 2;
      if (d < bestD) { bestD = d; best = h; }
    }
    return best && bestD < 0.0004 ? best.name : null;
  }

  // ---- levels ----
  riskAt(cell, band) {
    if (!cell) return 0;
    if (band === 'all') return (cell.r[0] + cell.r[1] + cell.r[2] + cell.r[3]) / 4;
    return cell.r[band];
  }
  level(value) {
    if (value >= this.levels.high) return 'high';
    if (value >= this.levels.elevated) return 'elevated';
    return 'low';
  }
  /**
   * 0-100 score on a log scale: 100 = the riskiest block-time in Seattle.
   * (A quantile scale capped at q99 gave every downtown evening route 100, so routes looked equal.)
   */
  score(value) {
    if (!(value > 0)) return 0;
    return Math.min(100, (100 * Math.log1p(value)) / this.logMax);
  }
  vulnerability(mode) {
    return (this.modes[mode] && this.modes[mode].vulnerability) || 1;
  }

  // ---- counts ----
  bandList(band) {
    return band === 'all' ? [0, 1, 2, 3] : [band];
  }
  countCell(cell, band, groups) {
    let n = 0;
    for (const b of this.bandList(band)) for (const g of groups) n += cell.c[b * 8 + g];
    return n;
  }
  topGroups(counts, band, groups, k = 3) {
    const totals = groups.map((g) => {
      let n = 0;
      for (const b of this.bandList(band)) n += counts[b * 8 + g];
      return { g, n };
    }).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
    const sum = totals.reduce((s, x) => s + x.n, 0) || 1;
    return totals.slice(0, k).map((x) => ({ ...x, label: this.groups[x.g].label, share: x.n / sum }));
  }

  /** Neighborhoods ranked by severity-weighted incidents per year per km². */
  rankHoods(band, groups) {
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
  scoreRoute(coords, mode, band) {
    const pts = densify(coords, 25);
    const vul = this.vulnerability(mode);
    const perBand = [0, 0, 0, 0];
    let sum = 0;
    const seen = new Map();
    const hoodRisk = new Map();
    const hot = new Map();
    const segments = [];
    let run = null;
    for (const p of pts) {
      const id = this.cellId(p[0], p[1]);
      const cell = this.cells.get(id);
      const v = this.riskAt(cell, band);
      sum += v;
      if (cell) {
        for (let b = 0; b < 4; b++) perBand[b] += cell.r[b];
        if (!seen.has(id)) seen.set(id, cell);
        if (cell.nb >= 0) hoodRisk.set(cell.nb, (hoodRisk.get(cell.nb) || 0) + v);
      }
      const lvl = this.level(v * vul);
      if (lvl === 'high' && cell && !hot.has(id)) hot.set(id, { lat: p[0], lng: p[1], nb: cell.nb, risk: v });
      if (!run || run.level !== lvl) {
        if (run) run.coords.push(p);
        run = { level: lvl, coords: [p] };
        segments.push(run);
      } else {
        run.coords.push(p);
      }
    }
    const n = Math.max(1, pts.length);
    const intensity = sum / n;
    const adjusted = intensity * vul;

    const counts = new Array(32).fill(0);
    for (const cell of seen.values()) for (let k = 0; k < 32; k++) counts[k] += cell.c[k];
    const relevant = MODE_GROUPS[mode] || STREET_GROUPS;
    let incidents = 0;
    for (const b of this.bandList(band)) for (const g of relevant) incidents += counts[b * 8 + g];

    let riskiest = null;
    let riskiestV = 0;
    for (const [nb, v] of hoodRisk) if (v > riskiestV) { riskiestV = v; riskiest = nb; }

    const byBand = perBand.map((v, b) => {
      const adj = (v / n) * vul;
      return { band: b, adjusted: adj, level: this.level(adj), score: this.score(adj) };
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
      segments: segments.filter((s) => s.level !== 'low' && s.coords.length > 1),
      inCar: this.level(intensity * this.vulnerability('car')),
      onFoot: this.level(intensity * this.vulnerability('walk')),
    };
  }
}
