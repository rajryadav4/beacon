import { useState, type Ref } from 'react';
import type { Alert, AlertsStatus, Hazard, Incident } from '../api';
import type { AlertsState } from '../hooks';
import { formatTime, relativeTime, severityColor } from '../lib/format';

interface Props {
  hasLocation: boolean;
  alerts: Alert[];
  incidents: Incident[];
  state: AlertsState;
  status: AlertsStatus | null;
  statusError: string | null;
  hazards: Hazard[];
  defaultHazard: string;
  demoActive: boolean;
  onSurvival: (hazard: string) => void;
  onDemo: (hazard: string) => void;
  onClearDemo: () => void;
  survivalSelectRef?: Ref<HTMLSelectElement>;
}

interface SourceFreshness { name: string; ok: boolean; at: string | null; error: string | null }

/** Normalise `/api/alerts/status`, which may be `{sources: [...]}` or `{nws: {...}, usgs: {...}}`. */
export function sourceFreshness(status: AlertsStatus | null): SourceFreshness[] {
  if (!status) return [];
  const pick = (o: Record<string, unknown>, keys: string[]) => {
    for (const k of keys) if (typeof o[k] === 'string') return o[k] as string;
    return null;
  };
  const toRow = (name: string, value: unknown): SourceFreshness | null => {
    if (!value || typeof value !== 'object') return null;
    const o = value as Record<string, unknown>;
    const error = pick(o, ['error', 'lastError']);
    return {
      name: pick(o, ['label', 'name', 'source']) ?? name,
      at: pick(o, ['lastSuccess', 'lastSuccessAt', 'updatedAt', 'fetchedAt', 'lastFetch', 'lastRun']),
      ok: typeof o.ok === 'boolean' ? o.ok : typeof o.stale === 'boolean' ? !o.stale : !error,
      error,
    };
  };
  const list = Array.isArray(status.sources)
    ? (status.sources as unknown[]).map((v, i) => toRow(`source ${i + 1}`, v))
    : Object.entries((status.sources as Record<string, unknown>) ?? status).map(([k, v]) => toRow(k, v));
  return list.filter((r): r is SourceFreshness => r !== null);
}

export function AlertCard({ alert, open }: { alert: Alert; open?: boolean }) {
  const color = severityColor(alert.severity);
  return (
    <article className={`alert-card${alert.demo ? ' demo' : ''}`} style={{ borderLeftColor: color }}>
      <header>
        <span className="sev" style={{ background: color }}>{alert.severity || 'Unknown'}</span>
        {alert.demo && <span className="demo-tag">DEMO</span>}
        <h3>{alert.event}</h3>
      </header>
      {alert.headline && <p className="headline">{alert.headline}</p>}
      <p className="meta">
        {alert.sender && <>{alert.sender} · </>}
        {alert.expires ? <>expires {formatTime(alert.expires)} ({relativeTime(alert.expires)})</> : alert.effective && <>issued {formatTime(alert.effective)}</>}
        {alert.magnitude != null && <> · M{alert.magnitude.toFixed(1)}</>}
        {alert.distanceKm != null && alert.distanceKm > 0 && <> · {alert.distanceKm.toFixed(0)} km away</>}
      </p>
      {alert.instruction && (
        <div className="instruction">
          <strong>Official instructions</strong>
          <p>{alert.instruction}</p>
        </div>
      )}
      {alert.description && (
        <details open={open}>
          <summary>Details{alert.areaDesc ? ` · ${alert.areaDesc}` : ''}</summary>
          <p className="desc">{alert.description}</p>
        </details>
      )}
      {alert.url && /^https?:/.test(alert.url) && (
        <a className="source" href={alert.url} target="_blank" rel="noreferrer">Read the official alert ↗</a>
      )}
    </article>
  );
}

export default function AlertsPanel(props: Props) {
  const { hasLocation, alerts, incidents, state, status, statusError, hazards, defaultHazard, demoActive } = props;
  const [hazard, setHazard] = useState<string>('');
  const chosen = hazard || defaultHazard;
  const sources = sourceFreshness(status);

  return (
    <div className="alerts-panel">
      <section aria-labelledby="alerts-h">
        <h2 id="alerts-h">Active alerts{alerts.length > 0 && <span className="hint">{alerts.length}</span>}</h2>
        {!hasLocation && !demoActive && <p className="note">Set your location to check official alerts for where you are.</p>}
        {state.error && <p className="error small">{state.error}</p>}
        {hasLocation && state.loading && !state.data && <p className="note">Checking alerts…</p>}
        {hasLocation && state.data && alerts.length === 0 && !state.error && (
          <p className="ok-note">No active official alerts for your location.</p>
        )}
        <div className="alert-list">
          {alerts.map((a) => <AlertCard key={a.id} alert={a} />)}
        </div>
        {incidents.length > 0 && (
          <details className="incidents">
            <summary>{incidents.length} nearby incident{incidents.length > 1 ? 's' : ''} (unconfirmed reports)</summary>
            <ul>
              {incidents.map((i) => (
                <li key={i.id}>{i.type}{i.distanceKm != null && ` · ${i.distanceKm.toFixed(1)} km`}{i.time && ` · ${relativeTime(i.time)}`}</li>
              ))}
            </ul>
          </details>
        )}
        <p className="fresh-line">
          {hasLocation && state.checkedAt && <>Checked {formatTime(new Date(state.checkedAt).toISOString())}, every minute. </>}
          {sources.length > 0
            ? sources.map((s, i) => (
              <span key={s.name} className={s.ok ? '' : 'stale'}>
                {i > 0 && ' · '}{s.name}: {s.at ? relativeTime(s.at) : 'no data yet'}{!s.ok && ' (delayed)'}
              </span>
            ))
            : statusError ? <span className="stale">{statusError}</span> : null}
        </p>
      </section>

      <section aria-labelledby="surv-h" className="survival-tools">
        <h2 id="surv-h">Survival mode</h2>
        <p className="note">Turns on by itself when an official alert means immediate danger here. You can also turn it on yourself.</p>
        <label className="field">
          <span>Hazard</span>
          <select ref={props.survivalSelectRef} value={chosen} onChange={(e) => setHazard(e.target.value)}>
            {hazards.map((h) => <option key={h.key} value={h.key}>{h.label}</option>)}
          </select>
        </label>
        <div className="loc-row">
          <button className="btn danger" onClick={() => props.onSurvival(chosen)}>Turn on survival mode</button>
        </div>
        <details className="demo-menu">
          <summary>Demo</summary>
          <p className="note">Shows survival mode with a fake alert for the hazard above. It stays in this browser and is marked DEMO.</p>
          <div className="loc-row">
            <button className="btn" onClick={() => props.onDemo(chosen)}>Demo: simulate an alert</button>
            {demoActive && <button className="btn" onClick={props.onClearDemo}>Clear demo alert</button>}
          </div>
        </details>
      </section>
    </div>
  );
}
