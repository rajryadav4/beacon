// Trip in progress (ported from the class app's TripView): progress, where you are, danger alerts on
// the way, and turn-by-turn guidance, with the direction chip on the map.

import { useEffect } from 'react';
import { formatDistance, formatDuration, fmt } from '../../lib/format';
import { useTripRunner, type TripPlan, type TripProgress } from '../../hooks/useTripRunner';
import type { DangerAlerts } from '../../lib/danger';
import { useApp } from '../../context';
import { Icon, LevelBadge, MODE_ICON } from '../ui';
import NavChip from './NavChip';

export function TurnList({ plan, progress, limit = 6 }: { plan: TripPlan; progress: TripProgress | null; limit?: number }) {
  const d = progress?.d ?? 0;
  const upcoming = plan.steps.filter((s) => s.at > d + 8 && s.type !== 'depart').slice(0, limit);
  if (!upcoming.length) return null;
  return (
    <ol className="turns" aria-label="Next turns">
      {upcoming.map((s, i) => (
        <li key={`${s.at}-${i}`} className={i === 0 ? 'is-next' : ''}>
          <span>{s.instruction}</span>
          <small>{formatDistance(Math.max(0, s.at - d))}</small>
        </li>
      ))}
    </ol>
  );
}

export default function TripView({ plan, danger, onExit }: { plan: TripPlan; danger: DangerAlerts; onExit: () => void }) {
  const { model, ctrl } = useApp();
  const progress = useTripRunner(plan, danger);
  const f = progress?.f ?? 0;
  useEffect(() => {
    ctrl.drawRoutes([{ coords: plan.coords, role: 'best', duration: plan.duration }], 0, null, { guide: Boolean(plan.survival) });
    ctrl.setEndpoints(plan.from, plan.to, Boolean(plan.to.safe));
    return () => { ctrl.clearRoutes(); ctrl.setEndpoints(null, null); };
  }, [ctrl, plan]);
  const arrived = progress?.arrived ?? false;
  return (
    <section aria-label="Trip in progress">
      {progress && (
        <NavChip info={{
          heading: progress.heading, remainingM: progress.remainingM, remainingS: progress.remainingS, toName: plan.to.name,
          nextStep: progress.nextStep, distToNext: progress.distToNext, arrived, offRoute: progress.offRoute, safe: plan.to.safe,
        }} />
      )}
      <div className="section">
        <div className="trip-card">
          <div>
            <div className="stat-label">{plan.simulate ? 'Simulated trip' : 'Trip in progress'}</div>
            <div className="trip-dest">To {plan.to.name}</div>
          </div>
          <div className="route-mid">
            <Icon name={MODE_ICON[plan.mode]} className="icon-sm" /> {model.modes[plan.mode]?.label}
            <span>·</span>{formatDuration(plan.duration)}<span>·</span>{formatDistance(plan.distance)}
            {plan.level && <LevelBadge level={plan.level} />}
          </div>
          <div className="progress" role="progressbar" aria-label="Trip progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(f * 100)}>
            <i style={{ width: `${Math.round(f * 100)}%` }} />
          </div>
          {progress && (
            <div className="trip-now">
              <span>Now in <b>{progress.area}</b></span>
              <LevelBadge level={progress.level} />
            </div>
          )}
          <span className="hint" style={{ margin: 0 }}>
            {arrived ? 'Arrived' : progress?.waiting ? 'Waiting for your location…' : `${formatDuration(progress?.remainingS ?? plan.duration)} left · ${formatDistance(progress?.remainingM ?? plan.distance)}`}
          </span>
          <p className="hint" style={{ margin: 0 }}>
            {plan.simulate ? 'The trip plays at high speed so you can see where Beacon warns you.'
              : 'Beacon follows your location while you navigate and warns you before a high-risk block.'}
          </p>
        </div>
      </div>
      {!arrived && (
        <div className="section">
          <div className="section-title"><span>Turn by turn</span></div>
          <TurnList plan={plan} progress={progress} />
        </div>
      )}
      <div className="section">
        <div className="section-title"><span>Alerts on this trip</span></div>
        <ul className="trip-log" aria-live="polite">
          {!progress?.log.length ? (
            <li><Icon name="shield" className="icon-sm" />No alerts yet. You get a warning before a high-risk block.</li>
          ) : progress.log.map((a) => (
            <li key={a.id} className="is-alert"><Icon name="octagon" className="icon-sm" />
              <span><b>{a.area}</b> · {a.ahead ? 'warned before entering' : 'warned inside'} at {fmt.pct(a.progress)} of the trip</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="section">
        {arrived
          ? <button className="btn btn-primary btn-block" type="button" onClick={onExit}><Icon name="check" className="icon-sm" />Done</button>
          : <button className="btn btn-secondary btn-block" type="button" onClick={onExit}><Icon name="x" className="icon-sm" />End trip</button>}
      </div>
    </section>
  );
}
