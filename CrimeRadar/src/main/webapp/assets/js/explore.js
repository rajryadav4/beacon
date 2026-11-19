// Explore view: time-of-day and crime-type filters, heatmap / risk grid, stat tiles and the area ranking.

import { $, h, fmt, levelBadge, ring, seattleClock, bandOfHour, clockLabel } from './ui.js';
import { svg, iconEl, BAND_ICON } from './icons.js';
import { HEAT_LIGHT, HEAT_DARK, LEVEL_COLOR } from './mapview.js';
import { STREET_GROUPS } from './risk.js';

const STATE_KEY = 'crimeradar.explore.v1';
const BAND_ORDER = ['all', 1, 2, 3, 0];
const SHORT_HOURS = { all: '24 h', 0: '12–6 AM', 1: '6 AM–12', 2: '12–6 PM', 3: '6 PM–12' };

export class Explore {
  constructor({ model, mapView, onWhereTo }) {
    this.model = model;
    this.map = mapView;
    this.onWhereTo = onWhereTo;
    this.showAll = false;
    const saved = this.readState();
    this.state = {
      band: saved && saved.band != null ? saved.band : bandOfHour(seattleClock().hour),
      groups: new Set(saved && Array.isArray(saved.groups) && saved.groups.length ? saved.groups : [0, 1, 2, 3, 4, 5, 6]),
      layer: saved && saved.layer === 'grid' ? 'grid' : 'heat',
    };
    this.weightsCache = new Map();
  }

