// The simulator's "digital twin" map: a dark, cinematic 3D Seattle (OpenFreeMap vector tiles,
// 3D buildings, AWS Terrain Tiles, sky and fog) that plays a simulated calamity: the danger
// spreading, buildings at risk turning red, and the route to safety drawn with a fly-through.

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { ExpressionSpecification, GeoJSONSource, LayerSpecification, Map as MlMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// maplibre-gl 6 loads its worker relative to its own module URL, which breaks under a bundler.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';
import { destPoint, zoneOf, type SimResult } from './api';
import { bboxOf, bearing, cumulative, meters, polygonTester, sliceLine, turn, zonePoints } from './geo';
import { HAZARD_BY_KEY, type LatLng, type Scenario } from './scenario';

maplibregl.setWorkerUrl(workerUrl);

export type Stage = 'idle' | 'spreading' | 'zones' | 'route' | 'done';
export type PickTarget = 'origin' | 'event' | null;
export interface SimMapHandle { center: () => LatLng }

// OpenFreeMap: free vector tiles, no API key.
const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const SEATTLE: [number, number] = [-122.335, 47.607];
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };
const SEVERE = '#ff4d4f';
const MODERATE = '#f5a524';
const ROUTE = '#34d399';
const MAX_DANGER_BUILDINGS = 6000;

interface Props {
  scenario: Scenario;
  result: SimResult | null;
  /** Bump to (re)play the result's animation. */
  playKey: number;
  /** Bump to frame the user and the event. */
  focusKey: number;
  pickTarget: PickTarget;
  onPick: (target: 'origin' | 'event', p: LatLng) => void;
  onStage: (stage: Stage) => void;
  onClock: (tMinutes: number | null) => void;
  reducedMotion: boolean;
  handleRef?: Ref<SimMapHandle>;
}

// ---- Dark "digital twin" palette over the positron style ----

function recolor(map: MlMap) {
  const set = (id: string, prop: string, value: unknown) => {
    try { map.setPaintProperty(id, prop as never, value as never); } catch { /* property not on this layer */ }
  };
  for (const layer of map.getStyle().layers as LayerSpecification[]) {
    const id = layer.id;
    if (layer.type === 'background') set(id, 'background-color', '#070b14');
    else if (layer.type === 'fill') {
      const color = id.includes('water') ? '#0a1d33'
        : /park|wood|grass|landcover_wood/.test(id) ? '#0c1a17'
        : id === 'building' ? '#121a29'
        : /residential|landuse/.test(id) ? '#0b111d' : '#0a101b';
      set(id, 'fill-color', color);
      set(id, 'fill-outline-color', color);
    } else if (layer.type === 'line') {
      const color = id.includes('water') ? '#0d2a47'
        : id.startsWith('boundary') ? '#2a3550'
        : id.startsWith('railway') ? '#1a2333'
        : id.includes('motorway') ? (id.includes('casing') ? '#2a2b2a' : '#4a4232')
        : id.includes('casing') ? '#0e1522'
        : id.includes('path') ? '#182032' : '#222c3f';
      set(id, 'line-color', color);
    } else if (layer.type === 'symbol') {
      set(id, 'text-color', id.includes('water') ? '#4f86b8' : '#8fa1bd');
      set(id, 'text-halo-color', '#070b14');
    }
  }
}

function supportsWebGL2(): boolean {
  try { return Boolean(document.createElement('canvas').getContext('webgl2')); } catch { return false; }
}

const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const feature = (geometry: Geometry, properties: Record<string, unknown> = {}): Feature => ({ type: 'Feature', properties, geometry });

function markerEl(className: string, svg: string, label?: string): HTMLElement {
  const el = document.createElement('div');
  el.className = `sim-marker ${className}`;
  el.innerHTML = svg; // static SVG markup defined in this file, never API text
  if (label) {
    const tag = document.createElement('span');
    tag.className = 'sim-marker-label';
    tag.textContent = label;
    el.append(tag);
  }
  return el;
}

