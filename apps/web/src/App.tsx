import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MlMap } from 'maplibre-gl';
import {
  api, errorMessage, type Alert, type AlertAreas, type BandKey, type BBox, type HeatmapData, type Meta,
  type NearestPlace, type RiskData, type SafePlacesData,
} from './api';
import { ALERT_POLL_MS, useActiveAlerts, useAlertsStatus, useHazards, useNearestPlaces } from './hooks';
import { makeDemoAlert } from './lib/demo';
import { SEVERITY_RANK, severityColor } from './lib/format';
import { hazardLabel } from './lib/hazards';
import { MOCK } from './lib/mock';
import { walkingRoute } from './lib/routing';
import AlertsPanel from './components/AlertsPanel';
import CrimeLayers from './components/CrimeLayers';
import LocationControl, { requestGps, type UserLocation } from './components/LocationControl';
import MapView, { type Layer } from './components/MapView';
import SafePlacesPanel, { type RouteState } from './components/SafePlacesPanel';
import SurvivalMode, { type SurvivalView } from './components/SurvivalMode';

type Tab = 'map' | 'alerts' | 'places';
const TABS: { key: Tab; label: string }[] = [
  { key: 'map', label: 'Map' },
  { key: 'alerts', label: 'Alerts' },
  { key: 'places', label: 'Safe places' },
];
const PLACES_MIN_ZOOM = 11.5;

/** The band that is happening now in Seattle (the default for the risk grid). */
function currentBand(): BandKey {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', hourCycle: 'h23', timeZone: 'America/Los_Angeles',
  }).format(new Date()));
  return (['night', 'morning', 'afternoon', 'evening'] as const)[Math.floor(hour / 6)];
}

const isPhone = () => window.matchMedia('(max-width: 640px)').matches;

