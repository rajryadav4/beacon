// Start-up and navigation. One router owns the views:
//   #/explore  (home)  --push-->  #/directions  --push-->  #/trip
// Back returns one step. The account menu is the only layer and closes before the page changes.

import { $, h, toast, seattleClock, greeting, bandOfHour, isPhone } from './ui.js';
import { iconEl } from './icons.js';
import * as api from './api.js';
import { RiskModel, STREET_GROUPS } from './risk.js';
import { createMapView } from './mapview.js';
import { Explore } from './explore.js';
import { Directions } from './directions.js';
import { TripView, DangerAlerts, PassiveWatcher } from './trip.js';
import { AccountMenu } from './account.js';
import { LoginView } from './auth.js';
import { getPosition, inSeattle } from './geo.js';

const app = { current: null, built: false };
const ROUTES = ['explore', 'directions', 'trip'];
window.crimeRadar = app; // handle for debugging in the browser console

boot();

async function boot() {
  $('#boot-retry').addEventListener('click', () => location.reload());
  if (!window.maplibregl && !(window.L && L.heatLayer)) {
    $('#boot-text').textContent = 'The map library did not load. Check the internet connection, then try again.';
    $('#boot-text').classList.add('boot-error');
    $('#boot-retry').hidden = false;
    return;
  }
  try {
    await api.detectMode();
    const data = await api.loadMapData();
    app.model = new RiskModel(data.meta, data.grid, data.hoods);
    app.landmarks = data.landmarks;
    app.map = await createMapView('map');
    app.login = new LoginView({ onSignedIn: (user) => enterApp(user, true) });
    app.login.mount();
    let user = null;
    try {
      user = await api.auth.me();
    } catch {
      user = null;
    }
    $('#boot').hidden = true;
    if (user) enterApp(user, false);
    else showLogin();
  } catch (e) {
    console.error(e);
    $('#boot-text').textContent = 'Could not load the crime data. Check the connection, then try again.';
    $('#boot-text').classList.add('boot-error');
    $('#boot-retry').hidden = false;
  }
}

function showLogin() {
  $('#app').hidden = true;
  const m = app.model;
  app.map.setDark(true);
  app.map.setLayer('heat');
  app.map.cellInfo = null;
  const pts = [];
  for (const c of m.cells.values()) {
    const w = m.countCell(c, 'all', [0, 1, 2, 3, 4, 5, 6]);
    if (w > 0) pts.push([c.lat, c.lng, w]);
  }
  const sorted = pts.map((p) => p[2]).sort((a, b) => a - b);
  app.map.setHeat(pts, sorted[Math.floor(sorted.length * 0.97)] || 1);
  app.map.setView(47.62, -122.33, isPhone() ? 12 : 13);
  app.map.startShowcase(); // vector map: a slow orbit over the 3D city behind the sign-in card
  app.login.show(m);
}

function enterApp(user, fresh) {
  app.user = user;
  app.login.hide();
  app.map.stopShowcase();
  $('#app').hidden = false;
  if (!app.built) build();
  renderGreeting();
  if (fresh || !ROUTES.includes(routeName())) location.replace('#/explore');
  render();
}

