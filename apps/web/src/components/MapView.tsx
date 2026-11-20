import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// maplibre-gl 6 loads its worker relative to its own module URL, which breaks under a bundler.
// Let Vite bundle the worker (with its shared chunk) and hand maplibre the URL.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { LineString } from 'geojson';
import type { AlertAreas, BBox, HeatmapData, RiskData, SafePlacesData } from '../api';
import { KIND_COLOR, OTHER_KIND_COLOR } from '../lib/hazards';
import { SEVERITY_COLOR, formatTime } from '../lib/format';
import type { LatLng } from '../lib/routing';
import { isNarrowScreen, setupScene, supportsWebGL2, type MapTheme, type Scene, type ViewMode } from '../lib/mapScene';

maplibregl.setWorkerUrl(workerUrl);

export type Layer = 'heatmap' | 'risk' | 'none';
export type { MapTheme, ViewMode };

// OpenFreeMap: free vector tiles, no API key (the same style as the class app).
const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const SEATTLE: [number, number] = [-122.335, 47.615];
// Opening 3D camera: downtown Seattle from the southwest, looking toward the Space Needle.
const DOWNTOWN: [number, number] = [-122.3372, 47.6078];
const OPEN_PITCH = 58;
const OPEN_BEARING = -20;
const SLOW_FRAME_MS = 40;

/** Map control button that switches between the 2D and 3D views. */
class ViewModeControl implements maplibregl.IControl {
  private container = document.createElement('div');
  private button = document.createElement('button');
  constructor(onToggle: () => void) {
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group view-mode-ctrl';
    this.button.type = 'button';
    this.button.addEventListener('click', onToggle);
    this.container.append(this.button);
  }
  onAdd() { return this.container; }
  onRemove() { this.container.remove(); }
  set(mode: ViewMode, available: boolean) {
    this.container.hidden = !available;
    this.button.textContent = mode === '3d' ? '2D' : '3D';
    this.button.setAttribute('aria-label', mode === '3d' ? 'Switch to flat 2D map' : 'Switch to 3D map');
    this.button.title = this.button.getAttribute('aria-label')!;
  }
}

// Colors from the class app (CrimeRadar/src/main/webapp/assets/js/mapstyle.js).
export const LEVEL_COLOR = { low: '#0ca30c', elevated: '#ec835a', high: '#e5484d' } as const;
const HEAT_RAMP = [0.15, '#ffe39a', 0.35, '#ffb55c', 0.55, '#f9773f', 0.75, '#e03b3b', 1.0, '#9d174d'];

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const LONG_PRESS_MS = 550;

interface Props {
  layer: Layer;
  heatmap: HeatmapData | null;
  risk: RiskData | null;
  extrude: boolean;
  safePlaces: SafePlacesData | null;
  showPlaces: boolean;
  alertAreas: AlertAreas | null;
  showAlerts: boolean;
  location: LatLng | null;
  destination: LatLng | null;
  route: LineString | null;
  /** When true, the next click on the map sets the location. */
  pickMode: boolean;
  /** Click in pick mode, long-press (touch) or right-click: "I'm here". */
  onPick: (p: LatLng) => void;
  onViewChange?: (bbox: BBox, zoom: number) => void;
  onMapReady?: (map: MlMap) => void;
  theme: MapTheme;
  viewMode: ViewMode;
  /** Called by the 2D/3D control, and with '2d' when WebGL2 or terrain is not available. */
  onViewMode: (mode: ViewMode) => void;
}

function quantile(values: number[], q: number): number {
  if (!values.length) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] || 1;
}

const matchColor = (prop: string, colors: Record<string, string>, fallback: string) =>
  ['match', ['get', prop], ...Object.entries(colors).flat(), fallback] as unknown as maplibregl.ExpressionSpecification;

/** Popup body built from text nodes (API strings are never parsed as HTML). */
function popupNode(title: string, lines: (string | null | undefined)[]) {
  const root = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = title;
  root.append(strong);
  for (const line of lines) {
    if (line) root.append(document.createElement('br'), document.createTextNode(line));
  }
  return root;
}

const pointFeature = (p: LatLng | null): GeoJSON.FeatureCollection => p
  ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } }] }
  : EMPTY;

