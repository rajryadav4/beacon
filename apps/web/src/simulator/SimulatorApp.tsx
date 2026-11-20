// Beacon Simulator: a "digital twin" demo mode. Pick a calamity, drop it and yourself on the map,
// and watch Beacon work out the danger, what to do and the safest way out. Scenarios are shared
// by link (all inputs live in the URL hash); nothing is stored.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import SimMap, { type PickTarget, type SimMapHandle, type Stage } from './SimMap';
import { destPoint, runSimulation, type Destination, type SimResult } from './api';
import {
  HAZARDS, HAZARD_BY_KEY, PRESETS, compass, decodeScenario, defaultScenario, encodeScenario, formatSize,
  type HazardKey, type LatLng, type Scenario,
} from './scenario';

const ENGINE_LABEL = { valhalla: 'Valhalla (FOSSGIS, OpenStreetMap)', osrm: 'OSRM (OpenStreetMap)', straight_line: 'straight line (routing offline)' } as const;
const STAGE_TEXT: Record<Stage, string> = {
  idle: '', spreading: 'Simulating how the danger spreads', zones: 'Danger zones mapped', route: 'Routing you to safety', done: 'Your way to safety',
};

function Icon({ path, size = 22 }: { path: string; size?: number }) {
  return (
    <svg className="sim-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

const fmtDist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);
const fmtMin = (s: number) => `${Math.max(1, Math.round(s / 60))} min`;
const fmtT = (t: number) => (t >= 120 ? `T+${(t / 60).toFixed(t % 60 ? 1 : 0)} h` : t < 1 && t > 0 ? `T+${Math.round(t * 60)} s` : `T+${Math.round(t)} min`);
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function shareUrl(s: Scenario, play = false) {
  return `${location.origin}${location.pathname}#${encodeScenario(s, play)}`;
}

export default function SimulatorApp() {
  const initial = useMemo(() => decodeScenario(location.hash), []);
  const [scenario, setScenario] = useState<Scenario>(initial?.scenario ?? defaultScenario('earthquake'));
  const [result, setResult] = useState<SimResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<PickTarget>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [clock, setClock] = useState<number | null>(null);
  const [playKey, setPlayKey] = useState(0);
  const [focusKey, setFocusKey] = useState(initial ? 1 : 0);
  const [presenter, setPresenter] = useState(Boolean(initial?.play));
  const [collapsed, setCollapsed] = useState(false);
  const [toast, setToast] = useState<{ text: string; url?: string } | null>(null);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [reducedMotion] = useState(reduced);
  const mapHandle = useRef<SimMapHandle>(null);
  const abort = useRef<AbortController | null>(null);
  const meta = HAZARD_BY_KEY[scenario.hazard];
  const ready = Boolean(scenario.origin && scenario.event);

  const update = (patch: Partial<Scenario>) => {
    setScenario((s) => ({ ...s, ...patch }));
    setActivePreset(null);
  };

  const run = useCallback(async (s: Scenario) => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true);
    setError(null);
    setPick(null);
    try {
      const r = await runSimulation(s, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setResult(r);
      setPlayKey((k) => k + 1);
      setCollapsed(false);
      history.replaceState(null, '', `#${encodeScenario(s, document.documentElement.dataset.presenter === '1')}`);
    } catch (e) {
      if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : 'The simulation failed.');
    } finally {
      if (abort.current === ctrl) setBusy(false);
    }
  }, []);

  // A shared link replays its scenario.
  useEffect(() => {
    if (initial?.scenario.origin && initial.scenario.event) void run(initial.scenario);
  }, [initial, run]);

  useEffect(() => {
    document.documentElement.dataset.presenter = presenter ? '1' : '0';
  }, [presenter]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (pick) setPick(null);
      else if (presenter) setPresenter(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pick, presenter]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), toast.url ? 12000 : 2600);
    return () => clearTimeout(id);
  }, [toast]);

  const loadPreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    setScenario(p.scenario);
    setActivePreset(id);
    setResult(null);
    setFocusKey((k) => k + 1);
    void run(p.scenario);
  };

  const chooseHazard = (key: HazardKey) => {
    setScenario((s) => ({ ...defaultScenario(key), origin: s.origin, event: s.event, mode: s.mode }));
    setActivePreset(null);
    setResult(null);
  };

  const onPick = useCallback((target: 'origin' | 'event', p: LatLng) => {
    setScenario((s) => ({ ...s, [target]: p }));
    setActivePreset(null);
    setResult(null);
    // After placing yourself, place the event next.
    setPick((cur) => (cur === 'origin' && target === 'origin' ? 'event' : null));
  }, []);

  const useCentre = (target: 'origin' | 'event') => {
    const c = mapHandle.current?.center();
    if (c) onPick(target, c);
  };

  const reset = () => {
    abort.current?.abort();
    setBusy(false);
    setResult(null);
    setError(null);
    setPick(null);
    setActivePreset(null);
    setScenario(defaultScenario('earthquake'));
    history.replaceState(null, '', location.pathname);
  };

  const share = async (play = false) => {
    const url = shareUrl(scenario, play);
    try {
      await navigator.clipboard.writeText(url);
      setToast({ text: play ? 'Presenter link copied' : 'Scenario link copied: anyone with it can replay this simulation' });
    } catch {
      setToast({ text: 'Copy this link:', url });
    }
  };

  const togglePresenter = () => {
    const next = !presenter;
    setPresenter(next);
    document.documentElement.dataset.presenter = next ? '1' : '0';
    if (next) {
      if (ready) void run(scenario);
      else loadPreset(PRESETS[0].id);
    }
  };

  const status = result?.userStatus;
  const dest = result?.destination ?? null;

  return (
    <div className={`sim-app${presenter ? ' is-presenter' : ''}${pick ? ' is-picking' : ''}`}>
      <SimMap
        handleRef={mapHandle}
        scenario={scenario}
        result={result}
        playKey={playKey}
        focusKey={focusKey}
        pickTarget={pick}
        onPick={onPick}
        onStage={setStage}
        onClock={setClock}
        reducedMotion={reducedMotion}
      />
      <div className="sim-vignette" aria-hidden="true" />

      <header className="sim-top">
        <div className="sim-brand">
          <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="#34d399" strokeWidth="1.6" /><circle cx="12" cy="12" r="5.5" fill="none" stroke="#34d399" strokeOpacity="0.55" strokeWidth="1.6" /><circle cx="12" cy="12" r="2" fill="#34d399" /></svg>
          <div>
            <strong>Beacon Simulator</strong>
            <span>Digital twin of Seattle</span>
          </div>
        </div>
        <div className="sim-badge" role="note" aria-label="Simulation, not a real alert">
          <span className="dot" aria-hidden="true" />SIMULATION <span className="sim-badge-sub">not a real alert</span>
        </div>
        <nav className="sim-actions" aria-label="Simulator">
          {!presenter && <a className="sim-btn ghost" href="/">&larr; <span className="hide-sm">Back to </span>Beacon</a>}
          {!presenter && <button type="button" className="sim-btn ghost" onClick={() => void share()} disabled={!ready}>Share<span className="hide-sm"> scenario</span></button>}
          <button type="button" className="sim-btn ghost" onClick={togglePresenter} aria-pressed={presenter}>
            {presenter ? 'Exit presenter' : <>Presenter<span className="hide-sm"> mode</span></>}
          </button>
        </nav>
      </header>

      {clock !== null && stage === 'spreading' && (
        <div className="sim-clock" aria-live="off"><span>{fmtT(clock)}</span> simulated time</div>
      )}
      {pick && (
        <div className="sim-pickhint" role="status">
          Click the map to place {pick === 'origin' ? 'yourself' : `the ${meta.label.toLowerCase()}`}
          <button type="button" className="sim-link" onClick={() => setPick(null)}>Cancel (Esc)</button>
        </div>
      )}

      {!presenter && (
        <aside className={`sim-panel${collapsed ? ' is-collapsed' : ''}`} aria-label="Simulation controls and results">
          <div className="sim-panel-head">
            <span>{result ? 'Simulation result' : 'Build a scenario'}</span>
            <button type="button" className="sim-link" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed}>
              {collapsed ? 'Show' : 'Hide'}
            </button>
          </div>
          <div className="sim-panel-body">
            {result ? (
              <ResultView result={result} stage={stage} onReplay={() => setPlayKey((k) => k + 1)}
                          onEdit={() => setResult(null)} onShare={() => void share()} onReset={reset} />
            ) : (
              <SetupView
                scenario={scenario} meta={meta} activePreset={activePreset} busy={busy} ready={ready} error={error} pick={pick}
                onPreset={loadPreset} onHazard={chooseHazard} onPick={setPick} onCentre={useCentre} onUpdate={update}
                onRun={() => void run(scenario)}
              />
            )}
          </div>
        </aside>
      )}

      {presenter && <PresenterCaption result={result} stage={stage} busy={busy} scenario={scenario}
                                      onReplay={() => (result ? setPlayKey((k) => k + 1) : ready && void run(scenario))} />}

      {result && !presenter && stage !== 'spreading' && status && (
        <div className={`sim-status sim-status-${status}`} role="status">
          <strong>{result.headline}</strong>
          <span>{result.actionLabel}{dest && result.route ? ` · ${destPoint(dest).name}, ${fmtMin(result.route.durationS)}` : ''}</span>
        </div>
      )}

      <div className="sim-legend" aria-hidden={!result}>
        {result && (<>
          <span><i className="sw severe" />Severe</span><span><i className="sw moderate" />Danger</span>
          <span><i className="sw route" />Route</span><span><i className="sw bldg" />Buildings at risk</span>
        </>)}
      </div>

      {toast && (
        <div className="sim-toast" role="status">
          {toast.text}
          {toast.url && <input readOnly value={toast.url} onFocus={(e) => e.currentTarget.select()} autoFocus aria-label="Scenario link" />}
        </div>
      )}
    </div>
  );
}

