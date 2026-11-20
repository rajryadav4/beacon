// Data hooks for Beacon's endpoints: alerts, safe places and the hazard outlook.
// Every hook keeps working when its endpoint is down: it reports `unavailable` and the UI hides the section.

import { useEffect, useState } from 'react';
import {
  ApiError, api, errorMessage, type ActiveAlerts, type AlertsStatus, type Hazard, type NearestPlace, type Outlook,
  type SafeAreas,
} from '../api';
import { FALLBACK_HAZARDS } from '../lib/hazards';
import type { LatLng } from '../lib/geo';

export const ALERT_POLL_MS = 60_000;

/** Hazard list from the API, falling back to the built-in taxonomy. */
export function useHazards(): Hazard[] {
  const [hazards, setHazards] = useState<Hazard[]>(FALLBACK_HAZARDS);
  useEffect(() => {
    const ctrl = new AbortController();
    api.hazards(ctrl.signal)
      .then((d) => { if (d.hazards?.length) setHazards(d.hazards); })
      .catch(() => { /* keep the fallback list */ });
    return () => ctrl.abort();
  }, []);
  return hazards;
}

export interface AlertsState { data: ActiveAlerts | null; error: string | null; loading: boolean; checkedAt: number | null }

/** Polls `/api/alerts/active` for the chosen location every 60 s (and when the tab becomes visible). */
export function useActiveAlerts(location: LatLng | null): AlertsState {
  const [state, setState] = useState<AlertsState>({ data: null, error: null, loading: false, checkedAt: null });
  const lat = location ? Number(location.lat.toFixed(3)) : undefined;
  const lng = location ? Number(location.lng.toFixed(3)) : undefined;

  useEffect(() => {
    if (lat === undefined || lng === undefined) {
      setState({ data: null, error: null, loading: false, checkedAt: null });
      return;
    }
    let ctrl = new AbortController();
    let stopped = false;
    const load = () => {
      ctrl.abort();
      ctrl = new AbortController();
      const signal = ctrl.signal;
      setState((s) => ({ ...s, loading: true }));
      api.activeAlerts(lat, lng, signal)
        .then((data) => setState({ data, error: null, loading: false, checkedAt: Date.now() }))
        .catch((e) => {
          if (signal.aborted || stopped) return;
          // Keep the last good data so a blip does not hide an active alert.
          setState((s) => ({ ...s, error: errorMessage(e, 'alerts'), loading: false, checkedAt: Date.now() }));
        });
    };
    load();
    const timer = window.setInterval(load, ALERT_POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      ctrl.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [lat, lng]);

  return state;
}

/** Per-source freshness from `/api/alerts/status`, refreshed with the alerts poll. */
export function useAlertsStatus(): { status: AlertsStatus | null; error: string | null } {
  const [status, setStatus] = useState<AlertsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let ctrl = new AbortController();
    const load = () => {
      ctrl.abort();
      ctrl = new AbortController();
      const signal = ctrl.signal;
      api.alertsStatus(signal)
        .then((s) => { setStatus(s); setError(null); })
        .catch((e) => { if (!signal.aborted) setError(errorMessage(e, 'alert status')); });
    };
    load();
    const timer = window.setInterval(load, ALERT_POLL_MS);
    return () => { ctrl.abort(); window.clearInterval(timer); };
  }, []);
  return { status, error };
}

export interface NearestState { places: NearestPlace[]; error: string | null; loading: boolean }

/** The nearest safe places for a hazard (sorted by distance). */
export function useNearestPlaces(location: LatLng | null, hazard: string | null, limit = 5): NearestState {
  const [state, setState] = useState<NearestState>({ places: [], error: null, loading: false });
  const lat = location?.lat;
  const lng = location?.lng;
  useEffect(() => {
    if (lat === undefined || lng === undefined || !hazard) {
      setState({ places: [], error: null, loading: false });
      return;
    }
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    api.nearestSafePlaces(lat, lng, hazard, limit, ctrl.signal)
      .then((d) => setState({ places: d.places ?? [], error: null, loading: false }))
      .catch((e) => { if (!ctrl.signal.aborted) setState({ places: [], error: errorMessage(e, 'safe places'), loading: false }); });
    return () => ctrl.abort();
  }, [lat, lng, hazard, limit]);
  return state;
}

export interface Optional<T> { data: T | null; loading: boolean; unavailable: boolean }

/** A request whose endpoint may not exist yet: a 404 or a network error just hides the feature. */
function useOptional<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>): Optional<T> {
  const [state, setState] = useState<Optional<T>>({ data: null, loading: false, unavailable: false });
  useEffect(() => {
    if (!key) { setState({ data: null, loading: false, unavailable: false }); return; }
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    load(ctrl.signal)
      .then((data) => setState({ data, loading: false, unavailable: false }))
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        setState({ data: null, loading: false, unavailable: !(e instanceof ApiError) || e.unavailable || e.status === 422 });
      });
    return () => ctrl.abort();
    // `load` is rebuilt every render; `key` carries everything it depends on.
  }, [key]);
  return state;
}

/** "Upcoming": the hazard outlook for a point (next ~72 h). */
export function useOutlook(location: LatLng | null): Optional<Outlook> {
  const lat = location?.lat.toFixed(3);
  const lng = location?.lng.toFixed(3);
  return useOptional(lat && lng ? `${lat},${lng}` : null, (signal) => api.outlook(Number(lat), Number(lng), signal));
}

/** "Where to go": low-exposure areas and suitable places for a hazard. */
export function useSafeAreas(location: LatLng | null, hazard: string | null): Optional<SafeAreas> {
  const lat = location?.lat.toFixed(4);
  const lng = location?.lng.toFixed(4);
  return useOptional(lat && lng && hazard ? `${lat},${lng},${hazard}` : null, (signal) => api.safeAreas(Number(lat), Number(lng), hazard!, signal));
}
