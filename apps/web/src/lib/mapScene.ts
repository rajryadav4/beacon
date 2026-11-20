// 3D scene for the MapLibre map: terrain, hillshade, 3D buildings, sky, light, and a softer
// light / dark palette over the OpenFreeMap positron style (OpenMapTiles schema).

import type { ExpressionSpecification, LayerSpecification, Map as MlMap } from 'maplibre-gl';

export type MapTheme = 'light' | 'dark';
export type ViewMode = '2d' | '3d';

const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const TERRAIN_ATTRIBUTION = 'Terrain: Mapzen / AWS Terrain Tiles (Open Data on AWS)';
export const TERRAIN_SOURCE = 'terrain-dem';
const HILLSHADE_SOURCE = 'hillshade-dem';
export const BUILDINGS_LAYER = '3d-buildings';

/** WebGL2 is needed for terrain and smooth extrusions; without it Beacon stays 2D. */
export function supportsWebGL2(): boolean {
  try {
    return Boolean(document.createElement('canvas').getContext('webgl2'));
  } catch {
    return false;
  }
}

export const isNarrowScreen = () => window.matchMedia('(max-width: 640px)').matches;

export function terrainExaggeration(lowPower: boolean) {
  return lowPower ? 1.0 : 1.3;
}

// ---- Palette ----
// [light, dark]. A light value of null restores the style's original colour.
type Pair = [string | null, string];

interface Rule { test: (id: string) => boolean; colors: Partial<Record<string, Pair>> }

const fillOrLine = (pair: Pair) => ({ 'fill-color': pair, 'line-color': pair, 'background-color': pair });

const RULES: Rule[] = [
  { test: (id) => id === 'background', colors: fillOrLine(['#f6f3ee', '#1b2029']) },
  { test: (id) => id === 'park', colors: fillOrLine(['#dcebd4', '#1f2e27']) },
  { test: (id) => id === 'landcover_wood', colors: fillOrLine(['#d2e5c9', '#1f2d26']) },
  { test: (id) => id.startsWith('landcover_'), colors: fillOrLine(['#fbfaf7', '#232a35']) },
  { test: (id) => id === 'landuse_residential', colors: fillOrLine(['#f0ece5', '#1f242e']) },
  { test: (id) => id === 'water' || id === 'waterway', colors: fillOrLine(['#a5d2f3', '#12304c']) },
  { test: (id) => id === 'building', colors: { 'fill-color': ['#e7e2da', '#2a303b'], 'fill-outline-color': ['#dbd5cc', '#333a47'] } },
  { test: (id) => id.includes('casing'), colors: fillOrLine(['#e3ddd3', '#262c37']) },
  { test: (id) => id.startsWith('highway_motorway') && id.endsWith('inner'), colors: fillOrLine(['#fdf1c9', '#5b5440']) },
  { test: (id) => id.endsWith('_inner') || id === 'highway_minor', colors: fillOrLine(['#ffffff', '#3d4553']) },
  { test: (id) => id === 'highway_path', colors: fillOrLine(['#f1ece4', '#2e3440']) },
  { test: (id) => id.endsWith('_subtle'), colors: fillOrLine([null, '#333a47']) },
  { test: (id) => id.startsWith('railway') && id.endsWith('dashline'), colors: fillOrLine(['#f8f6f2', '#2a303a']) },
  { test: (id) => id.startsWith('railway'), colors: fillOrLine(['#d8d2c8', '#3b414d']) },
  { test: (id) => id.startsWith('road_') && id.includes('pier'), colors: fillOrLine(['#f6f3ee', '#1b2029']) },
  { test: (id) => id.startsWith('aeroway'), colors: fillOrLine(['#ece8e1', '#2a303b']) },
  { test: (id) => id.startsWith('boundary'), colors: fillOrLine([null, '#566070']) },
  { test: (id) => id.startsWith('water') && id.includes('label'), colors: { 'text-color': ['#3b6ea8', '#7fb3e3'], 'text-halo-color': [null, '#12304c'] } },
  { test: (id) => id.startsWith('highway-name'), colors: { 'text-color': [null, '#9aa4b2'], 'text-halo-color': [null, '#1b2029'] } },
  { test: (id) => id.startsWith('label_') || id === 'airport', colors: { 'text-color': [null, '#dde3ec'], 'text-halo-color': [null, '#1b2029'] } },
];

