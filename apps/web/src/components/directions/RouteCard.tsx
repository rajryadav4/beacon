// One route option (class app's route card): risk ring, level, time, tags, and a "Why?" breakdown.

import { useState } from 'react';
import { useApp } from '../../context';
import { formatDistance, formatDuration, fmt } from '../../lib/format';
import { ROLE_COLOR, ROLE_LABEL } from '../../lib/map/style';
import { arrival, type Departure, type ScoredRoute } from '../../lib/plan';
import type { Mode } from '../../lib/risk';
import { Icon, LEVEL_WORD, LevelBadge, Ring } from '../ui';

interface Props {
  route: ScoredRoute;
  index: number;
  selected: boolean;
  mode: Mode;
  dep: Departure;
  onSelect: () => void;
  onStart: (simulate: boolean) => void;
}

export default function RouteCard({ route: r, index: i, selected, mode, dep, onSelect, onStart }: Props) {
  const { model } = useApp();
  const [why, setWhy] = useState(false);
  const s = r.score;
  const color = ROLE_COLOR[r.role];
  const bandLabel = model.bandLabel(dep.band).toLowerCase();
  return (
    <div className={`route-card role-${r.role}`} role="button" tabIndex={0} aria-pressed={selected}
      style={{ '--route-color': color } as React.CSSProperties}
      aria-label={`Route R${i + 1}, ${ROLE_LABEL[r.role]}: ${formatDuration(r.duration)}, ${LEVEL_WORD[s.level].toLowerCase()} risk, score ${s.score} of 100`}
      onClick={onSelect}
      onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); onSelect(); } }}>
      {r.tags.length > 0 && (
        <div className="route-tags">
          {r.tags.map((t) => <span key={t} className={t === ROLE_LABEL[r.role] ? `tag tag-role tag-${r.role}` : 'tag tag-plain'}>{t}</span>)}
        </div>
      )}
      <div className="route-top">
        <Ring value={s.score} size={56} stroke={6} color={color} />
        <div className="route-head">
          <div className="route-name"><span className="route-id">R{i + 1}</span><span>{formatDistance(r.distance)}</span></div>
          <div className="route-mid"><LevelBadge level={s.level} /></div>
        </div>
        <div className="route-time"><b>{formatDuration(r.duration)}</b><span>arrive {arrival(dep, r.duration)}</span></div>
      </div>
      <div className="route-mid">
        <span>Risk score <span className="score">{s.score}</span>/100 · ≈ {fmt.perYear(s.incidentsPerYear)} {mode === 'car' ? 'car-related' : 'street'} crimes a year along it ({bandLabel})</span>
      </div>
      <div className="row-between">
        <button className="why-btn" type="button" aria-expanded={why} onClick={(e) => { e.stopPropagation(); setWhy(!why); }}>
          <Icon name="info" className="icon-sm" /><span>{why ? 'Hide' : 'Why?'}</span>
        </button>
        <span className="hint" style={{ margin: 0 }}>
          {s.hotspots.length ? `${s.hotspots.length} high-risk block${s.hotspots.length > 1 ? 's' : ''}` : 'No high-risk blocks'}
        </span>
      </div>
      {why && <WhyPanel route={r} mode={mode} dep={dep} />}
      <div className="route-actions">
        <button className="btn btn-primary btn-sm" type="button" onClick={(e) => { e.stopPropagation(); onStart(false); }}>
          <Icon name="nav" className="icon-sm" />Start trip
        </button>
        <button className="btn btn-secondary btn-sm" type="button" title="Play the trip on the map to see the danger alerts"
          onClick={(e) => { e.stopPropagation(); onStart(true); }}>
          <Icon name="play" className="icon-sm" />Simulate
        </button>
      </div>
    </div>
  );
}

function WhyPanel({ route: r, mode, dep }: { route: ScoredRoute; mode: Mode; dep: Departure }) {
  const { model } = useApp();
  const s = r.score;
  const safest = s.safestBand;
  return (
    <div className="why">
      <div>
        <h4>{mode === 'car' ? 'Car-related crime along this route' : 'Street crime along this route'}</h4>
        <div className="why-bars">
          {s.topGroups.length ? s.topGroups.map((g) => (
            <div className="why-bar" key={g.g}>
              <span className="lbl">{g.label}</span><span className="val">{fmt.pct(g.share)}</span>
              <span className="track" aria-hidden="true"><i style={{ width: `${Math.round(g.share * 100)}%` }} /></span>
            </div>
          )) : <span>No reports along this route at this time.</span>}
        </div>
      </div>
      <div>
        <h4>Riskiest stretch</h4>
        {s.hotspots.length
          ? `${s.riskiestHood ?? 'Part of the route'}: ${s.hotspots.length} high-risk block${s.hotspots.length > 1 ? 's' : ''} (red dots on the map).`
          : `${s.riskiestHood ? `Highest risk near ${s.riskiestHood}, ` : ''}but no block on this route is in the city's top 3% for this time.`}
      </div>
      <div>
        <h4>Same route at other times</h4>
        <div className="band-strip">
          {([1, 2, 3, 0] as const).map((b) => {
            const x = s.byBand[b];
            return (
              <div key={b} className={`band-cell band-${x.level}${b === dep.band ? ' is-now' : ''}`} title={`${model.bandHours(b)}: score ${Math.round(x.score)}`}>
                <b>{model.bandLabel(b)}</b><span>{LEVEL_WORD[x.level]} · {Math.round(x.score)}</span>
              </div>
            );
          })}
        </div>
        <p className="hint">{safest.band === dep.band ? 'You already travel at the safest time of day for this route.'
          : `Safest time for this route: ${model.bandLabel(safest.band).toLowerCase()} (${model.bandHours(safest.band)}).`}</p>
      </div>
      <div>
        <h4>Travel mode</h4>
        {mode === 'car'
          ? `In a car you are less exposed. On foot this route would be ${LEVEL_WORD[s.onFoot].toLowerCase()} risk.`
          : `On foot or bike you are more exposed. In a car this route would be ${LEVEL_WORD[s.inCar].toLowerCase()} risk.`}
      </div>
      <div>
        <h4>Exposure</h4>
        {r.exposure !== null
          ? `${r.exposure.toFixed(2)} risk-km over the trip, counted block by block at the time you reach each one.`
          : 'Could not be scored: most of this route is outside the Seattle risk grid.'}
      </div>
    </div>
  );
}
