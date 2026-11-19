// Directions view: From / To with suggestions, travel mode, departure time, and the scored route cards.

import { $, h, fmt, debounce, levelBadge, ring, toast, seattleClock, bandOfHour, clockLabel, isAbort } from './ui.js';
import { ROLE_COLOR, ROLE_LABEL } from './mapview.js';
import { svg, iconEl, KIND_ICON, MODE_ICON, BAND_ICON } from './icons.js';
import { fetchRoutes, searchPlaces, getPosition, inSeattle, DEMO_START, haversine } from './geo.js';
import { account } from './api.js';

const MODES = ['walk', 'bike', 'car'];
const MODE_VERB = { walk: 'walking', bike: 'biking', car: 'driving' };
const LEVEL_WORD = { low: 'Lower', elevated: 'Elevated', high: 'High' };

/** Accessible combobox for a place input (keyboard, screen reader, mouse). */
class PlaceBox {
  constructor(input, list, opts) {
    this.input = input;
    this.list = list;
    this.opts = opts;
    this.items = [];
    this.active = -1;
    this.seq = 0;
    this.ctrl = null;
    this.picked = '';
    this.remote = debounce((q, seq) => this.searchRemote(q, seq), 280);
    input.addEventListener('focus', () => { input.select(); this.refresh(); });
    input.addEventListener('input', () => this.refresh());
    input.addEventListener('keydown', (e) => this.onKey(e));
    input.addEventListener('blur', () => setTimeout(() => this.close(), 150));
    list.addEventListener('mousedown', (e) => e.preventDefault());
  }

  query() {
    const q = this.input.value.trim();
    return q === this.picked ? '' : q;
  }

  refresh() {
    const q = this.query();
    const seq = ++this.seq;
    if (this.ctrl) this.ctrl.abort();
    const sections = this.opts.local(q);
    this.render(sections, q.length >= 3 ? 'searching' : null);
    if (q.length >= 3) this.remote(q, seq);
  }

  async searchRemote(q, seq) {
    if (seq !== this.seq) return;
    this.ctrl = new AbortController();
    try {
      const found = await searchPlaces(q, this.ctrl.signal);
      if (seq !== this.seq) return;
      const sections = this.opts.local(q);
      const seen = new Set(sections.flatMap((s) => s.items).map((i) => i.name.toLowerCase()));
      const fresh = found.filter((p) => !seen.has(p.name.toLowerCase())).slice(0, 6);
      if (fresh.length) sections.push({ title: 'Places', items: fresh });
      this.render(sections, sections.some((s) => s.items.length) ? null : 'none');
    } catch (e) {
      if (isAbort(e) || seq !== this.seq) return;
      this.render(this.opts.local(q), 'error');
    }
  }

  render(sections, status) {
    this.items = [];
    this.active = -1;
    const rows = [];
    for (const s of sections) {
      if (!s.items.length) continue;
      if (s.title) rows.push(h('li', { class: 's-head', role: 'presentation' }, s.title));
      for (const item of s.items) {
        const idx = this.items.length;
        this.items.push(item);
        const icon = h('span', { class: 's-icon' }, iconEl(KIND_ICON[item.kind] || 'pin', 'icon-sm'));
        rows.push(h('li', {
          id: `${this.list.id}-${idx}`, role: 'option', 'aria-selected': 'false',
          onclick: () => this.pick(item),
        }, icon, h('span', null, h('div', { class: 's-name' }, item.name), item.detail ? h('div', { class: 's-detail' }, item.detail) : '')));
      }
    }
    const note = { searching: 'Searching places in Seattle…', none: 'No places found in Seattle.', error: 'Place search is offline. Pick a saved place or a landmark.' }[status];
    if (note) rows.push(h('li', { class: 's-empty', role: 'presentation' }, note));
    this.list.replaceChildren(...rows);
    const open = rows.length > 0 && document.activeElement === this.input;
    this.list.hidden = !open;
    this.input.setAttribute('aria-expanded', String(open));
    this.input.removeAttribute('aria-activedescendant');
  }