export default function App() {
  const mapRef = useRef<MlMap | null>(null);
  const [tab, setTab] = useState<Tab>('map');

  // ---- Crime layers (Seattle) ----
  const [meta, setMeta] = useState<Meta | null>(null);
  const [layer, setLayer] = useState<Layer>('heatmap');
  const [band, setBand] = useState<BandKey | 'all'>('all');
  const [groups, setGroups] = useState<string[]>([]);   // empty = every group
  const [extrude, setExtrude] = useState(false);
  const [heatmap, setHeatmap] = useState<HeatmapData | null>(null);
  const [risk, setRisk] = useState<RiskData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    api.meta(ctrl.signal).then(setMeta).catch(() => { /* the footer just omits the data range */ });
    return () => ctrl.abort();
  }, []);

  // The risk grid has no "all day": switching to it picks the current band.
  const riskBand: BandKey = band === 'all' ? currentBand() : band;

  useEffect(() => {
    if (layer === 'none') { setError(null); setLoading(false); return; }
    const ctrl = new AbortController();
    setLoading(true);
    const request = layer === 'heatmap'
      ? api.heatmap(band, groups, ctrl.signal).then(setHeatmap)
      : api.risk(riskBand, ctrl.signal).then(setRisk);
    request
      .then(() => setError(null))
      .catch((e) => { if (!ctrl.signal.aborted) setError(errorMessage(e, 'crime data')); })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [layer, band, riskBand, groups]);

  const shown = useMemo(() => {
    if (layer === 'heatmap' && heatmap) {
      return `${heatmap.features.reduce((s, f) => s + f.properties.count, 0).toLocaleString()} incidents in ${heatmap.features.length.toLocaleString()} blocks`;
    }
    if (layer === 'risk' && risk) {
      const high = risk.features.filter((f) => f.properties.level === 'high').length;
      return `${risk.features.length.toLocaleString()} blocks scored, ${high} high risk`;
    }
    return '';
  }, [layer, heatmap, risk]);

  // ---- Location ----
  const [location, setLocation] = useState<UserLocation | null>(null);
  const [pickMode, setPickMode] = useState(false);

  const changeLocation = useCallback((loc: UserLocation | null) => {
    setLocation(loc);
    setPickMode(false);
    const map = mapRef.current;
    if (loc && map && loc.source === 'gps') map.flyTo({ center: [loc.lng, loc.lat], zoom: Math.max(map.getZoom(), 14) });
  }, []);
  const onPick = useCallback((p: { lat: number; lng: number }) => changeLocation({ ...p, source: 'map' }), [changeLocation]);

  // ---- Map view: safe places and alert areas for the visible area ----
  const [view, setView] = useState<{ bbox: BBox; zoom: number } | null>(null);
  const [showPlaces, setShowPlaces] = useState(true);
  const [showAlerts, setShowAlerts] = useState(true);
  const [safePlaces, setSafePlaces] = useState<SafePlacesData | null>(null);
  const [placesError, setPlacesError] = useState<string | null>(null);
  const [alertAreas, setAlertAreas] = useState<AlertAreas | null>(null);
  const onViewChange = useCallback((bbox: BBox, zoom: number) => setView({ bbox, zoom }), []);

  useEffect(() => {
    if (!view || !showPlaces || view.zoom < PLACES_MIN_ZOOM) return;
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      api.safePlaces(view.bbox, [], ctrl.signal)
        .then((d) => { setSafePlaces(d); setPlacesError(null); })
        .catch((e) => { if (!ctrl.signal.aborted) setPlacesError(errorMessage(e, 'safe places')); });
    }, 350);
    return () => { window.clearTimeout(timer); ctrl.abort(); };
  }, [view, showPlaces]);

  const [areasTick, setAreasTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setAreasTick((t) => t + 1), ALERT_POLL_MS);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!view || !showAlerts) return;
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      api.alertAreas(view.bbox, ctrl.signal)
        .then(setAlertAreas)
        .catch(() => { if (!ctrl.signal.aborted) setAlertAreas(null); });
    }, 350);
    return () => { window.clearTimeout(timer); ctrl.abort(); };
  }, [view, showAlerts, areasTick]);

  const placesNote = !showPlaces ? 'Safe places are hidden (Map tab).'
    : placesError ?? (view && view.zoom < PLACES_MIN_ZOOM ? 'Zoom in to see safe places on the map.' : null);

  // ---- Alerts ----
  const hazards = useHazards();
  const alertsState = useActiveAlerts(location);
  const { status: alertsStatus, error: statusError } = useAlertsStatus();
  const [demoAlert, setDemoAlert] = useState<Alert | null>(null);
  const alerts = useMemo(() => {
    const real = [...(alertsState.data?.alerts ?? [])]
      .sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0));
    return demoAlert ? [demoAlert, ...real] : real;
  }, [alertsState.data, demoAlert]);
  const topHazard = demoAlert?.hazard ?? alertsState.data?.topHazard ?? alerts[0]?.hazard ?? null;

  // Announce new alerts to screen readers.
  const seen = useRef<Set<string>>(new Set());
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    const fresh = alerts.filter((a) => !seen.current.has(a.id));
    alerts.forEach((a) => seen.current.add(a.id));
    if (fresh.length) {
      setAnnouncement(`New alert${fresh.length > 1 ? 's' : ''}: ${fresh.map((a) => `${a.demo ? 'Demo. ' : ''}${a.event}. ${a.headline ?? ''}`).join(' ')}`);
    }
  }, [alerts]);

  // ---- Survival mode ----
  const [manualHazard, setManualHazard] = useState<string | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [survivalView, setSurvivalView] = useState<SurvivalView>('info');
  // Auto survival is keyed by the alerts that caused it, so "I'm safe" lasts until a new alert arrives.
  const autoKey = demoAlert ? demoAlert.id
    : alertsState.data?.survival ? `api:${alerts.map((a) => a.id).sort().join(',')}` : null;
  const survivalOn = manualHazard !== null || (autoKey !== null && autoKey !== dismissedKey);
  const survivalHazard = manualHazard ?? topHazard ?? 'other';
  const survivalAlert = manualHazard
    ? alerts.find((a) => a.hazard === manualHazard) ?? null
    : alerts.find((a) => a.hazard === survivalHazard) ?? alerts[0] ?? null;

  const exitSurvival = () => {
    setManualHazard(null);
    setDemoAlert(null);
    setDismissedKey(autoKey);
    setSurvivalView('info');
  };

  // ---- Nearest safe places and walking route ----
  const [placesHazardChoice, setPlacesHazardChoice] = useState<string | null>(null);
  const placesHazard = placesHazardChoice ?? topHazard ?? 'other';
  const nearest = useNearestPlaces(location, tab === 'places' && !survivalOn ? placesHazard : null, 5);
  const survivalNearest = useNearestPlaces(location, survivalOn ? survivalHazard : null, 4);

  const [routeState, setRouteState] = useState<RouteState | null>(null);
  const routeCtrl = useRef<AbortController | null>(null);
  const clearRoute = useCallback(() => { routeCtrl.current?.abort(); setRouteState(null); }, []);
  useEffect(() => { clearRoute(); }, [location, clearRoute]);

  const fitRoute = useCallback((coords: number[][], forSurvivalMap: boolean) => {
    const map = mapRef.current;
    if (!map || !coords.length) return;
    let [w, s, e, n] = [coords[0][0], coords[0][1], coords[0][0], coords[0][1]];
    for (const [x, y] of coords) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
    const phone = isPhone();
    const padding = forSurvivalMap
      ? { top: phone ? 190 : 170, bottom: 40, left: 40, right: 60 }
      : phone ? { top: 50, bottom: Math.round(window.innerHeight * 0.52), left: 30, right: 50 }
        : { top: 60, bottom: 60, left: 400, right: 70 };
    map.fitBounds([[w, s], [e, n]], { padding, maxZoom: 17, duration: 800 });
  }, []);

  const navigate = useCallback((place: NearestPlace) => {
    if (!location) return;
    routeCtrl.current?.abort();
    const ctrl = new AbortController();
    routeCtrl.current = ctrl;
    setRouteState({ place, route: null, loading: true, error: null });
    walkingRoute(location, place, ctrl.signal)
      .then((route) => {
        setRouteState({ place, route, loading: false, error: null });
        fitRoute(route.geometry.coordinates, false);
      })
      .catch((e: Error) => {
        if (ctrl.signal.aborted) return;
        setRouteState({ place, route: null, loading: false, error: `No walking route: ${e.message}. The place is ${Math.round(place.distanceM)} m away in a straight line.` });
      });
  }, [location, fitRoute]);

  const showSurvivalMap = (v: SurvivalView) => {
    setSurvivalView(v);
    if (v === 'map' && routeState?.route) {
      // Wait for the overlay to collapse before fitting.
      requestAnimationFrame(() => fitRoute(routeState.route!.geometry.coordinates, true));
    }
  };

  const survivalSelect = useRef<HTMLSelectElement>(null);
  const openSurvivalTools = () => {
    setTab('alerts');
    requestAnimationFrame(() => survivalSelect.current?.focus());
  };

  const topAlert = alerts[0];
  const survivalCovering = survivalOn && survivalView === 'info';

  return (
    <div className={`app${survivalOn ? ' in-survival' : ''}`}>
      <div className="visually-hidden" aria-live="assertive" aria-atomic="true">{announcement}</div>

      <div className="app-content" inert={survivalCovering}>
        <MapView
          layer={layer} heatmap={heatmap} risk={risk} extrude={extrude}
          safePlaces={safePlaces} showPlaces={showPlaces}
          alertAreas={alertAreas} showAlerts={showAlerts}
          location={location}
          destination={routeState?.route ? { lat: routeState.place.lat, lng: routeState.place.lng } : null}
          route={routeState?.route?.geometry ?? null}
          pickMode={pickMode} onPick={onPick}
          onViewChange={onViewChange}
          onMapReady={(m) => { mapRef.current = m; }}
        />

        {!survivalOn && (
          <aside className="panel" aria-label="Beacon">
            <header className="brand">
              <img src="/favicon.svg" alt="" width={28} height={28} />
              <div className="brand-text">
                <h1>Beacon</h1>
                <p>Know what's happening. Get to safety.</p>
              </div>
              {MOCK && <span className="mock-tag" title="Opened with ?mock=1: alerts and safe places are fake">MOCK DATA</span>}
              <button className="btn danger small" onClick={openSurvivalTools}>Survival mode</button>
            </header>

            {topAlert && (
              <button className="alert-banner" style={{ borderColor: severityColor(topAlert.severity), background: `${severityColor(topAlert.severity)}14` }}
                onClick={() => setTab('alerts')}>
                <span className="sev" style={{ background: severityColor(topAlert.severity) }}>{topAlert.severity}</span>
                {topAlert.demo && <span className="demo-tag">DEMO</span>}
                <span className="banner-text">
                  {topAlert.headline || topAlert.event}
                  {alerts.length > 1 && <small> +{alerts.length - 1} more</small>}
                </span>
              </button>
            )}

            <LocationControl location={location} onChange={changeLocation} pickMode={pickMode} onPickMode={setPickMode} />

            <div className="segmented tabs" role="tablist" aria-label="Sections">
              {TABS.map((t) => (
                <button key={t.key} id={`tab-${t.key}`} role="tab" aria-selected={tab === t.key}
                  aria-controls={`panel-${t.key}`} onClick={() => setTab(t.key)}>
                  {t.label}{t.key === 'alerts' && alerts.length > 0 && <span className="count">{alerts.length}</span>}
                </button>
              ))}
            </div>

            <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} className="tabpanel">
              {tab === 'map' && (
                <>
                  <CrimeLayers
                    meta={meta} layer={layer} onLayer={setLayer} band={band} riskBand={riskBand} onBand={setBand}
                    groups={groups} onGroups={setGroups} extrude={extrude} onExtrude={setExtrude}
                    showPlaces={showPlaces} onShowPlaces={setShowPlaces} showAlerts={showAlerts} onShowAlerts={setShowAlerts}
                  />
                  {layer !== 'none' && (
                    <p className="status" aria-live="polite">
                      {error ? <span className="error">{error}</span> : loading ? 'Loading…' : shown}
                    </p>
                  )}
                </>
              )}
              {tab === 'alerts' && (
                <AlertsPanel
                  hasLocation={location !== null}
                  alerts={alerts}
                  incidents={alertsState.data?.incidents ?? []}
                  state={alertsState}
                  status={alertsStatus}
                  statusError={statusError}
                  hazards={hazards}
                  defaultHazard={topHazard ?? hazards[0]?.key ?? 'other'}
                  demoActive={demoAlert !== null}
                  onSurvival={(h) => { setManualHazard(h); setSurvivalView('info'); }}
                  onDemo={(h) => { setDemoAlert(makeDemoAlert(h, hazardLabel(hazards, h))); setSurvivalView('info'); }}
                  onClearDemo={() => setDemoAlert(null)}
                  survivalSelectRef={survivalSelect}
                />
              )}
              {tab === 'places' && (
                <SafePlacesPanel
                  hasLocation={location !== null}
                  hazards={hazards}
                  hazard={placesHazard}
                  onHazard={setPlacesHazardChoice}
                  nearest={nearest}
                  routeState={routeState}
                  onNavigate={navigate}
                  onClearRoute={clearRoute}
                  placesNote={placesNote}
                />
              )}
            </div>

            <footer className="fresh">
              <strong>Beacon is a helper.</strong> It does not replace official alerts or emergency services.
              In danger, call 911 and follow official instructions.
              <br />
              {meta && (
                <>
                  Crime: <a href={meta.source?.url} target="_blank" rel="noreferrer">SPD reports</a>{' '}
                  {meta.dataRange.from} to {meta.dataRange.to}
                  {meta.model && <> · model {meta.model.version}</>}. Reported crime only, not a guarantee of safety.{' '}
                </>
              )}
              Safe places &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors.
            </footer>
          </aside>
        )}
      </div>

      {survivalOn && (
        <SurvivalMode
          hazard={survivalHazard}
          hazardLabel={survivalAlert?.hazardLabel || hazardLabel(hazards, survivalHazard)}
          alert={survivalAlert}
          otherAlerts={alerts.filter((a) => a.id !== survivalAlert?.id)}
          location={location}
          onLocate={() => requestGps().then(changeLocation)}
          nearest={survivalNearest}
          routeState={routeState}
          onNavigate={navigate}
          view={survivalView}
          onView={showSurvivalMap}
          onExit={exitSurvival}
        />
      )}
    </div>
  );
}
