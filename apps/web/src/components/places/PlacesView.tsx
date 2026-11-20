// Safe places: the nearest suitable places for a hazard, "Where to go" low-exposure areas, and the map layer.
// "Route here" plans a crime-scored route in Directions.

import type { NearestPlace, SafeAreas } from '../../api';
import { useApp } from '../../context';
import type { NearestState, Optional } from '../../hooks/beacon';
import { formatDistance, walkTime } from '../../lib/format';
import { KIND_COLOR, KIND_LABEL, kindColor } from '../../lib/hazards';
import type { LatLng } from '../../lib/geo';
import LocationBar from '../LocationBar';
import { Icon } from '../ui';

export function PlaceSummary({ place }: { place: NearestPlace }) {
  return (
    <span className="place-sum">
      <span className="place-name">{place.name || place.kindLabel}</span>
      <span className="place-meta">
        <span className="kind-dot" style={{ background: kindColor(place.kind) }} aria-hidden="true" />
        {place.kindLabel} · {formatDistance(place.distanceM)} · ~{walkTime(place.distanceM)} walk
      </span>
      {(place.address || place.openingHours) && (
        <span className="place-extra">{[place.address, place.openingHours && `Hours: ${place.openingHours}`].filter(Boolean).join(' · ')}</span>
      )}
    </span>
  );
}

interface Props {
  hazard: string;
  onHazard: (key: string) => void;
  nearest: NearestState;
  areas: Optional<SafeAreas>;
  onRoute: (to: LatLng & { name: string; detail: string; safeKind?: string }) => void;
  showPlaces: boolean;
  onShowPlaces: (on: boolean) => void;
  placesNote: string | null;
}

export default function PlacesView({ hazard, onHazard, nearest, areas, onRoute, showPlaces, onShowPlaces, placesNote }: Props) {
  const { hazards, location, ctrl } = useApp();
  const a = areas.data;
  return (
    <section aria-label="Safe places">
      <div className="section"><LocationBar compact /></div>
      <div className="section">
        <div className="section-title"><span>Nearest safe places</span></div>
        <label className="field">
          <span>For</span>
          <select className="input" value={hazard} onChange={(e) => onHazard(e.target.value)}>
            {hazards.map((h) => <option key={h.key} value={h.key}>{h.label}</option>)}
          </select>
        </label>
        {!location && <p className="hint">Set your location to find the nearest safe places.</p>}
        {nearest.loading && <div className="skeleton skeleton-sm" aria-hidden="true" />}
        {nearest.error && <p className="form-error">{nearest.error}</p>}
        {location && !nearest.loading && !nearest.error && nearest.places.length === 0 && <p className="hint">No suitable places found nearby. Follow official instructions.</p>}
        <ul className="safe-list">
          {nearest.places.map((p) => (
            <li key={p.id}>
              <button className="safe-item" type="button" onClick={() => ctrl.flyTo(p.lat, p.lng, 16)}><PlaceSummary place={p} /></button>
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => onRoute({ lat: p.lat, lng: p.lng, name: p.name || p.kindLabel, detail: `${p.kindLabel} · safe place`, safeKind: p.kind })}>
                <Icon name="route" className="icon-sm" />Route
              </button>
            </li>
          ))}
        </ul>
        {nearest.places.length > 0 && <p className="hint">Straight-line distance. “Route” compares safe routes in Directions.</p>}
      </div>

      {!areas.unavailable && location && (
        <div className="section">
          <div className="section-title"><span>Where to go</span><small>{a?.hazardLabel}</small></div>
          {areas.loading && !a && <div className="skeleton skeleton-sm" aria-hidden="true" />}
          {a?.advice && <p className="route-why">{a.advice}</p>}
          {a && a.areas.length === 0 && a.places.length === 0 && <p className="hint">{a.note}</p>}
          <ul className="safe-list">
            {a?.areas.map((x) => (
              <li key={x.cellId}>
                <button className="safe-item" type="button" onClick={() => ctrl.flyTo(x.lat, x.lng, 15.5)}>
                  <span className="place-sum"><span className="place-name"><Icon name="flag" className="icon-sm" /> Safer area · {formatDistance(x.distanceM)}</span>
                    <span className="place-extra">{x.reason}</span></span>
                </button>
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => onRoute({ lat: x.lat, lng: x.lng, name: 'Safer area', detail: x.reason })}><Icon name="route" className="icon-sm" />Route</button>
              </li>
            ))}
          </ul>
          {a && (a.areas.length > 0) && <p className="hint">{a.note}</p>}
        </div>
      )}

      <div className="section">
        <label className="switch-row toggle-line">
          <span>Show safe places on the map</span>
          <span className="toggle"><input type="checkbox" checked={showPlaces} onChange={(e) => onShowPlaces(e.target.checked)} /><span /></span>
        </label>
        <ul className="kind-legend">
          {Object.entries(KIND_COLOR).map(([kind, color]) => (
            <li key={kind}><span className="kind-dot" style={{ background: color }} aria-hidden="true" />{KIND_LABEL[kind] ?? kind}</li>
          ))}
        </ul>
        {placesNote && <p className="hint">{placesNote}</p>}
      </div>
    </section>
  );
}
