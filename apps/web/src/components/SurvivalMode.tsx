import { useEffect, useRef, useState } from 'react';
import type { Alert, NearestPlace } from '../api';
import type { NearestState } from '../hooks';
import { formatDistance, formatDuration, formatTime } from '../lib/format';
import { EMERGENCY_NUMBERS, guidanceFor } from '../lib/guidance';
import { osmDirectionsUrl, type LatLng } from '../lib/routing';
import { PlaceSummary, RouteSteps, type RouteState } from './SafePlacesPanel';

export type SurvivalView = 'info' | 'map';

interface Props {
  hazard: string;
  hazardLabel: string;
  /** The alert that triggered survival mode (null when the user turned it on). */
  alert: Alert | null;
  otherAlerts: Alert[];
  location: LatLng | null;
  onLocate: () => Promise<void>;
  nearest: NearestState;
  routeState: RouteState | null;
  onNavigate: (place: NearestPlace) => void;
  view: SurvivalView;
  onView: (view: SurvivalView) => void;
  onExit: () => void;
}

export default function SurvivalMode(props: Props) {
  const { hazard, hazardLabel, alert, otherAlerts, location, nearest, routeState, view } = props;
  const guidance = guidanceFor(hazard);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState<string | null>(null);
  const demo = Boolean(alert?.demo);

  // Move focus to the title when survival mode opens or returns from the map.
  useEffect(() => { if (view === 'info') titleRef.current?.focus(); }, [view, hazard]);

  const locate = () => {
    setLocating(true);
    setLocError(null);
    props.onLocate().catch((e: Error) => setLocError(e.message)).finally(() => setLocating(false));
  };

  const place = routeState?.place ?? nearest.places[0] ?? null;
  const others = nearest.places.filter((p) => p.id !== place?.id);
  const routeReady = routeState && routeState.place.id === place?.id ? routeState : null;

  const exitButton = (big?: boolean) => (
    <button className={`sv-exit${big ? ' big' : ''}`} onClick={props.onExit}>
      I'm safe · exit survival mode
    </button>
  );

  if (view === 'map') {
    return (
      <div className="survival-bar" role="region" aria-label="Survival mode: route map">
        <div className="sv-bar-row">
          <span className="sv-badge">Survival mode</span>
          {demo && <span className="sv-demo">DEMO</span>}
          <strong className="sv-bar-title">{hazardLabel}</strong>
        </div>
        {routeState?.route && (
          <p className="sv-bar-route">
            Walk {formatDistance(routeState.route.distanceM)} (~{formatDuration(routeState.route.durationS)}) to {routeState.place.name}
          </p>
        )}
        <div className="sv-bar-row">
          <button className="sv-btn" onClick={() => props.onView('info')} autoFocus>Back to instructions</button>
          <a className="sv-btn call" href="tel:911">Call 911</a>
        </div>
      </div>
    );
  }

  return (
    <div className="survival" role="dialog" aria-modal="true" aria-labelledby="sv-title">
      <div className="sv-inner">
        <div className="sv-top">
          <span className="sv-badge">Survival mode</span>
          {demo && <span className="sv-demo">DEMO · not a real alert</span>}
          {exitButton()}
        </div>

        <h1 id="sv-title" ref={titleRef} tabIndex={-1}>{hazardLabel}</h1>
        {alert ? (
          <>
            <p className="sv-headline">{alert.headline || alert.event}</p>
            <p className="sv-meta">
              {alert.sender && <>{alert.sender}<br /></>}
              {alert.effective && <>Issued {formatTime(alert.effective)}</>}
              {alert.expires && <> · until {formatTime(alert.expires)}</>}
            </p>
          </>
        ) : (
          <p className="sv-meta">You turned this on. No official alert has been received for your location.</p>
        )}

        <section aria-labelledby="sv-do">
          <h2 id="sv-do">Do this now</h2>
          {alert?.instruction ? (
            <div className="sv-official">
              <p className="sv-label">{demo ? 'Simulated instructions (DEMO)' : `Official instructions${alert.sender ? ` from ${alert.sender}` : ''}`}</p>
              <p className="sv-instr">{alert.instruction}</p>
            </div>
          ) : (
            <div className="sv-official">
              <p className="sv-label">No official instructions yet</p>
              <p className="sv-instr">{guidance.now}</p>
            </div>
          )}
          <h3 className="sv-sub">Checklist</h3>
          <ol className="sv-checklist">
            {guidance.steps.map((s) => <li key={s}>{s}</li>)}
          </ol>
        </section>

        <section aria-labelledby="sv-place">
          <h2 id="sv-place">Nearest safe place</h2>
          {!location ? (
            <>
              <button className="sv-nav" onClick={locate} disabled={locating}>{locating ? 'Locating…' : 'Use my location'}</button>
              {locError && <p className="sv-warn" role="alert">{locError}</p>}
              <p className="sv-note">Your location stays in this browser and is used only to find a safe place.</p>
            </>
          ) : nearest.loading && !place ? (
            <p className="sv-note" aria-live="polite">Finding the nearest safe place…</p>
          ) : nearest.error ? (
            <p className="sv-warn">{nearest.error} Follow the official instructions above.</p>
          ) : !place ? (
            <p className="sv-note">No suitable place found nearby. Follow the official instructions above.</p>
          ) : (
            <>
              <div className="sv-place"><PlaceSummary place={place} /></div>
              {!routeReady?.route && (
                <button className="sv-nav" onClick={() => props.onNavigate(place)} disabled={routeReady?.loading}>
                  {routeReady?.loading ? 'Finding route…' : 'Navigate'}
                </button>
              )}
              {routeReady && <RouteSteps state={routeReady} large />}
              {routeReady?.route && (
                <div className="sv-actions">
                  <button className="sv-nav" onClick={() => props.onView('map')}>Show route on map</button>
                  <a className="sv-btn" href={osmDirectionsUrl(location, place)} target="_blank" rel="noreferrer">Open in OpenStreetMap ↗</a>
                </div>
              )}
              {others.length > 0 && (
                <details className="sv-others">
                  <summary>Other places nearby ({others.length})</summary>
                  <ul>
                    {others.map((p) => (
                      <li key={p.id}>
                        <button className="sv-place-btn" onClick={() => props.onNavigate(p)}><PlaceSummary place={p} /></button>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </section>

        <section aria-labelledby="sv-call">
          <h2 id="sv-call">Emergency numbers</h2>
          <a className="sv-call-911" href="tel:911">Call 911</a>
          <ul className="sv-numbers">
            {EMERGENCY_NUMBERS.slice(1).map((n) => (
              <li key={n.number}>{n.label}: <a href={`tel:${n.number.replace(/[^0-9+]/g, '')}`}>{n.number}</a></li>
            ))}
          </ul>
          <p className="sv-note">Outside the US, call your local emergency number (112 in Europe).</p>
        </section>

        {otherAlerts.length > 0 && (
          <section aria-labelledby="sv-more">
            <h2 id="sv-more">Other active alerts</h2>
            <ul className="sv-numbers">
              {otherAlerts.map((a) => <li key={a.id}><strong>{a.event}</strong>{a.headline && `: ${a.headline}`}</li>)}
            </ul>
          </section>
        )}

        {exitButton(true)}
        <p className="sv-foot">
          Beacon is a helper. It does not replace official alerts or emergency services. Always follow instructions from officials.
        </p>
      </div>
    </div>
  );
}
