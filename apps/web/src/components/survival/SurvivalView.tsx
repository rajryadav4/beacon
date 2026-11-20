// Map-first survival mode. The map stays on screen and becomes the guidance: your position, the danger
// area shaded, the chosen safe place marked, the walking route drawn bold, a big direction arrow with
// distance and time to go, and the next turn. "Navigate" follows you (watchPosition, only while
// navigating); "Simulate" plays the walk for demos. Instructions sit in a collapsible sheet / side panel.

import { useEffect, useMemo, useState } from 'react';
import { api, type Alert } from '../../api';
import { useApp } from '../../context';
import { useNearestPlaces, useSafeAreas } from '../../hooks/beacon';
import { useTripRunner, type TripPlan } from '../../hooks/useTripRunner';
import { nowBand } from '../../lib/clock';
import type { DangerAlerts } from '../../lib/danger';
import { isAbort } from '../../lib/format';
import { bearing, circleRing, cumulative, pointAt, type LatLng, type Pt } from '../../lib/geo';
import { fetchRoute, type RawRoute } from '../../lib/routing';
import NavChip, { type NavInfo } from '../trip/NavChip';
import SurvivalSheet, { type Target } from './SurvivalSheet';

interface Props {
  hazard: string;
  hazardLabel: string;
  alert: Alert | null;
  otherAlerts: Alert[];
  danger: DangerAlerts;
  onExit: () => void;
}

let planSeq = 0;

