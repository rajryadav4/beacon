// The survival instructions over the map: a high-contrast bottom sheet on phones (collapsible) and a side
// panel on desktop. Official instruction first, then where to go, turn by turn, the checklist and numbers.

import { useEffect, useRef, useState } from 'react';
import type { Alert } from '../../api';
import { useApp } from '../../context';
import type { TripPlan, TripProgress } from '../../hooks/useTripRunner';
import { formatDistance, formatDuration, formatTime, walkTime } from '../../lib/format';
import { EMERGENCY_NUMBERS, guidanceFor } from '../../lib/guidance';
import { kindColor } from '../../lib/hazards';
import { osmDirectionsUrl, type RawRoute } from '../../lib/routing';
import LocationBar from '../LocationBar';
import { TurnList } from '../trip/TripView';
import { Icon } from '../ui';

export interface Target {
  id: string; lat: number; lng: number; name: string; detail: string; distanceM: number;
  reason?: string; kind?: string; address?: string | null; openingHours?: string | null; area?: boolean;
}

type Size = 'peek' | 'full' | 'min';

interface Props {
  hazard: string;
  hazardLabel: string;
  alert: Alert | null;
  otherAlerts: Alert[];
  target: Target | null;
  targets: Target[];
  areas: Target[];
  loading: boolean;
  placesError: string | null;
  route: RawRoute | null;
  routeError: string | null;
  routeLoading: boolean;
  nav: TripPlan | null;
  progress: TripProgress | null;
  advice: string | null;
  onChoose: (t: Target) => void;
  onNavigate: (simulate: boolean) => void;
  onStop: () => void;
  onReroute: () => void;
  onExit: () => void;
}