  move(delta) {
    if (!this.items.length) return;
    this.active = (this.active + delta + this.items.length) % this.items.length;
    this.items.forEach((_, i) => {
      const li = document.getElementById(`${this.list.id}-${i}`);
      if (li) li.setAttribute('aria-selected', String(i === this.active));
    });
    const li = document.getElementById(`${this.list.id}-${this.active}`);
    if (li) {
      li.scrollIntoView({ block: 'nearest' });
      this.input.setAttribute('aria-activedescendant', li.id);
    }
  }

  onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (this.list.hidden) this.refresh(); else this.move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.move(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const item = this.items[this.active >= 0 ? this.active : 0];
      if (item) this.pick(item);
    } else if (e.key === 'Escape') {
      if (!this.list.hidden) { e.stopPropagation(); this.close(); }
    }
  }

  pick(item) {
    this.close();
    this.opts.onPick(item);
  }

  set(place, pending) {
    this.picked = place ? place.name : '';
    this.input.value = place ? place.name : pending || '';
  }

  close() {
    this.list.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }
}

export class Directions {
  constructor({ model, mapView, landmarks, user, onStartTrip, onPrefsChange }) {
    this.model = model;
    this.map = mapView;
    this.landmarks = landmarks;
    this.user = user;
    this.prefs = { ...user.preferences };
    this.onStartTrip = onStartTrip;
    this.onPrefsChange = onPrefsChange;
    this.places = [];
    this.trips = [];
    this.from = null;
    this.to = null;
    this.mode = MODES.includes(this.prefs.mode) ? this.prefs.mode : 'walk';
    this.raw = [];
    this.routes = [];
    this.selected = 0;
    this.req = 0;
    this.ctrl = null;
    this.triedGps = false;
    this.fromSeq = 0; // counts start changes, so a late GPS answer never replaces the visitor's choice
    this.active = false; // true while the Directions view is on screen (only then it draws on the map)
    this.lastStart = 0;
  }

  mount() {
    // travel mode
    const modeSeg = $('#mode-seg');
    for (const m of MODES) {
      const input = h('input', { type: 'radio', name: 'mode', value: m });
      modeSeg.append(h('label', null, input, h('span', null, iconEl(MODE_ICON[m], 'icon-sm'), this.model.modes[m].label)));
    }
    modeSeg.addEventListener('change', (e) => this.setMode(e.target.value, true));

    // departure time
    const timeInput = $('#depart-time');
    const now = seattleClock();
    const nextQuarter = (now.hour * 60 + now.minute + 15 - ((now.minute + 15) % 15)) % (24 * 60);
    timeInput.value = `${String(Math.floor(nextQuarter / 60)).padStart(2, '0')}:${String(nextQuarter % 60).padStart(2, '0')}`;
    for (const r of document.querySelectorAll('input[name="when"]')) {
      r.addEventListener('change', () => {
        timeInput.hidden = document.querySelector('input[name="when"]:checked').value !== 'at';
        if (!timeInput.hidden) timeInput.focus();
        this.rescore();
      });
    }
    timeInput.addEventListener('change', () => this.rescore());

    // icons
    $('#from-gps').insertAdjacentHTML('afterbegin', svg('locate'));
    $('#swap-btn').insertAdjacentHTML('afterbegin', svg('swap'));
    $('#to-save').insertAdjacentHTML('afterbegin', svg('star'));
    $('#from-gps').addEventListener('click', () => this.useGps(true));
    $('#swap-btn').addEventListener('click', () => this.swap());
    $('#to-save').addEventListener('click', () => this.toggleSaveRow());

    this.fromBox = new PlaceBox($('#from-input'), $('#from-suggest'), {
      local: (q) => this.suggestions(q, true),
      onPick: (item) => (item.kind === 'gps' ? this.useGps(true) : this.setFrom(item)),
    });
    this.toBox = new PlaceBox($('#to-input'), $('#to-suggest'), {
      local: (q) => this.suggestions(q, false),
      onPick: (item) => this.setTo(item),
    });

    this.syncMode();
    this.renderEmpty();
  }

  async loadPersonal() {
    try {
      const [places, trips] = await Promise.all([account.listPlaces(), account.listTrips(10)]);
      this.places = places || [];
      this.trips = trips || [];
    } catch {
      this.places = [];
      this.trips = [];
    }
    this.renderQuick();
  }

