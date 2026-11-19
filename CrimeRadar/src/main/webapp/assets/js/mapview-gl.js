// Main map engine: MapLibre GL with an OpenFreeMap vector basemap, recolored with CrimeRadar's
// day and night palettes. Adds a GPU heatmap, a 3D risk "skyline", glowing routes with a moving
// dash, pulsing radar blips and a slow 3D showcase for the login screen.
// Same interface as LeafletMapView (mapview-leaflet.js).

import { h, isPhone, reducedMotion } from './ui.js';
import { HEAT_LIGHT, HEAT_DARK, LEVEL_COLOR, ROLE_COLOR, ROLE_ORDER, labelPoints, pillOffsets, pillHtml } from './mapstyle.js';

const PALETTE = {
  day: {
    land: '#eef1f6', landuse: '#e7eaf2', park: '#d9ead6', water: '#a9cdf2', waterText: '#36659a',
    building: '#dde2eb', building3d: '#d3d9e6',
    minor: '#ffffff', major: '#ffffff', casing: '#d0d6e2', motorway: '#ffe0b3', motorwayCasing: '#efbd83',
    rail: '#c4cbd8', boundary: '#b2bacb', text: '#44506c', halo: '#ffffff',
  },
  night: {
    land: '#0b0e1d', landuse: '#0e1226', park: '#0c1a1e', water: '#050a18', waterText: '#5b78b2',
    building: '#151a33', building3d: '#202650',
    minor: '#191f3d', major: '#262f63', casing: '#0f1329', motorway: '#4c3fa8', motorwayCasing: '#1a1745',
    rail: '#222a4b', boundary: '#2d345f', text: '#a6aed6', halo: '#0b0e1d',
  },
};

/** Paint changes for one basemap layer of the OpenFreeMap "positron" style, or null to leave it. */
function paintFor(layer, p) {
  const id = layer.id;
  const t = layer.type;
  if (id.startsWith('cr-')) return null;
  if (t === 'background') return { 'background-color': p.land };
  if (t === 'symbol') return { 'text-color': /water/.test(id) ? p.waterText : p.text, 'text-halo-color': p.halo };
  if (id === 'water') return { 'fill-color': p.water };
  if (id === 'waterway') return { 'line-color': p.water };
  if (id === 'park' || id.startsWith('landcover')) return { 'fill-color': p.park };
  if (id.startsWith('landuse')) return { 'fill-color': p.landuse };
  if (id === 'building') return { 'fill-color': p.building, 'fill-outline-color': p.building };
  if (t !== 'line' && t !== 'fill') return null;
  const key = t === 'line' ? 'line-color' : 'fill-color';
  if (id.includes('casing')) return { [key]: id.includes('motorway') ? p.motorwayCasing : p.casing };
  if (id.includes('motorway')) return { [key]: p.motorway };
  if (id.includes('major')) return { [key]: p.major };
  if (id.startsWith('highway') || id.startsWith('road') || id.startsWith('tunnel')) return { [key]: p.minor };
  if (id.startsWith('railway')) return { [key]: p.rail };
  if (id.startsWith('aeroway')) return { [key]: t === 'line' ? p.minor : p.landuse };
  if (id.startsWith('boundary')) return { [key]: p.boundary };
  return null;
}

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** MapLibre heatmap-color expression from a ramp object; fades in from the first color. */
function heatColor(ramp) {
  const entries = Object.entries(ramp).map(([k, c]) => [Number(k), c]).sort((a, b) => a[0] - b[0]);
  const expr = ['interpolate', ['linear'], ['heatmap-density'], 0, hexToRgba(entries[0][1], 0), 0.05, hexToRgba(entries[0][1], 0)];
  for (const [k, c] of entries) expr.push(k, c);
  return expr;
}

const EMPTY = { type: 'FeatureCollection', features: [] };
const FLOW_DASHES = [
  [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0],
  [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5],
];

