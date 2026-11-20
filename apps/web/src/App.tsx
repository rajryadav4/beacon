// Beacon: the CrimeRadar design and features (Explore, safe Directions, Trip mode with danger alerts)
// plus Beacon's alerts, safe places, hazard outlook and map-first survival mode.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppContext, requestGps, type AppServices, type ToastOpts, type UserLocation } from './context';
import AccountMenu from './components/AccountMenu';
import AlertsView from './components/alerts/AlertsView';
import DirectionsView, { initialDir, type DirState, type StartTrip } from './components/directions/DirectionsView';
import ExploreView from './components/explore/ExploreView';
import { Boot, DangerBanner, MapButtons, PickBanner, Toast, type ToastState } from './components/Overlays';
import Panel, { type View } from './components/Panel';
import PlacesView from './components/places/PlacesView';
import SurvivalView from './components/survival/SurvivalView';
import TripView from './components/trip/TripView';
import { Floating, Icon } from './components/ui';
import { useActiveAlerts, useAlertsStatus, useHazards, useNearestPlaces, useOutlook, useSafeAreas } from './hooks/beacon';
import { useMapBoot } from './hooks/useMapBoot';
import { useOverlays } from './hooks/useOverlays';
import { usePassiveAlerts } from './hooks/usePassiveAlerts';
import { useSurvival } from './hooks/useSurvival';
import type { TripPlan } from './hooks/useTripRunner';
import { isDarkBand, nowBand } from './lib/clock';
import { DangerAlerts, type DangerNotice } from './lib/danger';
import { DEMO_START, inSeattle, type LatLng } from './lib/geo';
import {
  loadPlaces, loadPrefs, loadTrips, newId, savePlaces, savePrefs, saveTrips, type Prefs, type SavedPlace, type TripRecord,
} from './lib/storage';