export default function SurvivalSheet(p: Props) {
  const { location } = useApp();
  const guidance = guidanceFor(p.hazard);
  const [size, setSize] = useState<Size>('peek');
  const titleRef = useRef<HTMLHeadingElement>(null);
  const demo = Boolean(p.alert?.demo);
  const arrived = Boolean(p.progress?.arrived);

  useEffect(() => { titleRef.current?.focus(); }, [p.hazard]);
  // While walking, keep the sheet small so the map leads.
  useEffect(() => { if (p.nav) setSize('min'); }, [p.nav]);
  useEffect(() => { if (arrived) setSize('peek'); }, [arrived]);
  // The map buttons move with the sheet on phones.
  useEffect(() => {
    document.body.classList.add('survival-on');
    return () => document.body.classList.remove('survival-on', 'sheet-min', 'sheet-full');
  }, []);
  useEffect(() => {
    document.body.classList.toggle('sheet-min', size === 'min');
    document.body.classList.toggle('sheet-full', size === 'full');
  }, [size]);

  const cycle = () => setSize(size === 'min' ? 'peek' : size === 'peek' ? 'full' : 'min');
  const others = [...p.targets, ...p.areas].filter((t) => t.id !== p.target?.id);

  return (
    <aside className={`sv-sheet size-${size}`} role="region" aria-labelledby="sv-title">
      <button className="sheet-handle" type="button" onClick={cycle}
        aria-label={size === 'full' ? 'Make the instructions smaller' : 'Show more instructions'} aria-expanded={size !== 'min'} />
      <div className="sv-head">
        <span className="sv-badge"><Icon name="octagon" className="icon-sm" />Survival mode</span>
        {demo && <span className="sv-demo">DEMO · not a real alert</span>}
        <button className="sv-exit" type="button" onClick={p.onExit}>I'm safe · exit</button>
      </div>
      <h1 id="sv-title" ref={titleRef} tabIndex={-1}>{p.hazardLabel}</h1>

      <div className="sv-body">
        <div className="sv-official">
          <p className="sv-label">
            {p.alert?.instruction ? (demo ? 'Simulated instruction (DEMO)' : `Official instruction${p.alert.sender ? ` · ${p.alert.sender}` : ''}`) : 'Do this now'}
          </p>
          <p className="sv-instr">{p.alert?.instruction || guidance.now}</p>
          {p.alert ? (
            <p className="sv-meta">{p.alert.headline || p.alert.event}{p.alert.expires && ` · until ${formatTime(p.alert.expires)}`}</p>
          ) : <p className="sv-meta">You turned this on. No official alert has been received for your location.</p>}
        </div>

        <section className="sv-go" aria-label="Where to go">
          <h2>{arrived ? 'You have arrived' : p.nav ? 'Walking to safety' : 'Go to the nearest safe place'}</h2>
          {!location ? (
            <>
              <p className="sv-note">Set your location to see the way on the map.</p>
              <LocationBar compact />
            </>
          ) : p.loading && !p.target ? (
            <p className="sv-note" aria-live="polite">Finding the nearest safe place…</p>
          ) : !p.target ? (
            <p className="sv-warn">{p.placesError ? `${p.placesError} ` : 'No suitable place found nearby. '}Follow the official instruction above.</p>
          ) : (
            <>
              <div className="sv-target">
                <span className="kind-dot" style={{ background: p.target.area ? '#22c55e' : kindColor(p.target.kind ?? '') }} aria-hidden="true" />
                <div>
                  <b>{p.target.name}</b>
                  <span>
                    {p.target.detail && !p.target.area ? `${p.target.detail} · ` : ''}
                    {p.route ? `${formatDistance(p.route.distance)} · ${formatDuration(p.route.duration)} walk` : `${formatDistance(p.target.distanceM)} away · ~${walkTime(p.target.distanceM)}`}
                  </span>
                  {(p.target.reason || p.target.address) && <small>{p.target.area ? p.target.reason : [p.target.address, p.target.openingHours && `Hours: ${p.target.openingHours}`].filter(Boolean).join(' · ')}</small>}
                </div>
              </div>
              {p.routeLoading && <p className="sv-note" aria-live="polite">Finding the walking route…</p>}
              {p.routeError && <p className="sv-warn" role="alert">No walking route: {p.routeError}. Head toward the marked place on the map.</p>}
              {arrived ? (
                <p className="sv-ok">Stay here and follow official instructions. Tell someone where you are.</p>
              ) : p.nav ? (
                <>
                  {p.progress?.offRoute && <button className="sv-btn" type="button" onClick={p.onReroute}>Re-route from here</button>}
                  <TurnList plan={p.nav} progress={p.progress} limit={size === 'min' ? 1 : 5} />
                  <div className="sv-actions">
                    <button className="sv-btn" type="button" onClick={p.onStop}>Stop navigation</button>
                    <a className="sv-btn call" href="tel:911"><Icon name="phone" className="icon-sm" />Call 911</a>
                  </div>
                </>
              ) : (
                <div className="sv-actions">
                  <button className="sv-nav" type="button" disabled={!p.route} onClick={() => p.onNavigate(false)}><Icon name="nav" className="icon-sm" />Navigate</button>
                  <button className="sv-btn" type="button" disabled={!p.route} onClick={() => p.onNavigate(true)} title="Play the walk on the map"><Icon name="play" className="icon-sm" />Simulate</button>
                  <a className="sv-btn call" href="tel:911"><Icon name="phone" className="icon-sm" />Call 911</a>
                </div>
              )}
              {!p.nav && p.route && location && (
                <a className="sv-link" href={osmDirectionsUrl(location, p.target)} target="_blank" rel="noreferrer">Open this route in OpenStreetMap ↗</a>
              )}
            </>
          )}
          {p.advice && <p className="sv-note">{p.advice}</p>}
        </section>

        {others.length > 0 && !p.nav && (
          <details className="sv-others">
            <summary>Other places ({others.length})</summary>
            <ul>
              {others.map((t) => (
                <li key={t.id}>
                  <button type="button" className="sv-place-btn" onClick={() => p.onChoose(t)}>
                    <b>{t.area ? <><Icon name="flag" className="icon-sm" /> Safer area</> : t.name}</b>
                    <span>{t.area ? t.reason : t.detail} · {formatDistance(t.distanceM)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}

        <section aria-labelledby="sv-check">
          <h2 id="sv-check">Checklist</h2>
          <ol className="sv-checklist">{guidance.steps.map((s) => <li key={s}>{s}</li>)}</ol>
        </section>

        <section aria-labelledby="sv-call">
          <h2 id="sv-call">Emergency numbers</h2>
          <ul className="sv-numbers">
            {EMERGENCY_NUMBERS.map((n) => <li key={n.number}>{n.label}: <a href={`tel:${n.number.replace(/[^0-9+]/g, '')}`}>{n.number}</a></li>)}
          </ul>
          <p className="sv-note">Outside the US, call your local emergency number (112 in Europe).</p>
        </section>

        {p.otherAlerts.length > 0 && (
          <section aria-labelledby="sv-more">
            <h2 id="sv-more">Other active alerts</h2>
            <ul className="sv-numbers">{p.otherAlerts.map((a) => <li key={a.id}><strong>{a.event}</strong>{a.headline && `: ${a.headline}`}</li>)}</ul>
          </section>
        )}

        <button className="sv-exit big" type="button" onClick={p.onExit}>I'm safe · exit survival mode</button>
        <p className="sv-foot">Beacon is a helper. It does not replace official alerts or emergency services. Always follow instructions from officials.</p>
      </div>
    </aside>
  );
}
