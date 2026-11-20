// The map's look: CrimeRadar's daylight and midnight palettes over the OpenFreeMap "positron" vector
// style (free, no API key), plus every data layer Beacon draws, inserted before the basemap labels.
// Ported from the class app (assets/js/mapview-gl.js and mapstyle.js), with Beacon's terrain,
// hillshade and 3D buildings added.

import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from 'maplibre-gl';
import { KIND_COLOR, OTHER_KIND_COLOR } from '../hazards';
import { SEVERITY_COLOR } from '../format';

export const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const TERRAIN_ATTRIBUTION = 'Terrain: Mapzen / AWS Terrain Tiles (Open Data on AWS)';
export const TERRAIN_SOURCE = 'terrain-dem';

export const PALETTE = {
  day: {
    land: '#eef1f6', landuse: '#e7eaf2', park: '#d9ead6', water: '#a9cdf2', waterText: '#36659a',
    building: '#dde2eb', building3d: '#d3d9e6',
    minor: '#ffffff', major: '#ffffff', casing: '#d0d6e2', motorway: '#ffe0b3', motorwayCasing: '#efbd83',
    rail: '#c4cbd8', boundary: '#b2bacb', text: '#44506c', halo: '#ffffff',
    sky: '#b9d3f3', horizon: '#eef1f6', shadow: '#5b6680', highlight: '#ffffff',
  },
  night: {
    land: '#0b0e1d', landuse: '#0e1226', park: '#0c1a1e', water: '#050a18', waterText: '#5b78b2',
    building: '#151a33', building3d: '#202650',
    minor: '#191f3d', major: '#262f63', casing: '#0f1329', motorway: '#4c3fa8', motorwayCasing: '#1a1745',
    rail: '#222a4b', boundary: '#2d345f', text: '#a6aed6', halo: '#0b0e1d',
    sky: '#05060f', horizon: '#1c2150', shadow: '#000000', highlight: '#2b3170',
  },
};
export type Palette = typeof PALETTE.day;

// Sequential "fire" ramps: light map light -> dark, dark map dark -> light (more = brighter).
export const HEAT_LIGHT: Record<string, string> = { 0.15: '#ffe39a', 0.35: '#ffb55c', 0.55: '#f9773f', 0.75: '#e03b3b', '1.0': '#9d174d' };
export const HEAT_DARK: Record<string, string> = { 0.15: '#5b1a5e', 0.35: '#a3245f', 0.55: '#e4453e', 0.75: '#ff8c3a', '1.0': '#ffe17d' };
export const LEVEL_COLOR = { low: '#0ca30c', elevated: '#ec835a', high: '#e5484d' } as const;
/** Route colors compare the options: best = recommended, mid = moderate, worst = most dangerous. */
export const ROLE_COLOR = { best: '#16a34a', mid: '#f59f00', worst: '#e03131' } as const;
export const ROLE_LABEL = { best: 'Recommended', mid: 'Moderate risk', worst: 'Most dangerous' } as const;
export const ROLE_ORDER = { worst: 0, mid: 1, best: 2 } as const;
export type Role = keyof typeof ROLE_COLOR;
/** Hazard exposure (worst to safest), relative 0-100. */
export const EXPOSURE_RAMP: [number, string][] = [[0, '#22c55e'], [20, '#eab308'], [50, '#f97316'], [80, '#dc2626']];

type Paint = Record<string, unknown>;

/** Paint changes for one basemap layer of the positron style, or null to leave it. */
export function paintFor(layer: { id: string; type: string }, p: Palette): Paint | null {
  const { id, type: t } = layer;
  if (id.startsWith('cr-') || id.startsWith('bc-') || id === 'hillshade') return null;
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

function hexToRgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** MapLibre heatmap-color expression from a ramp; fades in from the first color. */
export function heatColor(ramp: Record<string, string>): ExpressionSpecification {
  const entries = Object.entries(ramp).map(([k, c]) => [Number(k), c] as const).sort((a, b) => a[0] - b[0]);
  const expr: unknown[] = ['interpolate', ['linear'], ['heatmap-density'], 0, hexToRgba(entries[0][1], 0), 0.05, hexToRgba(entries[0][1], 0)];
  for (const [k, c] of entries) expr.push(k, c);
  return expr as ExpressionSpecification;
}

export const BUILDING_OPACITY: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 13.5, 0, 14.6, 0.82];
export const BUILDING_OPACITY_DIM: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 13.5, 0, 14.6, 0.4];

