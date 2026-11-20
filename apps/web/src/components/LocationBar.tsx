// Where Beacon thinks you are (for alerts and safe places): GPS, a tap on the map, or clear.

import { useState } from 'react';
import { useApp } from '../context';
import { Icon } from './ui';

export default function LocationBar({ compact }: { compact?: boolean }) {
  const { location, setLocation, locate, startPick, model, ctrl } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const gps = () => {
    setBusy(true);
    setError(null);
    locate()
      .then((l) => ctrl.flyTo(l.lat, l.lng, 15))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const pick = () => startPick('Tap the map where you are', (p) => setLocation({ ...p, source: 'map' }));
  const area = location ? model.areaName(location.lat, location.lng) : null;

  return (
    <div className="loc-bar">
      <div className="loc-status" aria-live="polite">
        <span className={`loc-dot${location ? ' is-on' : ''}`} aria-hidden="true" />
        <span>
          {location
            ? <>{location.source === 'gps' ? 'Using your location' : location.source === 'demo' ? 'Demo location' : 'Location set on the map'}{area ? ` · ${area}` : ''}{location.accuracyM ? ` (±${Math.round(location.accuracyM)} m)` : ''}</>
            : 'No location set yet'}
        </span>
        {location && <button className="link" type="button" onClick={() => setLocation(null)}>Clear</button>}
      </div>
      <div className="loc-actions">
        <button className="btn btn-secondary btn-sm" type="button" onClick={gps} disabled={busy}><Icon name="locate" className="icon-sm" />{busy ? 'Locating…' : 'My location'}</button>
        <button className="btn btn-secondary btn-sm" type="button" onClick={pick}><Icon name="crosshair" className="icon-sm" />Pick on map</button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {!compact && (
        <p className="hint privacy">
          Your location stays in this browser. Beacon sends it, rounded, only to its own server for alerts and safe places,
          and to the OpenStreetMap routing server when you ask for a route. Nothing is stored. Tip: long-press or right-click the map.
        </p>
      )}
    </div>
  );
}