const PROPS_BY_TYPE: Record<string, string[]> = {
  background: ['background-color'],
  fill: ['fill-color', 'fill-outline-color'],
  line: ['line-color'],
  symbol: ['text-color', 'text-halo-color'],
};

type PaintProp = Parameters<MlMap['getPaintProperty']>[1];
type PaintValue = Parameters<MlMap['setPaintProperty']>[2];

interface Override { layer: string; prop: string; original: unknown; light: string | null; dark: string }

/** Work out once which base-style paint properties get recoloured. */
function collectOverrides(map: MlMap, baseLayers: LayerSpecification[]): Override[] {
  const out: Override[] = [];
  for (const layer of baseLayers) {
    const rule = RULES.find((r) => r.test(layer.id));
    if (!rule) continue;
    for (const prop of PROPS_BY_TYPE[layer.type] ?? []) {
      const pair = rule.colors[prop];
      if (!pair) continue;
      out.push({ layer: layer.id, prop, original: map.getPaintProperty(layer.id, prop as PaintProp), light: pair[0], dark: pair[1] });
    }
  }
  return out;
}

const BUILDING_COLOR: Record<MapTheme, ExpressionSpecification> = {
  // Soft neutral, with a slight cool tint on tall buildings.
  light: ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 0], 0, '#ebe6df', 40, '#e1ddd8', 150, '#d3d9e3'],
  dark: ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 0], 0, '#394151', 40, '#454f61', 150, '#56668a'],
};

const SKY = {
  light: { 'sky-color': '#a9cdee', 'horizon-color': '#e8eff5', 'fog-color': '#f3f0ea', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.75, 'atmosphere-blend': 0.6 },
  dark: { 'sky-color': '#0b1220', 'horizon-color': '#26344a', 'fog-color': '#1b2029', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.75, 'atmosphere-blend': 0.3 },
} as const;

const LIGHT = {
  light: { anchor: 'viewport', position: [1.4, 200, 35], color: '#ffffff', intensity: 0.32 },
  dark: { anchor: 'viewport', position: [1.4, 200, 35], color: '#cfd8ff', intensity: 0.22 },
} as const;

export interface Scene {
  applyTheme: (theme: MapTheme) => void;
  setMode: (mode: ViewMode, opts: { buildingsHidden: boolean }) => void;
  setLowPower: (low: boolean) => void;
  /** Make buildings see-through so a walking route behind them stays readable. */
  dimBuildings: (dim: boolean) => void;
  terrainFailed: () => boolean;
}

const BUILDING_OPACITY: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 13.5, 0, 14.6, 0.9];
const BUILDING_OPACITY_DIM: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 13.5, 0, 14.6, 0.45];

/**
 * Add terrain, hillshade and 3D buildings to a loaded positron map.
 * `beforeLabels` is the first symbol layer of the base style (buildings go under the labels).
 */