  readState() {
    try { return JSON.parse(localStorage.getItem(STATE_KEY)); } catch { return null; }
  }
  saveState() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({ band: this.state.band, groups: [...this.state.groups], layer: this.state.layer }));
    } catch { /* not important */ }
  }

  mount() {
    const view = $('#view-explore');
    // "Where to?" entry, like the search bar on the whiteboard sketch
    const where = h('button', { class: 'search-btn', type: 'button', onclick: () => this.onWhereTo() });
    where.insertAdjacentHTML('afterbegin', svg('search', 'icon'));
    where.append(h('span', null, 'Where to? Find a safer route'));
    view.prepend(h('div', { class: 'section' }, where));

    // time of day: each band has its own sky color when selected (see .seg-bands in app.css)
    const seg = $('#band-seg');
    seg.classList.add('seg-bands');
    for (const b of BAND_ORDER) {
      const label = b === 'all' ? 'All day' : this.model.bands[b].label;
      const input = h('input', { type: 'radio', name: 'band', value: String(b), 'aria-label': `${label}, ${SHORT_HOURS[b]}` });
      const span = h('span', null, iconEl(BAND_ICON[b], 'icon-sm'), label, h('small', null, SHORT_HOURS[b]));
      seg.append(h('label', { title: b === 'all' ? 'All hours' : this.model.bands[b].hours, dataset: { band: String(b) } }, input, span));
    }
    seg.addEventListener('change', (e) => {
      this.stopPlay();
      const v = e.target.value;
      this.setBand(v === 'all' ? 'all' : Number(v));
    });
    $('#explore-now').addEventListener('click', () => { this.stopPlay(); this.setBand(bandOfHour(seattleClock().hour)); });
    $('#play-day').addEventListener('click', () => (this.playTimer ? this.stopPlay() : this.play()));

    // crime types
    const chips = $('#group-chips');
    this.model.groups.forEach((g) => {
      const input = h('input', { type: 'checkbox', value: String(g.id) });
      const span = h('span', null, iconEl('check', 'check'), g.label, h('span', { class: 'chip-count', dataset: { group: g.id } }, ''));
      chips.append(h('label', { class: 'chip', title: `Severity weight ${g.severity}` }, input, span));
    });
    chips.addEventListener('change', (e) => {
      const id = Number(e.target.value);
      if (e.target.checked) this.state.groups.add(id); else this.state.groups.delete(id);
      if (!this.state.groups.size) {
        this.state.groups.add(id);
        e.target.checked = true;
        return;
      }
      this.weightsCache.clear();
      this.update();
    });
    $('#groups-all').addEventListener('click', () => this.setGroups([0, 1, 2, 3, 4, 5, 6, 7]));
    $('#groups-street').addEventListener('click', () => this.setGroups(STREET_GROUPS));

    // layer
    $('#layer-seg').addEventListener('change', (e) => {
      this.state.layer = e.target.value;
      this.update();
    });

    $('#rank-more').addEventListener('click', () => {
      this.showAll = !this.showAll;
      this.renderRanking();
    });

    // data freshness, so nobody mistakes 4 years of history for a live feed
    const range = this.model.meta.dataRange || {};
    const fmtDate = (s) => (s ? new Date(`${s}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '?');
    view.append(h('p', { class: 'hint', style: { marginTop: '18px', textAlign: 'center' } },
      `Seattle Police reports from ${fmtDate(range.from)} to ${fmtDate(range.to)} · ${fmt.int(this.model.meta.totals.incidents)} reports`));

    this.syncControls();
  }

  setBand(band) {
    this.state.band = band;
    this.syncControls();
    this.update();
  }

  /** Time-lapse: morning, afternoon, evening, night, again and again. The map and the whole app follow. */
  play() {
    const order = [1, 2, 3, 0];
    let i = Math.max(0, order.indexOf(this.state.band));
    const btn = $('#play-day');
    btn.setAttribute('aria-pressed', 'true');
    btn.textContent = 'Stop';
    const stepOnce = () => {
      this.setBand(order[i % order.length]);
      i += 1;
    };
    stepOnce();
    this.playTimer = setInterval(stepOnce, 2600);
  }

  stopPlay() {
    if (!this.playTimer) return;
    clearInterval(this.playTimer);
    this.playTimer = null;
    const btn = $('#play-day');
    btn.setAttribute('aria-pressed', 'false');
    btn.textContent = 'Play the day';
  }
  setGroups(list) {
    this.state.groups = new Set(list);
    this.weightsCache.clear();
    this.syncControls();
    this.update();
  }

  syncControls() {
    for (const input of document.querySelectorAll('#band-seg input')) input.checked = input.value === String(this.state.band);
    for (const input of document.querySelectorAll('#group-chips input')) input.checked = this.state.groups.has(Number(input.value));
    for (const input of document.querySelectorAll('#layer-seg input')) input.checked = input.value === this.state.layer;
  }

  /** Called when the view becomes visible. */
  activate() {
    this.map.cellInfo = (latlng) => this.describe(latlng);
    this.update();
  }
  deactivate() {
    this.stopPlay();
    this.map.cellInfo = null;
    this.map.closeTip();
    this.map.setBlips([]);
  }

  get band() { return this.state.band; }
  isDarkBand(band = this.state.band) { return band === 0 || band === 3; }

  update() {
    this.saveState();
    const { band, layer } = this.state;
    this.map.setDark(this.isDarkBand(band));
    this.map.setLayer(layer);
    if (layer === 'heat') this.drawHeat(); else this.drawGrid();
    this.drawBlips();
    this.renderRanking();
    this.renderStats();
    this.renderLegend();
    this.renderTimeBadge();
    this.renderChipCounts();
  }

  // ---- map layers ----
  weightsFor(band) {
    const key = `${band}|${[...this.state.groups].sort().join(',')}`;
    if (this.weightsCache.has(key)) return this.weightsCache.get(key);
    const groups = [...this.state.groups];
    const pts = [];
    for (const cell of this.model.cells.values()) {
      const w = this.model.countCell(cell, band, groups);
      if (w > 0) pts.push([cell.lat, cell.lng, w]);
    }
    this.weightsCache.set(key, pts);
    return pts;
  }

  /** Max for the color ramp: 99.5th percentile, shared by the 4 bands so night looks calmer than evening. */
  heatMax(band) {
    const pool = [];
    for (const b of band === 'all' ? ['all'] : [0, 1, 2, 3]) for (const p of this.weightsFor(b)) pool.push(p[2]);
    if (!pool.length) return 1;
    pool.sort((a, b) => a - b);
    return pool[Math.floor(pool.length * 0.995)] || pool[pool.length - 1];
  }

  drawHeat() {
    const band = this.state.band;
    this.map.setHeat(this.weightsFor(band), this.heatMax(band));
  }

  drawGrid() {
    const band = this.state.band;
    const cells = [];
    for (const cell of this.model.cells.values()) {
      const risk = this.model.riskAt(cell, band);
      const level = this.model.level(risk);
      if (level !== 'low') cells.push({ bounds: this.model.bounds(cell.id), level, risk });
    }
    this.map.setGrid(cells);
  }

  /** Radar blips on the 6 riskiest blocks for the selected time, at least 600 m apart. */
  drawBlips() {
    const band = this.state.band;
    const ranked = [...this.model.cells.values()].sort((a, b) => this.model.riskAt(b, band) - this.model.riskAt(a, band));
    const picked = [];
    for (const c of ranked) {
      if (picked.length >= 6) break;
      if (picked.some((p) => Math.abs(p.lat - c.lat) < 0.0055 && Math.abs(p.lng - c.lng) < 0.008)) continue;
      picked.push({ lat: c.lat, lng: c.lng });
    }
    this.map.setBlips(picked);
  }

  describe(latlng) {
    const cell = this.model.cellAt(latlng.lat, latlng.lng);
    if (!cell) return null;
    const band = this.state.band;
    const groups = [...this.state.groups];
    const count = this.model.countCell(cell, band, groups) / this.model.years;
    const risk = this.model.riskAt(cell, band);
    const level = this.model.level(risk);
    const top = this.model.topGroups(cell.c, band, groups, 2);
    const area = this.model.hoodName(cell.nb) || 'Seattle';
    const when = band === 'all' ? 'all day' : this.model.bands[band].label.toLowerCase();
    const lines = [
      `${fmt.perYear(count)} reports a year (${when})`,
      top.length ? `Mostly ${top.map((t) => t.label.toLowerCase()).join(', ')}` : 'No reports of these types',
      `Predicted risk: ${{ low: 'lower', elevated: 'elevated', high: 'high' }[level]}`,
    ];
    return { title: area, lines };
  }

  // ---- panel ----
  renderChipCounts() {
    const band = this.state.band;
    const totals = new Array(8).fill(0);
    for (const hd of this.model.hoods) {
      for (const b of this.model.bandList(band)) for (let g = 0; g < 8; g++) totals[g] += hd.counts[b * 8 + g];
    }
    for (const el of document.querySelectorAll('#group-chips .chip-count')) {
      el.textContent = fmt.compact(totals[Number(el.dataset.group)] / this.model.years);
    }
  }

  renderStats() {
    const band = this.state.band;
    const groups = [...this.state.groups];
    let total = 0;
    const perBand = [0, 0, 0, 0];
    for (const hd of this.model.hoods) {
      for (let b = 0; b < 4; b++) for (const g of groups) perBand[b] += hd.counts[b * 8 + g];
    }
    for (const b of this.model.bandList(band)) total += perBand[b];
    const all = perBand.reduce((s, x) => s + x, 0) || 1;
    const peak = perBand.indexOf(Math.max(...perBand));
    const ranking = this.ranking || this.model.rankHoods(band, groups);
    const top = ranking[0];

    const tiles = [
      h('div', { class: 'stat' },
        h('div', { class: 'stat-label' }, 'Reports a year'),
        h('div', { class: 'stat-value' }, fmt.compact(total / this.model.years)),
        h('div', { class: 'stat-sub' }, band === 'all' ? 'all day, selected types' : `${this.model.bands[band].label.toLowerCase()}, selected types`)),
      h('div', { class: 'stat' },
        h('div', { class: 'stat-label' }, 'Peak time'),
        h('div', { class: 'stat-value' }, this.model.bands[peak].label),
        h('div', { class: 'stat-sub' }, `${fmt.pct(perBand[peak] / all)} of reports`)),
    ];
    if (top) {
      tiles.push(h('div', { class: 'stat stat-wide stat-top' },
        h('div', { class: 'stat-label' }, `Most dangerous area · ${band === 'all' ? 'all day' : this.model.bands[band].label.toLowerCase()}`),
        h('div', { class: 'row-between' },
          h('div', { class: 'stat-value' }, top.hood.name),
          levelBadge('high', 'Index 100')),
        h('div', { class: 'stat-sub' }, `${fmt.perYear(top.perYear)} reports a year · mostly ${top.top ? top.top.label.toLowerCase() : 'mixed'}`)));
    }
    const m = this.model.meta.model;
    if (m && m.metrics && m.metrics.hotspotCapture10 != null) {
      const base = m.baseline && m.baseline.hotspotCapture10 != null ? ` Simple history: ${fmt.pct(m.baseline.hotspotCapture10)}.` : '';
      const rank = m.metrics.spearman != null ? ` Rank match ${m.metrics.spearman.toFixed(2)}${m.baseline && m.baseline.spearman != null ? ` vs ${m.baseline.spearman.toFixed(2)}` : ''}.` : '';
      tiles.push(h('div', { class: 'stat stat-wide stat-hero' },
        ring(m.metrics.hotspotCapture10 * 100, { size: 72, stroke: 8, color: '#6d5dfc', text: fmt.pct(m.metrics.hotspotCapture10), cls: 'ring-lg' }),
        h('div', null,
          h('div', { class: 'stat-label' }, 'ML model accuracy'),
          h('div', { class: 'stat-sub' }, `of the test year's weighted crime happened in the 10% of blocks the model flagged.${base}${rank}`))));
    }
    $('#explore-stats').replaceChildren(...tiles);
  }

  renderRanking() {
    const band = this.state.band;
    const groups = [...this.state.groups];
    this.ranking = this.model.rankHoods(band, groups);
    const rows = this.showAll ? this.ranking : this.ranking.slice(0, 10);
    const list = $('#rank-list');
    list.replaceChildren(...rows.map((r, idx) => h('li', null,
      h('button', {
        class: idx < 3 ? 'rank-item top' : 'rank-item', type: 'button',
        'aria-label': `${idx + 1}. ${r.hood.name}, danger index ${r.index}. Show on map.`,
        onclick: () => this.focusHood(r),
      },
        h('span', { class: 'rank-num' }, String(idx + 1)),
        h('span', null,
          h('div', { class: 'rank-name' }, r.hood.name),
          h('div', { class: 'rank-meta' }, `${fmt.perYear(r.perYear)} a year · mostly ${r.top ? r.top.label.toLowerCase() : 'mixed'}`),
          h('div', { class: 'rank-bar', 'aria-hidden': 'true' }, h('i', { style: { width: `${Math.max(3, r.index)}%` } }))),
        levelBadge(r.level, r.level === 'high' ? 'High' : r.level === 'elevated' ? 'Elevated' : 'Lower')))));
    $('#rank-caption').textContent = band === 'all' ? 'all day' : this.model.bands[band].label.toLowerCase();
    const more = $('#rank-more');
    more.textContent = this.showAll ? 'Show top 10' : `Show all ${this.ranking.length} areas`;
    more.hidden = this.ranking.length <= 10;
  }

  focusHood(r) {
    this.map.flyTo(r.hood.lat, r.hood.lng, 14);
    const lines = [
      `Danger index ${r.index} (rank ${this.ranking.indexOf(r) + 1} of ${this.ranking.length})`,
      `${fmt.perYear(r.perYear)} reports a year`,
      r.top ? `Mostly ${r.top.label.toLowerCase()}` : '',
      `${r.hood.precinct || ''} precinct`.trim(),
    ].filter(Boolean);
    const body = h('div', null, h('div', { class: 'tip-title' }, r.hood.name), ...lines.map((l) => h('div', { class: 'tip-sub' }, l)));
    setTimeout(() => this.map.popup(r.hood.lat, r.hood.lng, body), this.map.engine === 'gl' ? 1150 : 650);
  }

  renderLegend() {
    const legend = $('#legend');
    legend.classList.remove('legend-compact');
    const band = this.state.band;
    const when = band === 'all' ? 'All day' : this.model.bands[band].label;
    if (this.state.layer === 'heat') {
      const ramp = this.map.dark ? HEAT_DARK : HEAT_LIGHT;
      const stops = Object.entries(ramp).map(([k, c]) => `${c} ${Math.round(Number(k) * 100)}%`).join(', ');
      legend.replaceChildren(
        h('div', { class: 'legend-title' }, 'Reported crime', h('small', null, when)),
        h('div', { class: 'legend-body' },
          h('div', { class: 'legend-ramp', style: { background: `linear-gradient(90deg, rgba(255,255,255,0) 0%, ${stops})` } }),
          h('div', { class: 'legend-scale' }, h('span', null, 'Fewer'), h('span', null, 'More reports')),
          h('div', { class: 'legend-note' }, 'Hover or tap the map for details.')),
      );
    } else {
      const q = this.model.meta.risk.levels;
      legend.replaceChildren(
        h('div', { class: 'legend-title' }, 'Predicted risk', h('small', null, when)),
        h('div', { class: 'legend-body' },
          h('div', { class: 'legend-levels' },
            h('div', null, h('span', { class: 'swatch', style: { background: LEVEL_COLOR.high } }), levelBadge('high', 'High'), h('span', { class: 'tip-sub' }, `≥ ${q.high.toFixed(1)}`)),
            h('div', null, h('span', { class: 'swatch', style: { background: LEVEL_COLOR.elevated, opacity: 0.75 } }), levelBadge('elevated', 'Elevated'), h('span', { class: 'tip-sub' }, `≥ ${q.elevated.toFixed(1)}`)),
            h('div', null, h('span', { class: 'swatch', style: { background: 'transparent', border: '1px dashed var(--border-strong)' } }), h('span', null, 'No color = lower risk'))),
          h('div', { class: 'legend-note' }, 'ML model, all crime types weighted by severity. Score = expected weighted incidents a year in the block.')),
      );
    }
  }

  renderTimeBadge() {
    const badge = $('#time-badge');
    const band = this.state.band;
    const now = seattleClock();
    const nowBand = bandOfHour(now.hour);
    const label = band === 'all' ? 'All day' : this.model.bands[band].label;
    const hours = band === 'all' ? '24 hours' : this.model.bands[band].hours;
    badge.replaceChildren(
      iconEl(BAND_ICON[band], 'icon'),
      h('span', null, `${label} `, h('small', null, hours)),
      band === nowBand ? h('small', null, `· Seattle now ${clockLabel(now.hour, now.minute)}`) : '',
    );
  }
}
