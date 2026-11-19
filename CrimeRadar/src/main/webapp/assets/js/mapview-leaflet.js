// Fallback map engine (Leaflet + raster tiles), used when WebGL or the vector map is not available.
// It has the same interface as GLMapView in mapview-gl.js.

import { h, isPhone, reducedMotion } from './ui.js';
import { HEAT_LIGHT, HEAT_DARK, LEVEL_COLOR, ROLE_COLOR, ROLE_LABEL, ROLE_ORDER, labelPoints, pillOffsets, pillHtml } from './mapstyle.js';

// OpenStreetMap tiles (free, no key). A CSS filter makes them muted by day and dark at night (see app.css).
const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Crime data: <a href="https://data.seattle.gov/d/tazs-3rd5">Seattle Police</a>';

const divIcon = (cls, size) => L.divIcon({ className: '', html: `<div class="${cls}"></div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });

export class LeafletMapView {
  constructor(elementId) {
    this.engine = 'leaflet';
    this.supports3D = false;
    this.map = L.map(elementId, {
      zoomControl: false,
      preferCanvas: true,
      minZoom: 11,
      maxZoom: 18,
      maxBounds: L.latLngBounds([47.36, -122.62], [47.86, -122.04]),
      maxBoundsViscosity: 0.7,
    }).setView([47.6145, -122.334], 13);
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    this.map.attributionControl.setPrefix(false);
    this.map.getContainer().classList.add('engine-leaflet');

    this.base = L.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(this.map);
    this.dark = false;

    this.heat = L.heatLayer([], { radius: 18, blur: 16, minOpacity: 0.04, gradient: HEAT_LIGHT, max: 1 });
    this.gridRenderer = L.canvas({ padding: 0.4 });
    this.grid = L.layerGroup();
    this.routes = L.layerGroup().addTo(this.map);
    this.marks = L.layerGroup().addTo(this.map);
    this.blips = L.layerGroup().addTo(this.map);
    this.layer = null;
    this.setLayer('heat');

    this.cellInfo = null; // function({lat, lng}) -> {title, lines[]} | null, set by the Explore view
    this.tip = L.tooltip({ className: 'cell-tip', direction: 'top', offset: [0, -10], opacity: 1 });
    let pending = null;
    this.map.on('mousemove', (e) => {
      if (!this.cellInfo || isPhone()) return;
      pending = e.latlng;
      if (this._tipFrame) return;
      this._tipFrame = requestAnimationFrame(() => {
        this._tipFrame = null;
        this.showTip(pending, false);
      });
    });
    this.map.on('mouseout', () => this.closeTip());
    this.map.on('click', (e) => { if (this.cellInfo) this.showTip(e.latlng, true); });
    this.map.on('zoomend', () => this.fitHeat());
    this.map.on('zoomend', () => this.layoutPills());
    this.fitHeat();
  }

  showTip(latlng, sticky) {
    const info = this.cellInfo && this.cellInfo({ lat: latlng.lat, lng: latlng.lng });
    if (!info) {
      this.closeTip();
      return;
    }
    const body = h('div', null, h('div', { class: 'tip-title' }, info.title), ...info.lines.map((l) => h('div', { class: 'tip-sub' }, l)));
    if (sticky) this.popup(latlng.lat, latlng.lng, body);
    else {
      this.tip.setLatLng(latlng).setContent(body);
      if (!this.map.hasLayer(this.tip)) this.tip.openOn(this.map);
    }
  }

  closeTip() {
    this.map.closeTooltip(this.tip);
  }

  popup(lat, lng, node) {
    L.popup({ maxWidth: 260 }).setLatLng([lat, lng]).setContent(node).openOn(this.map);
  }

  setView(lat, lng, zoom) {
    this.map.setView([lat, lng], Math.round(zoom), { animate: false });
  }

  // 3D, showcase and blips are GL extras; the fallback keeps the calls harmless.
  set3D() {}
  startShowcase() {}
  stopShowcase() {}

  setBlips(points) {
    this.blips.clearLayers();
    for (const p of points || []) {
      L.marker([p.lat, p.lng], { icon: divIcon('blip', 16), keyboard: false, interactive: false }).addTo(this.blips);
    }
  }

  /** leaflet.heat crashes in redraw() when it is not on the map, so only redraw when it is. */
  heatOptions(opts) {
    if (this.map.hasLayer(this.heat)) this.heat.setOptions(opts);
    else L.setOptions(this.heat, opts); // applied when the layer is added again
  }

  /** Dark map for evening and night. The whole app follows (body.theme-night). */
  setDark(dark) {
    document.body.classList.toggle('theme-night', dark);
    if (dark === this.dark) return;
    this.dark = dark;
    this.map.getContainer().classList.toggle('is-dark', dark);
    this.heatOptions({ gradient: dark ? HEAT_DARK : HEAT_LIGHT });
  }

  setLayer(name) {
    if (this.layer === name) return;
    this.layer = name;
    if (name === 'heat') {
      this.map.removeLayer(this.grid);
      this.heat.addTo(this.map);
    } else if (name === 'grid') {
      this.map.removeLayer(this.heat);
      this.grid.addTo(this.map);
    } else {
      this.map.removeLayer(this.heat);
      this.map.removeLayer(this.grid);
    }
  }

  /** Heat radius follows the zoom so one grid cell is about one blob. */
  fitHeat() {
    const z = this.map.getZoom();
    const metersPerPx = (156543.03392 * Math.cos((47.61 * Math.PI) / 180)) / 2 ** z;
    const cellPx = 224 / metersPerPx;
    const radius = Math.max(6, Math.min(60, cellPx * 0.72));
    this.heatOptions({ radius, blur: radius * 0.85, maxZoom: z });
  }

  setHeat(points, max) {
    this.heatOptions({ max: Math.max(1e-6, max) });
    if (this.map.hasLayer(this.heat)) this.heat.setLatLngs(points);
    else this.heat._latlngs = points; // shown when the layer is added again
  }

  setGrid(cells, { subtle = false, faint = false } = {}) {
    this.grid.clearLayers();
    const alpha = faint ? { high: 0.15, elevated: 0.07 } : subtle ? { high: 0.26, elevated: 0.13 } : { high: 0.5, elevated: 0.32 };
    for (const c of cells) {
      // inset each block a little so the layer reads as a grid of city blocks
      const [[s, w], [n, e]] = c.bounds;
      const dy = (n - s) * 0.06;
      const dx = (e - w) * 0.06;
      L.rectangle([[s + dy, w + dx], [n - dy, e - dx]], {
        renderer: this.gridRenderer,
        stroke: false,
        fillColor: LEVEL_COLOR[c.level],
        fillOpacity: alpha[c.level],
        interactive: false,
      }).addTo(this.grid);
    }
  }

  // ---- routes and markers ----
  clearRoutes() {
    this.routes.clearLayers();
    this._pills = [];
  }

  /**
   * All route options at once, colored by how they compare: green = recommended, orange = moderate,
   * red = most dangerous. The selected route is thicker, glows, and is drawn on top.
   */
  drawRoutes(routes, selected, onSelect) {
    this.routes.clearLayers();
    const order = routes.map((_, i) => i).sort((a, b) =>
      (a === selected) - (b === selected) || (ROLE_ORDER[routes[a].role] ?? 0) - (ROLE_ORDER[routes[b].role] ?? 0));
    for (const i of order) {
      const r = routes[i];
      const color = ROLE_COLOR[r.role] || ROLE_COLOR.best;
      const isSel = i === selected;
      if (isSel) L.polyline(r.coords, { color, weight: 24, opacity: this.dark ? 0.32 : 0.22, interactive: false, lineCap: 'round' }).addTo(this.routes);
      const casing = L.polyline(r.coords, { color: '#ffffff', weight: isSel ? 13 : 10, opacity: isSel ? 1 : 0.92, lineCap: 'round', lineJoin: 'round', interactive: !isSel });
      const line = L.polyline(r.coords, { color, weight: isSel ? 8 : 6, opacity: isSel ? 1 : 0.88, lineCap: 'round', lineJoin: 'round', interactive: !isSel });
      for (const l of [casing, line]) {
        if (!isSel) l.on('click', () => onSelect(i));
        l.addTo(this.routes);
      }
      if (!isSel) casing.bindTooltip(`R${i + 1} · ${ROLE_LABEL[r.role] || ''} · click to select`, { sticky: true, className: 'cell-tip' });
    }
    this._pills = labelPoints(routes).map((p, i) => {
      const r = routes[i];
      const html = pillHtml(r.role, i, Math.max(1, Math.round(r.duration / 60)), i === selected);
      const marker = L.marker(p, { icon: L.divIcon({ className: 'route-pill-anchor', html, iconSize: null }), keyboard: false, zIndexOffset: i === selected ? 950 : 900 });
      marker.on('click', () => onSelect(i));
      marker.addTo(this.routes);
      return { marker, latlng: L.latLng(p), selected: i === selected };
    });
    this.layoutPills();
    const sel = routes[selected];
    if (!sel) return;
    for (const spot of sel.score.hotspots.slice(0, 12)) {
      L.marker([spot.lat, spot.lng], { icon: divIcon('hot-dot', 14), keyboard: false })
        .bindTooltip('High-risk block', { className: 'cell-tip', direction: 'top', offset: [0, -8] })
        .addTo(this.routes);
    }
  }

  /** Move route pills apart when they overlap on screen; the selected pill stays in place. */
  layoutPills() {
    const pills = (this._pills || []).filter((p) => this.routes.hasLayer(p.marker));
    if (!pills.length) return;
    const offsets = pillOffsets(pills.map((p) => {
      const pt = this.map.latLngToContainerPoint(p.latlng);
      return { x: pt.x, y: pt.y, selected: p.selected };
    }));
    pills.forEach((p, i) => {
      const el = p.marker.getElement() && p.marker.getElement().querySelector('.route-pill');
      if (el) el.style.marginTop = `${offsets[i]}px`;
    });
  }

  setEndpoints(from, to) {
    if (this._from) this.marks.removeLayer(this._from);
    if (this._to) this.marks.removeLayer(this._to);
    this._from = from ? L.marker([from.lat, from.lng], { icon: divIcon('start-dot', 16), keyboard: false, title: from.name }).addTo(this.marks) : null;
    this._to = to ? L.marker([to.lat, to.lng], { icon: L.divIcon({ className: '', html: '<div class="dest-pin"></div>', iconSize: [22, 22], iconAnchor: [11, 22] }), keyboard: false, title: to.name }).addTo(this.marks) : null;
  }

  setMe(pos) {
    if (!pos) {
      if (this._me) this.marks.removeLayer(this._me);
      this._me = null;
      return;
    }
    if (!this._me) this._me = L.marker([pos.lat, pos.lng], { icon: divIcon('me-dot', 18), keyboard: false, zIndexOffset: 500 }).addTo(this.marks);
    else this._me.setLatLng([pos.lat, pos.lng]);
  }

  setTraveler(pos) {
    if (!pos) {
      if (this._sim) this.marks.removeLayer(this._sim);
      this._sim = null;
      return;
    }
    if (!this._sim) this._sim = L.marker(pos, { icon: divIcon('sim-dot', 22), keyboard: false, zIndexOffset: 1000 }).addTo(this.marks);
    else this._sim.setLatLng(pos);
  }

  // Leaflet's flyTo can leave canvas layers with a stale zoom transform, so these use the
  // standard animated zoom (fitBounds / setView), which the canvas renderers follow correctly.

  /** Fit bounds, keeping clear of the side panel (desktop) or the bottom sheet (phone). */
  fit(latlngs, maxZoom = 16) {
    if (!latlngs || !latlngs.length) return;
    const b = L.latLngBounds(latlngs);
    const opts = isPhone()
      ? { paddingTopLeft: [28, 110], paddingBottomRight: [28, Math.round(window.innerHeight * 0.48)] }
      : { paddingTopLeft: [470, 90], paddingBottomRight: [90, 100] };
    this.map.stop();
    this.map.fitBounds(b, { ...opts, maxZoom, animate: !reducedMotion() });
  }

  flyTo(lat, lng, zoom = 15) {
    const target = L.latLng(lat, lng);
    this.map.stop();
    if (!isPhone()) {
      const p = this.map.project(target, zoom).subtract([220, 0]); // keep it clear of the panel
      this.map.setView(this.map.unproject(p, zoom), zoom, { animate: !reducedMotion() });
    } else {
      this.map.setView(target, zoom, { animate: !reducedMotion() });
    }
  }

  /** Keep a moving point in view; one pan at a time (canvas layers redraw only at 'moveend'). */
  panIfNeeded(latlng) {
    if (this._panning) return;
    const size = this.map.getSize();
    const box = isPhone()
      ? { x0: 30, y0: 90, x1: size.x - 30, y1: size.y * 0.5 }
      : { x0: 470, y0: 100, x1: size.x - 70, y1: size.y - 90 };
    const p = this.map.latLngToContainerPoint(latlng);
    if (p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1) return;
    const offset = L.point(p.x - (box.x0 + box.x1) / 2, p.y - (box.y0 + box.y1) / 2);
    if (Math.abs(offset.x) < 2 && Math.abs(offset.y) < 2) return;
    this._panning = true;
    const done = () => { this._panning = false; };
    this.map.once('moveend', done);
    setTimeout(done, 1200);
    this.map.panBy(offset, { animate: !reducedMotion(), duration: 0.5 });
  }
}