const VIEWS: View[] = ['explore', 'directions', 'alerts', 'places', 'trip'];
const viewFromHash = (): View => {
  const v = location.hash.replace(/^#\/?/, '') as View;
  return VIEWS.includes(v) ? v : 'explore';
};
let tripSeq = 0;

export default function App() {
  const mapEl = useRef<HTMLDivElement>(null);
  const { booted, error, retry } = useMapBoot(mapEl);
  const ctrl = booted?.ctrl ?? null;

  // ---- personal data (this browser only) ----
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const [places, setPlacesState] = useState<SavedPlace[]>(loadPlaces);
  const [trips, setTrips] = useState<TripRecord[]>(loadTrips);
  const setPrefs = useCallback((p: Prefs) => { setPrefsState(p); savePrefs(p); }, []);
  const setPlaces = useCallback((l: SavedPlace[]) => { setPlacesState(l); savePlaces(l); }, []);
  const addTrip = useCallback((t: TripRecord) => setTrips((list) => { const next = [t, ...list].slice(0, 20); saveTrips(next); return next; }), []);

  // ---- toast, pick mode, 3D ----
  const [toast, setToast] = useState<ToastState | null>(null);
  const showToast = useCallback((message: string, opts: ToastOpts = {}) => setToast({ id: Date.now(), message, duration: opts.duration ?? 5000, ...opts }), []);
  const closeToast = useCallback(() => setToast(null), []);
  const [pickLabel, setPickLabel] = useState<string | null>(null);
  const [threeD, setThreeDState] = useState(true);
  const setThreeD = useCallback((on: boolean) => { setThreeDState(on); ctrl?.set3D(on); }, [ctrl]);
  const startPick = useCallback((label: string, cb: (p: LatLng) => void) => {
    if (!ctrl) return;
    setPickLabel(label);
    ctrl.pick((p) => { setPickLabel(null); cb(p); });
  }, [ctrl]);
  const cancelPick = () => { ctrl?.pick(null); setPickLabel(null); };

  // ---- location ----
  const [userLocation, setUserLocation] = useState<UserLocation | null>(null);
  useEffect(() => { ctrl?.setMe(userLocation); }, [ctrl, userLocation]);
  const locate = useCallback(async () => {
    const l = await requestGps();
    setUserLocation(l);
    return l;
  }, []);
  useEffect(() => {
    if (!ctrl) return;
    ctrl.onContext = (p) => {
      setUserLocation({ ...p, source: 'map' });
      showToast('Location set here. Alerts and safe places use this point.');
    };
    ctrl.intro(true);
  }, [ctrl, showToast]);

  // ---- danger alerts ----
  const [notice, setNotice] = useState<DangerNotice | null>(null);
  const closeNotice = useCallback(() => setNotice(null), []);
  const danger = useMemo(() => (booted ? new DangerAlerts(booted.model, setNotice) : null), [booted]);

  // ---- views ----
  const [view, setViewState] = useState<View>(viewFromHash);
  const setView = useCallback((v: View) => { setViewState(v); if (location.hash !== `#/${v}`) location.hash = `#/${v}`; }, []);
  useEffect(() => {
    const on = () => setViewState(viewFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dir, setDir] = useState<DirState>(() => initialDir(loadPrefs().mode));
  const [focusTo, setFocusTo] = useState(0);
  const [plan, setPlan] = useState<TripPlan | null>(null);
  useEffect(() => { if (view === 'trip' && !plan) setView('directions'); }, [view, plan, setView]);

  // ---- Beacon data ----
  const hazards = useHazards();
  const alertsState = useActiveAlerts(userLocation);
  const { status, error: statusError } = useAlertsStatus();
  const survival = useSurvival(alertsState.data, hazards);
  const outlook = useOutlook(view === 'alerts' ? userLocation : null);
  const [placesHazard, setPlacesHazard] = useState<string | null>(null);
  const shownPlacesHazard = placesHazard ?? survival.topHazard ?? 'other';
  const nearest = useNearestPlaces(view === 'places' && !survival.on ? userLocation : null, shownPlacesHazard, 5);
  const safeAreas = useSafeAreas(view === 'places' && !survival.on ? userLocation : null, shownPlacesHazard);
  const [showPlaces, setShowPlaces] = useState(true);
  const [showAreas, setShowAreas] = useState(true);
  const [hazardLayer, setHazardLayer] = useState<string | null>(null);
  const overlays = useOverlays(ctrl, {
    showPlaces: showPlaces && (view !== 'explore' || survival.on), showAreas: showAreas || survival.on, hazardLayer,
    alertsKey: survival.alerts.map((a) => String(a.id)).join(','),
  });
  usePassiveAlerts(danger, prefs.alerts && !plan && !survival.on, prefs.mode);

  // Announce new alerts to screen readers.
  const seen = useRef(new Set<string | number>());
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    const fresh = survival.alerts.filter((a) => !seen.current.has(a.id));
    survival.alerts.forEach((a) => seen.current.add(a.id));
    if (fresh.length) setAnnouncement(`New alert${fresh.length > 1 ? 's' : ''}: ${fresh.map((a) => `${a.demo ? 'Demo. ' : ''}${a.event}. ${a.headline ?? ''}`).join(' ')}`);
  }, [survival.alerts]);

  // Alerts and Safe places follow the Seattle clock for the palette (Explore and Directions set their own).
  useEffect(() => {
    if (ctrl && !survival.on && (view === 'alerts' || view === 'places')) ctrl.setDark(isDarkBand(nowBand()));
    if (ctrl && view === 'trip' && plan) ctrl.setDark(isDarkBand(plan.band));
  }, [ctrl, view, plan, survival.on]);

  // Survival ends any normal trip.
  useEffect(() => { if (survival.on && plan) { setPlan(null); if (view === 'trip') setView('directions'); } }, [survival.on]);

  const startTrip = ({ route, simulate, dir: d }: StartTrip) => {
    if (!d.from || !d.to) return;
    const dep = { band: nowBand() };
    const band = d.when.now ? dep.band : Math.floor(Number(d.when.time.split(':')[0]) / 6) as 0 | 1 | 2 | 3;
    setPlan({
      id: ++tripSeq, coords: route.coords, duration: route.duration, distance: route.distance, steps: route.steps,
      from: { ...d.from }, to: { ...d.to, safe: d.to.kind === 'safe' }, mode: d.mode, band, simulate,
      level: route.score.level, score: route.score.score,
    });
    addTrip({
      id: newId(), fromLabel: d.from.name, toLabel: d.to.name, toLat: d.to.lat, toLng: d.to.lng, mode: d.mode,
      departAt: new Date().toISOString(), distanceMeters: Math.round(route.distance), durationSeconds: Math.round(route.duration),
      riskScore: route.score.score, riskLevel: route.score.level, choice: route.choice, createdAt: new Date().toISOString(),
    });
    setView('trip');
  };
  const endTrip = () => { setPlan(null); setNotice(null); setView('directions'); };

  const routeTo = (to: LatLng & { name: string; detail?: string; safeKind?: string }) => {
    setDir((d) => ({
      ...d,
      from: d.from ?? (userLocation ? { name: 'My location', detail: booted?.model.areaName(userLocation.lat, userLocation.lng) ?? 'Seattle', lat: userLocation.lat, lng: userLocation.lng, kind: 'gps' } : null),
      to: { name: to.name, detail: to.detail, lat: to.lat, lng: to.lng, kind: to.safeKind || to.detail?.includes('safe') ? 'safe' : 'pin', safeKind: to.safeKind },
    }));
    setMenuOpen(false);
    setView('directions');
  };

  const onDemo = (h: string) => {
    if (!userLocation) {
      setUserLocation({ lat: DEMO_START.lat, lng: DEMO_START.lng, source: 'demo' });
      showToast('DEMO: using Pike Place Market as your location. Set your own with My location or a tap on the map.', { duration: 7000 });
    }
    survival.demo(h);
  };

  const onLocateBtn = () => {
    locate().then((l) => {
      if (!inSeattle(l.lat, l.lng)) showToast('You are outside Seattle. Crime data covers Seattle only; alerts and safe places still work.');
      ctrl?.flyTo(l.lat, l.lng, 15);
    }).catch((e: Error) => showToast(e.message, { actionLabel: 'Pick on map', onAction: () => startPick('Tap the map where you are', (p) => setUserLocation({ ...p, source: 'map' })) }));
  };

  const services: AppServices | null = booted && ctrl ? {
    model: booted.model, ctrl, landmarks: booted.landmarks, live: booted.live, hazards, toast: showToast,
    location: userLocation, setLocation: setUserLocation, locate, startPick, threeD, setThreeD,
    prefs, setPrefs, places, setPlaces, trips, addTrip,
  } : null;

  return (
    <>
      <div ref={mapEl} className="map" role="region" aria-label="Map of Seattle. Long-press or right-click to set your location." />
      <div className="map-vignette" aria-hidden="true" />
      <div className="sr-only" aria-live="assertive" aria-atomic="true">{announcement}</div>
      {!services && <Boot error={error} onRetry={retry} />}
      {services && (
        <AppContext.Provider value={services}>
          <div className={`app${survival.on ? ' in-survival' : ''}`}>
            {survival.on && danger ? (
              <SurvivalView hazard={survival.hazard} hazardLabel={survival.label} alert={survival.alert}
                otherAlerts={survival.alerts.filter((a) => a.id !== survival.alert?.id)} danger={danger} onExit={survival.exit} />
            ) : (
              <Panel view={view} onView={setView} alerts={survival.alerts}>
                {view === 'explore' && <ExploreView onWhereTo={() => { setView('directions'); setFocusTo((n) => n + 1); }} />}
                {view === 'directions' && <DirectionsView dir={dir} setDir={setDir} onStart={startTrip} hazard={survival.topHazard ?? 'other'} focusTo={focusTo} />}
                {view === 'trip' && plan && danger && <TripView plan={plan} danger={danger} onExit={endTrip} />}
                {view === 'alerts' && (
                  <AlertsView alerts={survival.alerts} incidents={alertsState.data?.incidents ?? []} state={alertsState}
                    status={status} statusError={statusError} defaultHazard={survival.topHazard ?? hazards[0]?.key ?? 'other'}
                    demoActive={survival.demoActive} onSurvival={survival.start} onDemo={onDemo} onClearDemo={survival.clearDemo}
                    outlook={outlook} hazardLayer={hazardLayer} onHazardLayer={setHazardLayer} layerState={overlays.layerState}
                    showAreas={showAreas} onShowAreas={setShowAreas} />
                )}
                {view === 'places' && (
                  <PlacesView hazard={shownPlacesHazard} onHazard={setPlacesHazard} nearest={nearest} areas={safeAreas}
                    onRoute={routeTo} showPlaces={showPlaces} onShowPlaces={setShowPlaces} placesNote={overlays.placesNote} />
                )}
              </Panel>
            )}
            <Floating>
              <button className="avatar" type="button" aria-haspopup="dialog" aria-expanded={menuOpen} title="Your places and settings" onClick={() => setMenuOpen(!menuOpen)}>
                <Icon name="user" />
              </button>
            </Floating>
            <Floating><AccountMenu open={menuOpen} onClose={() => setMenuOpen(false)} onTrip={routeTo} /></Floating>
            <MapButtons threeD={threeD} onThreeD={() => setThreeD(!threeD)} onLocate={onLocateBtn} />
            <PickBanner label={pickLabel} onCancel={cancelPick} />
            <DangerBanner notice={notice} onClose={closeNotice} />
            <Toast toast={toast} onClose={closeToast} />
          </div>
        </AppContext.Provider>
      )}
    </>
  );
}
