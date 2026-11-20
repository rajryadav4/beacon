// The map engine: MapLibre GL with the CrimeRadar palettes, GPU heatmap, 3D risk skyline, glowing routes
// with a moving dash, pulsing radar blips, 3D buildings and terrain, plus Beacon's alert areas, hazard
// layers and safe places. Ported from the class app's GLMapView (assets/js/mapview-gl.js).
// Views drive it through methods; React state never mirrors the map.

import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MlMap, Marker, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// maplibre-gl 6 loads its worker relative to its own module URL, which breaks under a bundler.
// Let Vite bundle the worker (with its shared chunk) and hand maplibre the URL.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { BBox } from '../../api';
import { isPhone, reducedMotion } from '../format';
import type { LatLng, Pt } from '../geo';
import { labelPoints, pillOffsets } from './labels';
import {
  HEAT_DARK, HEAT_LIGHT, PALETTE, ROLE_COLOR, ROLE_ORDER, TERRAIN_SOURCE,
  heatColor, paintFor, prepareStyle, skyFor, type Role,
} from './style';

maplibregl.setWorkerUrl(workerUrl);

type FC = GeoJSON.FeatureCollection;
const EMPTY: FC = { type: 'FeatureCollection', features: [] };
const FLOW_DASHES = [
  [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0],
  [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5],
];
const HOME: [number, number] = [-122.334, 47.6145];
const LONG_PRESS_MS = 550;

export interface CellInfo { title: string; lines: string[] }
export interface DrawRoute { coords: Pt[]; role?: Role; duration: number; hotspots?: { lat: number; lng: number }[] }

export function markerEl(cls: string, title?: string): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'gl-marker';
  const inner = document.createElement('div');
  inner.className = cls;
  wrap.append(inner);
  if (title) wrap.title = title;
  return wrap;
}

/** Popup body from text nodes only (API strings are never parsed as HTML). */
export function tipNode(title: string, lines: (string | null | undefined)[]): HTMLElement {
  const root = document.createElement('div');
  const t = document.createElement('div');
  t.className = 'tip-title';
  t.textContent = title;
  root.append(t);
  for (const line of lines) {
    if (!line) continue;
    const d = document.createElement('div');
    d.className = 'tip-sub';
    d.textContent = line;
    root.append(d);
  }
  return root;
}

export function supportsWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

export class MapController {
  readonly map: MlMap;
  dark: boolean;
  is3D = false;
  loaded = false;
  private queue: (() => void)[] = [];
  private terrainFailed = false;
  /** Explore: hover / tap text for a point (null = no tooltips). */
  cellInfo: ((p: LatLng) => CellInfo | null) | null = null;
  /** When set, the next map click picks a point instead of anything else. */
  pickHandler: ((p: LatLng) => void) | null = null;
  /** Long-press (touch) or right-click: "I'm here". */
  onContext: ((p: LatLng) => void) | null = null;
  onMoveEnd: ((bbox: BBox, zoom: number) => void) | null = null;
  private onRouteSelect: ((i: number) => void) | null = null;
  private tipPopup: maplibregl.Popup;
  private stickyPopup: maplibregl.Popup | null = null;
  private pills: { marker: Marker; lngLat: [number, number]; selected: boolean }[] = [];
  private hotMarkers: Marker[] = [];
  private blipMarkers: Marker[] = [];
  private areaMarkers: Marker[] = [];
  private named: Record<string, Marker | null> = {};
  private heatNow = new Map<string, { lat: number; lng: number; n: number }>();
  private heatAnim = 0;
  private flow = 0;
  private panning = false;