export function skyFor(p: Palette, dark: boolean) {
  return {
    'sky-color': p.sky, 'horizon-color': p.horizon, 'fog-color': p.land,
    'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.8, 'atmosphere-blend': dark ? 0.25 : 0.6,
  };
}

const EMPTY = { type: 'FeatureCollection', features: [] } as const;
const geo = () => ({ type: 'geojson' as const, data: EMPTY as unknown as GeoJSON.FeatureCollection });
const match = (prop: string, colors: Record<string, string>, fallback: string) =>
  ['match', ['get', prop], ...Object.entries(colors).flat(), fallback] as unknown as ExpressionSpecification;

/** Recolor the basemap, add terrain sources, 3D buildings and every data layer before the labels. */
export function prepareStyle(styleJson: StyleSpecification, dark: boolean): StyleSpecification {
  const style = JSON.parse(JSON.stringify(styleJson)) as StyleSpecification;
  const p = dark ? PALETTE.night : PALETTE.day;
  style.transition = { duration: 900, delay: 0 };
  // US highway shields need data the basemap does not have (MapLibre warns about their filters).
  style.layers = style.layers.filter((l) => !l.id.includes('shield'));
  for (const layer of style.layers) {
    const paint = paintFor(layer, p);
    if (paint) (layer as { paint?: Paint }).paint = { ...((layer as { paint?: Paint }).paint ?? {}), ...paint };
  }
  const vector = Object.entries(style.sources).find(([, s]) => s.type === 'vector')?.[0] ?? 'openmaptiles';
  const dem = { type: 'raster-dem' as const, tiles: [TERRAIN_TILES], encoding: 'terrarium' as const, tileSize: 256, maxzoom: 15 };
  Object.assign(style.sources, {
    [TERRAIN_SOURCE]: { ...dem, attribution: TERRAIN_ATTRIBUTION },
    'hillshade-dem': dem,
    'cr-cells': geo(), 'cr-grid': geo(), 'cr-routes': geo(), 'cr-hood': geo(),
    'bc-hazard-grid': geo(), 'bc-hazard-zones': geo(), 'bc-alerts': geo(), 'bc-danger': geo(), 'bc-places': geo(),
  });
  style.sky = skyFor(p, dark);

  const sev = match('severity', SEVERITY_COLOR, SEVERITY_COLOR.Unknown);
  const exposure = ['interpolate', ['linear'], ['get', 'score'], ...EXPOSURE_RAMP.flat()] as unknown as ExpressionSpecification;
  const zoneColor = match('level', { high: '#dc2626', moderate: '#f97316', low: '#eab308' }, '#f97316');
  const ours: LayerSpecification[] = [
    { id: 'bc-hazard-grid', type: 'fill', source: 'bc-hazard-grid', paint: { 'fill-color': exposure, 'fill-opacity': 0.42, 'fill-outline-color': 'rgba(0,0,0,0)' } },
    { id: 'bc-hazard-zones-fill', type: 'fill', source: 'bc-hazard-zones', paint: { 'fill-color': zoneColor, 'fill-opacity': 0.22 } },
    { id: 'bc-hazard-zones-line', type: 'line', source: 'bc-hazard-zones', paint: { 'line-color': zoneColor, 'line-width': 1.6, 'line-opacity': 0.8 } },
    {
      id: 'cr-buildings-3d', type: 'fill-extrusion', source: vector, 'source-layer': 'building', minzoom: 13.5,
      layout: { visibility: 'none' }, filter: ['!=', ['get', 'hide_3d'], true],
      paint: {
        'fill-extrusion-color': p.building3d,
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13.5, 0, 14.6, ['coalesce', ['get', 'render_height'], 8]],
        'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 13.5, 0, 14.6, ['coalesce', ['get', 'render_min_height'], 0]],
        'fill-extrusion-opacity': BUILDING_OPACITY,
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
        // Cells are ~225 m apart; a radius of ~2.4x the spacing blends them into one smooth glowing surface.
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 12, 0.85, 16, 0.95],
        'heatmap-radius': ['interpolate', ['exponential', 2], ['zoom'], 10, 7, 12, 21, 13, 42, 16, 330],
        'heatmap-color': heatColor(dark ? HEAT_DARK : HEAT_LIGHT),
        'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.9, 17, 0.62],
      },
    },
    // The highlighted neighborhood (Areas ranked) sits above the heat so it reads on any palette.
    { id: 'cr-hood', type: 'fill', source: 'cr-hood', paint: { 'fill-color': '#67e8f9', 'fill-opacity': 0.26, 'fill-outline-color': 'rgba(103,232,249,0)' } },
    { id: 'bc-alerts-fill', type: 'fill', source: 'bc-alerts', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': sev, 'fill-opacity': 0.16 } },
    { id: 'bc-alerts-line', type: 'line', source: 'bc-alerts', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': sev, 'line-width': 2, 'line-dasharray': [2, 1.5] } },
    { id: 'bc-danger-fill', type: 'fill', source: 'bc-danger', paint: { 'fill-color': '#ef4444', 'fill-opacity': 0.2 } },
    { id: 'bc-danger-line', type: 'line', source: 'bc-danger', paint: { 'line-color': '#ef4444', 'line-width': 2.5, 'line-dasharray': [2, 1.2] } },
    { id: 'cr-routes-hit', type: 'line', source: 'cr-routes', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#000000', 'line-opacity': 0, 'line-width': 22 } },
    {
      id: 'cr-routes-glow', type: 'line', source: 'cr-routes', filter: ['==', ['get', 'sel'], 1], layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': ['+', ['get', 'w'], 16], 'line-blur': 12, 'line-opacity': 0.55 },
    },
    {
      id: 'cr-routes-casing', type: 'line', source: 'cr-routes', layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'sort'] },
      paint: { 'line-color': '#ffffff', 'line-width': ['+', ['get', 'w'], 5], 'line-opacity': 0.95 },
    },
    {
      id: 'cr-routes-line', type: 'line', source: 'cr-routes', layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'sort'] },
      paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'w'], 'line-opacity': ['case', ['==', ['get', 'sel'], 1], 1, 0.9] },
    },
    {
      id: 'cr-routes-flow', type: 'line', source: 'cr-routes', filter: ['==', ['get', 'sel'], 1], layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 3, 'line-opacity': 0.9, 'line-dasharray': [0, 4, 3] },
    },
  ];
  const firstSymbol = style.layers.findIndex((l) => l.type === 'symbol');
  style.layers.splice(firstSymbol < 0 ? style.layers.length : firstSymbol, 0, ...ours);
  const hillAt = style.layers.findIndex((l) => l.id === 'waterway');
  style.layers.splice(hillAt < 0 ? 1 : hillAt, 0, {
    id: 'hillshade', type: 'hillshade', source: 'hillshade-dem',
    paint: { 'hillshade-exaggeration': 0.2, 'hillshade-shadow-color': p.shadow, 'hillshade-highlight-color': p.highlight, 'hillshade-accent-color': p.shadow },
  });
  // Safe places on top of everything, with names when zoomed in.
  style.layers.push(
    {
      id: 'bc-places', type: 'circle', source: 'bc-places',
      paint: {
        'circle-color': match('kind', KIND_COLOR, OTHER_KIND_COLOR),
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 4.5, 16, 8],
        'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5,
      },
    },
    {
      id: 'bc-places-label', type: 'symbol', source: 'bc-places', minzoom: 14.5,
      layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': p.text, 'text-halo-color': p.halo, 'text-halo-width': 1.4 },
    },
  );
  return style;
}