const PERSON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="6.5" r="3.2"/><path d="M6 21v-5.5A4.5 4.5 0 0 1 10.5 11h3a4.5 4.5 0 0 1 4.5 4.5V21z"/></svg>';
const EVENT_SVG = '<span class="ring r1"></span><span class="ring r2"></span><span class="ring r3"></span><span class="core"></span>';
const FLAG_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z"/><path d="M8.5 12l2.5 2.5 4.5-5" fill="none" stroke="#062b1f" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export default function SimMap(props: Props) {
  const { scenario, result, playKey, focusKey, pickTarget, reducedMotion } = props;
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const vectorSource = useRef<string | null>(null);
  const markers = useRef<{ origin?: maplibregl.Marker; event?: maplibregl.Marker; dest?: maplibregl.Marker }>({});
  const [ready, setReady] = useState(false);
  const live = useRef(props);
  live.current = props;

  useImperativeHandle(props.handleRef, () => ({
    center: () => {
      const c = mapRef.current?.getCenter();
      return c ? { lat: c.lat, lng: c.lng } : { lat: SEATTLE[1], lng: SEATTLE[0] };
    },
  }), []);

  // Create the map once.
  useEffect(() => {
    if (!container.current) return;
    const webgl2 = supportsWebGL2();
    const narrow = window.matchMedia('(max-width: 640px)').matches;
    const map = new maplibregl.Map({
      container: container.current,
      center: SEATTLE,
      zoom: narrow ? 11.2 : 11.8,
      pitch: webgl2 ? 52 : 0,
      bearing: -18,
      maxPitch: 75,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      attributionControl: {
        compact: true,
        customAttribution: 'Safe places &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>, City of Seattle &middot; Terrain: Mapzen / AWS Terrain Tiles &middot; Routing: FOSSGIS Valhalla / OSRM',
      },
    });
    mapRef.current = map;
    // Road shields are drawn as light badges and their filters warn in this style: leave them out.
    map.setStyle(STYLE_URL, { transformStyle: (_prev, next) => ({ ...next, layers: next.layers.filter((l) => !l.id.includes('shield')) }) });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    // Start the compact attribution folded (the (i) button opens it).
    map.once('idle', () => container.current?.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));

    // Recolour before the first frame so the light base style never flashes.
    map.once('style.load', () => {
      recolor(map);
      container.current?.classList.add('is-styled');
      container.current?.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
    });
    map.on('load', () => {
      const style = map.getStyle();
      const firstSymbol = style.layers.find((l) => l.type === 'symbol')?.id;
      vectorSource.current = Object.entries(style.sources).find(([, s]) => s.type === 'vector')?.[0] ?? null;

      if (webgl2) {
        map.addSource('terrain-dem', { type: 'raster-dem', tiles: [TERRAIN_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 15 });
        map.setTerrain({ source: 'terrain-dem', exaggeration: narrow ? 1.1 : 1.35 });
        let errors = 0;
        map.on('error', (e) => {
          if ((e as { sourceId?: string }).sourceId === 'terrain-dem' && ++errors === 4) map.setTerrain(null);
        });
      }
      map.setSky({
        'sky-color': '#04060c', 'horizon-color': '#1a2742', 'fog-color': '#070b14',
        'sky-horizon-blend': 0.5, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.85, 'atmosphere-blend': 0.25,
      });
      map.setLight({ anchor: 'viewport', position: [1.4, 210, 40], color: '#c7d2fe', intensity: 0.28 });

      const add = (layer: maplibregl.AddLayerObject, before = firstSymbol) => map.addLayer(layer, before);
      for (const id of ['sim-moderate', 'sim-severe', 'sim-growth', 'sim-route', 'danger-buildings', 'sim-alts']) {
        map.addSource(id, { type: 'geojson', data: EMPTY });
      }
      add({ id: 'sim-moderate-fill', type: 'fill', source: 'sim-moderate',
            paint: { 'fill-color': MODERATE, 'fill-opacity': 0, 'fill-opacity-transition': { duration: 900 } } });
      add({ id: 'sim-moderate-line', type: 'line', source: 'sim-moderate',
            paint: { 'line-color': MODERATE, 'line-width': 1.4, 'line-dasharray': [2, 2], 'line-opacity': 0, 'line-opacity-transition': { duration: 900 } } });
      add({ id: 'sim-growth-fill', type: 'fill', source: 'sim-growth',
            paint: { 'fill-color': SEVERE, 'fill-opacity': 0, 'fill-opacity-transition': { duration: 500 } } });
      add({ id: 'sim-growth-line', type: 'line', source: 'sim-growth',
            paint: { 'line-color': '#ffd0d0', 'line-width': 2.5, 'line-blur': 2, 'line-opacity': 0, 'line-opacity-transition': { duration: 500 } } });
      add({ id: 'sim-severe-fill', type: 'fill', source: 'sim-severe',
            paint: { 'fill-color': SEVERE, 'fill-opacity': 0, 'fill-opacity-transition': { duration: 900 } } });
      add({ id: 'sim-severe-line', type: 'line', source: 'sim-severe',
            paint: { 'line-color': '#ff7a7c', 'line-width': 2.2, 'line-opacity': 0, 'line-opacity-transition': { duration: 900 } } });

      if (vectorSource.current) {
        const height: ExpressionSpecification = ['coalesce', ['get', 'render_height'], 0];
        add({
          id: 'sim-buildings', type: 'fill-extrusion', source: vectorSource.current, 'source-layer': 'building', minzoom: 13,
          filter: ['!=', ['get', 'hide_3d'], true],
          paint: {
            'fill-extrusion-color': ['interpolate', ['linear'], height, 0, '#1b2436', 40, '#24314a', 150, '#33507a'],
            'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.2, height],
            'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
            'fill-extrusion-opacity': 0.88,
          },
        });
      }
      add({
        id: 'danger-buildings', type: 'fill-extrusion', source: 'danger-buildings', minzoom: 13,
        paint: {
          'fill-extrusion-color': ['interpolate', ['linear'], ['get', 'h'], 0, '#b4232a', 60, '#ff4d4f'],
          'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.2, ['+', ['get', 'h'], 0.8]],
          'fill-extrusion-base': ['get', 'b'],
          'fill-extrusion-opacity': 0.92,
        },
      });
      add({ id: 'sim-route-glow', type: 'line', source: 'sim-route', layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': ROUTE, 'line-width': 16, 'line-blur': 10, 'line-opacity': 0.45 } });
      add({ id: 'sim-route-casing', type: 'line', source: 'sim-route', layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#04110c', 'line-width': 8 } });
      add({ id: 'sim-route-line', type: 'line', source: 'sim-route', layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': ROUTE, 'line-width': 4.5 } });
      add({ id: 'sim-alts', type: 'circle', source: 'sim-alts',
            paint: { 'circle-radius': 6, 'circle-color': '#0f172a', 'circle-stroke-color': '#a7f3d0', 'circle-stroke-width': 2 } });
      setReady(true);
    });

    map.on('click', (e) => {
      const target = live.current.pickTarget;
      if (target) live.current.onPick(target, { lat: e.lngLat.lat, lng: e.lngLat.lng });
    });
    if (import.meta.env.DEV) (window as unknown as { __simMap?: MlMap }).__simMap = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Crosshair while picking.
  useEffect(() => {
    const canvas = mapRef.current?.getCanvas();
    if (canvas) canvas.style.cursor = pickTarget ? 'crosshair' : '';
  }, [pickTarget, ready]);

  // User and event markers (draggable).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const color = HAZARD_BY_KEY[scenario.hazard].color;
    const place = (key: 'origin' | 'event', p: LatLng | null, make: () => HTMLElement) => {
      let m = markers.current[key];
      if (!p) { m?.remove(); markers.current[key] = undefined; return; }
      if (!m) {
        m = new maplibregl.Marker({ element: make(), draggable: true, anchor: key === 'origin' ? 'bottom' : 'center' });
        m.on('dragend', () => {
          const ll = m!.getLngLat();
          live.current.onPick(key, { lat: ll.lat, lng: ll.lng });
        });
        markers.current[key] = m;
      }
      m.setLngLat([p.lng, p.lat]).addTo(map);
    };
    place('origin', scenario.origin, () => {
      const el = markerEl('sim-marker-user', PERSON_SVG, 'You');
      el.setAttribute('aria-label', 'Your simulated location');
      return el;
    });
    place('event', scenario.event, () => {
      const el = markerEl('sim-marker-event', EVENT_SVG);
      el.setAttribute('aria-label', 'Simulated event');
      return el;
    });
    markers.current.event?.getElement().style.setProperty('--c', color);
  }, [ready, scenario.origin, scenario.event, scenario.hazard]);

  // Frame the user and the event (preset loaded, link opened).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !focusKey) return;
    const pts: Position[] = [scenario.origin, scenario.event].filter((p): p is LatLng => Boolean(p)).map((p) => [p.lng, p.lat]);
    if (!pts.length) return;
    const [w, s, e, n] = bboxOf(pts);
    map.fitBounds([[w - 0.012, s - 0.008], [e + 0.012, n + 0.008]], {
      padding: framePadding(), pitch: 55, bearing: -18, duration: reducedMotion ? 0 : 1600, maxZoom: 15,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, ready]);

  // Play (or clear) the simulation.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    let alive = true;
    let tintListener: (() => void) | null = null;
    const src = (id: string) => map.getSource(id) as GeoJSONSource;
    const opacity = (pairs: [string, string, number][]) => pairs.forEach(([layer, prop, v]) => map.setPaintProperty(layer, prop as never, v as never));
    const cb = live.current;

    const clear = () => {
      for (const id of ['sim-moderate', 'sim-severe', 'sim-growth', 'sim-route', 'danger-buildings', 'sim-alts']) src(id).setData(EMPTY);
      opacity([['sim-moderate-fill', 'fill-opacity', 0], ['sim-moderate-line', 'line-opacity', 0], ['sim-severe-fill', 'fill-opacity', 0],
               ['sim-severe-line', 'line-opacity', 0], ['sim-growth-fill', 'fill-opacity', 0], ['sim-growth-line', 'line-opacity', 0]]);
      markers.current.dest?.remove();
      markers.current.dest = undefined;
    };

    clear();
    if (!result) {
      cb.onStage('idle');
      cb.onClock(null);
      return () => { alive = false; };
    }

    const severe = zoneOf(result, 'severe');
    const moderate = zoneOf(result, 'moderate');
    const route = result.route;
    const dest = result.destination ? destPoint(result.destination) : null;
    const quick = reducedMotion;
    const hazardColor = HAZARD_BY_KEY[scenario.hazard]?.color ?? SEVERE;

    const tint = () => {
      if (!severe || !vectorSource.current || map.getZoom() < 13) { src('danger-buildings').setData(EMPTY); return; }
      const inside = polygonTester(severe.geometry);
      const out: Feature[] = [];
      const seen = new Set<string>();
      for (const f of map.querySourceFeatures(vectorSource.current, { sourceLayer: 'building' })) {
        const g = f.geometry;
        // Low-zoom tiles merge many buildings into one MultiPolygon: test every part on its own.
        const parts = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
        const p = f.properties ?? {};
        const props = { h: Number(p.render_height ?? 8) || 8, b: Number(p.render_min_height ?? 0) || 0 };
        for (const rings of parts) {
          const first = rings[0]?.[0];
          if (!first || !inside(first[0], first[1])) continue;
          const key = `${first[0].toFixed(6)},${first[1].toFixed(6)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(feature({ type: 'Polygon', coordinates: rings }, props));
        }
        if (out.length >= MAX_DANGER_BUILDINGS) break;
      }
      src('danger-buildings').setData(fc(out));
    };

    const overview = (withRoute: boolean, duration: number) => {
      const pts: Position[] = [[result.scenario.origin.lng, result.scenario.origin.lat]];
      if (withRoute && route) pts.push(...route.geometry.coordinates);
      else {
        pts.push([result.scenario.event.lng, result.scenario.event.lat]);
        // The spreading core (the last growth stage), not every far-flung part of the zone.
        const core = result.growth.length ? result.growth[result.growth.length - 1].geometry : severe?.geometry ?? moderate?.geometry;
        // Keep the view near the action even when a zone stretches along the whole coast.
        const { lat, lng } = result.scenario.event;
        if (core) pts.push(...zonePoints(core).filter(([x, y]) => Math.abs(x - lng) < 0.06 && Math.abs(y - lat) < 0.04));
      }
      if (dest) pts.push([dest.lng, dest.lat]);
      const [w, s, e, n] = bboxOf(pts);
      map.fitBounds([[w, s], [e, n]], { padding: framePadding(), pitch: 58, bearing: -18, duration, maxZoom: 15.6 });
    };

    const run = async () => {
      cb.onStage('spreading');
      map.setPaintProperty('sim-growth-fill', 'fill-color', hazardColor);
      overview(false, quick ? 0 : 1800);
      if (!quick) await sleep(1700);
      if (!alive) return;

      // 1. The danger spreads, stage by stage, with a simulated clock.
      const stages = quick ? [] : result.growth;
      const stepMs = stages.length ? Math.max(650, 3200 / stages.length) : 0;
      let prevT = 0;
      for (const stage of stages) {
        if (!alive) return;
        src('sim-growth').setData(fc([feature(stage.geometry)]));
        opacity([['sim-growth-fill', 'fill-opacity', 0.38], ['sim-growth-line', 'line-opacity', 0.9]]);
        const start = performance.now();
        const from = prevT, to = stage.tMinutes;
        while (alive && performance.now() - start < stepMs) {
          cb.onClock(from + (to - from) * Math.min(1, (performance.now() - start) / stepMs));
          await sleep(50);
        }
        prevT = to;
      }
      if (!alive) return;

      // 2. Final zones, buildings at risk turn red.
      src('sim-moderate').setData(moderate ? fc([moderate]) : EMPTY);
      src('sim-severe').setData(severe ? fc([severe]) : EMPTY);
      opacity([['sim-growth-fill', 'fill-opacity', 0], ['sim-growth-line', 'line-opacity', 0],
               ['sim-moderate-fill', 'fill-opacity', 0.16], ['sim-moderate-line', 'line-opacity', 0.85],
               ['sim-severe-fill', 'fill-opacity', 0.3], ['sim-severe-line', 'line-opacity', 1]]);
      cb.onClock(stages.length ? prevT : null);
      cb.onStage('zones');
      tint();
      tintListener = () => tint();
      map.on('idle', tintListener);
      src('sim-alts').setData(fc(result.alternatives.map((a) => feature({ type: 'Point', coordinates: [destPoint(a).lng, destPoint(a).lat] }))));
      if (dest) {
        markers.current.dest = new maplibregl.Marker({ element: markerEl('sim-marker-dest', FLAG_SVG, dest.name), anchor: 'bottom' })
          .setLngLat([dest.lng, dest.lat]).addTo(map);
      }
      if (!quick) await sleep(1600);
      if (!alive) return;

      // 3. Route to safety with a camera fly-through.
      if (route && route.geometry.coordinates.length >= 2) {
        cb.onStage('route');
        const coords = route.geometry.coordinates;
        const cum = cumulative(coords);
        const total = cum[cum.length - 1];
        if (quick || total < 30) {
          src('sim-route').setData(fc([feature(route.geometry)]));
        } else {
          const zoom = total > 8000 ? 14 : total > 3000 ? 15 : 16;
          const lookAhead = (d: number) => {
            const a = sliceLine(coords, cum, d).head;
            const b = sliceLine(coords, cum, Math.min(total, d + Math.max(80, total * 0.08))).head;
            return meters(a, b) > 1 ? bearing(a, b) : null;
          };
          let heading = lookAhead(0) ?? -18;
          map.flyTo({ center: coords[0] as [number, number], zoom, pitch: 64, bearing: heading, duration: 1500, essential: true });
          await sleep(1550);
          const duration = Math.min(9000, Math.max(4500, total * (result.scenario.mode === 'walk' ? 2.4 : 0.6)));
          const start = performance.now();
          let lastTint = 0;
          await new Promise<void>((resolve) => {
            const frame = () => {
              if (!alive) { resolve(); return; }
              const t = Math.min(1, (performance.now() - start) / duration);
              const d = total * ease(t);
              const { part, head } = sliceLine(coords, cum, d);
              src('sim-route').setData(fc([feature({ type: 'LineString', coordinates: part })]));
              const want = lookAhead(d);
              if (want !== null) heading += turn(heading, want) * 0.06;
              map.jumpTo({ center: head as [number, number], bearing: heading, pitch: 64, zoom });
              if (performance.now() - lastTint > 700) { lastTint = performance.now(); tint(); }
              if (t < 1) requestAnimationFrame(frame); else resolve();
            };
            requestAnimationFrame(frame);
          });
          if (!alive) return;
          src('sim-route').setData(fc([feature(route.geometry)]));
        }
      }
      overview(true, quick ? 0 : 1800);
      cb.onStage('done');
    };
    void run();

    return () => {
      alive = false;
      if (tintListener) map.off('idle', tintListener);
      map.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, result, playKey]);

  return <div ref={container} className="sim-map" role="region" aria-label="Simulation map. Click to place the selected point; arrow keys pan." />;
}

function framePadding() {
  const narrow = window.matchMedia('(max-width: 760px)').matches;
  if (document.documentElement.dataset.presenter === '1') {
    return narrow ? { top: 90, bottom: 220, left: 24, right: 24 } : { top: 100, bottom: 220, left: 80, right: 80 };
  }
  return narrow
    ? { top: 110, bottom: Math.round(window.innerHeight * 0.45), left: 30, right: 30 }
    : { top: 110, bottom: 60, left: 420, right: 80 };
}
