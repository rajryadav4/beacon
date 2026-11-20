import type { Hazard, NearestPlace } from '../api';
import type { NearestState } from '../hooks';
import { formatDistance, formatDuration, walkTime } from '../lib/format';
import { KIND_COLOR, KIND_LABEL, kindColor } from '../lib/hazards';
import type { WalkingRoute } from '../lib/routing';

export interface RouteState {
  place: NearestPlace;
  route: WalkingRoute | null;
  loading: boolean;
  error: string | null;
}

export function RouteSteps({ state, large }: { state: RouteState; large?: boolean }) {
  if (state.loading) return <p className="note" aria-live="polite">Finding a walking route…</p>;
  if (state.error) return <p className="error small" role="alert">{state.error}</p>;
  if (!state.route) return null;
  const { route } = state;
  return (
    <div className={`route${large ? ' large' : ''}`}>
      <p className="route-sum" aria-live="polite">
        Walk {formatDistance(route.distanceM)}, about {formatDuration(route.durationS)}, to {state.place.name}
      </p>
      <ol className="turns">
        {route.steps.map((s, i) => (
          <li key={i}>
            <span>{s.instruction}</span>
            {s.distanceM > 0 && <small>{formatDistance(s.distanceM)}</small>}
          </li>
        ))}
      </ol>
      <p className="note">Route by OSRM on OpenStreetMap data. Check the way is open and safe before you go.</p>
    </div>
  );
}

export function PlaceSummary({ place }: { place: NearestPlace }) {
  return (
    <>
      <span className="place-name">{place.name || place.kindLabel}</span>
      <span className="place-meta">
        <span className="kind-dot" style={{ background: kindColor(place.kind) }} aria-hidden="true" />
        {place.kindLabel} · {formatDistance(place.distanceM)} · ~{walkTime(place.distanceM)} walk
      </span>
      {(place.address || place.openingHours) && (
        <span className="place-extra">{[place.address, place.openingHours && `Hours: ${place.openingHours}`].filter(Boolean).join(' · ')}</span>
      )}
    </>
  );
}

interface Props {
  hasLocation: boolean;
  hazards: Hazard[];
  hazard: string;
  onHazard: (key: string) => void;
  nearest: NearestState;
  routeState: RouteState | null;
  onNavigate: (place: NearestPlace) => void;
  onClearRoute: () => void;
  placesNote: string | null;
}

export default function SafePlacesPanel(props: Props) {
  const { hasLocation, hazards, hazard, nearest, routeState } = props;
  return (
    <div className="places-panel">
      <section aria-labelledby="nearest-h">
        <h2 id="nearest-h">Nearest safe place</h2>
        <label className="field">
          <span>For</span>
          <select value={hazard} onChange={(e) => props.onHazard(e.target.value)}>
            {hazards.map((h) => <option key={h.key} value={h.key}>{h.label}</option>)}
          </select>
        </label>
        {!hasLocation && <p className="note">Set your location to find the nearest safe places.</p>}
        {nearest.loading && <p className="note">Searching…</p>}
        {nearest.error && <p className="error small">{nearest.error}</p>}
        {hasLocation && !nearest.loading && !nearest.error && nearest.places.length === 0 && (
          <p className="note">No suitable places found nearby. Follow official instructions.</p>
        )}
        {nearest.places.length > 0 && (
          <ul className="place-list">
            {nearest.places.map((p) => {
              const selected = routeState?.place.id === p.id;
              return (
                <li key={p.id}>
                  <button className="place" aria-pressed={selected} onClick={() => props.onNavigate(p)}>
                    <PlaceSummary place={p} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {nearest.places.length > 0 && <p className="note">Straight-line distance; select a place for the walking route.</p>}
      </section>

      {routeState && (
        <section aria-labelledby="route-h">
          <h2 id="route-h">Walking route <button className="link" onClick={props.onClearRoute}>Clear</button></h2>
          <RouteSteps state={routeState} />
        </section>
      )}

      <section aria-labelledby="kinds-h">
        <h2 id="kinds-h">On the map</h2>
        <ul className="kind-legend">
          {Object.entries(KIND_COLOR).map(([kind, color]) => (
            <li key={kind}><span className="kind-dot" style={{ background: color }} aria-hidden="true" />{KIND_LABEL[kind] ?? kind}</li>
          ))}
        </ul>
        {props.placesNote && <p className="note">{props.placesNote}</p>}
      </section>
    </div>
  );
}
