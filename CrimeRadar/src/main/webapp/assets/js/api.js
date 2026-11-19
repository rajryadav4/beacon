// Data and account access.
// "server" mode: the Java backend answers under api/ (see docs/API.md).
// "static" mode: no backend; map data comes from assets/data/*.json and the account lives in this browser.

import { fetchWithTimeout } from './ui.js';

export const DEMO = { email: 'demo@crimeradar.app', password: 'CrimeRadar2026!' };

let mode = 'static';
export const getMode = () => mode;

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

export async function detectMode() {
  try {
    const r = await fetchWithTimeout('api/health', { cache: 'no-store', headers: { Accept: 'application/json' } }, 3000);
    const body = r.ok ? await r.json().catch(() => null) : null;
    mode = body && body.ok ? 'server' : 'static';
  } catch {
    mode = 'static';
  }
  return mode;
}

// ---------------- Map data ----------------

async function getJson(path, ms) {
  const r = await fetchWithTimeout(path, { headers: { Accept: 'application/json' } }, ms);
  if (!r.ok) throw new ApiError(`Could not load ${path} (HTTP ${r.status}).`, r.status);
  return r.json();
}

/**
 * The three map files must come from ONE source: grid.json's nbIndex points into the neighborhoods list,
 * so a server grid with a static neighborhoods file could name the wrong area.
 */
export async function loadMapData() {
  const places = fetchWithTimeout('assets/data/places.json', {}, 15000)
    .then((r) => (r.ok ? r.json() : { places: [] }))
    .catch(() => ({ places: [] }));
  let files = null;
  if (mode === 'server') {
    try {
      files = await Promise.all([getJson('api/meta', 20000), getJson('api/grid', 20000), getJson('api/neighborhoods', 20000)]);
    } catch {
      files = null; // use the static copies below, all three of them
    }
  }
  if (!files) {
    files = await Promise.all([
      getJson('assets/data/meta.json', 30000),
      getJson('assets/data/grid.json', 30000),
      getJson('assets/data/neighborhoods.json', 30000),
    ]);
  }
  const [meta, grid, hoods] = files;
  return { meta, grid, hoods, landmarks: (await places).places || [] };
}

// ---------------- Server calls ----------------

async function call(method, path, form) {
  const headers = { Accept: 'application/json' };
  const opts = { method, headers, credentials: 'same-origin', cache: 'no-store' };
  if (method !== 'GET') headers['X-CrimeRadar'] = '1';
  if (form) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) if (v != null) params.append(k, String(v));
    opts.body = params;
  }
  let r;
  try {
    r = await fetchWithTimeout(path, opts, 15000);
  } catch (e) {
    throw new ApiError(e && e.name === 'TimeoutError' ? 'The server did not answer in time. Try again.' : 'Could not reach the CrimeRadar server.', 0);
  }
  if (r.status === 204) return null;
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new ApiError((body && body.error) || `Request failed (HTTP ${r.status}).`, r.status);
  return body;
}

// ---------------- Local (offline mode) account store ----------------
// Offline accounts live in sessionStorage: they end when the tab closes, so a shared exhibition
// laptop does not keep visitors' emails or password hashes. Passwords use salted PBKDF2.

const STORE_KEY = 'crimeradar.local.v2';
const DEFAULT_PREFS = { mode: 'walk', safetyWeight: 0.7, alerts: true };
const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new Uint8Array((hex.match(/../g) || []).map((x) => parseInt(x, 16)));

function normalizePrefs(p) {
  const out = { ...DEFAULT_PREFS, ...p };
  out.mode = ['walk', 'bike', 'car'].includes(out.mode) ? out.mode : 'walk';
  const w = Number(out.safetyWeight);
  out.safetyWeight = Number.isFinite(w) ? Math.min(1, Math.max(0, w)) : DEFAULT_PREFS.safetyWeight;
  out.alerts = out.alerts === true || out.alerts === 'true';
  return out;
}

const local = {
  load() {
    try {
      const db = JSON.parse(sessionStorage.getItem(STORE_KEY));
      if (db && db.users) return db;
    } catch {
      // storage blocked or corrupt: start fresh
    }
    return { users: {}, session: null, seq: 100 };
  },
  save(db) {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify(db)); } catch { /* storage blocked: nothing kept */ }
  },
  /** PBKDF2-SHA-256, 120,000 rounds, 16-byte random salt. Needs a secure page (localhost or https). */
  async hash(password, saltHex) {
    if (!(globalThis.crypto && crypto.subtle)) {
      throw new ApiError('Offline accounts need a secure page (localhost or https). Use the demo account.', 400);
    }
    const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' }, key, 256);
    return { salt: toHex(salt), hash: toHex(new Uint8Array(bits)) };
  },
  sameText(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  },
  ensureDemo(db) {
    if (db.users[DEMO.email]) return;
    db.users[DEMO.email] = {
      id: 1, displayName: 'Demo User', email: DEMO.email, demo: true,
      createdAt: new Date().toISOString(), preferences: { ...DEFAULT_PREFS },
      places: [
        { id: 1, kind: 'home', label: 'Home', address: 'Capitol Hill, Seattle', lat: 47.6235, lng: -122.32 },
        { id: 2, kind: 'work', label: 'Work', address: 'Northeastern University Seattle, 401 Terry Ave N', lat: 47.6226, lng: -122.3375 },
      ],
      trips: [],
    };
  },
  publicUser(u) {
    return { id: u.id, displayName: u.displayName, email: u.email, createdAt: u.createdAt, preferences: normalizePrefs(u.preferences) };
  },
  current(db) {
    return db.session && db.users[db.session] ? db.users[db.session] : null;
  },
  requireUser(db) {
    const u = this.current(db);
    if (!u) throw new ApiError('Please sign in again.', 401);
    return u;
  },
};