  /** Account settings changed. Change the trip's mode only when the usual mode itself was edited. */
  setPrefs(prefs) {
    const modeEdited = prefs.mode && prefs.mode !== this.prefs.mode;
    this.prefs = { ...this.prefs, ...prefs };
    if (modeEdited && prefs.mode !== this.mode) this.setMode(prefs.mode, true);
    else if (this.active) this.rescore();
  }

  setPlaces(places) {
    this.places = places;
    this.renderQuick();
    this.updateSaveButton();
  }

  // ---------- view lifecycle ----------
  activate() {
    this.active = true;
    this.map.cellInfo = null;
    this.map.setLayer('grid');
    this.map.setEndpoints(this.from, this.to);
    if (this.raw.length) this.rescore(false); // the time or settings may have changed meanwhile
    else this.drawContext();
    if (!this.from && !this.triedGps) this.useGps(false);
  }

  deactivate() {
    this.active = false;
    this.map.clearRoutes();
    this.map.setEndpoints(null, null);
  }

  focusTo() {
    setTimeout(() => $('#to-input').focus(), 50);
  }

  /** Grid layer for the departure band behind the routes: shows why a route avoids some blocks. */
  drawContext() {
    if (!this.active) return; // never draw Directions layers over another view
    const band = this.departure().band;
    this.map.setDark(band === 0 || band === 3);
    const cells = [];
    for (const cell of this.model.cells.values()) {
      const risk = this.model.riskAt(cell, band) * this.model.vulnerability(this.mode);
      const level = this.model.level(risk);
      if (level !== 'low') cells.push({ bounds: this.model.bounds(cell.id), level, risk });
    }
    // with routes on the map, the grid fades so the green / orange / red lines stand out
    this.map.setGrid(cells, this.raw.length ? { faint: true } : { subtle: true });
    const d = this.departure();
    const badge = $('#time-badge');
    badge.replaceChildren(iconEl(BAND_ICON[d.band], 'icon'),
      h('span', null, `${d.now ? 'Leaving now' : 'Leaving at'} ${clockLabel(d.hour, d.minute)} `, h('small', null, `${this.model.bands[d.band].label} · ${this.model.modes[this.mode].label.toLowerCase()} risk shown`)));
    // compact one-line legend, so it never covers the start or end of a route
    const line = (color) => h('span', { class: 'swatch swatch-line', style: { background: color } });
    const legend = $('#legend');
    legend.classList.add('legend-compact');
    legend.replaceChildren(
      h('div', { class: 'legend-levels', title: `Line colors compare the routes with each other, for ${MODE_VERB[this.mode]}. Each card shows the route's own risk level.` },
        h('b', null, 'Routes'),
        h('div', null, line(ROLE_COLOR.best), h('span', null, 'Recommended')),
        h('div', null, line(ROLE_COLOR.mid), h('span', null, 'Moderate')),
        h('div', null, line(ROLE_COLOR.worst), h('span', null, 'Most dangerous')),
        h('div', null, h('span', { class: 'swatch-dot' }), h('span', null, 'High-risk block'))),
    );
  }

  // ---------- inputs ----------
  suggestions(q, forFrom) {
    const ql = q.toLowerCase();
    const saved = this.places.map((p) => ({ name: p.label, detail: p.address, lat: p.lat, lng: p.lng, kind: p.kind }));
    const seen = new Set();
    const recent = [];
    for (const t of this.trips) {
      const key = `${t.toLabel}|${Number(t.toLat).toFixed(4)}`;
      if (seen.has(key) || t.toLat == null) continue;
      seen.add(key);
      recent.push({ name: t.toLabel, detail: 'Recent trip', lat: Number(t.toLat), lng: Number(t.toLng), kind: 'recent' });
    }
    const marks = this.landmarks.map((l) => ({ name: l.name, detail: l.category || 'Landmark', lat: l.lat, lng: l.lng, kind: 'landmark' }));
    const sections = [];
    // only for an empty box: with typed text, Enter must pick the typed place, not the GPS row
    if (forFrom && !q) sections.push({ title: null, items: [{ name: 'Your location', detail: 'Use this device’s location', kind: 'gps' }] });
    if (!q) {
      if (saved.length) sections.push({ title: 'Saved', items: saved });
      if (recent.length) sections.push({ title: 'Recent', items: recent.slice(0, 3) });
      sections.push({ title: 'Popular places', items: marks.slice(0, 6) });
    } else {
      const match = (x) => x.name.toLowerCase().includes(ql) || String(x.detail || '').toLowerCase().includes(ql);
      const found = [...saved, ...recent, ...marks].filter(match).slice(0, 5);
      if (found.length) sections.push({ title: 'Suggestions', items: found });
    }
    return sections;
  }

