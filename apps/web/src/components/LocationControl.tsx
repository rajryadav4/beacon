import { useState } from 'react';
import type { LatLng } from '../lib/routing';

export interface UserLocation extends LatLng {
  source: 'gps' | 'map';
  accuracyM?: number;
}

/** Ask the browser for the current position. Only ever called from a user action. */
export function requestGps(): Promise<UserLocation> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('This browser cannot share your location. Long-press or right-click the map instead.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy, source: 'gps' }),
      (err) => reject(new Error(err.code === err.PERMISSION_DENIED
        ? 'Location permission was denied. Long-press or right-click the map to set your location instead.'
        : 'Could not get your location. Long-press or right-click the map instead.')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  });
}

interface Props {
  location: UserLocation | null;
  onChange: (loc: UserLocation | null) => void;
  pickMode: boolean;
  onPickMode: (on: boolean) => void;
}

export default function LocationControl({ location, onChange, pickMode, onPickMode }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const locate = () => {
    setBusy(true);
    setError(null);
    requestGps()
      .then(onChange)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <section className="location" aria-labelledby="loc-h">
      <h2 id="loc-h" className="visually-hidden">Your location</h2>
      <div className="loc-row">
        <button className="btn primary" onClick={locate} disabled={busy}>
          {busy ? 'Locating…' : 'Use my location'}
        </button>
        <button className="btn" aria-pressed={pickMode} onClick={() => onPickMode(!pickMode)}>
          {pickMode ? 'Tap the map…' : 'Pick on map'}
        </button>
      </div>
      <p className="loc-status" aria-live="polite">
        {location ? (
          <>
            <span className="dot" aria-hidden="true" />
            {location.source === 'gps'
              ? `Using your location${location.accuracyM ? ` (±${Math.round(location.accuracyM)} m)` : ''}`
              : 'Location set on the map'}
            {' · '}
            <button className="link" onClick={() => onChange(null)}>Clear</button>
          </>
        ) : pickMode ? 'Click the map where you are.' : 'No location set. Long-press or right-click the map, or use a button above.'}
      </p>
      {error && <p className="error small" role="alert">{error}</p>}
      <p className="privacy">
        Your location stays in this browser. Beacon sends it, rounded, only to its own server for alerts and safe places,
        and to the OpenStreetMap routing server when you ask for a walking route. Nothing is stored.
      </p>
    </section>
  );
}