export default function SurvivalView({ hazard, hazardLabel, alert, otherAlerts, danger, onExit }: Props) {
  const { ctrl, location } = useApp();
  const nearest = useNearestPlaces(location, hazard, 4);
  const safeAreas = useSafeAreas(location, hazard);
  const [choice, setChoice] = useState<Target | null>(null);
  const [route, setRoute] = useState<{ key: string; data: RawRoute | null; error: string | null } | null>(null);
  const [nav, setNav] = useState<TripPlan | null>(null);
  const [rerouteFrom, setRerouteFrom] = useState<LatLng | null>(null);
  const progress = useTripRunner(nav, danger);

  // Destinations: suitable places in low-exposure areas first (when the outlook API has them), then the nearest.
  const targets = useMemo<Target[]>(() => {
    const fromAreas: Target[] = (safeAreas.data?.places ?? []).map((p) => ({
      id: `p${p.id}`, lat: p.lat, lng: p.lng, name: p.name || p.kindLabel, detail: p.kindLabel, distanceM: p.distanceM,
      reason: p.reason, kind: p.kind, address: p.address, openingHours: p.openingHours,
    }));
    const near: Target[] = nearest.places.map((p) => ({
      id: `p${p.id}`, lat: p.lat, lng: p.lng, name: p.name || p.kindLabel, detail: p.kindLabel, distanceM: p.distanceM,
      kind: p.kind, address: p.address, openingHours: p.openingHours,
    }));
    const seen = new Set<string>();
    return [...fromAreas, ...near].filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  }, [safeAreas.data, nearest.places]);
  const areas = useMemo<Target[]>(() => (safeAreas.data?.areas ?? []).map((a) => ({
    id: `a${a.cellId}`, lat: a.lat, lng: a.lng, name: 'Safer area', detail: a.reason, distanceM: a.distanceM, reason: a.reason, area: true,
  })), [safeAreas.data]);

  // High ground nearby beats a shelter far away (tsunami, flood): take a safer area when it is under half the walk.
  const nearArea = areas[0] && (!targets[0] || areas[0].distanceM < targets[0].distanceM * 0.5) ? areas[0] : null;
  const target = choice ?? nearArea ?? targets[0] ?? null;
  const start = rerouteFrom ?? location;
  const key = target && start ? `${start.lat.toFixed(5)},${start.lng.toFixed(5)}>${target.id}` : null;

  // Fetch the walking route as soon as there is a place: the map shows the way without a click.
  useEffect(() => {
    if (!key || !target || !start) { setRoute(null); return; }
    const c = new AbortController();
    setRoute({ key, data: null, error: null });
    fetchRoute(start, target, 'walk', c.signal)
      .then((r) => setRoute({ key, data: r, error: null }))
      .catch((e) => { if (!isAbort(e) && !c.signal.aborted) setRoute({ key, data: null, error: e instanceof Error ? e.message : 'No walking route found.' }); });
    return () => c.abort();
  }, [key]);

  const ready = route?.key === key ? route.data : null;

  // Map: night palette for contrast, no crime layers, the danger area, safer areas and the bold route.
  useEffect(() => {
    ctrl.setDark(true);
    ctrl.setLayer('none');
    ctrl.closePopup();
    return () => { ctrl.clearRoutes(); ctrl.setEndpoints(null, null); ctrl.setDangerArea(null); ctrl.setSafeAreas([]); ctrl.setHazardZones(null); };
  }, [ctrl]);

  useEffect(() => {
    // A DEMO alert has no official area: shade a circle around the user so the map shows what "danger here" means.
    if (alert?.demo && location) {
      ctrl.setDangerArea({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [circleRing(location, 450)] } }] });
    } else ctrl.setDangerArea(null);
  }, [ctrl, alert, location]);

  useEffect(() => {
    if (!location) return;
    const c = new AbortController();
    const d = 0.03;
    api.hazardZones(hazard, [location.lng - d * 1.5, location.lat - d, location.lng + d * 1.5, location.lat + d], c.signal)
      .then((fc) => ctrl.setHazardZones(fc)).catch(() => ctrl.setHazardZones(null));
    return () => c.abort();
  }, [ctrl, hazard, location]);

  useEffect(() => { ctrl.setSafeAreas(areas.map((a) => ({ lat: a.lat, lng: a.lng, title: a.reason ?? 'Safer area' })), (i) => setChoice(areas[i])); }, [ctrl, areas]);

  useEffect(() => {
    if (!ready || !target) { ctrl.clearRoutes(); ctrl.setEndpoints(null, target); return; }
    ctrl.drawRoutes([{ coords: ready.coords, role: 'best', duration: ready.duration }], 0, null, { guide: true });
    ctrl.setEndpoints(null, target, true);
    if (!nav) ctrl.fit(ready.coords, 17, 0.42);
  }, [ctrl, ready, target]);

  const begin = (simulate: boolean) => {
    if (!ready || !target || !start) return;
    setNav({
      id: ++planSeq, coords: ready.coords, duration: ready.duration, distance: ready.distance, steps: ready.steps,
      from: { ...start, name: 'Your location' }, to: { lat: target.lat, lng: target.lng, name: target.name, safe: true },
      mode: 'walk', band: nowBand(), simulate, survival: true,
    });
  };
  const stop = () => { setNav(null); setRerouteFrom(null); };
  const reroute = () => {
    if (!progress) return;
    setRerouteFrom({ lat: progress.pos[0], lng: progress.pos[1] });
    setNav(null);
  };
  const choose = (t: Target) => { setNav(null); setRerouteFrom(null); setChoice(t); };

  const info: NavInfo | null = useMemo(() => {
    if (!target) return null;
    if (nav && progress) {
      return {
        heading: progress.heading, remainingM: progress.remainingM, remainingS: progress.remainingS, toName: target.name,
        nextStep: progress.nextStep, distToNext: progress.distToNext, arrived: progress.arrived, offRoute: progress.offRoute, safe: true,
      };
    }
    if (!ready) return null;
    const acc = cumulative(ready.coords);
    const first: Pt = ready.coords[0];
    const next = ready.steps.find((s) => s.type !== 'depart') ?? null;
    return {
      heading: bearing(first, pointAt(ready.coords, acc, 30)), remainingM: ready.distance, remainingS: ready.duration,
      toName: target.name, nextStep: next, distToNext: next ? next.at : ready.distance, arrived: false, safe: true, preview: true,
    };
  }, [nav, progress, ready, target]);

  return (
    <>
      {info && <NavChip info={info} survival />}
      <SurvivalSheet
        hazard={hazard} hazardLabel={hazardLabel} alert={alert} otherAlerts={otherAlerts}
        target={target} targets={targets} areas={areas}
        loading={nearest.loading || (safeAreas.loading && !targets.length)} placesError={nearest.error}
        route={ready} routeError={route?.key === key ? route.error : null} routeLoading={Boolean(key) && !ready && !(route?.key === key && route.error)}
        nav={nav} progress={progress} advice={safeAreas.data?.advice ?? null}
        onChoose={choose} onNavigate={begin} onStop={stop} onReroute={reroute} onExit={onExit}
      />
    </>
  );
}