  async useGps(userAsked) {
    this.triedGps = true;
    const seq = this.fromSeq;
    const stale = () => !userAsked && this.fromSeq !== seq; // the visitor chose a start meanwhile
    if (userAsked || !this.from) this.fromBox.set(null, 'Finding your location…');
    try {
      const pos = await getPosition(userAsked ? 10000 : 6000);
      if (stale()) return;
      if (inSeattle(pos.lat, pos.lng)) {
        const area = this.model.areaName(pos.lat, pos.lng);
        this.setFrom({ name: 'Your location', detail: area || 'Seattle', lat: pos.lat, lng: pos.lng, kind: 'gps' });
        this.map.setMe(pos);
      } else {
        this.setFrom(DEMO_START);
        toast('You are outside Seattle, so trips start at Pike Place Market.');
      }
    } catch (e) {
      if (stale()) return;
      this.setFrom(DEMO_START);
      if (userAsked) toast(e && e.code === 1 ? 'Location access is off. Allow it in the browser settings, or pick a start place.' : 'Could not get your location, so trips start at Pike Place Market.');
    }
  }

  setFrom(place) {
    this.fromSeq++;
    this.from = { name: place.name, detail: place.detail, lat: Number(place.lat), lng: Number(place.lng), kind: place.kind };
    this.fromBox.set(this.from);
    this.plan();
  }

  setTo(place) {
    this.to = { name: place.name, detail: place.detail, lat: Number(place.lat), lng: Number(place.lng), kind: place.kind };
    this.toBox.set(this.to);
    this.updateSaveButton();
    this.hideSaveRow();
    this.plan();
  }

  swap() {
    if (!this.from && !this.to) return;
    const a = this.from;
    this.fromSeq++;
    this.from = this.to;
    this.to = a;
    this.fromBox.set(this.from);
    this.toBox.set(this.to);
    this.updateSaveButton();
    this.plan();
  }

  setMode(m, replan) {
    if (!MODES.includes(m)) return;
    this.mode = m;
    this.syncMode();
    if (replan) this.plan();
  }

  syncMode() {
    for (const input of document.querySelectorAll('#mode-seg input')) input.checked = input.value === this.mode;
  }

  departure() {
    const checked = document.querySelector('input[name="when"]:checked');
    const value = $('#depart-time').value;
    const c = seattleClock();
    if (checked && checked.value === 'at' && /^\d{2}:\d{2}$/.test(value)) {
      const [hour, minute] = value.split(':').map(Number);
      const tomorrow = hour * 60 + minute < c.hour * 60 + c.minute; // a time already past means tomorrow
      return { now: false, hour, minute, band: bandOfHour(hour), iso: this.isoSeattle(hour, minute, tomorrow ? 1 : 0) };
    }
    return { now: true, hour: c.hour, minute: c.minute, band: bandOfHour(c.hour), iso: this.isoSeattle(c.hour, c.minute, 0) };
  }

  arrival(d, seconds) {
    const total = (d.hour * 60 + d.minute + Math.round(seconds / 60)) % (24 * 60);
    return clockLabel(Math.floor(total / 60), total % 60);
  }

