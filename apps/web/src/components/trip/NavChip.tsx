// Map-first guidance: a big direction arrow with "Head north-east · 450 m · 6 min" and the next turn,
// floating over the map. The arrow turns with the map, so it always points the real way to go.

import { useEffect, useState } from 'react';
import { useApp } from '../../context';
import { formatDistance, formatDuration, walkSeconds } from '../../lib/format';
import { compassWord } from '../../lib/geo';
import type { RouteStep } from '../../lib/routing';
import { Floating, Icon } from '../ui';

export function useMapBearing(): number {
  const { ctrl } = useApp();
  const [b, setB] = useState(() => ctrl.map.getBearing());
  useEffect(() => {
    const on = () => setB(ctrl.map.getBearing());
    ctrl.map.on('rotate', on);
    return () => { ctrl.map.off('rotate', on); };
  }, [ctrl]);
  return b;
}

const TURN_ICON: Record<string, number> = {
  left: -90, 'sharp left': -135, 'slight left': -45, right: 90, 'sharp right': 135, 'slight right': 45, straight: 0, uturn: 180,
};

export interface NavInfo {
  heading: number;
  remainingM: number;
  remainingS?: number;
  toName: string;
  nextStep: RouteStep | null;
  distToNext: number;
  arrived: boolean;
  offRoute?: boolean;
  safe?: boolean;
  /** Before the trip starts: "Route ready" instead of live progress. */
  preview?: boolean;
}

export default function NavChip({ info, survival }: { info: NavInfo; survival?: boolean }) {
  const mapBearing = useMapBearing();
  const seconds = info.remainingS ?? walkSeconds(info.remainingM);
  if (info.arrived) {
    return (
      <Floating>
        <div className={`nav-chip is-arrived${survival ? ' is-survival' : ''}`} role="status" aria-live="polite">
          <span className="nav-arrow done"><Icon name="check" className="icon" /></span>
          <div className="nav-text">
            <b>You have arrived</b>
            <span>{info.toName}. {info.safe ? 'Stay here and follow official instructions.' : 'Trip complete.'}</span>
          </div>
        </div>
      </Floating>
    );
  }
  const turn = info.nextStep;
  const turnDeg = turn?.modifier ? TURN_ICON[turn.modifier] ?? 0 : 0;
  return (
    <Floating>
      <div className={`nav-chip${survival ? ' is-survival' : ''}${info.offRoute ? ' is-off' : ''}`} role="status" aria-live="polite">
        <span className="nav-arrow" aria-hidden="true" style={{ transform: `rotate(${info.heading - mapBearing}deg)` }}>
          <Icon name="arrow" className="icon" />
        </span>
        <div className="nav-text">
          <b>{info.offRoute ? 'Off the route: head back to the line' : `Head ${compassWord(info.heading)}`}</b>
          <span>{formatDistance(info.remainingM)} · {formatDuration(seconds)} to {info.toName}</span>
        </div>
        {turn && turn.type !== 'arrive' && (
          <div className="nav-next">
            <span className="turn-ico" aria-hidden="true" style={{ transform: `rotate(${turnDeg}deg)` }}><Icon name="arrow" className="icon-sm" /></span>
            <span><small>In {formatDistance(info.distToNext)}</small>{turn.instruction}</span>
          </div>
        )}
        {turn && turn.type === 'arrive' && (
          <div className="nav-next"><span className="turn-ico" aria-hidden="true"><Icon name="flag" className="icon-sm" /></span>
            <span><small>In {formatDistance(info.distToNext)}</small>Arrive at {info.toName}</span></div>
        )}
      </div>
    </Floating>
  );
}