function build() {
  app.built = true;
  const { model, map } = app;

  app.explore = new Explore({
    model, mapView: map,
    onWhereTo: () => { go('directions'); app.directions.focusTo(); },
  });
  app.explore.mount();

  app.alerts = new DangerAlerts(model);
  app.directions = new Directions({
    model, mapView: map, landmarks: app.landmarks, user: app.user,
    onStartTrip: (trip) => startTrip(trip),
    onPrefsChange: (change) => { if (change.places) app.menu.setPlaces(change.places); },
  });
  app.directions.mount();
  app.directions.loadPersonal().then(() => app.menu.setPlaces(app.directions.places));

  app.trip = new TripView({ model, mapView: map, alerts: app.alerts, onExit: () => endTrip() });

  app.menu = new AccountMenu({
    user: app.user, model,
    onPrefs: (prefs) => {
      app.directions.setPrefs(prefs);
      app.passive.start();
    },
    onPlaces: (places) => app.directions.setPlaces(places),
    onLogout: () => logout(),
  });
  app.menu.mount();

  app.passive = new PassiveWatcher({
    model, alerts: app.alerts,
    getPrefs: () => app.user.preferences || {},
    isBusy: () => app.trip.active,
  });
  setTimeout(() => app.passive.start(), 5000); // let the person look around before any alert

  $('#tab-explore').addEventListener('click', () => go('explore'));
  $('#tab-directions').addEventListener('click', () => go('directions'));
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tab.id === 'tab-explore' ? $('#tab-directions') : $('#tab-explore');
      next.focus();
      next.click();
    });
  }

  const handle = $('#sheet-handle');
  handle.addEventListener('click', () => {
    const open = !$('#panel').classList.contains('is-expanded');
    $('#panel').classList.toggle('is-expanded', open);
    handle.setAttribute('aria-expanded', String(open));
    handle.setAttribute('aria-label', open ? 'Collapse panel' : 'Expand panel');
  });

  const tilt = $('#tilt-btn');
  if (app.map.supports3D) {
    tilt.hidden = false;
    tilt.addEventListener('click', () => {
      const on = tilt.getAttribute('aria-pressed') !== 'true';
      tilt.setAttribute('aria-pressed', String(on));
      tilt.title = on ? 'Back to 2D' : '3D view';
      app.map.set3D(on);
      if (on && app.explore && app.current === 'explore' && app.explore.state.layer === 'heat') {
        toast('Tip: switch the map layer to "Risk grid" to see the risk skyline in 3D.');
      }
    });
  }

  const locate = $('#locate-btn');
  locate.append(iconEl('locate', 'icon'));
  locate.addEventListener('click', async () => {
    try {
      const pos = await getPosition(10000);
      if (!inSeattle(pos.lat, pos.lng)) {
        toast('You are outside Seattle. The map stays on Seattle.');
        return;
      }
      app.map.setMe(pos);
      app.map.flyTo(pos.lat, pos.lng, 15);
    } catch (e) {
      toast(e && e.code === 1 ? 'Location access is off. Allow it in the browser settings.' : 'Could not get your location.');
    }
  });

  const pill = $('#mode-pill');
  const server = api.getMode() === 'server';
  pill.replaceChildren(h('span', { class: server ? 'live-dot' : 'live-dot is-offline', 'aria-hidden': 'true' }), server ? 'Live data' : 'Offline data');
  pill.title = server ? 'Data and accounts come from the CrimeRadar server (MySQL).' : 'No server found: map data comes from files, and the account stays in this browser.';

  window.addEventListener('hashchange', render);
}

function renderGreeting() {
  const now = seattleClock();
  const band = bandOfHour(now.hour);
  const first = String(app.user.displayName || '').split(/\s+/)[0] || 'there';
  const top = app.model.rankHoods(band, STREET_GROUPS)[0];
  const el = $('#greeting');
  el.replaceChildren(
    `${greeting(now.hour)}, `, Object.assign(document.createElement('b'), { textContent: first }), '. ',
    top ? `It is ${app.model.bands[band].label.toLowerCase()} in Seattle: street crime is highest around ${top.hood.name} right now.` : '',
  );
}

// ---------------- Router ----------------

function routeName() {
  return location.hash.replace(/^#\/?/, '').split('?')[0];
}

function go(name) {
  const now = routeName();
  if (now === name) {
    render();
    return;
  }
  if (name === 'explore' && now === 'directions' && app.pushedDirections) {
    history.back(); // the Explore entry is right below
    return;
  }
  if (name === 'directions' && now === 'explore') app.pushedDirections = true;
  location.hash = `#/${name}`;
}

function render() {
  if (!app.built || $('#app').hidden) return;
  let r = routeName();
  if (!ROUTES.includes(r)) {
    location.replace('#/explore');
    return;
  }
  if (r === 'trip' && !app.trip.active) {
    location.replace('#/directions');
    return;
  }
  if (r === 'explore') app.pushedDirections = false;
  const prev = app.current;
  if (prev === 'trip' && r !== 'trip') app.trip.stop();

  $('#tab-explore').setAttribute('aria-selected', String(r === 'explore'));
  $('#tab-directions').setAttribute('aria-selected', String(r !== 'explore'));
  $('#tab-explore').tabIndex = r === 'explore' ? 0 : -1;
  $('#tab-directions').tabIndex = r === 'explore' ? -1 : 0;
  $('#view-explore').hidden = r !== 'explore';
  $('#view-directions').hidden = r !== 'directions';
  $('#view-trip').hidden = r !== 'trip';
  document.querySelector('.tabs').hidden = r === 'trip';

  if (prev !== r) {
    if (prev === 'explore') app.explore.deactivate();
    // a jump to Explore from Directions or straight from a trip (history list) clears the route layers
    if ((prev === 'directions' || prev === 'trip') && r === 'explore') app.directions.deactivate();
    if (r === 'explore') app.explore.activate();
    if (r === 'directions') app.directions.activate();
    $('#panel-body').scrollTop = 0;
  }
  app.current = r;
}

function startTrip(trip) {
  if (app.trip.active) return; // one trip at a time
  app.trip.start(trip);
  go('trip');
}

function endTrip() {
  app.trip.stop();
  if (routeName() === 'trip') history.back();
}

async function logout() {
  app.menu.close();
  app.trip.stop();
  app.passive.stop();
  await api.auth.logout();
  location.replace(`${location.pathname}#/explore`);
  location.reload();
}