// ---------------- Auth ----------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const auth = {
  async me() {
    if (mode === 'server') {
      try {
        const body = await call('GET', 'api/auth/me');
        return body.user;
      } catch (e) {
        if (e.status === 401) return null;
        throw e;
      }
    }
    const db = local.load();
    const u = local.current(db);
    return u ? local.publicUser(u) : null;
  },

  async login(email, password) {
    email = String(email || '').trim();
    if (mode === 'server') return (await call('POST', 'api/auth/login', { email, password })).user;
    const db = local.load();
    local.ensureDemo(db);
    const key = email.toLowerCase();
    const u = db.users[key];
    let ok = false;
    if (u && u.demo) ok = password === DEMO.password; // the demo password is public
    else if (u && u.salt) ok = local.sameText(u.hash, (await local.hash(password, u.salt)).hash);
    if (!ok) throw new ApiError('Email or password is incorrect.', 401);
    db.session = key;
    local.save(db);
    return local.publicUser(u);
  },

  async register(displayName, email, password) {
    displayName = String(displayName || '').trim();
    email = String(email || '').trim();
    if (mode === 'server') return (await call('POST', 'api/auth/register', { displayName, email, password })).user;
    if (!displayName) throw new ApiError('Please enter your name.', 400);
    if (!EMAIL_RE.test(email)) throw new ApiError('Please enter a valid email address.', 400);
    if (String(password).length < 8) throw new ApiError('Use at least 8 characters for the password.', 400);
    const db = local.load();
    local.ensureDemo(db);
    const key = email.toLowerCase();
    if (db.users[key]) throw new ApiError('An account with this email already exists.', 409);
    const { salt, hash } = await local.hash(password);
    db.users[key] = {
      id: ++db.seq, displayName, email: key, createdAt: new Date().toISOString(),
      salt, hash, preferences: { ...DEFAULT_PREFS }, places: [], trips: [],
    };
    db.session = key;
    local.save(db);
    return local.publicUser(db.users[key]);
  },

  async logout() {
    if (mode === 'server') {
      await call('POST', 'api/auth/logout').catch(() => null);
      return;
    }
    const db = local.load();
    db.session = null;
    local.save(db);
  },
};

// ---------------- Personal data ----------------

export const account = {
  async savePreferences(prefs) {
    if (mode === 'server') return (await call('POST', 'api/me/preferences', prefs)).preferences;
    const db = local.load();
    const u = local.requireUser(db);
    u.preferences = normalizePrefs({ ...u.preferences, ...prefs });
    local.save(db);
    return u.preferences;
  },

  async listPlaces() {
    if (mode === 'server') return (await call('GET', 'api/me/places')).places;
    const db = local.load();
    return [...local.requireUser(db).places];
  },

  async savePlace(place) {
    const p = {
      kind: place.kind, label: place.label, address: place.address || '',
      lat: Number(place.lat).toFixed(6), lng: Number(place.lng).toFixed(6),
    };
    if (mode === 'server') return (await call('POST', 'api/me/places', p)).place;
    const db = local.load();
    const u = local.requireUser(db);
    if (p.kind !== 'saved') u.places = u.places.filter((x) => x.kind !== p.kind);
    const saved = { ...p, id: ++db.seq, lat: Number(p.lat), lng: Number(p.lng) };
    u.places.push(saved);
    local.save(db);
    return saved;
  },

  async deletePlace(id) {
    if (mode === 'server') return call('DELETE', `api/me/places/${encodeURIComponent(id)}`);
    const db = local.load();
    const u = local.requireUser(db);
    u.places = u.places.filter((x) => x.id !== id);
    local.save(db);
    return null;
  },

  async listTrips(limit = 10) {
    if (mode === 'server') return (await call('GET', `api/me/trips?limit=${limit}`)).trips;
    const db = local.load();
    return local.requireUser(db).trips.slice(0, limit);
  },

  async saveTrip(trip) {
    if (mode === 'server') return (await call('POST', 'api/me/trips', trip)).trip;
    const db = local.load();
    const u = local.requireUser(db);
    const saved = { ...trip, id: ++db.seq, createdAt: new Date().toISOString() };
    u.trips = [saved, ...u.trips].slice(0, 30);
    local.save(db);
    return saved;
  },
};