  constructor(container: HTMLElement, styleJson: StyleSpecification, dark: boolean) {
    this.dark = dark;
    this.map = new maplibregl.Map({
      container,
      style: prepareStyle(styleJson, dark),
      center: HOME,
      zoom: 12.7,
      minZoom: 3,
      maxZoom: 18.5,
      maxPitch: 70,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      attributionControl: false,
      fadeDuration: 180,
    });
    container.classList.toggle('is-dark', dark);
    document.body.classList.toggle('theme-night', dark);
    this.map.addControl(new maplibregl.AttributionControl({
      compact: true,
      customAttribution: 'Crime data: <a href="https://data.seattle.gov/d/tazs-3rd5" target="_blank" rel="noopener">Seattle Police</a> · Safe places &copy; OpenStreetMap contributors',
    }), 'bottom-right');
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    this.map.on('load', () => {
      this.loaded = true;
      if (isPhone()) {
        const attrib = this.map.getContainer().querySelector('.maplibregl-ctrl-attrib');
        attrib?.classList.remove('maplibregl-compact-show');
        attrib?.removeAttribute('open');
      }
      const q = this.queue;
      this.queue = [];
      for (const fn of q) fn();
      this.reportView();
    });
    this.map.on('error', (e) => {
      const sourceId = (e as { sourceId?: string }).sourceId;
      if (sourceId === TERRAIN_SOURCE && !this.terrainFailed) {
        this.terrainFailed = true;
        this.map.setTerrain(null);
      }
    });
    this.tipPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'gl-tip', offset: 14, maxWidth: '280px' });
    this.bindEvents();
  }

  whenReady(fn: () => void) {
    if (this.loaded) fn();
    else this.queue.push(fn);
  }

  private setData(id: string, data: FC | GeoJSON.Feature[]) {
    this.whenReady(() => {
      const src = this.map.getSource(id) as GeoJSONSource | undefined;
      src?.setData(Array.isArray(data) ? { type: 'FeatureCollection', features: data } : data);
    });
  }

  private show(id: string, on: boolean) {
    this.whenReady(() => { if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); });
  }

  private reportView() {
    const b = this.map.getBounds();
    this.onMoveEnd?.([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], this.map.getZoom());
  }

  bbox(): BBox {
    const b = this.map.getBounds();
    return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  }

  private bindEvents() {
    let pending: maplibregl.LngLat | null = null;
    let frame = 0;
    this.map.on('mousemove', (e) => {
      if (!this.cellInfo || isPhone()) return;
      pending = e.lngLat;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (pending) this.showTip(pending, false);
      });
    });
    this.map.getCanvas().addEventListener('mouseleave', () => this.closeTip());
    this.map.on('click', (e) => {
      if (this.pickHandler) {
        const pick = this.pickHandler;
        this.pickHandler = null;
        this.map.getCanvas().style.cursor = '';
        pick({ lat: e.lngLat.lat, lng: e.lngLat.lng });
        return;
      }
      const layers = ['cr-routes-hit', 'bc-places', 'bc-alerts-fill', 'bc-hazard-zones-fill', 'bc-hazard-grid'].filter((l) => this.map.getLayer(l));
      const hits = this.map.queryRenderedFeatures(e.point, { layers });
      const route = hits.find((f) => f.layer.id === 'cr-routes-hit');
      if (route && this.onRouteSelect) { this.onRouteSelect(Number(route.properties.idx)); return; }
      const place = hits.find((f) => f.layer.id === 'bc-places');
      if (place) {
        const p = place.properties as Record<string, string | null>;
        this.popupAt(e.lngLat.lat, e.lngLat.lng, tipNode(p.name || p.kindLabel || 'Safe place', [p.kindLabel, p.address, p.phone, p.openingHours && `Hours: ${p.openingHours}`]));
        return;
      }
      const alert = hits.find((f) => f.layer.id === 'bc-alerts-fill');
      if (alert) {
        const p = alert.properties as Record<string, string | null>;
        this.popupAt(e.lngLat.lat, e.lngLat.lng, tipNode(p.event ?? 'Alert', [p.headline, p.severity && `Severity: ${p.severity}`]));
        return;
      }
      const zone = hits.find((f) => f.layer.id === 'bc-hazard-zones-fill');
      if (zone) {
        const p = zone.properties as Record<string, string | null>;
        this.popupAt(e.lngLat.lat, e.lngLat.lng, tipNode(p.name || 'Hazard zone', [p.kind?.replace(/_/g, ' '), p.level && `Level: ${p.level}`]));
        return;
      }
      const cell = hits.find((f) => f.layer.id === 'bc-hazard-grid');
      if (cell && !this.cellInfo) {
        const p = cell.properties as Record<string, number | string>;
        this.popupAt(e.lngLat.lat, e.lngLat.lng, tipNode(`Exposure ${p.score} of 100`, [`${p.level} compared with the rest of the map`, 'Relative, not a probability']));
        return;
      }
      if (this.cellInfo) this.showTip(e.lngLat, true);
    });
    for (const id of ['cr-routes-hit', 'bc-places']) {
      this.map.on('mouseenter', id, () => { if (!this.pickHandler) this.map.getCanvas().style.cursor = 'pointer'; });
      this.map.on('mouseleave', id, () => { if (!this.pickHandler) this.map.getCanvas().style.cursor = ''; });
    }
    this.map.on('moveend', () => this.reportView());
    for (const ev of ['zoomend', 'rotateend', 'pitchend'] as const) this.map.on(ev, () => this.layoutPills());

    const context = (lngLat: maplibregl.LngLat) => this.onContext?.({ lat: lngLat.lat, lng: lngLat.lng });
    this.map.on('contextmenu', (e) => { e.preventDefault(); context(e.lngLat); });
    let pressTimer = 0;
    let pressStart: maplibregl.Point | null = null;
    const cancel = () => { window.clearTimeout(pressTimer); pressStart = null; };
    this.map.on('touchstart', (e) => {
      cancel();
      if (e.originalEvent.touches.length !== 1) return;
      pressStart = e.point;
      const lngLat = e.lngLat;
      pressTimer = window.setTimeout(() => { pressStart = null; context(lngLat); }, LONG_PRESS_MS);
    });
    this.map.on('touchmove', (e) => { if (pressStart && pressStart.dist(e.point) > 10) cancel(); });
    this.map.on('touchend', cancel);
    this.map.on('touchcancel', cancel);
  }

  /** Pick mode: crosshair cursor until the next click. */
  pick(handler: ((p: LatLng) => void) | null) {
    this.pickHandler = handler;
    this.map.getCanvas().style.cursor = handler ? 'crosshair' : '';
  }

  private showTip(lngLat: maplibregl.LngLat, sticky: boolean) {
    const info = this.cellInfo?.({ lat: lngLat.lat, lng: lngLat.lng });
    if (!info) { this.closeTip(); return; }
    const body = tipNode(info.title, info.lines);
    if (sticky) {
      this.closeTip();
      this.popupAt(lngLat.lat, lngLat.lng, body);
    } else {
      this.tipPopup.setLngLat(lngLat).setDOMContent(body);
      if (!this.tipPopup.isOpen()) this.tipPopup.addTo(this.map);
    }
  }

  closeTip() {
    this.tipPopup.remove();
  }

  popupAt(lat: number, lng: number, node: HTMLElement) {
    this.stickyPopup?.remove();
    this.stickyPopup = new maplibregl.Popup({ maxWidth: '280px', className: 'gl-popup', offset: 10 }).setLngLat([lng, lat]).setDOMContent(node).addTo(this.map);
  }

  closePopup() {
    this.stickyPopup?.remove();
    this.stickyPopup = null;
  }

  // ---------- look ----------

  /** Night palette for evening and night; colors fade over 0.9 s and the whole app follows (body.theme-night). */
  setDark(dark: boolean) {
    document.body.classList.toggle('theme-night', dark);
    if (dark === this.dark) return;
    this.dark = dark;
    this.map.getContainer().classList.toggle('is-dark', dark);
    this.whenReady(() => {
      const p = dark ? PALETTE.night : PALETTE.day;
      for (const layer of this.map.getStyle().layers) {
        const paint = paintFor(layer, p);
        if (!paint) continue;
        for (const [prop, value] of Object.entries(paint)) {
          try { this.map.setPaintProperty(layer.id, prop as never, value as never); } catch { /* property not on this layer */ }
        }
      }
      this.map.setPaintProperty('cr-buildings-3d', 'fill-extrusion-color', p.building3d);
      this.map.setPaintProperty('cr-heat', 'heatmap-color', heatColor(dark ? HEAT_DARK : HEAT_LIGHT));
      this.map.setPaintProperty('bc-places-label', 'text-color', p.text);
      this.map.setPaintProperty('bc-places-label', 'text-halo-color', p.halo);
      this.map.setPaintProperty('hillshade', 'hillshade-shadow-color', p.shadow);
      this.map.setPaintProperty('hillshade', 'hillshade-highlight-color', p.highlight);
      this.map.setSky(skyFor(p, dark));
    });
  }

  /** 'grid' = risk blocks as 3D columns (Explore); 'flat' = flat blocks behind routes (Directions). */
  setLayer(name: 'heat' | 'grid' | 'flat' | 'none') {
    this.show('cr-heat', name === 'heat');
    this.show('cr-grid', name === 'grid');
    this.show('cr-grid-flat', name === 'flat');
  }

  /** 3D: tilt the camera, raise the risk blocks into a skyline, show 3D buildings and terrain. */
  set3D(on: boolean, animate = true) {
    this.is3D = on;
    this.whenReady(() => {
      this.applyBuildings();
      this.map.setTerrain(on && !this.terrainFailed ? { source: TERRAIN_SOURCE, exaggeration: isPhone() ? 1 : 1.3 } : null);
      if (animate) this.map.easeTo({ pitch: on ? 58 : 0, bearing: on ? -20 : 0, duration: reducedMotion() ? 0 : 1600 });
    });
  }

  /** Tilt the camera (for the risk skyline) unless it is already tilted. */
  tilt(pitch = 60) {
    this.whenReady(() => {
      if (this.map.getPitch() < 35) this.map.easeTo({ pitch, bearing: this.map.getBearing() || -20, zoom: Math.min(this.map.getZoom(), 13.6), duration: reducedMotion() ? 0 : 1400 });
    });
  }

  private buildingsHidden = { skyline: false, route: false };

  /** The risk skyline and the 3D buildings are never shown together: the skyline wins. */
  hideBuildings(hidden: boolean) {
    this.buildingsHidden.skyline = hidden;
    this.applyBuildings();
  }

  /**
   * 3D buildings hide route lines behind them (even see-through ones), so they step aside while a route
   * is on the map; the terrain and the tilt stay.
   */
  dimBuildings(dim: boolean) {
    this.buildingsHidden.route = dim;
    this.applyBuildings();
  }

  private applyBuildings() {
    const { skyline, route } = this.buildingsHidden;
    this.show('cr-buildings-3d', this.is3D && !skyline && !route);
  }

  /** Pulsing radar blips on the riskiest blocks (Explore). */
  setBlips(points: LatLng[]) {
    for (const m of this.blipMarkers) m.remove();
    this.blipMarkers = points.map((p) => new maplibregl.Marker({ element: markerEl('blip', 'High-risk block'), anchor: 'center' })
      .setLngLat([p.lng, p.lat]).addTo(this.map));
  }

  // ---------- crime layers ----------

  /** Heat points [lat, lng, weight]; when the selection changes, the old map fades into the new one. */
  setHeat(points: [number, number, number][], max: number) {
    const target = new Map<string, { lat: number; lng: number; n: number }>();
    const m = Math.max(1e-6, max);
    for (const [lat, lng, w] of points) target.set(`${lat.toFixed(5)},${lng.toFixed(5)}`, { lat, lng, n: Math.min(1, w / m) });
    const from = this.heatNow;
    const keys = new Set([...from.keys(), ...target.keys()]);
    const animate = this.loaded && from.size > 0 && !reducedMotion();
    cancelAnimationFrame(this.heatAnim);
    const start = performance.now();
    const step = (now: number) => {
      const t = animate ? Math.min(1, (now - start) / 700) : 1;
      const e = t * (2 - t);
      const feats: GeoJSON.Feature[] = [];
      const cur = new Map<string, { lat: number; lng: number; n: number }>();
      for (const k of keys) {
        const a = from.get(k);
        const b = target.get(k);
        const n = (a ? a.n : 0) + ((b ? b.n : 0) - (a ? a.n : 0)) * e;
        if (n <= 0.002) continue;
        const p = (b ?? a)!;
        feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { n } });
        cur.set(k, { lat: p.lat, lng: p.lng, n });
      }
      this.heatNow = cur;
      (this.map.getSource('cr-cells') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: feats });
      if (t < 1) this.heatAnim = requestAnimationFrame(step);
    };
    this.whenReady(() => {
      if (animate) this.heatAnim = requestAnimationFrame(step);
      else step(performance.now());
    });
  }

  /** Risk blocks as 3D columns: height follows the risk, so the riskiest blocks form a skyline in 3D. */
  setGrid(cells: { bounds: [Pt, Pt]; level: string; risk: number }[], opts: { subtle?: boolean; faint?: boolean } = {}) {
    const feats: GeoJSON.Feature[] = cells.map((c) => {
      const [[s, w], [n, e]] = c.bounds;
      const dy = (n - s) * 0.06;
      const dx = (e - w) * 0.06;
      const ring = [[w + dx, s + dy], [e - dx, s + dy], [e - dx, n - dy], [w + dx, n - dy], [w + dx, s + dy]];
      return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { level: c.level, h: Math.min(900, 30 + (Number(c.risk) || 0) * 9) } };
    });
    this.setData('cr-grid', feats);
    this.whenReady(() => {
      this.map.setPaintProperty('cr-grid', 'fill-extrusion-opacity', opts.faint ? 0.2 : opts.subtle ? 0.36 : 0.62);
      this.map.setPaintProperty('cr-grid-flat', 'fill-opacity', opts.faint ? 0.14 : opts.subtle ? 0.3 : 0.5);
    });
  }

  /** Highlight one neighborhood's blocks (Areas ranked). */
  setHood(cells: [Pt, Pt][] | null) {
    this.setData('cr-hood', (cells ?? []).map(([[s, w], [n, e]]) => ({
      type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
    })));
  }

  // ---------- Beacon overlays ----------

  setAlertAreas(fc: FC | null) { this.setData('bc-alerts', fc ?? EMPTY); }
  setSafePlaces(fc: FC | null) { this.setData('bc-places', fc ?? EMPTY); }
  setHazardGrid(fc: FC | null) { this.setData('bc-hazard-grid', fc ?? EMPTY); }
  setHazardZones(fc: FC | null) { this.setData('bc-hazard-zones', fc ?? EMPTY); }
  setDangerArea(fc: FC | null) { this.setData('bc-danger', fc ?? EMPTY); }

  /** "Where to go" safe areas as flag markers. */
  setSafeAreas(areas: (LatLng & { title: string })[], onPick?: (i: number) => void) {
    for (const m of this.areaMarkers) m.remove();
    this.areaMarkers = areas.map((a, i) => {
      const el = markerEl('area-pin', a.title);
      if (onPick) el.addEventListener('click', (ev) => { ev.stopPropagation(); onPick(i); });
      return new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([a.lng, a.lat]).addTo(this.map);
    });
  }

  // ---------- routes ----------

  clearRoutes() {
    this.onRouteSelect = null;
    this.setData('cr-routes', EMPTY);
    for (const p of this.pills) p.marker.remove();
    for (const m of this.hotMarkers) m.remove();
    this.pills = [];
    this.hotMarkers = [];
    this.stopFlow();
    this.dimBuildings(false);
  }

  /**
   * All options at once: green = recommended, orange = moderate, red = most dangerous; the selected one glows.
   * `guide` draws one bold route (survival guidance) without pills.
   */
  drawRoutes(routes: DrawRoute[], selected: number, onSelect: ((i: number) => void) | null, opts: { guide?: boolean; color?: string } = {}) {
    this.clearRoutes();
    this.onRouteSelect = onSelect;
    const feats: GeoJSON.Feature[] = routes.map((r, i) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: r.coords.map(([lat, lng]) => [lng, lat]) },
      properties: {
        idx: i, color: opts.color ?? ROLE_COLOR[r.role ?? 'best'],
        sel: i === selected ? 1 : 0, sort: i === selected ? 10 : ROLE_ORDER[r.role ?? 'best'],
        w: opts.guide ? 11 : i === selected ? 8 : 6,
      },
    }));
    this.setData('cr-routes', feats);
    this.dimBuildings(true);
    if (!opts.guide) {
      this.pills = labelPoints(routes).map((p, i) => {
        const r = routes[i];
        const el = document.createElement('div');
        el.className = 'gl-marker gl-pill';
        const pill = document.createElement('div');
        pill.className = `route-pill route-pill-${r.role ?? 'best'}${i === selected ? ' is-selected' : ''}`;
        pill.append(`R${i + 1}`);
        const mins = document.createElement('span');
        mins.textContent = `${Math.max(1, Math.round(r.duration / 60))} min`;
        pill.append(mins);
        el.append(pill);
        el.addEventListener('click', (ev) => { ev.stopPropagation(); onSelect?.(i); });
        if (i === selected) el.style.zIndex = '3';
        const lngLat: [number, number] = [p[1], p[0]];
        return { marker: new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(lngLat).addTo(this.map), lngLat, selected: i === selected };
      });
      this.layoutPills();
      const sel = routes[selected];
      this.hotMarkers = (sel?.hotspots ?? []).slice(0, 12).map((s) => new maplibregl.Marker({ element: markerEl('hot-dot', 'High-risk block'), anchor: 'center' })
        .setLngLat([s.lng, s.lat]).addTo(this.map));
    }
    if (routes[selected]) this.startFlow();
  }

  private layoutPills() {
    if (!this.pills.length) return;
    const offsets = pillOffsets(this.pills.map((p) => {
      const pt = this.map.project(p.lngLat);
      return { x: pt.x, y: pt.y, selected: p.selected };
    }));
    this.pills.forEach((p, i) => p.marker.setOffset([0, offsets[i]]));
  }

  /** A white dash runs along the selected route, in the direction of travel. */
  private startFlow() {
    this.stopFlow();
    if (reducedMotion()) return;
    let step = -1;
    const tick = (now: number) => {
      const next = Math.floor(now / 55) % FLOW_DASHES.length;
      if (next !== step && this.loaded) {
        step = next;
        this.map.setPaintProperty('cr-routes-flow', 'line-dasharray', FLOW_DASHES[step]);
      }
      this.flow = requestAnimationFrame(tick);
    };
    this.flow = requestAnimationFrame(tick);
  }

  private stopFlow() {
    cancelAnimationFrame(this.flow);
    this.flow = 0;
  }

  // ---------- markers ----------

  /** One named DOM marker (start, destination, me, traveler ...); null removes it. */
  private marker(name: string, pos: LatLng | null, cls: string, opts: { anchor?: maplibregl.PositionAnchor; z?: number; title?: string } = {}) {
    const old = this.named[name];
    if (!pos) { old?.remove(); this.named[name] = null; return null; }
    if (old && old.getElement().firstElementChild?.className === cls) {
      old.setLngLat([pos.lng, pos.lat]);
      return old;
    }
    old?.remove();
    const el = markerEl(cls, opts.title);
    if (opts.z) el.style.zIndex = String(opts.z);
    const m = new maplibregl.Marker({ element: el, anchor: opts.anchor ?? 'center', rotationAlignment: 'map' }).setLngLat([pos.lng, pos.lat]).addTo(this.map);
    this.named[name] = m;
    return m;
  }

  setEndpoints(from: LatLng | null, to: LatLng | null, toIsSafe = false) {
    this.marker('from', from, 'start-dot', { title: 'Start' });
    this.marker('to', to, toIsSafe ? 'safe-pin' : 'dest-pin', { anchor: 'bottom', title: toIsSafe ? 'Safe place' : 'Destination' });
  }

  setMe(pos: LatLng | null) { this.marker('me', pos, 'me-dot', { title: 'Your location' }); }

  /** The moving traveler; `heading` (degrees) turns its arrow along the route. */
  setTraveler(pos: Pt | null, heading?: number) {
    const m = this.marker('sim', pos ? { lat: pos[0], lng: pos[1] } : null, 'sim-dot', { z: 4 });
    if (m && heading != null) m.setRotation(heading);
  }

  // ---------- camera ----------

  /** Room left by the side panel (desktop) or the bottom sheet (phone). */
  padding(sheetFraction = 0.48) {
    return isPhone()
      ? { top: 110, bottom: Math.round(window.innerHeight * sheetFraction), left: 28, right: 28 }
      : { top: 100, bottom: 100, left: 470, right: 90 };
  }

  fit(points: Pt[], maxZoom = 16, sheetFraction?: number) {
    if (!points.length) return;
    let s = 90; let w = 180; let n = -90; let e = -180;
    for (const [lat, lng] of points) {
      s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lng); e = Math.max(e, lng);
    }
    this.whenReady(() => this.map.fitBounds([[w, s], [e, n]], {
      padding: this.padding(sheetFraction), maxZoom, duration: reducedMotion() ? 0 : 1100, bearing: this.map.getBearing(),
      pitch: this.is3D ? 40 : 0,
    }));
  }

  private offset(sheetFraction = 0.48): [number, number] {
    return isPhone() ? [0, -Math.round(window.innerHeight * (sheetFraction / 2 - 0.02))] : [210, 0];
  }

  flyTo(lat: number, lng: number, zoom = 15, sheetFraction?: number) {
    this.whenReady(() => this.map.flyTo({ center: [lng, lat], zoom, offset: this.offset(sheetFraction), duration: reducedMotion() ? 0 : 1400, essential: true }));
  }

  /** Keep a moving point centred in the visible part of the map (survival guidance). */
  follow(pos: Pt, zoom?: number, sheetFraction?: number) {
    if (this.map.isMoving() && this.panning) return;
    this.panning = true;
    this.map.once('moveend', () => { this.panning = false; });
    this.map.easeTo({ center: [pos[1], pos[0]], zoom: zoom ?? Math.max(this.map.getZoom(), 16), offset: this.offset(sheetFraction), duration: reducedMotion() ? 0 : 700 });
  }

  /** Keep a moving point (the traveler) in the visible part of the map. One pan at a time. */
  panIfNeeded(p: Pt) {
    if (this.panning) return;
    const canvas = this.map.getCanvas();
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const box = isPhone() ? { x0: 30, y0: 150, x1: W - 30, y1: H * 0.5 } : { x0: 470, y0: 150, x1: W - 70, y1: H - 90 };
    const pt = this.map.project([p[1], p[0]]);
    if (pt.x >= box.x0 && pt.x <= box.x1 && pt.y >= box.y0 && pt.y <= box.y1) return;
    const dx = pt.x - (box.x0 + box.x1) / 2;
    const dy = pt.y - (box.y0 + box.y1) / 2;
    this.panning = true;
    const done = () => { this.panning = false; };
    this.map.once('moveend', done);
    window.setTimeout(done, 1200);
    this.map.panBy([dx, dy], { duration: reducedMotion() ? 0 : 550 });
  }

  /** Opening camera: a gentle fly-in over downtown in 3D. */
  intro(threeD: boolean) {
    this.set3D(threeD, false);
    this.whenReady(() => {
      const phone = isPhone();
      this.map.flyTo({
        center: [-122.3372, 47.6078], zoom: phone ? 13.6 : 13.4, pitch: threeD ? 52 : 0, bearing: threeD ? -20 : 0,
        offset: this.offset(), duration: reducedMotion() ? 0 : 2800, curve: 1.3,
      });
    });
  }

  remove() {
    this.stopFlow();
    cancelAnimationFrame(this.heatAnim);
    this.map.remove();
  }
}
