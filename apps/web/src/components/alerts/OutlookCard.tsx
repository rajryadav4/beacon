// "Upcoming": what may be coming in the next ~72 h for this point (GET /api/outlook). Hidden if the endpoint is missing.

import type { Outlook } from '../../api';
import type { Optional } from '../../hooks/beacon';
import { formatTime, relativeTime } from '../../lib/format';
import { Icon } from '../ui';

const LEVEL_CLASS: Record<string, string> = { imminent: 'level-high', likely: 'level-elevated', possible: 'level-low' };

export default function OutlookCard({ state, hasLocation }: { state: Optional<Outlook>; hasLocation: boolean }) {
  if (state.unavailable) return null;
  const o = state.data;
  return (
    <div className="section">
      <div className="section-title"><span>Upcoming</span><small>next 72 hours</small></div>
      {!hasLocation && <p className="hint">Set your location to see what may be coming.</p>}
      {hasLocation && state.loading && !o && <div className="skeleton skeleton-sm" aria-hidden="true" />}
      {o && (
        <div className="outlook-card">
          {o.outlook.length === 0
            ? <p className="ok-note"><Icon name="shield" className="icon-sm" />Nothing expected near you in the next 3 days.</p>
            : o.outlook.slice(0, 4).map((it) => (
              <div key={it.id} className="outlook-item">
                <div className="row-between">
                  <b>{it.title}</b>
                  <span className={`level ${LEVEL_CLASS[it.level] ?? 'level-low'}`}>{it.level}</span>
                </div>
                {it.summary && <p>{it.summary}</p>}
                <small>
                  {it.hazardLabel}
                  {it.validFrom && ` · from ${formatTime(it.validFrom)}`}
                  {it.validTo && ` to ${formatTime(it.validTo)}`}
                  {it.distanceKm > 0 && ` · ${it.distanceKm} km away`}
                  {it.sources[0]?.name && ` · ${it.sources.map((s) => s.name).filter(Boolean).join(', ')}`}
                </small>
              </div>
            ))}
          {o.location.exposure.length > 0 && (
            <p className="hint">Exposure here: {o.location.exposure.map((x) => `${x.hazardLabel} ${x.level} (${x.score}/100)`).join(' · ')}</p>
          )}
          <p className="hint">{o.updatedAt && `Updated ${relativeTime(o.updatedAt)}. `}{o.disclaimer}</p>
        </div>
      )}
    </div>
  );
}
