// Directions / safe routes (class app's directions.js): From and To with search, "My location" and
// pick-on-map; travel mode; departure time; up to 3 routes scored with the ML risk grid at the time of
// travel, coloured green / orange / red with R1-R3 pills, the recommendation and a "Why?" per route.

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../../api';
import { useApp } from '../../context';
import { clockLabel, isDarkBand } from '../../lib/clock';
import { isAbort } from '../../lib/format';
import { DEMO_START, distM, inSeattle, type LatLng } from '../../lib/geo';
import { ROLE_COLOR } from '../../lib/map/style';
import type { Place } from '../../lib/places';
import { departure, nextQuarter, scoreRoutes, type ScoredRoute } from '../../lib/plan';
import { MODES, type Mode } from '../../lib/risk';
import { fetchRoutes, type RawRoute } from '../../lib/routing';
import { upsertPlace, type SavedKind } from '../../lib/storage';
import { BAND_ICON, Floating, Icon, KIND_ICON, MODE_ICON } from '../ui';
import PlaceBox, { type Section } from './PlaceBox';
import RouteCard from './RouteCard';

export interface DirState { from: Place | null; to: Place | null; mode: Mode; when: { now: boolean; time: string } }
export const initialDir = (mode: Mode): DirState => ({ from: null, to: null, mode, when: { now: true, time: nextQuarter() } });

export interface StartTrip { route: ScoredRoute; simulate: boolean; dir: DirState }

const MODE_VERB: Record<Mode, string> = { walk: 'walking', bike: 'biking', car: 'driving' };

type Phase = { kind: 'empty' } | { kind: 'loading' } | { kind: 'same' } | { kind: 'error'; message: string } | { kind: 'ready' };

interface Props {
  dir: DirState;
  setDir: (fn: (d: DirState) => DirState) => void;
  onStart: (t: StartTrip) => void;
  hazard: string;
  focusTo: number;
}