export default function MapView(props: Props) {
  const { layer, heatmap, risk, extrude, safePlaces, showPlaces, alertAreas, showAlerts, location, destination, route, pickMode, theme, viewMode } = props;
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const modeControl = useRef<ViewModeControl | null>(null);
  const [webgl2] = useState(supportsWebGL2);
  const [ready, setReady] = useState(false);
  // Latest props for the map event handlers, which are registered once.
  const live = useRef(props);
  live.current = props;

  // Create the map once.
  useEffect(() => {
    if (!container.current) return;
    const map = new maplibregl.Map({
      container: container.current,
      style: STYLE_URL,
      center: SEATTLE,
      zoom: 11.3,
      minZoom: 3,
      maxZoom: 18,
      maxPitch: 70,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      attributionControl: { compact: true, customAttribution: 'Safe places &copy; OpenStreetMap contributors' },
    });
    mapRef.current = map;
    if (import.meta.env.DEV) {
      // Dev-only camera hook for browser checks: set <html data-camera='{"zoom":15}'> and fire "beacon:camera".
      const onCamera = () => {
        map.jumpTo(JSON.parse(document.documentElement.dataset.camera ?? '{}'));
        map.once('idle', () => {
          document.documentElement.dataset.cameraState = JSON.stringify({
            zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(), terrain: Boolean(map.getTerrain()),
            buildings: map.getLayer('3d-buildings') ? map.getLayoutProperty('3d-buildings', 'visibility') ?? 'visible' : 'missing',
          });
        });
      };
      document.addEventListener('beacon:camera', onCamera);
      map.on('remove', () => document.removeEventListener('beacon:camera', onCamera));
    }
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    const modeCtrl = new ViewModeControl(() => live.current.onViewMode(live.current.viewMode === '3d' ? '2d' : '3d'));
    modeCtrl.set(live.current.viewMode, webgl2);
    modeControl.current = modeCtrl;
    map.addControl(modeCtrl, 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

    map.on('load', () => {
      for (const id of ['heat', 'risk', 'alerts', 'places', 'route', 'me', 'dest']) {
        map.addSource(id, { type: 'geojson', data: EMPTY });
      }

      const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;

      // Official alert areas (polygons), or points for earthquakes.
      const sevColor = matchColor('severity', SEVERITY_COLOR, SEVERITY_COLOR.Unknown);
      map.addLayer({
        id: 'alerts-fill', type: 'fill', source: 'alerts', filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': sevColor, 'fill-opacity': 0.14 },
      }, firstSymbol);
      map.addLayer({
        id: 'alerts-line', type: 'line', source: 'alerts', filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'line-color': sevColor, 'line-width': 2, 'line-dasharray': [2, 1.5] },
      }, firstSymbol);

      map.addLayer({
        id: 'heat',
        type: 'heatmap',
        source: 'heat',
        paint: {
          'heatmap-weight': ['min', 1, ['/', ['get', 'weight'], ['coalesce', ['get', 'scale'], 1]]],
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 15, 2.2],
          // Points sit on a ~225 m grid, so the radius must cover the cell spacing at every zoom.
          'heatmap-radius': ['interpolate', ['exponential', 2], ['zoom'], 10, 10, 12, 18, 14, 48, 16, 150],
          // A little lighter close up, so the 3D buildings still read through it.
          'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0.8, 16, 0.55],
          'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(255,227,154,0)', ...HEAT_RAMP],
        },
      }, firstSymbol);

      const levelColor: maplibregl.ExpressionSpecification = [
        'match', ['get', 'level'],
        'high', LEVEL_COLOR.high, 'elevated', LEVEL_COLOR.elevated, LEVEL_COLOR.low,
      ];
      map.addLayer({
        id: 'risk-fill',
        type: 'fill',
        source: 'risk',
        paint: {
          'fill-color': levelColor,
          'fill-opacity': ['match', ['get', 'level'], 'high', 0.62, 'elevated', 0.48, 0.16],
          'fill-outline-color': 'rgba(255,255,255,0.35)',
        },
      }, firstSymbol);
      map.addLayer({
        id: 'risk-3d',
        type: 'fill-extrusion',
        source: 'risk',
        layout: { visibility: 'none' },
        paint: {
          // Pale low blocks so the elevated and high towers stand out.
          'fill-extrusion-color': ['match', ['get', 'level'],
            'high', LEVEL_COLOR.high, 'elevated', LEVEL_COLOR.elevated, '#cfe8cf'],
          'fill-extrusion-height': ['*', 18, ['sqrt', ['get', 'risk']]],
          'fill-extrusion-opacity': 0.85,
        },
      });

      // Terrain, hillshade and 3D buildings (buildings above the crime layers, under the labels).
      const scene = setupScene(map, {
        lowPower: isNarrowScreen(),
        beforeLabels: firstSymbol,
        onTerrainError: () => live.current.onViewMode('2d'),
      });
      sceneRef.current = scene;
      scene.applyTheme(live.current.theme);
      const start3d = webgl2 && live.current.viewMode === '3d';
      scene.setMode(start3d ? '3d' : '2d', { buildingsHidden: false });
      if (!webgl2) live.current.onViewMode('2d');
      if (start3d) {
        // Smooth fly-in to a pitched, slightly rotated downtown view; slow frames switch to low power.
        let frames = 0;
        const t0 = performance.now();
        const countFrame = () => { frames += 1; };
        map.on('render', countFrame);
        map.once('moveend', () => {
          map.off('render', countFrame);
          const elapsed = performance.now() - t0;
          if (elapsed > 1000 && document.visibilityState === 'visible' && elapsed / Math.max(frames, 1) > SLOW_FRAME_MS) {
            scene.setLowPower(true);
          }
        });
        // On a phone the bottom sheet covers the lower half, so aim downtown into the visible top part.
        const narrow = isNarrowScreen();
        map.flyTo({
          center: DOWNTOWN, zoom: narrow ? 15.1 : 14.9, pitch: OPEN_PITCH, bearing: OPEN_BEARING,
          offset: narrow ? [0, -Math.round(window.innerHeight * 0.25)] : [0, 0],
          duration: 3200, curve: 1.3,
        });
      }

      // Earthquake points, the walking route, safe places, then the user's location on top.
      map.addLayer({
        id: 'alerts-point', type: 'circle', source: 'alerts', filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-color': sevColor, 'circle-opacity': 0.25, 'circle-stroke-color': sevColor, 'circle-stroke-width': 2,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 8, 14, 30],
        },
      });
      map.addLayer({
        id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 9 },
      });
      map.addLayer({
        id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#1864ab', 'line-width': 5 },
      });
      map.addLayer({
        id: 'places', type: 'circle', source: 'places',
        paint: {
          'circle-color': matchColor('kind', KIND_COLOR, OTHER_KIND_COLOR),
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 4.5, 16, 8],
          'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5,
        },
      });
      map.addLayer({
        id: 'places-label', type: 'symbol', source: 'places', minzoom: 14.5,
        layout: {
          'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11,
          'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true,
        },
        paint: { 'text-color': '#343a40', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 },
      });
      map.addLayer({
        id: 'dest', type: 'circle', source: 'dest',
        paint: { 'circle-radius': 11, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#1864ab', 'circle-stroke-width': 3 },
      });
      map.addLayer({
        id: 'me-halo', type: 'circle', source: 'me',
        paint: { 'circle-radius': 16, 'circle-color': '#1c7ed6', 'circle-opacity': 0.18 },
      });
      map.addLayer({
        id: 'me', type: 'circle', source: 'me',
        paint: { 'circle-radius': 7, 'circle-color': '#1c7ed6', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 },
      });

      const popup = new maplibregl.Popup({ closeButton: false, offset: 6, maxWidth: '260px' });
      for (const id of ['risk-fill', 'risk-3d']) {
        map.on('click', id, (e) => {
          const f = e.features?.[0];
          if (!f || live.current.pickMode) return;
          const p = f.properties as { risk: number; level: string; neighborhood: string | null; cellId: number };
          popup.setLngLat(e.lngLat).setHTML(
            `<strong>${p.neighborhood ?? 'Block'}</strong><br/>` +
            `Risk ${Number(p.risk).toFixed(2)} &middot; <span class="lvl lvl-${p.level}">${p.level}</span><br/>` +
            `<small>cell ${p.cellId}</small>`,
          ).addTo(map);
        });
      }
      map.on('click', 'places', (e) => {
        const f = e.features?.[0];
        if (!f || live.current.pickMode) return;
        const p = f.properties as Record<string, string | null>;
        popup.setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number])
          .setDOMContent(popupNode(p.name ?? 'Safe place', [p.kindLabel, p.address, p.phone, p.openingHours && `Hours: ${p.openingHours}`]))
          .addTo(map);
      });
      for (const id of ['alerts-fill', 'alerts-point']) {
        map.on('click', id, (e) => {
          const f = e.features?.[0];
          if (!f || live.current.pickMode) return;
          const p = f.properties as Record<string, string | null>;
          popup.setLngLat(e.lngLat)
            .setDOMContent(popupNode(p.event ?? 'Alert', [p.headline, p.severity, p.expires && `Expires ${formatTime(p.expires)}`]))
            .addTo(map);
        });
      }
      for (const id of ['risk-fill', 'risk-3d', 'places', 'alerts-point']) {
        map.on('mouseenter', id, () => { if (!live.current.pickMode) map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', id, () => { if (!live.current.pickMode) map.getCanvas().style.cursor = ''; });
      }

      // Set "I'm here": click in pick mode, right-click, or long-press on a touch screen.
      const pick = (lngLat: maplibregl.LngLat) => live.current.onPick({ lat: lngLat.lat, lng: lngLat.lng });
      map.on('click', (e) => { if (live.current.pickMode) pick(e.lngLat); });
      map.on('contextmenu', (e) => { e.preventDefault(); pick(e.lngLat); });
      let pressTimer: number | undefined;
      let pressStart: maplibregl.Point | null = null;
      const cancelPress = () => { window.clearTimeout(pressTimer); pressStart = null; };
      map.on('touchstart', (e) => {
        cancelPress();
        if (e.originalEvent.touches.length !== 1) return;
        pressStart = e.point;
        const lngLat = e.lngLat;
        pressTimer = window.setTimeout(() => { pressStart = null; pick(lngLat); }, LONG_PRESS_MS);
      });
      map.on('touchmove', (e) => { if (pressStart && pressStart.dist(e.point) > 10) cancelPress(); });
      map.on('touchend', cancelPress);
      map.on('touchcancel', cancelPress);

      const reportView = () => {
        const b = map.getBounds();
        live.current.onViewChange?.([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], map.getZoom());
      };
      map.on('moveend', reportView);
      reportView();

      // Start with the attribution collapsed to its (i) button on phones; the footer also credits OSM.
      if (isNarrowScreen()) {
        const attrib = map.getContainer().querySelector('.maplibregl-ctrl-attrib');
        attrib?.classList.remove('maplibregl-compact-show');
        attrib?.removeAttribute('open');
      }

      setReady(true);
      live.current.onMapReady?.(map);
    });

    return () => { map.remove(); mapRef.current = null; };
  }, []);

  // Heatmap data: scale weights by the 98th percentile so a few hot cells do not flatten the rest.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const data = heatmap ?? EMPTY;
    if (heatmap) {
      const scale = quantile(heatmap.features.map((f) => f.properties.weight), 0.98);
      heatmap.features.forEach((f) => { (f.properties as Record<string, number>).scale = scale; });
    }
    (map.getSource('heat') as GeoJSONSource).setData(data);
  }, [ready, heatmap]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource('risk') as GeoJSONSource).setData(risk ?? EMPTY);
  }, [ready, risk]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource('places') as GeoJSONSource).setData(showPlaces && safePlaces ? safePlaces : EMPTY);
  }, [ready, safePlaces, showPlaces]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource('alerts') as GeoJSONSource).setData(showAlerts && alertAreas ? alertAreas : EMPTY);
  }, [ready, alertAreas, showAlerts]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource('me') as GeoJSONSource).setData(pointFeature(location));
    (map.getSource('dest') as GeoJSONSource).setData(pointFeature(destination));
    (map.getSource('route') as GeoJSONSource).setData(route
      ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: route }] }
      : EMPTY);
    sceneRef.current?.dimBuildings(Boolean(route));
  }, [ready, location, destination, route]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    map.getCanvas().style.cursor = pickMode ? 'crosshair' : '';
  }, [ready, pickMode]);

  useEffect(() => {
    if (ready) sceneRef.current?.applyTheme(theme);
  }, [ready, theme]);

  // Crime layer visibility, 2D/3D view and camera pitch.
  // The risk-grid "3D skyline" and the 3D buildings are never shown together: the skyline wins.
  const firstModeRun = useRef(true);
  useEffect(() => {
    const map = mapRef.current;
    modeControl.current?.set(viewMode, webgl2);
    if (!ready || !map) return;
    const show = (id: string, on: boolean) => map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    const skyline = layer === 'risk' && extrude;
    show('heat', layer === 'heatmap');
    show('risk-fill', layer === 'risk' && !extrude);
    show('risk-3d', skyline);
    sceneRef.current?.setMode(viewMode, { buildingsHidden: skyline });
    if (firstModeRun.current) { firstModeRun.current = false; return; } // the opening fly-in sets the camera
    if (viewMode === '2d' && !skyline) map.easeTo({ pitch: 0, bearing: 0, duration: 700 });
    else if (map.getPitch() < 25) map.easeTo({ pitch: skyline ? 55 : OPEN_PITCH, bearing: map.getBearing() || OPEN_BEARING, duration: 700 });
  }, [ready, layer, extrude, viewMode, webgl2]);

  return (
    <div ref={container} className="map" role="region"
      aria-label="Map. Right-click or long-press to set your location." />
  );
}