  /** Local Seattle date-time text (the trip's departure), `addDays` days from today in Seattle. */
  isoSeattle(hour, minute, addDays) {
    const now = new Date(Date.now() + addDays * 86400000);
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const get = (t) => parts.find((p) => p.type === t).value;
    return `${get('year')}-${get('month')}-${get('day')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  // ---------- saved places ----------
  renderQuick() {
    const row = $('#quick-places');
    const home = this.places.find((p) => p.kind === 'home');
    const work = this.places.find((p) => p.kind === 'work');
    const items = [];
    const btn = (kind, label, onclick, title) => h('button', { class: 'quick-btn', type: 'button', onclick, title }, iconEl(KIND_ICON[kind], 'icon-sm'), label);
    items.push(home ? btn('home', 'Home', () => this.setTo({ ...this.asPlace(home) }), home.address) : btn('home', 'Set Home', () => this.askToSave('home')));
    items.push(work ? btn('work', 'Work', () => this.setTo({ ...this.asPlace(work) }), work.address) : btn('work', 'Set Work', () => this.askToSave('work')));
    for (const p of this.places.filter((x) => x.kind === 'saved').slice(0, 6)) items.push(btn('saved', p.label, () => this.setTo(this.asPlace(p)), p.address));
    const recent = this.suggestions('', false).find((s) => s.title === 'Recent');
    if (recent) for (const r of recent.items.slice(0, 2)) items.push(btn('recent', r.name, () => this.setTo(r), 'Recent trip'));
    row.replaceChildren(...items);
  }

  asPlace(p) {
    return { name: p.label, detail: p.address, lat: Number(p.lat), lng: Number(p.lng), kind: p.kind };
  }

  askToSave(kind) {
    this.pendingSaveKind = kind;
    toast(`Search for your ${kind} address in “Where to?”, then tap the star to save it.`);
    this.focusTo();
  }

  updateSaveButton() {
    const button = $('#to-save');
    if (!this.to || ['home', 'work', 'saved'].includes(this.to.kind)) {
      button.hidden = true;
      return;
    }
    const already = this.places.some((p) => Math.abs(p.lat - this.to.lat) < 1e-4 && Math.abs(p.lng - this.to.lng) < 1e-4);
    button.hidden = already;
  }

  toggleSaveRow() {
    if (this.saveRow) { this.hideSaveRow(); return; }
    const to = this.to;
    if (!to) return;
    const choose = async (kind) => {
      const label = kind === 'home' ? 'Home' : kind === 'work' ? 'Work' : to.name.slice(0, 100);
      this.hideSaveRow();
      try {
        await account.savePlace({ kind, label, address: [to.name, to.detail].filter(Boolean).join(', ').slice(0, 255), lat: to.lat, lng: to.lng });
        this.setPlaces(await account.listPlaces());
        // the visitor may have picked another destination while the save ran: only mark the same place
        if (this.to && this.to.lat === to.lat && this.to.lng === to.lng) this.to = { ...this.to, kind };
        this.updateSaveButton();
        this.onPrefsChange && this.onPrefsChange({ places: this.places });
        toast(kind === 'saved' ? `Saved “${label}”.` : `Saved as your ${label}.`);
      } catch (e) {
        toast(e.message || 'Could not save the place.');
      }
    };
    const first = this.pendingSaveKind || null;
    this.saveRow = h('div', { class: 'quick', role: 'group', 'aria-label': 'Save destination as' },
      h('span', { class: 'hint', style: { alignSelf: 'center', margin: 0 } }, 'Save as:'),
      ...['home', 'work', 'saved'].map((k) => h('button', {
        class: 'quick-btn', type: 'button', onclick: () => choose(k),
        style: first === k ? { borderColor: 'var(--brand)' } : null,
      }, iconEl(KIND_ICON[k], 'icon-sm'), k === 'saved' ? 'Favorite' : k === 'home' ? 'Home' : 'Work')),
      h('button', { class: 'quick-btn', type: 'button', onclick: () => this.hideSaveRow() }, 'Cancel'));
    $('#quick-places').after(this.saveRow);
    this.pendingSaveKind = null;
  }

  hideSaveRow() {
    if (this.saveRow) this.saveRow.remove();
    this.saveRow = null;
  }

  // ---------- routing ----------
  /** Cancel the route request in flight, so its late answer cannot overwrite a newer state. */
  cancelPlan() {
    ++this.req;
    if (this.ctrl) this.ctrl.abort();
    this.ctrl = null;
  }

  async plan() {
    if (this.active) this.map.setEndpoints(this.from, this.to);
    if (!this.from || !this.to) {
      this.cancelPlan();
      this.raw = [];
      this.routes = [];
      this.map.clearRoutes();
      this.renderEmpty();
      if (this.active && this.from && !this.to) this.map.flyTo(this.from.lat, this.from.lng, 14);
      return;
    }
    if (haversine([this.from.lat, this.from.lng], [this.to.lat, this.to.lng]) < 40) {
      this.cancelPlan();
      this.raw = [];
      this.routes = [];
      this.map.clearRoutes();
      this.renderMessage('Start and destination are the same place.', 'Pick a different destination.');
      return;
    }
    const req = ++this.req;
    if (this.ctrl) this.ctrl.abort();
    this.ctrl = new AbortController();
    const skeletonTimer = setTimeout(() => { if (req === this.req) this.renderLoading(); }, 250);
    try {
      const raw = await fetchRoutes(this.from, this.to, this.mode, this.ctrl.signal);
      if (req !== this.req) return;
      clearTimeout(skeletonTimer);
      this.raw = raw;
      this.selected = 0;
      this.rescore(true);
    } catch (e) {
      clearTimeout(skeletonTimer);
      if (req !== this.req || isAbort(e)) return;
      this.routes = [];
      this.map.clearRoutes();
      if (this.active) this.map.fit([[this.from.lat, this.from.lng], [this.to.lat, this.to.lng]]);
      this.renderError(e);
    }
  }

  rescore(fit = false) {
    this.drawContext();
    if (!this.raw.length) return;
    const band = this.departure().band;
    const scored = this.raw.map((r) => ({ ...r, score: this.model.scoreRoute(r.coords, this.mode, band), tags: [] }));
    const w = Math.min(1, Math.max(0, Number(this.prefs.safetyWeight ?? 0.7)));
    const maxAdj = Math.max(...scored.map((s) => s.score.adjusted), 1e-9);
    const maxDur = Math.max(...scored.map((s) => s.duration), 1);
    for (const s of scored) s.rank = w * (s.score.adjusted / maxAdj) + (1 - w) * (s.duration / maxDur);
    const safest = scored.reduce((a, b) => (b.score.adjusted < a.score.adjusted - 1e-9 || (Math.abs(b.score.adjusted - a.score.adjusted) < 1e-9 && b.duration < a.duration) ? b : a));
    const fastest = scored.reduce((a, b) => (b.duration < a.duration ? b : a));
    scored.sort((a, b) => a.rank - b.rank);
    // Roles for the map colors: the recommended route is green; of the others, the riskier one is red
    // (most dangerous) and the other one is orange (moderate). With 2 routes, the other one is red only
    // if it is riskier than the recommended route.
    const [best, ...others] = scored;
    best.role = 'best';
    if (others.length === 1) {
      others[0].role = others[0].score.adjusted > best.score.adjusted ? 'worst' : 'mid';
    } else if (others.length >= 2) {
      const byRisk = [...others].sort((a, b) => b.score.adjusted - a.score.adjusted);
      byRisk[0].role = 'worst';
      for (const s of byRisk.slice(1)) s.role = 'mid';
    }
    for (const s of scored) s.tags.push(ROLE_LABEL[s.role]);
    if (scored.length > 1) {
      safest.tags.push('Safest');
      fastest.tags.push('Fastest');
    }
    for (const s of scored) s.choice = s === safest ? 'safest' : s === fastest ? 'fastest' : 'balanced';
    const keep = this.routes[this.selected] && scored.findIndex((s) => s.coords === this.routes[this.selected].coords);
    this.routes = scored;
    this.selected = !fit && keep >= 0 ? keep : 0;
    this.renderRoutes();
    this.draw(fit);
  }

  draw(fit) {
    if (!this.active) return;
    this.map.drawRoutes(this.routes, this.selected, (i) => this.select(i));
    if (fit && this.routes.length) this.map.fit(this.routes.flatMap((r) => [r.coords[0], r.coords[Math.floor(r.coords.length / 2)], r.coords[r.coords.length - 1]]));
  }

  select(i) {
    this.selected = i;
    this.draw(false);
    for (const card of document.querySelectorAll('.route-card')) card.setAttribute('aria-pressed', String(Number(card.dataset.idx) === i));
  }

  // ---------- rendering ----------
  renderEmpty() {
    $('#routes').replaceChildren(h('div', { class: 'empty' },
      iconEl('route', 'icon'),
      h('b', null, 'Plan a safer trip'),
      'Choose where you start and where you go. CrimeRadar compares up to 3 routes for the time you travel.'));
  }

  renderMessage(title, text) {
    $('#routes').replaceChildren(h('div', { class: 'empty' }, iconEl('info', 'icon'), h('b', null, title), text));
  }

  renderLoading() {
    $('#routes').replaceChildren(
      h('div', { class: 'sr-only' }, 'Finding routes…'),
      ...[0, 1, 2].map(() => h('div', { class: 'skeleton', 'aria-hidden': 'true' })),
    );
  }

  renderError(e) {
    $('#routes').replaceChildren(h('div', { class: 'inline-error', role: 'alert' },
      h('b', null, 'Could not get routes'),
      h('span', null, (e && e.message) || 'The routing service did not answer.'),
      h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => this.plan() }, 'Try again')));
  }

  renderRoutes() {
    const d = this.departure();
    const bandLabel = this.model.bands[d.band].label.toLowerCase();
    const cards = this.routes.map((r, i) => this.card(r, i, d, bandLabel));
    const caption = h('p', { class: 'hint', style: { margin: '0 0 2px' } },
      `${this.routes.length} route${this.routes.length > 1 ? 's' : ''} for ${MODE_VERB[this.mode]}, ${d.now ? 'leaving now' : `leaving at ${clockLabel(d.hour, d.minute)}`} (${bandLabel}).`);
    $('#routes').replaceChildren(caption, ...cards);
  }

  card(r, i, d, bandLabel) {
    const s = r.score;
    const whyId = `why-${i}`;
    const why = h('div', { class: 'why', id: whyId, hidden: true });
    const whyBtn = h('button', {
      class: 'why-btn', type: 'button', 'aria-expanded': 'false', 'aria-controls': whyId,
      onclick: (e) => {
        e.stopPropagation();
        const open = why.hidden;
        why.hidden = !open;
        whyBtn.setAttribute('aria-expanded', String(open));
        whyBtn.lastChild.textContent = open ? 'Hide' : 'Why?';
        if (open && !why.childElementCount) this.fillWhy(why, r, d);
      },
    }, iconEl('info', 'icon-sm'), h('span', null, 'Why?'));

    const start = h('button', {
      class: 'btn btn-primary btn-sm', type: 'button',
      onclick: (e) => { e.stopPropagation(); this.start(r, false); },
    }, iconEl('nav', 'icon-sm'), 'Start trip');
    const sim = h('button', {
      class: 'btn btn-secondary btn-sm', type: 'button', title: 'Play the trip on the map to see the danger alerts',
      onclick: (e) => { e.stopPropagation(); this.start(r, true); },
    }, iconEl('play', 'icon-sm'), 'Simulate');

    const color = ROLE_COLOR[r.role] || ROLE_COLOR.best;
    const card = h('div', {
      class: `route-card role-${r.role || 'best'}`, role: 'button', tabindex: '0', 'aria-pressed': String(i === this.selected), dataset: { idx: i },
      style: { '--route-color': color },
      'aria-label': `Route R${i + 1}, ${ROLE_LABEL[r.role] || ''}: ${fmt.duration(r.duration)}, ${LEVEL_WORD[s.level].toLowerCase()} risk, score ${s.score} of 100`,
      onclick: () => this.select(i),
      onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === card) { e.preventDefault(); this.select(i); } },
    },
      r.tags.length ? h('div', { class: 'route-tags' }, ...r.tags.map((t) => h('span', {
        class: t === ROLE_LABEL[r.role] ? `tag tag-role tag-${r.role}` : 'tag tag-plain',
      }, t))) : '',
      h('div', { class: 'route-top' },
        ring(s.score, { size: 56, stroke: 6, color }),
        h('div', { class: 'route-head' },
          h('div', { class: 'route-name' }, h('span', { class: 'route-id' }, `R${i + 1}`), h('span', null, fmt.distance(r.distance))),
          h('div', { class: 'route-mid' }, levelBadge(s.level))),
        h('div', { class: 'route-time' }, h('b', null, fmt.duration(r.duration)), h('span', null, `arrive ${this.arrival(d, r.duration)}`))),
      h('div', { class: 'route-mid' },
        h('span', null, 'Risk score ', h('span', { class: 'score' }, String(s.score)), '/100 · ',
          `≈ ${fmt.perYear(s.incidentsPerYear)} ${this.mode === 'car' ? 'car-related' : 'street'} crimes a year along it (${bandLabel})`)),
      h('div', { class: 'row-between' }, whyBtn,
        s.hotspots.length ? h('span', { class: 'hint', style: { margin: 0 } }, `${s.hotspots.length} high-risk block${s.hotspots.length > 1 ? 's' : ''}`) : h('span', { class: 'hint', style: { margin: 0 } }, 'No high-risk blocks')),
      why,
      h('div', { class: 'route-actions' }, start, sim));
    return card;
  }

  fillWhy(why, r, d) {
    const s = r.score;
    const bars = s.topGroups.length
      ? s.topGroups.map((g) => h('div', { class: 'why-bar' },
        h('span', { class: 'lbl' }, g.label), h('span', { class: 'val' }, fmt.pct(g.share)),
        h('span', { class: 'track', 'aria-hidden': 'true' }, h('i', { style: { width: `${Math.round(g.share * 100)}%` } }))))
      : [h('span', null, 'No reports along this route at this time.')];
    const strip = h('div', { class: 'band-strip' }, ...[1, 2, 3, 0].map((b) => {
      const x = s.byBand[b];
      return h('div', { class: `band-cell band-${x.level}${b === d.band ? ' is-now' : ''}`, title: `${this.model.bands[b].hours}: score ${Math.round(x.score)}` },
        h('b', null, this.model.bands[b].label), h('span', null, `${LEVEL_WORD[x.level]} · ${Math.round(x.score)}`));
    }));
    const safest = s.safestBand;
    const modeNote = this.mode === 'car'
      ? `In a car you are less exposed. On foot this route would be ${LEVEL_WORD[s.onFoot].toLowerCase()} risk.`
      : `On foot or bike you are more exposed. In a car this route would be ${LEVEL_WORD[s.inCar].toLowerCase()} risk.`;
    why.replaceChildren(
      h('div', null, h('h4', null, this.mode === 'car' ? 'Car-related crime along this route' : 'Street crime along this route'), h('div', { class: 'why-bars' }, ...bars)),
      h('div', null, h('h4', null, 'Riskiest stretch'),
        s.hotspots.length
          ? `${s.riskiestHood || 'Part of the route'}: ${s.hotspots.length} high-risk block${s.hotspots.length > 1 ? 's' : ''} (red dots on the map).`
          : `${s.riskiestHood ? `Highest risk near ${s.riskiestHood}, ` : ''}but no block on this route is in the city's top 10% for this time.`),
      h('div', null, h('h4', null, 'Same route at other times'), strip,
        h('p', { class: 'hint' }, safest.band === d.band ? 'You already travel at the safest time of day for this route.' : `Safest time for this route: ${this.model.bands[safest.band].label.toLowerCase()} (${this.model.bands[safest.band].hours}).`)),
      h('div', null, h('h4', null, 'Travel mode'), modeNote),
    );
  }

  start(route, simulate) {
    if (Date.now() - this.lastStart < 1500) return; // a double click starts one trip, not two
    this.lastStart = Date.now();
    const d = this.departure();
    const trip = {
      fromLabel: this.from.name, fromLat: this.from.lat.toFixed(6), fromLng: this.from.lng.toFixed(6),
      toLabel: this.to.name, toLat: this.to.lat.toFixed(6), toLng: this.to.lng.toFixed(6),
      mode: this.mode, departAt: d.iso, distanceMeters: Math.round(route.distance), durationSeconds: Math.round(route.duration),
      riskScore: route.score.score, riskLevel: route.score.level, choice: route.choice,
    };
    account.saveTrip(trip)
      .then((saved) => { this.trips = [saved, ...this.trips].slice(0, 10); this.renderQuick(); })
      .catch(() => { /* history is a convenience; the trip still starts */ });
    this.onStartTrip({ route, simulate, band: d.band, mode: this.mode, from: this.from, to: this.to });
  }
}