export default function DirectionsView({ dir, setDir, onStart, hazard, focusTo }: Props) {
  const app = useApp();
  const { model, ctrl, toast, location, places, trips, landmarks, prefs } = app;
  const { from, to, mode, when } = dir;
  const [raw, setRaw] = useState<RawRoute[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: 'empty' });
  const [selected, setSelected] = useState(0);
  const [fromPending, setFromPending] = useState<string | undefined>();
  const [saveRow, setSaveRow] = useState(false);
  const [retry, setRetry] = useState(0);
  const [findingSafe, setFindingSafe] = useState(false);
  const toInput = useRef<HTMLInputElement>(null);
  const triedGps = useRef(false);
  const dep = useMemo(() => departure(when), [when]);
  const set = (patch: Partial<DirState>) => setDir((d) => ({ ...d, ...patch }));

  useEffect(() => { if (focusTo) window.setTimeout(() => toInput.current?.focus(), 60); }, [focusTo]);

  // Start from the user's location when there is no start yet (a set location, never a surprise GPS prompt).
  useEffect(() => {
    if (from || triedGps.current) return;
    triedGps.current = true;
    if (location) set({ from: { name: 'My location', detail: model.areaName(location.lat, location.lng) ?? 'Seattle', lat: location.lat, lng: location.lng, kind: 'gps' } });
  }, []);

  // Fetch routes when the trip changes.
  useEffect(() => {
    setSaveRow(false);
    if (!from || !to) { setRaw([]); setPhase({ kind: 'empty' }); if (from && !to) ctrl.flyTo(from.lat, from.lng, 14); return; }
    if (distM(from, to) < 40) { setRaw([]); setPhase({ kind: 'same' }); return; }
    const c = new AbortController();
    const timer = window.setTimeout(() => setPhase({ kind: 'loading' }), 250);
    fetchRoutes(from, to, mode, c.signal)
      .then((r) => { window.clearTimeout(timer); setRaw(r); setSelected(0); setPhase({ kind: 'ready' }); fitRoutes(r); })
      .catch((e) => {
        window.clearTimeout(timer);
        if (isAbort(e) || c.signal.aborted) return;
        setRaw([]);
        setPhase({ kind: 'error', message: e instanceof Error ? e.message : 'The routing service did not answer.' });
        ctrl.fit([[from.lat, from.lng], [to.lat, to.lng]]);
      });
    return () => { window.clearTimeout(timer); c.abort(); };
  }, [from, to, mode, retry]);

  const fitRoutes = (r: RawRoute[]) => ctrl.fit(r.flatMap((x) => [x.coords[0], x.coords[Math.floor(x.coords.length / 2)], x.coords[x.coords.length - 1]]));

  const scored = useMemo(() => (raw.length ? scoreRoutes(raw, model, mode, dep, prefs.safetyWeight) : null), [raw, model, mode, dep, prefs.safetyWeight]);
  const routes = scored?.routes ?? [];

  // Map: departure-time palette, faint risk grid for context, endpoints and the routes.
  useEffect(() => {
    ctrl.setDark(isDarkBand(dep.band));
    const cells = [];
    for (const cell of model.cells.values()) {
      const risk = model.riskAt(cell, dep.band) * model.vulnerability(mode);
      const level = model.level(risk);
      if (level !== 'low') cells.push({ bounds: model.bounds(cell.id), level, risk });
    }
    ctrl.setGrid(cells, routes.length ? { faint: true } : { subtle: true });
    ctrl.setLayer('grid');
  }, [ctrl, model, dep.band, mode, routes.length]);

  useEffect(() => { ctrl.setEndpoints(from, to, to?.kind === 'safe'); }, [ctrl, from, to]);

  useEffect(() => {
    if (!routes.length) { ctrl.clearRoutes(); return; }
    ctrl.drawRoutes(routes.map((r) => ({ coords: r.coords, role: r.role, duration: r.duration, hotspots: r.score.hotspots })), Math.min(selected, routes.length - 1), setSelected);
  }, [ctrl, routes, selected]);

  useEffect(() => () => { ctrl.clearRoutes(); ctrl.setEndpoints(null, null); ctrl.setLayer('none'); }, [ctrl]);

  // ---------- inputs ----------
  const asPlace = (p: { label: string; address: string; lat: number; lng: number; kind: SavedKind }): Place =>
    ({ name: p.label, detail: p.address, lat: p.lat, lng: p.lng, kind: p.kind });

  const recent = useMemo(() => {
    const seen = new Set<string>();
    const out: Place[] = [];
    for (const t of trips) {
      const key = `${t.toLabel}|${t.toLat.toFixed(4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: t.toLabel, detail: 'Recent trip', lat: t.toLat, lng: t.toLng, kind: 'recent' });
    }
    return out;
  }, [trips]);

  const suggestions = (q: string, forFrom: boolean): Section[] => {
    const ql = q.toLowerCase();
    const saved = places.map(asPlace);
    const marks: Place[] = landmarks.map((l) => ({ name: l.name, detail: l.category ?? 'Landmark', lat: l.lat, lng: l.lng, kind: 'landmark' }));
    const out: Section[] = [];
    if (!q) {
      out.push({ title: null, items: [
        { name: 'My location', detail: location ? 'Your set location' : 'Use this device’s location', lat: 0, lng: 0, kind: 'gps' },
        { name: 'Pick on the map', detail: forFrom ? 'Tap where you start' : 'Tap where you go', lat: 0, lng: 0, kind: 'pin' },
      ] });
      if (saved.length) out.push({ title: 'Saved', items: saved });
      if (recent.length) out.push({ title: 'Recent', items: recent.slice(0, 3) });
      out.push({ title: 'Popular places', items: marks.slice(0, 6) });
    } else {
      const match = (x: Place) => x.name.toLowerCase().includes(ql) || String(x.detail ?? '').toLowerCase().includes(ql);
      const found = [...saved, ...recent, ...marks].filter(match).slice(0, 5);
      if (found.length) out.push({ title: 'Suggestions', items: found });
    }
    return out;
  };

  const myLocation = async (field: 'from' | 'to') => {
    const apply = (l: LatLng) => {
      const p: Place = { name: 'My location', detail: model.areaName(l.lat, l.lng) ?? 'Seattle', lat: l.lat, lng: l.lng, kind: 'gps' };
      set(field === 'from' ? { from: p } : { to: p });
    };
    if (location) { apply(location); return; }
    if (field === 'from') setFromPending('Finding your location…');
    try {
      const l = await app.locate();
      if (!inSeattle(l.lat, l.lng)) {
        if (field === 'from') set({ from: { ...DEMO_START, kind: 'demo' } });
        toast('You are outside Seattle, so trips start at Pike Place Market. Tap the map to choose a start instead.');
      } else apply(l);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not get your location.', { actionLabel: 'Pick on map', onAction: () => pickOnMap(field) });
    } finally {
      setFromPending(undefined);
    }
  };

  const pickOnMap = (field: 'from' | 'to') => {
    app.startPick(field === 'from' ? 'Tap the map where you start' : 'Tap the map where you want to go', (p) => {
      const area = model.areaName(p.lat, p.lng);
      if (field === 'from') {
        // A picked start is where you are: alerts and safe places use it too.
        app.setLocation({ ...p, source: 'map' });
        set({ from: { name: 'My location (pinned)', detail: area ?? 'Point on the map', lat: p.lat, lng: p.lng, kind: 'gps' } });
      } else {
        set({ to: { name: area ? `Pinned point · ${area}` : 'Pinned point', detail: 'Point on the map', lat: p.lat, lng: p.lng, kind: 'pin' } });
      }
    });
  };

  const onPick = (field: 'from' | 'to') => (p: Place) => {
    if (p.kind === 'gps' && p.lat === 0) { void myLocation(field); return; }
    if (p.kind === 'pin' && p.lat === 0) { pickOnMap(field); return; }
    set(field === 'from' ? { from: p } : { to: p });
  };

  const nearestSafe = async () => {
    const start = from ?? location;
    if (!start) { toast('Set your start first: My location, a search, or a tap on the map.'); return; }
    setFindingSafe(true);
    try {
      const d = await api.nearestSafePlaces(start.lat, start.lng, hazard, 1);
      const p = d.places[0];
      if (!p) { toast('No suitable safe place found nearby.'); return; }
      if (!from) set({ from: { name: 'My location', detail: model.areaName(start.lat, start.lng) ?? 'Seattle', lat: start.lat, lng: start.lng, kind: 'gps' } });
      set({ to: { name: p.name || p.kindLabel, detail: `${p.kindLabel} · safe place`, lat: p.lat, lng: p.lng, kind: 'safe', safeKind: p.kind } });
    } catch (e) {
      toast(errorMessage(e, 'safe places'));
    } finally {
      setFindingSafe(false);
    }
  };

  const save = (kind: SavedKind) => {
    if (!to) return;
    const label = kind === 'home' ? 'Home' : kind === 'work' ? 'Work' : to.name.slice(0, 100);
    app.setPlaces(upsertPlace(places, { kind, label, address: [to.name, to.detail].filter(Boolean).join(', ').slice(0, 255), lat: to.lat, lng: to.lng }));
    set({ to: { ...to, kind } });
    setSaveRow(false);
    toast(kind === 'saved' ? `Saved “${label}” in this browser.` : `Saved as your ${label} in this browser.`);
  };

  const home = places.find((p) => p.kind === 'home');
  const work = places.find((p) => p.kind === 'work');
  const canSave = to && !['home', 'work', 'saved'].includes(to.kind)
    && !places.some((p) => Math.abs(p.lat - to.lat) < 1e-4 && Math.abs(p.lng - to.lng) < 1e-4);
  const askToSave = (kind: string) => {
    toast(`Search for your ${kind} address in “Where to?”, then tap the star to save it.`);
    toInput.current?.focus();
  };

  const fieldActions = (field: 'from' | 'to') => (
    <>
      <button className="icon-btn" type="button" title="Use my location" aria-label={`${field === 'from' ? 'Start' : 'Go'} from my location`} onClick={() => void myLocation(field)}><Icon name="locate" /></button>
      <button className="icon-btn" type="button" title="Pick on the map" aria-label={`Pick the ${field === 'from' ? 'start' : 'destination'} on the map`} onClick={() => pickOnMap(field)}><Icon name="crosshair" /></button>
      {field === 'to' && canSave && (
        <button className="icon-btn" type="button" title="Save this place" aria-label="Save this place" aria-expanded={saveRow} onClick={() => setSaveRow(!saveRow)}><Icon name="star" /></button>
      )}
    </>
  );

  return (
    <section aria-label="Directions">
      <div className="section">
        <div className="trip-form">
          <PlaceBox label="From" placeholder="Choose start" markerClass="marker-from" value={from} pendingText={fromPending}
            local={(q) => suggestions(q, true)} onPick={onPick('from')} actions={fieldActions('from')} />
          <PlaceBox label="To" placeholder="Where to?" markerClass="marker-to" value={to} inputRef={toInput}
            local={(q) => suggestions(q, false)} onPick={onPick('to')} actions={fieldActions('to')} />
          <button className="icon-btn swap-btn" type="button" title="Swap start and destination" aria-label="Swap start and destination"
            onClick={() => (from || to) && set({ from: to, to: from })}><Icon name="swap" /></button>
        </div>
        <div className="quick" aria-label="Saved places">
          {home ? <button className="quick-btn" type="button" title={home.address} onClick={() => set({ to: asPlace(home) })}><Icon name="home" className="icon-sm" />Home</button>
            : <button className="quick-btn" type="button" onClick={() => askToSave('home')}><Icon name="home" className="icon-sm" />Set Home</button>}
          {work ? <button className="quick-btn" type="button" title={work.address} onClick={() => set({ to: asPlace(work) })}><Icon name="work" className="icon-sm" />Work</button>
            : <button className="quick-btn" type="button" onClick={() => askToSave('work')}><Icon name="work" className="icon-sm" />Set Work</button>}
          <button className="quick-btn quick-safe" type="button" disabled={findingSafe} onClick={() => void nearestSafe()}>
            <Icon name="shield" className="icon-sm" />{findingSafe ? 'Finding…' : 'Nearest safe place'}
          </button>
          {places.filter((x) => x.kind === 'saved').slice(0, 6).map((p) => (
            <button key={p.id} className="quick-btn" type="button" title={p.address} onClick={() => set({ to: asPlace(p) })}><Icon name="star" className="icon-sm" />{p.label}</button>
          ))}
          {recent.slice(0, 2).map((r) => (
            <button key={`${r.name}${r.lat}`} className="quick-btn" type="button" title="Recent trip" onClick={() => set({ to: r })}><Icon name="history" className="icon-sm" />{r.name}</button>
          ))}
        </div>
        {saveRow && to && (
          <div className="quick" role="group" aria-label="Save destination as">
            <span className="hint" style={{ alignSelf: 'center', margin: 0 }}>Save as:</span>
            {(['home', 'work', 'saved'] as const).map((k) => (
              <button key={k} className="quick-btn" type="button" onClick={() => save(k)}><Icon name={KIND_ICON[k]} className="icon-sm" />{k === 'saved' ? 'Favorite' : k === 'home' ? 'Home' : 'Work'}</button>
            ))}
            <button className="quick-btn" type="button" onClick={() => setSaveRow(false)}>Cancel</button>
          </div>
        )}
      </div>

      <div className="options-row">
        <div className="seg" role="radiogroup" aria-label="Travel mode">
          {MODES.map((m) => (
            <label key={m}>
              <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => set({ mode: m })} />
              <span><Icon name={MODE_ICON[m]} className="icon-sm" />{model.modes[m]?.label ?? m}</span>
            </label>
          ))}
        </div>
        <div className="time-row">
          <div className="seg" role="radiogroup" aria-label="Departure time">
            <label><input type="radio" name="when" checked={when.now} onChange={() => set({ when: { ...when, now: true } })} /><span>Leave now</span></label>
            <label><input type="radio" name="when" checked={!when.now} onChange={() => set({ when: { ...when, now: false } })} /><span>Leave at…</span></label>
          </div>
          {!when.now && (
            <>
              <label className="sr-only" htmlFor="depart-time">Departure time</label>
              <input className="time-input" id="depart-time" type="time" step={900} value={when.time} onChange={(e) => set({ when: { now: false, time: e.target.value } })} />
            </>
          )}
        </div>
      </div>

      <div className="routes" aria-live="polite">
        {phase.kind === 'empty' && (
          <div className="empty"><Icon name="route" /><b>Plan a safer trip</b>Choose where you start and where you go. Beacon compares up to 3 routes for the time you travel.</div>
        )}
        {phase.kind === 'same' && <div className="empty"><Icon name="info" /><b>Start and destination are the same place.</b>Pick a different destination.</div>}
        {phase.kind === 'loading' && (<><div className="sr-only">Finding routes…</div>{[0, 1, 2].map((i) => <div key={i} className="skeleton" aria-hidden="true" />)}</>)}
        {phase.kind === 'error' && (
          <div className="inline-error" role="alert">
            <b>Could not get routes</b><span>{phase.message}</span>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => setRetry((n) => n + 1)}>Try again</button>
          </div>
        )}
        {phase.kind === 'ready' && routes.length > 0 && (
          <>
            <p className="hint" style={{ margin: '0 0 2px' }}>
              {routes.length} route{routes.length > 1 ? 's' : ''} for {MODE_VERB[mode]}, {dep.now ? 'leaving now' : `leaving at ${clockLabel(dep.hour, dep.minute)}`} ({model.bandLabel(dep.band).toLowerCase()}).
            </p>
            {scored?.explanation && <p className="route-why" role="status"><b>Why this route? </b>{scored.explanation}</p>}
            {routes.map((r, i) => (
              <RouteCard key={r.id} route={r} index={i} selected={i === selected} mode={mode} dep={dep}
                onSelect={() => setSelected(i)} onStart={(simulate) => onStart({ route: r, simulate, dir })} />
            ))}
          </>
        )}
      </div>

      <Floating>
        <div className="time-badge" aria-live="polite">
          <Icon name={BAND_ICON[String(dep.band)]} />
          <span>{dep.now ? 'Leaving now' : 'Leaving at'} {clockLabel(dep.hour, dep.minute)} <small>{model.bandLabel(dep.band)} · {model.modes[mode]?.label.toLowerCase()} risk shown</small></span>
        </div>
        <div className="legend legend-compact">
          <div className="legend-levels" title={`Line colors compare the routes with each other, for ${MODE_VERB[mode]}. Each card shows the route's own risk level.`}>
            <b>Routes</b>
            <div><span className="swatch swatch-line" style={{ background: ROLE_COLOR.best }} /><span>Recommended</span></div>
            <div><span className="swatch swatch-line" style={{ background: ROLE_COLOR.mid }} /><span>Moderate</span></div>
            <div><span className="swatch swatch-line" style={{ background: ROLE_COLOR.worst }} /><span>Most dangerous</span></div>
            <div><span className="swatch-dot" /><span>High-risk block</span></div>
          </div>
        </div>
      </Floating>
    </section>
  );
}
