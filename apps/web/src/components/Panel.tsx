// The frosted panel (class app layout): a left column on desktop, a bottom sheet on phones.
// Brand, live-data pill, greeting, the top alert, the view tabs, the view, and the footer.

import { useState, type ReactNode } from 'react';
import type { Alert } from '../api';
import { useApp } from '../context';
import { greeting, nowBand, seattleClock } from '../lib/clock';
import { severityColor } from '../lib/format';
import { MOCK } from '../lib/mock';
import { STREET_GROUPS } from '../lib/risk';
import { Icon, Logo } from './ui';

export type View = 'explore' | 'directions' | 'alerts' | 'places' | 'trip';
const TABS: { key: View; label: string }[] = [
  { key: 'explore', label: 'Explore' },
  { key: 'directions', label: 'Directions' },
  { key: 'alerts', label: 'Alerts' },
  { key: 'places', label: 'Safe places' },
];

interface Props {
  view: View;
  onView: (v: View) => void;
  alerts: Alert[];
  children: ReactNode;
}

export default function Panel({ view, onView, alerts, children }: Props) {
  const { model, live } = useApp();
  const [expanded, setExpanded] = useState(false);
  const now = seattleClock();
  const band = nowBand();
  const top = model.rankHoods(band, STREET_GROUPS)[0];
  const topAlert = alerts[0];

  return (
    <aside className={`panel${expanded ? ' is-expanded' : ''}`} aria-label="Beacon">
      <button className="sheet-handle" type="button" aria-label={expanded ? 'Collapse panel' : 'Expand panel'} aria-expanded={expanded} onClick={() => setExpanded(!expanded)} />
      <header className="panel-head">
        <div className="brand"><Logo /> Beacon</div>
        <span className="head-pills">
          {MOCK && <span className="mode-pill mock" title="Opened with ?mock=1: alerts, safe places and the outlook are fake">Mock data</span>}
          <span className="mode-pill" title={live ? 'Crime data from the Beacon API (PostgreSQL).' : 'The API did not answer: crime data comes from the bundled copy.'}>
            <span className={live ? 'live-dot' : 'live-dot is-offline'} aria-hidden="true" />{live ? 'Live data' : 'Offline data'}
          </span>
        </span>
      </header>
      {topAlert ? (
        <button className="alert-banner" type="button" style={{ '--sev': severityColor(topAlert.severity) } as React.CSSProperties} onClick={() => onView('alerts')}>
          <Icon name="alert" className="icon-sm" />
          <span className="banner-text">
            {topAlert.demo && <b className="demo-tag">DEMO</b>}
            {topAlert.headline || topAlert.event}
            {alerts.length > 1 && <small> +{alerts.length - 1} more</small>}
          </span>
        </button>
      ) : (
        <p className="greeting">
          {greeting(now.hour)}. {top ? <>It is {model.bandLabel(band).toLowerCase()} in Seattle: street crime is highest around <b>{top.hood.name}</b> right now.</> : null}
        </p>
      )}
      {view !== 'trip' && (
        <div className="tabs" role="tablist" aria-label="Views">
          {TABS.map((t) => (
            <button key={t.key} className="tab" role="tab" type="button" aria-selected={view === t.key} tabIndex={view === t.key ? 0 : -1}
              onClick={() => onView(t.key)}>
              {t.label}{t.key === 'alerts' && alerts.length > 0 && <span className="count">{alerts.length}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="panel-body">
        {children}
        <footer className="panel-foot">
          <b>Beacon is a helper, not a replacement for official alerts.</b> It does not replace emergency services.
          In danger, call 911 and follow official instructions. Map © OpenStreetMap contributors, OpenFreeMap; terrain: AWS Terrain Tiles.
        </footer>
      </div>
    </aside>
  );
}