function markerEl(cls) {
  const wrap = document.createElement('div');
  wrap.className = 'gl-marker';
  const inner = document.createElement('div');
  inner.className = cls;
  wrap.append(inner);
  return wrap;
}

export class GLMapView {
  constructor(elementId, styleJson) {
    this.engine = 'gl';
    this.supports3D = true;
    this.dark = true; // the map starts in the night palette: the login screen is always "night"
    this.is3D = false;
    this.layer = 'heat';
    this.cellInfo = null;
    this.queue = [];
    this.loaded = false;
    this.pills = [];
    this.hotMarkers = [];
    this.blipMarkers = [];

    const style = this.prepareStyle(styleJson);
    this.map = new maplibregl.Map({
      container: elementId,
      style,
      center: [-122.334, 47.6145],
      zoom: 12.7,
      minZoom: 10.5,
      maxZoom: 18.5,
      maxPitch: 70,
      maxBounds: [[-122.66, 47.34], [-122.0, 47.88]],
      attributionControl: false,
      fadeDuration: 180,
    });
    this.map.getContainer().classList.add('engine-gl');
    this.map.addControl(new maplibregl.AttributionControl({
      compact: true,
      customAttribution: 'Crime data: <a href="https://data.seattle.gov/d/tazs-3rd5" target="_blank" rel="noopener">Seattle Police</a>',
    }), 'bottom-right');
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    this.map.on('load', () => {
      this.loaded = true;
      const q = this.queue;
      this.queue = [];
      for (const fn of q) fn();
    });
    this.tipPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'gl-tip', offset: 14, maxWidth: '280px' });
    this.bindEvents();
  }

  /** Recolor the basemap (night palette first), add 3D buildings and our empty data layers before the labels. */
  prepareStyle(styleJson) {
    const style = JSON.parse(JSON.stringify(styleJson));
    style.transition = { duration: 900, delay: 0 };
    for (const layer of style.layers) {
      const paint = paintFor(layer, PALETTE.night);
      if (paint) layer.paint = { ...(layer.paint || {}), ...paint };
    }
    Object.assign(style.sources, {
      'cr-cells': { type: 'geojson', data: EMPTY },
      'cr-grid': { type: 'geojson', data: EMPTY },
      'cr-routes': { type: 'geojson', data: EMPTY },
    });
    const ours = [
      {
        id: 'cr-buildings-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 13.5,
        layout: { visibility: 'none' },
        paint: {
          'fill-extrusion-color': PALETTE.night.building3d,
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': 0.8,
        },
      },
      {
        id: 'cr-grid', type: 'fill-extrusion', source: 'cr-grid', layout: { visibility: 'none' },
        paint: {
          'fill-extrusion-color': ['match', ['get', 'level'], 'high', LEVEL_COLOR.high, 'elevated', LEVEL_COLOR.elevated, LEVEL_COLOR.low],
          'fill-extrusion-height': ['get', 'h'],
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.62,
          'fill-extrusion-vertical-gradient': true,
        },
      },
      {
        id: 'cr-heat', type: 'heatmap', source: 'cr-cells',
        paint: {
          'heatmap-weight': ['get', 'n'],
          // Cells are ~225 m apart (about 17 px at zoom 13). A radius of ~2.4x the spacing (sigma = radius / 3)
          // blends them into one smooth glowing surface. Kernel peak = weight x intensity x 0.4, and with this
          // overlap the neighbors add ~3x more, so intensity ~0.9 brings a busy downtown cell (weight ~0.7) to
          // full color while quiet blocks stay a faint haze.
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 12, 0.85, 16, 0.95],
          'heatmap-radius': ['interpolate', ['exponential', 2], ['zoom'], 10, 7, 12, 21, 13, 42, 16, 330],
          'heatmap-color': heatColor(HEAT_DARK),
          'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.9, 17, 0.7],
        },
      },
      {
        id: 'cr-routes-hit', type: 'line', source: 'cr-routes', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#000000', 'line-opacity': 0, 'line-width': 22 },
      },
      {
        id: 'cr-routes-glow', type: 'line', source: 'cr-routes', filter: ['==', ['get', 'sel'], 1],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': 24, 'line-blur': 12, 'line-opacity': 0.55 },
      },
      {
        id: 'cr-routes-casing', type: 'line', source: 'cr-routes',
        layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'sort'] },
        paint: { 'line-color': '#ffffff', 'line-width': ['case', ['==', ['get', 'sel'], 1], 13, 10], 'line-opacity': 0.95 },
      },
      {
        id: 'cr-routes-line', type: 'line', source: 'cr-routes',
        layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'sort'] },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['case', ['==', ['get', 'sel'], 1], 8, 6],
          'line-opacity': ['case', ['==', ['get', 'sel'], 1], 1, 0.9],
        },
      },
      {
        id: 'cr-routes-flow', type: 'line', source: 'cr-routes', filter: ['==', ['get', 'sel'], 1],
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 3, 'line-opacity': 0.9, 'line-dasharray': FLOW_DASHES[0] },
      },
    ];
    const firstSymbol = style.layers.findIndex((l) => l.type === 'symbol');
    style.layers.splice(firstSymbol < 0 ? style.layers.length : firstSymbol, 0, ...ours);
    return style;
  }

  whenReady(fn) {
    if (this.loaded) fn();
    else this.queue.push(fn);
  }

  setSource(id, features) {
    const src = this.map.getSource(id);
    if (src) src.setData({ type: 'FeatureCollection', features });
  }

  bindEvents() {
    let pending = null;
    this.map.on('mousemove', (e) => {
      if (!this.cellInfo || isPhone()) return;
      pending = e.lngLat;
      if (this._tipFrame) return;
      this._tipFrame = requestAnimationFrame(() => {
        this._tipFrame = null;
        this.showTip(pending, false);
      });
    });
    this.map.getCanvas().addEventListener('mouseleave', () => this.closeTip());
    this.map.on('click', (e) => {
      const hit = this.map.getLayer('cr-routes-hit') && this.map.queryRenderedFeatures(e.point, { layers: ['cr-routes-hit'] });
      if (hit && hit.length && this.onRouteSelect) {
        this.onRouteSelect(hit[0].properties.idx);
        return;
      }
      if (this.cellInfo) this.showTip(e.lngLat, true);
    });
    this.map.on('mouseenter', 'cr-routes-hit', () => { this.map.getCanvas().style.cursor = 'pointer'; });
    this.map.on('mouseleave', 'cr-routes-hit', () => { this.map.getCanvas().style.cursor = ''; });
    this.map.on('zoomend', () => this.layoutPills());
    this.map.on('rotateend', () => this.layoutPills());
    this.map.on('pitchend', () => this.layoutPills());
  }

  showTip(lngLat, sticky) {
    const info = this.cellInfo && this.cellInfo({ lat: lngLat.lat, lng: lngLat.lng });
    if (!info) {
      this.closeTip();
      return;
    }
    const body = h('div', null, h('div', { class: 'tip-title' }, info.title), ...info.lines.map((l) => h('div', { class: 'tip-sub' }, l)));
    if (sticky) {
      this.closeTip();
      this.popup(lngLat.lat, lngLat.lng, body);
    } else {
      this.tipPopup.setLngLat(lngLat).setDOMContent(body);
      if (!this.tipPopup.isOpen()) this.tipPopup.addTo(this.map);
    }
  }

  closeTip() {
    this.tipPopup.remove();
  }

  popup(lat, lng, node) {
    if (this._popup) this._popup.remove();
    this._popup = new maplibregl.Popup({ maxWidth: '280px', className: 'gl-popup', offset: 10 }).setLngLat([lng, lat]).setDOMContent(node).addTo(this.map);
  }

  setView(lat, lng, zoom) {
    this.map.jumpTo({ center: [lng, lat], zoom });
  }

  // ---------- look ----------

  /** Dark palette for evening and night; colors fade over 0.9 s. The whole app follows (body.theme-night). */
  setDark(dark) {
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
          try { this.map.setPaintProperty(layer.id, prop, value); } catch { /* property not on this layer */ }
        }
      }
      this.map.setPaintProperty('cr-buildings-3d', 'fill-extrusion-color', p.building3d);
      this.map.setPaintProperty('cr-heat', 'heatmap-color', heatColor(dark ? HEAT_DARK : HEAT_LIGHT));
    });
  }

  setLayer(name) {
    this.layer = name;
    this.whenReady(() => {
      this.map.setLayoutProperty('cr-heat', 'visibility', name === 'heat' ? 'visible' : 'none');
      this.map.setLayoutProperty('cr-grid', 'visibility', name === 'grid' ? 'visible' : 'none');
    });
  }

  /** 3D: tilt the camera, raise the risk blocks into a skyline, show 3D buildings. */
  set3D(on) {
    this.is3D = !!on;
    this.whenReady(() => {
      this.map.setLayoutProperty('cr-buildings-3d', 'visibility', on ? 'visible' : 'none');
      this.map.easeTo({ pitch: on ? 58 : 0, bearing: on ? -20 : 0, duration: reducedMotion() ? 0 : 1600 });
    });
  }

  /** Login background: a slow orbit over the 3D city. */
  startShowcase() {
    this.whenReady(() => {
      this.map.jumpTo({ center: [-122.3355, 47.6085], zoom: 13.3, pitch: 62, bearing: -35 });
      this.map.setLayoutProperty('cr-buildings-3d', 'visibility', 'visible');
      if (reducedMotion()) return;
      cancelAnimationFrame(this._orbit);
      let last = performance.now();
      const spin = (now) => {
        const dt = Math.min(64, now - last);
        last = now;
        this.map.setBearing(this.map.getBearing() + dt * 0.004); // about 4 degrees a second
        this._orbit = requestAnimationFrame(spin);
      };
      this._orbit = requestAnimationFrame(spin);
    });
  }

  stopShowcase() {
    cancelAnimationFrame(this._orbit);
    this._orbit = null;
    this.whenReady(() => {
      this.map.setLayoutProperty('cr-buildings-3d', 'visibility', this.is3D ? 'visible' : 'none');
      this.map.easeTo({ center: [-122.334, 47.6145], zoom: 12.7, pitch: this.is3D ? 58 : 0, bearing: this.is3D ? -20 : 0, duration: reducedMotion() ? 0 : 1800 });
    });
  }

  /** Pulsing radar blips on the riskiest blocks (Explore). */
  setBlips(points) {
    for (const m of this.blipMarkers) m.remove();
    this.blipMarkers = (points || []).map((p) => new maplibregl.Marker({ element: markerEl('blip'), anchor: 'center' })
      .setLngLat([p.lng, p.lat]).addTo(this.map));
  }

  // ---------- data layers ----------

  /** Heat points [lat, lng, weight]; when the selection changes, the old map fades into the new one. */
  setHeat(points, max) {
    const target = new Map();
    const m = Math.max(1e-6, max);
    for (const [lat, lng, w] of points) target.set(`${lat.toFixed(5)},${lng.toFixed(5)}`, { lat, lng, n: Math.min(1, w / m) });
    const from = this.heatNow || new Map();
    const keys = new Set([...from.keys(), ...target.keys()]);
    const animate = this.loaded && from.size > 0 && !reducedMotion();
    const duration = 700;
    cancelAnimationFrame(this._heatAnim);
    const start = performance.now();
    const step = (now) => {
      const t = animate ? Math.min(1, (now - start) / duration) : 1;
      const e = t * (2 - t); // ease-out
      const feats = [];
      const cur = new Map();
      for (const k of keys) {
        const a = from.get(k);
        const b = target.get(k);
        const n = (a ? a.n : 0) + ((b ? b.n : 0) - (a ? a.n : 0)) * e;
        if (n <= 0.002) continue;
        const p = b || a;
        feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { n } });
        cur.set(k, { lat: p.lat, lng: p.lng, n });
      }
      this.heatNow = cur;
      this.setSource('cr-cells', feats);
      if (t < 1) this._heatAnim = requestAnimationFrame(step);
    };
    this.whenReady(() => {
      if (animate) this._heatAnim = requestAnimationFrame(step);
      else step(performance.now());
    });
  }

  /** Risk blocks as 3D columns: height follows the risk, so the riskiest blocks form a skyline in 3D. */
  setGrid(cells, { subtle = false, faint = false } = {}) {
    const feats = cells.map((c) => {
      const [[s, w], [n, e]] = c.bounds;
      const dy = (n - s) * 0.06;
      const dx = (e - w) * 0.06;
      const ring = [[w + dx, s + dy], [e - dx, s + dy], [e - dx, n - dy], [w + dx, n - dy], [w + dx, s + dy]];
      const height = Math.min(900, 30 + (Number(c.risk) || 0) * 9);
      return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { level: c.level, h: height } };
    });
    this.whenReady(() => {
      this.setSource('cr-grid', feats);
      this.map.setPaintProperty('cr-grid', 'fill-extrusion-opacity', faint ? 0.2 : subtle ? 0.36 : 0.62);
    });
  }

  // ---------- routes ----------

  clearRoutes() {
    this.onRouteSelect = null;
    this.whenReady(() => this.setSource('cr-routes', []));
    for (const p of this.pills) p.marker.remove();
    for (const m of this.hotMarkers) m.remove();
    this.pills = [];
    this.hotMarkers = [];
    this.stopFlow();
  }

  /** All options at once: green = recommended, orange = moderate, red = most dangerous; selected glows. */
  drawRoutes(routes, selected, onSelect) {
    this.clearRoutes();
    this.onRouteSelect = onSelect;
    const feats = routes.map((r, i) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: r.coords.map(([lat, lng]) => [lng, lat]) },
      properties: {
        idx: i, role: r.role || 'best', color: ROLE_COLOR[r.role] || ROLE_COLOR.best,
        sel: i === selected ? 1 : 0, sort: i === selected ? 10 : (ROLE_ORDER[r.role] ?? 0),
      },
    }));
    this.whenReady(() => this.setSource('cr-routes', feats));

    this.pills = labelPoints(routes).map((p, i) => {
      const r = routes[i];
      const el = document.createElement('div');
      el.className = 'gl-marker gl-pill';
      el.innerHTML = pillHtml(r.role, i, Math.max(1, Math.round(r.duration / 60)), i === selected);
      el.addEventListener('click', (ev) => { ev.stopPropagation(); onSelect(i); });
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([p[1], p[0]]).addTo(this.map);
      if (i === selected) el.style.zIndex = '3';
      return { marker, lngLat: [p[1], p[0]], selected: i === selected };
    });
    this.layoutPills();

    const sel = routes[selected];
    if (sel) {
      this.hotMarkers = sel.score.hotspots.slice(0, 12).map((s) => {
        const el = markerEl('hot-dot');
        el.title = 'High-risk block';
        return new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([s.lng, s.lat]).addTo(this.map);
      });
      this.startFlow();
    }
  }

  layoutPills() {
    if (!this.pills.length) return;
    const offsets = pillOffsets(this.pills.map((p) => {
      const pt = this.map.project(p.lngLat);
      return { x: pt.x, y: pt.y, selected: p.selected };
    }));
    this.pills.forEach((p, i) => p.marker.setOffset([0, offsets[i]]));
  }

  /** A white dash runs along the selected route, in the direction of travel. */
  startFlow() {
    this.stopFlow();
    if (reducedMotion()) return;
    let step = -1;
    const tick = (now) => {
      const next = Math.floor(now / 55) % FLOW_DASHES.length;
      if (next !== step && this.loaded) {
        step = next;
        this.map.setPaintProperty('cr-routes-flow', 'line-dasharray', FLOW_DASHES[step]);
      }
      this._flow = requestAnimationFrame(tick);
    };
    this._flow = requestAnimationFrame(tick);
  }

  stopFlow() {
    cancelAnimationFrame(this._flow);
    this._flow = null;
  }

  // ---------- markers ----------

  setEndpoints(from, to) {
    if (this._from) this._from.remove();
    if (this._to) this._to.remove();
    this._from = from ? new maplibregl.Marker({ element: markerEl('start-dot'), anchor: 'center' }).setLngLat([from.lng, from.lat]).addTo(this.map) : null;
    this._to = to ? new maplibregl.Marker({ element: markerEl('dest-pin'), anchor: 'bottom', offset: [0, -2] }).setLngLat([to.lng, to.lat]).addTo(this.map) : null;
  }

  setMe(pos) {
    if (!pos) {
      if (this._me) this._me.remove();
      this._me = null;
      return;
    }
    if (!this._me) this._me = new maplibregl.Marker({ element: markerEl('me-dot'), anchor: 'center' }).setLngLat([pos.lng, pos.lat]).addTo(this.map);
    else this._me.setLngLat([pos.lng, pos.lat]);
  }

  setTraveler(pos) {
    if (!pos) {
      if (this._sim) this._sim.remove();
      this._sim = null;
      return;
    }
    if (!this._sim) {
      this._sim = new maplibregl.Marker({ element: markerEl('sim-dot'), anchor: 'center' }).setLngLat([pos[1], pos[0]]).addTo(this.map);
      this._sim.getElement().style.zIndex = '4';
    } else {
      this._sim.setLngLat([pos[1], pos[0]]);
    }
  }

  // ---------- camera ----------

  padding() {
    return isPhone()
      ? { top: 110, bottom: Math.round(window.innerHeight * 0.48), left: 28, right: 28 }
      : { top: 90, bottom: 100, left: 470, right: 90 };
  }

  /** Fit points, keeping clear of the side panel (desktop) or the bottom sheet (phone). */
  fit(latlngs, maxZoom = 16) {
    if (!latlngs || !latlngs.length) return;
    let s = 90; let w = 180; let n = -90; let e = -180;
    for (const [lat, lng] of latlngs) {
      s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lng); e = Math.max(e, lng);
    }
    this.map.fitBounds([[w, s], [e, n]], { padding: this.padding(), maxZoom, duration: reducedMotion() ? 0 : 1100, bearing: this.map.getBearing() });
  }

  flyTo(lat, lng, zoom = 15) {
    const offset = isPhone() ? [0, -Math.round(window.innerHeight * 0.22)] : [210, 0];
    this.map.flyTo({ center: [lng, lat], zoom, offset, duration: reducedMotion() ? 0 : 1400, essential: true });
  }

  /** Keep a moving point (the traveler) in the visible part of the map. One pan at a time. */
  panIfNeeded(latlng) {
    if (this._panning) return;
    const canvas = this.map.getCanvas();
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const box = isPhone() ? { x0: 30, y0: 90, x1: W - 30, y1: H * 0.5 } : { x0: 470, y0: 100, x1: W - 70, y1: H - 90 };
    const p = this.map.project([latlng[1], latlng[0]]);
    if (p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1) return;
    const dx = p.x - (box.x0 + box.x1) / 2;
    const dy = p.y - (box.y0 + box.y1) / 2;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    this._panning = true;
    const done = () => { this._panning = false; };
    this.map.once('moveend', done);
    setTimeout(done, 1200);
    this.map.panBy([dx, dy], { duration: reducedMotion() ? 0 : 550 });
  }
}
