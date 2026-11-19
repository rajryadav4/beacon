// Trips and danger alerts: live (device location) or simulated (the trip plays on the map).
// An alert fires before the traveler enters a high-risk block, adjusted for the travel mode.

import { $, h, fmt, levelBadge, toast, clamp, reducedMotion, seattleClock, bandOfHour } from './ui.js';
import { iconEl, MODE_ICON } from './icons.js';
import { cumulative, pointAt, inSeattle, haversine, locationPermission } from './geo.js';
import { STREET_GROUPS } from './risk.js';

const TIPS = {
  walk: 'Stay on busy, well-lit streets and keep your phone out of sight.',
  bike: 'Stay on main streets and keep moving; lock your bike where people can see it.',
  car: 'Keep the doors locked and valuables out of sight when you park.',
};

export class DangerAlerts {
  constructor(model) {
    this.model = model;
    this.warned = new Map();
    this.lastAt = 0;
    this.sound = true;
    this.hideTimer = null;
    $('#danger-banner').addEventListener('click', (e) => {
      if (e.target.closest('button')) this.hide();
    });
  }

  reset() {
    this.warned.clear();
    this.lastAt = 0;
  }

  /** High-risk block here or just ahead? Returns {cell, kind} or null. */
  evaluate(lat, lng, band, mode, ahead = []) {
    const vul = this.model.vulnerability(mode);
    const isHigh = (cell) => cell && this.model.level(this.model.riskAt(cell, band) * vul) === 'high';
    const here = this.model.cellAt(lat, lng);
    if (isHigh(here)) return { cell: here, kind: 'inside' };
    for (const p of ahead) {
      const cell = this.model.cellAt(p[0], p[1]);
      if (isHigh(cell)) return { cell, kind: 'ahead' };
    }
    return null;
  }

  /** Show the alert unless this area was announced recently. */
  maybeWarn(hit, band, mode, { areaCooldown = 120000, globalCooldown = 15000 } = {}) {
    if (!hit) return null;
    const now = Date.now();
    const key = hit.cell.nb >= 0 ? `nb${hit.cell.nb}` : `c${hit.cell.id}`;
    if (this.warned.has(key) && now - this.warned.get(key) < areaCooldown) return null;
    if (this.lastAt && now - this.lastAt < globalCooldown) return null;
    this.warned.set(key, now);
    this.lastAt = now;
    return this.show(hit, band, mode);
  }

  show(hit, band, mode) {
    const cell = hit.cell;
    const area = this.model.hoodName(cell.nb) || 'this area';
    const perYear = this.model.countCell(cell, band, STREET_GROUPS) / this.model.years;
    const top = this.model.topGroups(cell.c, band, STREET_GROUPS, 2).map((t) => t.label.toLowerCase());
    const when = this.model.bands[band].label.toLowerCase();
    const title = hit.kind === 'ahead' ? `High-risk area ahead · ${area}` : `You are in a high-risk area · ${area}`;
    const text = `${fmt.perYear(perYear)} street crimes a year on this block in the ${when}${top.length ? `, mostly ${top.join(' and ')}` : ''}. ${TIPS[mode] || TIPS.walk}`;
    const banner = $('#danger-banner');
    banner.className = 'danger-banner';
    banner.replaceChildren(
      h('div', { class: 'd-icon' }, iconEl('octagon', 'icon')),
      h('div', null, h('b', null, title), h('span', null, text)),
      h('button', { class: 'btn btn-sm', type: 'button' }, 'OK'),
      h('i', { class: 'banner-timer', 'aria-hidden': 'true' }),
    );
    banner.hidden = true; // restart the entry animation
    void banner.offsetWidth;
    banner.hidden = false;
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hide(), 10000);
    const activated = !navigator.userActivation || navigator.userActivation.hasBeenActive;
    if (navigator.vibrate && activated) navigator.vibrate([180, 90, 180]);
    if (this.sound) this.beep();
    return { title, text, area, at: new Date() };
  }

  hide() {
    clearTimeout(this.hideTimer);
    $('#danger-banner').hidden = true;
  }

  beep() {
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      const t = this.ctx.currentTime;
      [880, 660].forEach((freq, i) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t + i * 0.16);
        gain.gain.exponentialRampToValueAtTime(0.12, t + i * 0.16 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.16 + 0.14);
        osc.connect(gain).connect(this.ctx.destination);
        osc.start(t + i * 0.16);
        osc.stop(t + i * 0.16 + 0.15);
      });
    } catch {
      // sound is optional
    }
  }
}

