// Beacon's map overlays for the visible area: safe places, official alert areas and the hazard layer.

import { useEffect, useState } from 'react';
import { ApiError, SCORED_HAZARDS, api, errorMessage, supports, type BBox } from '../api';
import type { LayerState } from '../components/alerts/AlertsView';
import { ALERT_POLL_MS } from './beacon';
import type { MapController } from '../lib/map/controller';

const PLACES_MIN_ZOOM = 11.5;

interface Opts { placesMinZoom?: number; showPlaces: boolean; showAreas: boolean; hazardLayer: string | null; alertsKey: string }

export function useOverlays(ctrl: MapController | null, { placesMinZoom = PLACES_MIN_ZOOM, showPlaces, showAreas, hazardLayer, alertsKey }: Opts) {
  const [view, setView] = useState<{ bbox: BBox; zoom: number } | null>(null);
  const [placesError, setPlacesError] = useState<string | null>(null);
  const [layerState, setLayerState] = useState<LayerState>('idle');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!ctrl) return;
    ctrl.onMoveEnd = (bbox, zoom) => setView({ bbox, zoom });
    if (ctrl.loaded) setView({ bbox: ctrl.bbox(), zoom: ctrl.map.getZoom() });
    return () => { ctrl.onMoveEnd = null; };
  }, [ctrl]);

  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), ALERT_POLL_MS);
    return () => window.clearInterval(t);
  }, []);

  // Safe places (zoomed in only; there are thousands).
  useEffect(() => {
    if (!ctrl) return;
    if (!view || !showPlaces || view.zoom < placesMinZoom) { ctrl.setSafePlaces(null); return; }
    const c = new AbortController();
    const timer = window.setTimeout(() => {
      api.safePlaces(view.bbox, [], c.signal)
        .then((d) => { ctrl.setSafePlaces(d); setPlacesError(null); })
        .catch((e) => { if (!c.signal.aborted) setPlacesError(errorMessage(e, 'safe places')); });
    }, 350);
    return () => { window.clearTimeout(timer); c.abort(); };
  }, [ctrl, view, showPlaces, placesMinZoom]);

  // Official alert areas, refreshed with the alerts poll.
  useEffect(() => {
    if (!ctrl) return;
    if (!view || !showAreas) { ctrl.setAlertAreas(null); return; }
    const c = new AbortController();
    const timer = window.setTimeout(() => {
      api.alertAreas(view.bbox, c.signal).then((d) => ctrl.setAlertAreas(d)).catch(() => { if (!c.signal.aborted) ctrl.setAlertAreas(null); });
    }, 350);
    return () => { window.clearTimeout(timer); c.abort(); };
  }, [ctrl, view, showAreas, tick, alertsKey]);

  // Hazard map: worst-to-safest grid (once per hazard) and the official zones for the visible area.
  useEffect(() => {
    if (!ctrl) return;
    if (!hazardLayer) { ctrl.setHazardGrid(null); setLayerState((s) => (s === 'unavailable' ? s : 'idle')); return; }
    if (!SCORED_HAZARDS.includes(hazardLayer)) return;
    const c = new AbortController();
    setLayerState('loading');
    api.hazardGrid(hazardLayer, c.signal)
      .then((fc) => { ctrl.setHazardGrid(fc); setLayerState('ready'); })
      .catch((e) => {
        if (c.signal.aborted) return;
        ctrl.setHazardGrid(null);
        setLayerState(!(e instanceof ApiError) || e.unavailable ? 'unavailable' : 'ready');
      });
    return () => c.abort();
  }, [ctrl, hazardLayer]);

  useEffect(() => {
    if (!ctrl || !hazardLayer || !view) { if (ctrl && !hazardLayer) ctrl.setHazardZones(null); return; }
    const c = new AbortController();
    const timer = window.setTimeout(() => {
      api.hazardZones(hazardLayer, view.bbox, c.signal).then((fc) => ctrl.setHazardZones(fc)).catch(() => { if (!c.signal.aborted) ctrl.setHazardZones(null); });
    }, 350);
    return () => { window.clearTimeout(timer); c.abort(); };
  }, [ctrl, hazardLayer, view]);

  // Hide the hazard map section when the API does not have it.
  useEffect(() => {
    let live = true;
    supports('/api/hazard-grid').then((ok) => { if (live && !ok) setLayerState('unavailable'); });
    return () => { live = false; };
  }, []);

  const placesNote = !showPlaces ? 'Safe places are hidden on the map.'
    : placesError ?? (view && view.zoom < placesMinZoom ? 'Zoom in to see safe places on the map.' : null);
  return { view, placesNote, layerState };
}
