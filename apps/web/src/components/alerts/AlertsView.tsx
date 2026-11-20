// Alerts: official alerts for your location with freshness, the hazard outlook, the hazard map layer,
// and survival mode (turn on, or a DEMO that simulates an alert).

import { useState } from 'react';
import { SCORED_HAZARDS, type Alert, type AlertsStatus, type Incident, type Outlook } from '../../api';
import { useApp } from '../../context';
import type { AlertsState, Optional } from '../../hooks/beacon';
import { formatTime, relativeTime } from '../../lib/format';
import { EXPOSURE_RAMP } from '../../lib/map/style';
import LocationBar from '../LocationBar';
import { Icon } from '../ui';
import AlertCard, { sourceFreshness } from './AlertCard';
import OutlookCard from './OutlookCard';

export type LayerState = 'idle' | 'loading' | 'ready' | 'unavailable';

interface Props {
  alerts: Alert[];
  incidents: Incident[];
  state: AlertsState;
  status: AlertsStatus | null;
  statusError: string | null;
  defaultHazard: string;
  demoActive: boolean;
  onSurvival: (hazard: string) => void;
  onDemo: (hazard: string) => void;
  onClearDemo: () => void;
  outlook: Optional<Outlook>;
  hazardLayer: string | null;
  onHazardLayer: (h: string | null) => void;
  layerState: LayerState;
  showAreas: boolean;
  onShowAreas: (on: boolean) => void;
}

export default function AlertsView(props: Props) {
  const { hazards, location } = useApp();
  const { alerts, incidents, state, defaultHazard, demoActive } = props;
  const [hazard, setHazard] = useState('');
  const chosen = hazard || defaultHazard;
  const sources = sourceFreshness(props.status);
  const scored = hazards.filter((h) => SCORED_HAZARDS.includes(h.key));

  return (
    <section aria-label="Alerts">
      <div className="section"><LocationBar /></div>

      <div className="section">
        <div className="section-title"><span>Active alerts</span>{alerts.length > 0 && <small>{alerts.length}</small>}</div>
        {!location && !demoActive && <p className="hint">Set your location to check official alerts for where you are.</p>}
        {state.error && <p className="form-error">{state.error}</p>}
        {location && state.loading && !state.data && <div className="skeleton skeleton-sm" aria-hidden="true" />}
        {location && state.data && alerts.length === 0 && !state.error && (
          <p className="ok-note"><Icon name="shield" className="icon-sm" />No active official alerts for your location.</p>
        )}
        <div className="alert-list">{alerts.map((a) => <AlertCard key={a.id} alert={a} />)}</div>
        {incidents.length > 0 && (
          <details className="incidents">
            <summary>{incidents.length} nearby incident{incidents.length > 1 ? 's' : ''} (unconfirmed reports)</summary>
            <ul>{incidents.map((i) => <li key={i.id}>{i.type}{i.distanceKm != null && ` · ${i.distanceKm.toFixed(1)} km`}{i.time && ` · ${relativeTime(i.time)}`}</li>)}</ul>
          </details>
        )}
        <p className="hint fresh-line">
          {location && state.checkedAt && <>Checked {formatTime(new Date(state.checkedAt).toISOString())}, every minute. </>}
          {sources.length > 0
            ? sources.map((s, i) => (
              <span key={s.name} className={s.ok ? '' : 'stale'}>{i > 0 && ' · '}{s.name}: {s.at ? relativeTime(s.at) : 'no data yet'}{!s.ok && ' (delayed)'}</span>
            ))
            : props.statusError ? <span className="stale">{props.statusError}</span> : null}
        </p>
        <label className="switch-row toggle-line">
          <span>Show alert areas on the map</span>
          <span className="toggle"><input type="checkbox" checked={props.showAreas} onChange={(e) => props.onShowAreas(e.target.checked)} /><span /></span>
        </label>
      </div>

      <OutlookCard state={props.outlook} hasLocation={location !== null} />

      {props.layerState !== 'unavailable' && (
        <div className="section">
          <div className="section-title"><span>Hazard map</span><small>worst to safest</small></div>
          <div className="chips">
            {scored.map((h) => (
              <label key={h.key} className="chip">
                <input type="checkbox" checked={props.hazardLayer === h.key} onChange={(e) => props.onHazardLayer(e.target.checked ? h.key : null)} />
                <span><Icon name="check" className="check" />{h.label}</span>
              </label>
            ))}
          </div>
          {props.hazardLayer && (
            <div className="legend-inline">
              <div className="legend-ramp" style={{ background: `linear-gradient(90deg, ${EXPOSURE_RAMP.map(([v, c]) => `${c} ${v}%`).join(', ')})` }} />
              <div className="legend-scale"><span>Safest</span><span>Worst</span></div>
              <p className="hint">{props.layerState === 'loading' ? 'Loading the hazard map…' : 'Relative exposure from official hazard zones and terrain, not a probability. Outlined areas are mapped hazard zones.'}</p>
            </div>
          )}
        </div>
      )}

      <div className="section survival-tools">
        <div className="section-title"><span>Survival mode</span></div>
        <p className="hint" style={{ marginTop: 0 }}>Turns on by itself when an official alert means immediate danger here. The map then guides you to the nearest safe place.</p>
        <label className="field">
          <span>Hazard</span>
          <select className="input" value={chosen} onChange={(e) => setHazard(e.target.value)}>
            {hazards.map((h) => <option key={h.key} value={h.key}>{h.label}</option>)}
          </select>
        </label>
        <div className="btn-row">
          <button className="btn btn-danger" type="button" onClick={() => props.onSurvival(chosen)}><Icon name="octagon" className="icon-sm" />Turn on survival mode</button>
          <button className="btn btn-secondary" type="button" onClick={() => props.onDemo(chosen)} title="Simulates an alert in this browser, marked DEMO">DEMO</button>
        </div>
        {demoActive && <button className="link" type="button" onClick={props.onClearDemo}>Clear the demo alert</button>}
        <p className="hint">DEMO shows survival mode with a fake alert for the hazard above. It stays in this browser and is always marked DEMO.</p>
        <a className="btn btn-ghost btn-sm test-link" href="/simulator.html"><Icon name="test" className="icon-sm" />Test Beacon: alert simulator</a>
      </div>
    </section>
  );
}