// ---- Setup ----

interface SetupProps {
  scenario: Scenario;
  meta: (typeof HAZARDS)[number];
  activePreset: string | null;
  busy: boolean;
  ready: boolean;
  error: string | null;
  pick: PickTarget;
  onPreset: (id: string) => void;
  onHazard: (key: HazardKey) => void;
  onPick: (t: PickTarget) => void;
  onCentre: (t: 'origin' | 'event') => void;
  onUpdate: (patch: Partial<Scenario>) => void;
  onRun: () => void;
}

function SetupView(p: SetupProps) {
  const { scenario: s, meta } = p;
  const spec = meta.size;
  return (
    <>
      <section className="sim-section">
        <h2><span className="step">1</span>Try a ready-made scenario</h2>
        <div className="sim-presets">
          {PRESETS.map((pr) => {
            const h = HAZARD_BY_KEY[pr.scenario.hazard];
            return (
              <button key={pr.id} type="button" className={`sim-preset${p.activePreset === pr.id ? ' is-active' : ''}`}
                      style={{ '--c': h.color } as CSSProperties} onClick={() => p.onPreset(pr.id)} disabled={p.busy}>
                <Icon path={h.icon} />
                <span><strong>{pr.title}</strong><small>{pr.blurb}</small></span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="sim-section">
        <h2><span className="step">2</span>Or build your own</h2>
        <div className="sim-hazards" role="radiogroup" aria-label="Type of calamity">
          {HAZARDS.map((h) => (
            <button key={h.key} type="button" role="radio" aria-checked={s.hazard === h.key}
                    className={`sim-hazard${s.hazard === h.key ? ' is-active' : ''}`}
                    style={{ '--c': h.color } as CSSProperties} onClick={() => p.onHazard(h.key)}>
              <Icon path={h.icon} />
              <span>{h.short}</span>
            </button>
          ))}
        </div>

        <div className="sim-places">
          <PlaceRow label="You" hint="Where the user is" value={s.origin} active={p.pick === 'origin'}
                    onPick={() => p.onPick(p.pick === 'origin' ? null : 'origin')} onCentre={() => p.onCentre('origin')} />
          <PlaceRow label={meta.label} hint="Where it happens" value={s.event} active={p.pick === 'event'}
                    onPick={() => p.onPick(p.pick === 'event' ? null : 'event')} onCentre={() => p.onCentre('event')} />
          <p className="sim-help">Markers can be dragged. Pick, then click the map; or pan the map and use its centre.</p>
        </div>

        <label className="sim-field">
          <span>{spec.label} <b>{formatSize(s)}</b></span>
          <input type="range" min={spec.min} max={spec.max} step={spec.step} value={s.size}
                 onChange={(e) => p.onUpdate({ size: Number(e.target.value) })} />
        </label>
        {meta.wind && (
          <div className="sim-wind">
            <label className="sim-field">
              <span>Wind from <b>{compass(s.windDeg)} ({Math.round(s.windDeg)}&deg;)</b></span>
              <input type="range" min={0} max={359} step={5} value={s.windDeg} onChange={(e) => p.onUpdate({ windDeg: Number(e.target.value) })} />
            </label>
            <div className="sim-windrose" aria-hidden="true" style={{ transform: `rotate(${s.windDeg + 180}deg)` }}>&uarr;</div>
            <label className="sim-field">
              <span>Wind speed <b>{Math.round(s.windKmh)} km/h</b></span>
              <input type="range" min={0} max={80} step={1} value={s.windKmh} onChange={(e) => p.onUpdate({ windKmh: Number(e.target.value) })} />
            </label>
          </div>
        )}
        {s.hazard === 'tsunami' && (
          <label className="sim-field">
            <span>Source earthquake</span>
            <select value={s.tsunami} onChange={(e) => p.onUpdate({ tsunami: e.target.value as Scenario['tsunami'] })}>
              <option value="cascadia">M9 Cascadia subduction zone (waves in about 90 min)</option>
              <option value="seattle_fault">M7.5 Seattle Fault (waves in minutes)</option>
            </select>
          </label>
        )}
        {s.hazard === 'flood' && (
          <label className="sim-field">
            <span>Water rises <b>{s.depthM} m</b></span>
            <input type="range" min={1} max={10} step={0.5} value={s.depthM} onChange={(e) => p.onUpdate({ depthM: Number(e.target.value) })} />
          </label>
        )}
        <div className="sim-seg" role="radiogroup" aria-label="How the user travels">
          {(['walk', 'drive'] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={s.mode === m} className={s.mode === m ? 'is-active' : ''}
                    onClick={() => p.onUpdate({ mode: m })}>{m === 'walk' ? 'On foot' : 'By car'}</button>
          ))}
        </div>
      </section>

      {p.error && <p className="sim-error" role="alert">{p.error}</p>}
      <button type="button" className="sim-run" onClick={p.onRun} disabled={!p.ready || p.busy}>
        {p.busy ? 'Simulating…' : p.ready ? 'Run simulation' : 'Place yourself and the event first'}
      </button>
    </>
  );
}

function PlaceRow(props: { label: string; hint: string; value: LatLng | null; active: boolean; onPick: () => void; onCentre: () => void }) {
  return (
    <div className={`sim-place${props.active ? ' is-active' : ''}`}>
      <div>
        <strong>{props.label}</strong>
        <small>{props.value ? `${props.value.lat.toFixed(4)}, ${props.value.lng.toFixed(4)}` : props.hint}</small>
      </div>
      <button type="button" className="sim-btn small" onClick={props.onPick} aria-pressed={props.active}>
        {props.active ? 'Click map…' : props.value ? 'Move' : 'Set on map'}
      </button>
      <button type="button" className="sim-btn small ghost" onClick={props.onCentre}>Map centre</button>
    </div>
  );
}

// ---- Results ----

function DestCard({ d, route }: { d: Destination; route: SimResult['route'] }) {
  const p = destPoint(d);
  const kind = d.place?.kindLabel ?? (d.area?.kind === 'high_ground' ? 'High ground' : 'Open area');
  return (
    <div className="sim-dest">
      <div className="sim-dest-head">
        <span className="sim-dest-kind">{kind}</span>
        <strong>{p.name}</strong>
      </div>
      <p>{d.reason}</p>
      {route && (
        <div className="sim-dest-meta">
          <span className="big">{fmtMin(route.durationS)}</span>
          <span>{fmtDist(route.distanceM)}</span>
          <span className={`pill ${route.avoidsDanger ? 'ok' : 'warn'}`}>{route.avoidsDanger ? 'Avoids the severe zone' : 'Crosses the danger zone'}</span>
        </div>
      )}
    </div>
  );
}

function ResultView({ result, stage, onReplay, onEdit, onShare, onReset }: {
  result: SimResult; stage: Stage; onReplay: () => void; onEdit: () => void; onShare: () => void; onReset: () => void;
}) {
  const r = result;
  const meta = HAZARD_BY_KEY[r.scenario.hazard as HazardKey];
  const shown = stage === 'zones' || stage === 'route' || stage === 'done';
  return (
    <div className={`sim-result${shown ? ' is-shown' : ''}`}>
      <div className="sim-result-title" style={{ '--c': meta?.color } as CSSProperties}>
        {meta && <Icon path={meta.icon} size={26} />}
        <div>
          <strong>{r.scenario.hazardLabel}</strong>
          <small>Simulated · {r.scenario.mode === 'walk' ? 'on foot' : 'by car'}</small>
        </div>
      </div>

      {!shown && <p className="sim-wait" role="status">{STAGE_TEXT[stage] || 'Preparing the simulation'}…</p>}

      {shown && (<>
        <div className={`sim-banner sim-status-${r.userStatus}`}>
          <strong>{r.headline}</strong>
          <span>{r.actionLabel}</span>
        </div>

        <section className="sim-section">
          <h3>Do this now</h3>
          <p className="sim-now">{r.now}</p>
          <ol className="sim-steps">{r.guidance.map((g, i) => <li key={i}>{g}</li>)}</ol>
        </section>

        {r.destination && (
          <section className="sim-section">
            <h3>Go here</h3>
            <DestCard d={r.destination} route={r.route} />
            {r.route && (
              <details className="sim-details">
                <summary>Turn-by-turn ({r.route.steps.length} steps) · {ENGINE_LABEL[r.route.engine]}</summary>
                <ol>{r.route.steps.map((s, i) => <li key={i}>{s.instruction}{s.distanceM ? <small> · {fmtDist(s.distanceM)}</small> : null}</li>)}</ol>
              </details>
            )}
          </section>
        )}

        {r.alternatives.length > 0 && (
          <section className="sim-section">
            <h3>Alternatives</h3>
            <ul className="sim-alts">
              {r.alternatives.map((a, i) => {
                const p = destPoint(a);
                return <li key={i}><strong>{p.name}</strong><small>{a.place?.kindLabel ?? 'Area'} · {fmtDist(p.distanceM)} away</small></li>;
              })}
            </ul>
          </section>
        )}

        <section className="sim-section">
          <h3>Timeline</h3>
          <ol className="sim-timeline">
            {r.timeline.map((t, i) => <li key={i}><span>{fmtT(t.tMinutes)}</span>{t.label}</li>)}
          </ol>
        </section>

        <details className="sim-details">
          <summary>How this was simulated</summary>
          <p>{r.scenario.model}</p>
          {r.scenario.sources.length > 0 && <p>Data: {r.scenario.sources.join('; ')}.</p>}
          <p>{r.disclaimer}</p>
        </details>
      </>)}

      <div className="sim-result-actions">
        <button type="button" className="sim-btn" onClick={onReplay}>Replay</button>
        <button type="button" className="sim-btn" onClick={onShare}>Share scenario</button>
        <button type="button" className="sim-btn ghost" onClick={onEdit}>Edit</button>
        <button type="button" className="sim-btn ghost" onClick={onReset}>Reset</button>
      </div>
    </div>
  );
}

// ---- Presenter mode ----

function PresenterCaption({ result, stage, busy, scenario, onReplay }: {
  result: SimResult | null; stage: Stage; busy: boolean; scenario: Scenario; onReplay: () => void;
}) {
  const meta = HAZARD_BY_KEY[scenario.hazard];
  const d = result?.destination;
  return (
    <div className="sim-caption" role="status" style={{ '--c': meta.color } as CSSProperties}>
      <div className="sim-caption-kicker"><Icon path={meta.icon} size={18} />{meta.label} · {formatSize(scenario)}</div>
      {busy || !result || stage === 'spreading' || stage === 'idle' ? (
        <div className="sim-caption-main">{busy ? 'Running the simulation…' : STAGE_TEXT[stage] || 'Ready'}</div>
      ) : (<>
        <div className={`sim-caption-main sim-text-${result.userStatus}`}>{result.headline}</div>
        <div className="sim-caption-sub">{result.now}</div>
        {d && result.route && (stage === 'route' || stage === 'done') && (
          <div className="sim-caption-route">
            Beacon routes you to <strong>{destPoint(d).name}</strong>: {fmtMin(result.route.durationS)} {result.scenario.mode === 'walk' ? 'on foot' : 'by car'}
            {result.route.avoidsDanger ? ', avoiding the severe zone' : ''}
          </div>
        )}
      </>)}
      {stage === 'done' && <button type="button" className="sim-btn small" onClick={onReplay}>Replay</button>}
    </div>
  );
}