export class TripView {
  constructor({ model, mapView, alerts, onExit }) {
    this.model = model;
    this.map = mapView;
    this.alerts = alerts;
    this.onExit = onExit;
    this.active = false;
  }

  start({ route, simulate, band, mode, to }) {
    this.stop();
    this.active = true;
    this.route = route;
    this.coords = route.coords;
    this.acc = cumulative(route.coords);
    this.total = this.acc[this.acc.length - 1] || 1;
    this.simulate = simulate;
    this.band = band;
    this.mode = mode;
    this.to = to;
    this.log = [];
    this.lastCheck = 0;
    this.outsideNoted = false;
    this.alerts.reset();
    this.render();
    this.map.fit(this.coords);
    this.map.setTraveler(this.coords[0]);
    if (simulate) this.startSim(); else this.startLive();
  }

  render() {
    const r = this.route;
    this.els = {
      progress: h('i'),
      now: h('div', { class: 'trip-now' }),
      left: h('span', { class: 'hint', style: { margin: 0 } }),
      log: h('ul', { class: 'trip-log', 'aria-live': 'polite' }),
    };
    const card = h('div', { class: 'trip-card' },
      h('div', null,
        h('div', { class: 'stat-label' }, this.simulate ? 'Simulated trip' : 'Trip in progress'),
        h('div', { class: 'trip-dest' }, `To ${this.to.name}`)),
      h('div', { class: 'route-mid' },
        iconEl(MODE_ICON[this.mode], 'icon-sm'), this.model.modes[this.mode].label,
        h('span', null, '·'), fmt.duration(r.duration), h('span', null, '·'), fmt.distance(r.distance),
        levelBadge(r.score.level)),
      h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Trip progress', 'aria-valuemin': '0', 'aria-valuemax': '100' }, this.els.progress),
      this.els.now,
      this.els.left,
      h('p', { class: 'hint', style: { margin: 0 } }, this.simulate
        ? 'The trip plays at high speed so you can see where CrimeRadar warns you.'
        : 'CrimeRadar follows your location and warns you before a high-risk block.'));
    const end = h('button', { class: 'btn btn-secondary btn-block', type: 'button', onclick: () => this.onExit() }, iconEl('x', 'icon-sm'), 'End trip');
    $('#view-trip').replaceChildren(
      h('div', { class: 'section' }, card),
      h('div', { class: 'section' }, h('div', { class: 'section-title' }, h('span', null, 'Alerts on this trip')), this.els.log),
      h('div', { class: 'section' }, end));
    this.renderLog();
    this.updateNow(this.coords[0]);
    this.setProgress(0, 0);
  }

  renderLog() {
    if (!this.log.length) {
      this.els.log.replaceChildren(h('li', null, iconEl('shield', 'icon-sm'), 'No alerts yet. You get a warning before a high-risk block.'));
      return;
    }
    this.els.log.replaceChildren(...this.log.map((a) => h('li', { class: 'is-alert' }, iconEl('octagon', 'icon-sm'),
      h('span', null, h('b', null, a.area), ` · ${a.title.startsWith('High-risk area ahead') ? 'warned before entering' : 'warned inside'} at ${fmt.pct(a.progress)} of the trip`))));
  }

  setProgress(f, d) {
    this.els.progress.style.width = `${Math.round(f * 100)}%`;
    this.els.progress.parentElement.setAttribute('aria-valuenow', String(Math.round(f * 100)));
    const remainS = Math.max(0, this.route.duration * (1 - f));
    this.els.left.textContent = f >= 1 ? 'Arrived' : `${fmt.duration(remainS)} left · ${fmt.distance(Math.max(0, this.total - d))}`;
  }

  updateNow(pos) {
    const cell = this.model.cellAt(pos[0], pos[1]);
    const area = (cell && this.model.hoodName(cell.nb)) || this.model.areaName(pos[0], pos[1]) || 'Seattle';
    const level = cell ? this.model.level(this.model.riskAt(cell, this.band) * this.model.vulnerability(this.mode)) : 'low';
    this.els.now.replaceChildren(h('span', null, 'Now in ', h('b', null, area)), levelBadge(level));
  }

  check(pos, d) {
    const ahead = [60, 120].map((x) => pointAt(this.coords, this.acc, d + x));
    const hit = this.alerts.evaluate(pos[0], pos[1], this.band, this.mode, ahead);
    const cooldowns = this.simulate ? { areaCooldown: Infinity, globalCooldown: 3500 } : { areaCooldown: 300000, globalCooldown: 30000 };
    const shown = this.alerts.maybeWarn(hit, this.band, this.mode, cooldowns);
    if (shown) {
      this.log.push({ ...shown, progress: d / this.total });
      this.renderLog();
    }
    this.updateNow(pos);
  }

