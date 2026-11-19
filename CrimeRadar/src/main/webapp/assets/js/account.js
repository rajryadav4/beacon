// Account menu: route settings (travel mode, safety vs speed, alerts), saved places, data info, sign out.
// It is a single layer: Escape, the browser back button, the close button and an outside click all close it.

import { $, h, toast, debounce, fmt } from './ui.js';
import { iconEl, KIND_ICON, MODE_ICON } from './icons.js';
import { account, getMode } from './api.js';

export class AccountMenu {
  constructor({ user, model, onPrefs, onPlaces, onLogout }) {
    this.user = user;
    this.model = model;
    this.onPrefs = onPrefs;
    this.onPlaces = onPlaces;
    this.onLogout = onLogout;
    this.places = [];
    this.isOpen = false;
    this.button = $('#avatar-btn');
    this.menu = $('#account-menu');
    this.savePrefs = debounce((prefs) => this.persist(prefs), 400);
    this.onDocKey = (e) => { if (e.key === 'Escape') this.close(); };
    // An outside click only closes the menu. The click itself is swallowed, so it cannot also
    // start a navigation that races with the history.back() of the close.
    this.onDocDown = (e) => {
      if (this.menu.contains(e.target) || this.button.contains(e.target)) return;
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      document.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 600);
      this.close();
    };
  }

  mount() {
    this.button.textContent = initials(this.user.displayName);
    this.button.setAttribute('aria-label', `Account: ${this.user.displayName}`);
    this.button.addEventListener('click', () => (this.isOpen ? this.close() : this.open()));
    window.addEventListener('popstate', () => {
      if (this.isOpen && !(history.state && history.state.layer === 'account')) this.close(true);
    });
  }

  setPlaces(places) {
    this.places = places;
    if (this.isOpen) this.render();
  }

  async open() {
    this.isOpen = true;
    this.render();
    this.menu.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    history.pushState({ layer: 'account' }, '');
    document.addEventListener('keydown', this.onDocKey);
    document.addEventListener('pointerdown', this.onDocDown, true);
    const first = this.menu.querySelector('input, button');
    if (first) first.focus();
    try {
      this.places = await account.listPlaces();
      if (this.isOpen) this.renderPlaces();
    } catch {
      // the list keeps the last known places
    }
  }

  close(fromHistory = false) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.menu.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', this.onDocKey);
    document.removeEventListener('pointerdown', this.onDocDown, true);
    if (!fromHistory && history.state && history.state.layer === 'account') history.back();
    this.button.focus();
  }

  prefs() {
    return { mode: 'walk', safetyWeight: 0.7, alerts: true, ...this.user.preferences };
  }

  update(change) {
    this.user.preferences = { ...this.prefs(), ...change };
    this.onPrefs(this.user.preferences);
    this.savePrefs(this.user.preferences);
  }

  async persist(prefs) {
    try {
      // real types here; the server call turns them into form text, the offline store keeps them typed
      await account.savePreferences({ mode: prefs.mode, safetyWeight: Math.round(Number(prefs.safetyWeight) * 100) / 100, alerts: !!prefs.alerts });
    } catch (e) {
      toast(e.message || 'Could not save your settings.');
    }
  }

  render() {
    const p = this.prefs();
    const modeSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Usual travel mode' },
      ...['walk', 'bike', 'car'].map((m) => h('label', null,
        h('input', { type: 'radio', name: 'pref-mode', value: m, checked: p.mode === m, onchange: () => this.update({ mode: m }) }),
        h('span', null, iconEl(MODE_ICON[m], 'icon-sm'), this.model.modes[m].label))));

    const weightPct = Math.round(Number(p.safetyWeight) * 100);
    const weightText = h('p', { class: 'hint' }, weightText_(weightPct));
    const range = h('input', {
      class: 'range', type: 'range', min: '0', max: '100', step: '10', value: String(weightPct),
      'aria-label': 'Safety versus speed', 'aria-valuetext': weightText_(weightPct),
      oninput: (e) => {
        const v = Number(e.target.value);
        weightText.textContent = weightText_(v);
        e.target.setAttribute('aria-valuetext', weightText_(v));
        this.update({ safetyWeight: v / 100 });
      },
    });

    const alerts = h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: !!p.alerts, 'aria-label': 'Danger alerts', onchange: (e) => this.update({ alerts: e.target.checked }) }),
      h('span'));

    this.placesEl = h('ul', { class: 'place-list' });
    const meta = this.model.meta;
    const modeText = getMode() === 'server' ? 'Live: MySQL database' : 'Offline demo data (no server)';

    this.menu.replaceChildren(
      h('div', { class: 'account-head' },
        h('span', { class: 'avatar-lg', 'aria-hidden': 'true' }, initials(this.user.displayName)),
        h('div', { style: { flex: 1, minWidth: 0 } }, h('b', null, this.user.displayName), h('span', null, this.user.email)),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => this.close() }, iconEl('x', 'icon'))),
      h('div', null,
        h('div', { class: 'section-title' }, h('span', null, 'How I usually travel')),
        modeSeg),
      h('div', { class: 'menu-section' },
        h('div', { class: 'section-title' }, h('span', null, 'Route choice')),
        range,
        h('div', { class: 'range-labels' }, h('span', null, 'Fastest'), h('span', null, 'Safest')),
        weightText),
      h('div', { class: 'menu-section switch-row' },
        h('div', null, h('b', null, 'Danger alerts'), h('p', { class: 'hint', style: { margin: '2px 0 0' } }, 'Warn me before I enter a high-risk block. Uses my location in Seattle.')),
        alerts),
      h('div', { class: 'menu-section' },
        h('div', { class: 'section-title' }, h('span', null, 'Saved places')),
        this.placesEl),
      h('div', { class: 'menu-section' },
        h('div', { class: 'section-title' }, h('span', null, 'About the data')),
        h('p', { class: 'hint', style: { margin: 0 } },
          `${modeText}. ${fmt.int(meta.totals.incidents)} reports, ${meta.dataRange.from} to ${meta.dataRange.to}. Risk model: ${meta.model && meta.model.version ? meta.model.version : 'baseline'}.`)),
      h('div', { class: 'menu-section' },
        h('button', { class: 'btn btn-secondary btn-block', type: 'button', onclick: () => this.onLogout() }, iconEl('logout', 'icon-sm'), 'Sign out')),
    );
    this.renderPlaces();
  }

  renderPlaces() {
    if (!this.placesEl) return;
    if (!this.places.length) {
      this.placesEl.replaceChildren(h('li', { style: { display: 'block' } }, h('span', { class: 'hint' }, 'No saved places yet. Tap the star next to a destination to save it.')));
      return;
    }
    const order = { home: 0, work: 1, saved: 2 };
    const sorted = [...this.places].sort((a, b) => order[a.kind] - order[b.kind]);
    this.placesEl.replaceChildren(...sorted.map((p) => h('li', null,
      h('span', { class: 's-icon', style: { display: 'grid', placeItems: 'center' } }, iconEl(KIND_ICON[p.kind] || 'star', 'icon-sm')),
      h('span', { style: { minWidth: 0 } }, h('div', { class: 'p-name' }, p.label), h('div', { class: 'p-addr' }, p.address || '')),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove ${p.label}`, onclick: () => this.remove(p) }, iconEl('trash', 'icon-sm')))));
  }

  async remove(place) {
    this.places = this.places.filter((x) => x.id !== place.id);
    this.renderPlaces();
    this.onPlaces(this.places);
    try {
      await account.deletePlace(place.id);
      toast(`Removed ${place.label}.`, {
        actionLabel: 'Undo',
        onAction: async () => {
          try {
            await account.savePlace(place);
            this.places = await account.listPlaces();
            this.renderPlaces();
            this.onPlaces(this.places);
          } catch (e) {
            toast(e.message || 'Could not restore the place.');
          }
        },
      });
    } catch (e) {
      this.places = await account.listPlaces().catch(() => [...this.places, place]);
      this.renderPlaces();
      this.onPlaces(this.places);
      toast(e.message || 'Could not remove the place.');
    }
  }
}

function weightText_(pct) {
  if (pct >= 90) return 'Always pick the safest route, even if it takes longer.';
  if (pct <= 10) return 'Always pick the fastest route.';
  return `Routes are ranked ${pct}% on safety and ${100 - pct}% on travel time.`;
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