export function setupScene(map: MlMap, opts: { lowPower: boolean; beforeLabels?: string; onTerrainError: () => void }): Scene {
  const style = map.getStyle();
  const baseLayers = style.layers.slice();
  const vectorSource = Object.entries(style.sources).find(([, s]) => s.type === 'vector')?.[0];
  const overrides = collectOverrides(map, baseLayers);
  let lowPower = opts.lowPower;
  let mode: ViewMode = '2d';
  let failed = false;
  let errors = 0;

  const dem = { type: 'raster-dem' as const, tiles: [TERRAIN_TILES], encoding: 'terrarium' as const, tileSize: 256, maxzoom: 15 };
  map.addSource(TERRAIN_SOURCE, { ...dem, attribution: TERRAIN_ATTRIBUTION });
  map.addSource(HILLSHADE_SOURCE, dem);

  // Subtle hillshade over land, under roads, buildings and labels.
  const hillshadeBefore = baseLayers.find((l) => l.id === 'waterway')?.id ?? opts.beforeLabels;
  map.addLayer({
    id: 'hillshade', type: 'hillshade', source: HILLSHADE_SOURCE,
    paint: { 'hillshade-exaggeration': 0.22, 'hillshade-shadow-color': '#6f6656', 'hillshade-highlight-color': '#ffffff', 'hillshade-accent-color': '#8a8170' },
  }, hillshadeBefore);

  if (vectorSource) {
    const height: ExpressionSpecification = ['coalesce', ['get', 'render_height'], 0];
    const base: ExpressionSpecification = ['coalesce', ['get', 'render_min_height'], 0];
    map.addLayer({
      id: BUILDINGS_LAYER, type: 'fill-extrusion', source: vectorSource, 'source-layer': 'building',
      minzoom: 13.5,
      filter: ['!=', ['get', 'hide_3d'], true],
      paint: {
        'fill-extrusion-color': BUILDING_COLOR.light,
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13.5, 0, 14.6, height],
        'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 13.5, 0, 14.6, base],
        'fill-extrusion-opacity': BUILDING_OPACITY,
      },
    }, opts.beforeLabels);
  }

  map.on('error', (e) => {
    const sourceId = (e as { sourceId?: string }).sourceId;
    if (failed || sourceId !== TERRAIN_SOURCE) return;
    if (++errors >= 4) {
      failed = true;
      map.setTerrain(null);
      opts.onTerrainError();
    }
  });

  const applyPower = () => {
    if (!map.getLayer(BUILDINGS_LAYER)) return;
    map.setLayerZoomRange(BUILDINGS_LAYER, lowPower ? 14.8 : 13.5, 24);
    map.setLayoutProperty('hillshade', 'visibility', lowPower ? 'none' : 'visible');
    if (mode === '3d' && !failed) map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: terrainExaggeration(lowPower) });
  };
  applyPower();

  return {
    applyTheme(theme) {
      for (const o of overrides) {
        const value = theme === 'dark' ? o.dark : o.light ?? o.original;
        if (value !== undefined) map.setPaintProperty(o.layer, o.prop as PaintProp, value as PaintValue);
      }
      if (map.getLayer(BUILDINGS_LAYER)) map.setPaintProperty(BUILDINGS_LAYER, 'fill-extrusion-color', BUILDING_COLOR[theme]);
      map.setPaintProperty('hillshade', 'hillshade-shadow-color', theme === 'dark' ? '#05070b' : '#6f6656');
      map.setPaintProperty('hillshade', 'hillshade-highlight-color', theme === 'dark' ? '#3a4558' : '#ffffff');
      map.setSky({ ...SKY[theme] });
      map.setLight({ ...LIGHT[theme], position: [...LIGHT[theme].position] });
    },
    setMode(next, { buildingsHidden }) {
      mode = next;
      const threeD = next === '3d';
      if (threeD && !failed) map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: terrainExaggeration(lowPower) });
      else map.setTerrain(null);
      if (map.getLayer(BUILDINGS_LAYER)) {
        map.setLayoutProperty(BUILDINGS_LAYER, 'visibility', threeD && !buildingsHidden ? 'visible' : 'none');
      }
    },
    setLowPower(low) {
      if (low === lowPower) return;
      lowPower = low;
      applyPower();
    },
    dimBuildings(dim) {
      if (map.getLayer(BUILDINGS_LAYER)) map.setPaintProperty(BUILDINGS_LAYER, 'fill-extrusion-opacity', dim ? BUILDING_OPACITY_DIM : BUILDING_OPACITY);
    },
    terrainFailed: () => failed,
  };
}