  startSim() {
    const seconds = clamp(this.route.duration / 25, 14, 40);
    const t0 = performance.now();
    const frame = (now) => {
      if (!this.active) return;
      const f = Math.min(1, (now - t0) / (seconds * 1000));
      const d = f * this.total;
      const pos = pointAt(this.coords, this.acc, d);
      this.map.setTraveler(pos);
      if (!reducedMotion()) this.map.panIfNeeded(pos);
      this.setProgress(f, d);
      if (now - this.lastCheck > 300) {
        this.lastCheck = now;
        this.check(pos, d);
      }
      if (f < 1) this.raf = requestAnimationFrame(frame);
      else this.arrive();
    };
    this.raf = requestAnimationFrame(frame);
  }

  async startLive() {
    if (!('geolocation' in navigator)) {
      toast('This browser cannot share its location. Use Simulate to see the alerts.');
      return;
    }
    const route = this.route;
    if ((await locationPermission()) === 'denied') {
      toast('Location access is off, so live alerts cannot run. Use Simulate to see them.');
    }
    if (!this.active || this.route !== route) return; // the trip ended or changed while we waited
    this.watchId = navigator.geolocation.watchPosition((p) => {
      if (!this.active) return;
      const pos = [p.coords.latitude, p.coords.longitude];
      if (!inSeattle(pos[0], pos[1])) {
        if (!this.outsideNoted) {
          this.outsideNoted = true;
          toast('You are outside Seattle, so live alerts are paused. Use Simulate to see them.', { duration: 7000 });
        }
        return;
      }
      this.map.setTraveler(pos);
      this.map.panIfNeeded(pos);
      const d = this.distanceAlong(pos);
      this.setProgress(d / this.total, d);
      this.check(pos, d);
      if (this.total - d < 30) this.arrive();
    }, (err) => {
      if (err.code === 1) toast('Location access is off, so live alerts cannot run. Use Simulate to see them.');
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  }

  distanceAlong(pos) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.coords.length; i++) {
      const dd = haversine(pos, this.coords[i]);
      if (dd < bestD) { bestD = dd; best = i; }
    }
    return this.acc[best];
  }

  arrive() {
    this.stopMotion();
    this.setProgress(1, this.total);
    const n = this.log.length;
    toast(n ? `You arrived. CrimeRadar warned you ${n} time${n > 1 ? 's' : ''} on the way.` : 'You arrived. No high-risk blocks on the way.', { duration: 6000 });
    const done = h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: () => this.onExit() }, iconEl('check', 'icon-sm'), 'Done');
    const endSection = $('#view-trip').lastElementChild;
    endSection.replaceChildren(done);
  }

  stopMotion() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  stop() {
    this.stopMotion();
    if (!this.active) return;
    this.active = false;
    this.map.setTraveler(null);
    this.alerts.hide();
  }
}

/** Background alerts when no trip runs: only if the user turned alerts on and already allowed location. */
export class PassiveWatcher {
  constructor({ model, alerts, getPrefs, isBusy }) {
    this.model = model;
    this.alerts = alerts;
    this.getPrefs = getPrefs;
    this.isBusy = isBusy;
    this.watchId = null;
    this.seq = 0;
  }

  async start() {
    this.stop();
    const seq = ++this.seq; // overlapping starts: only the newest one may create a watch
    const prefs = this.getPrefs();
    if (!prefs.alerts || !('geolocation' in navigator)) return;
    if ((await locationPermission()) !== 'granted') return;
    if (seq !== this.seq) return;
    this.watchId = navigator.geolocation.watchPosition((p) => {
      if (this.isBusy() || !this.getPrefs().alerts) return;
      const { latitude: lat, longitude: lng } = p.coords;
      if (!inSeattle(lat, lng)) return;
      const band = bandOfHour(seattleClock().hour);
      const mode = this.getPrefs().mode || 'walk';
      this.alerts.maybeWarn(this.alerts.evaluate(lat, lng, band, mode), band, mode, { areaCooldown: 900000, globalCooldown: 120000 });
    }, () => {}, { enableHighAccuracy: false, maximumAge: 30000, timeout: 30000 });
  }

  stop() {
    this.seq++;
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }
}
