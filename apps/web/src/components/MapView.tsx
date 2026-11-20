import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// maplibre-gl 6 loads its worker relative to its own module URL, which breaks under a bundler.
// Let Vite bundle the worker (with its shared chunk) and hand maplibre the URL.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { HeatmapData, RiskData } from '../api';

maplibregl.setWorkerUrl(workerUrl);

export type Layer = 'heatmap' | 'risk';

// OpenFreeMap: free vector tiles, no API key (the same style as the class app).
const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const SEATTLE: [number, number] = [-122.335, 47.615];

// Colors from the class app (CrimeRadar/src/main/webapp/assets/js/mapstyle.js).
export const LEVEL_COLOR = { low: '#0ca30c', elevated: '#ec835a', high: '#e5484d' } as const;
const HEAT_RAMP = [0.15, '#ffe39a', 0.35, '#ffb55c', 0.55, '#f9773f', 0.75, '#e03b3b', 1.0, '#9d174d'];

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

interface Props {
  layer: Layer;
  heatmap: HeatmapData | null;
  risk: RiskData | null;
  extrude: boolean;
  onMapReady?: (map: MlMap) => void;
}

function quantile(values: number[], q: number): number {
  if (!values.length) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] || 1;
}

export default function MapView({ layer, heatmap, risk, extrude, onMapReady }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);

  // Create the map once.
  useEffect(() => {
    if (!container.current) return;
    const map = new maplibregl.Map({
      container: container.current,
      style: STYLE_URL,
      center: SEATTLE,
      zoom: 11.3,
      minZoom: 9,
      maxZoom: 18,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

    map.on('load', () => {
      map.addSource('heat', { type: 'geojson', data: EMPTY });
      map.addSource('risk', { type: 'geojson', data: EMPTY });

      const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;

      map.addLayer({
        id: 'heat',
        type: 'heatmap',
        source: 'heat',
        paint: {
          'heatmap-weight': ['min', 1, ['/', ['get', 'weight'], ['coalesce', ['get', 'scale'], 1]]],
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 15, 2.2],
          // Points sit on a ~225 m grid, so the radius must cover the cell spacing at every zoom.
          'heatmap-radius': ['interpolate', ['exponential', 2], ['zoom'], 10, 10, 12, 18, 14, 48, 16, 150],
          'heatmap-opacity': 0.8,
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

      const popup = new maplibregl.Popup({ closeButton: false, offset: 6 });
      for (const id of ['risk-fill', 'risk-3d']) {
        map.on('click', id, (e) => {
          const f = e.features?.[0];
          if (!f) return;
          const p = f.properties as { risk: number; level: string; neighborhood: string | null; cellId: number };
          popup.setLngLat(e.lngLat).setHTML(
            `<strong>${p.neighborhood ?? 'Block'}</strong><br/>` +
            `Risk ${Number(p.risk).toFixed(2)} &middot; <span class="lvl lvl-${p.level}">${p.level}</span><br/>` +
            `<small>cell ${p.cellId}</small>`,
          ).addTo(map);
        });
        map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
      }
      setReady(true);
      onMapReady?.(map);
    });

    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Layer visibility and 3D.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const show = (id: string, on: boolean) => map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    show('heat', layer === 'heatmap');
    show('risk-fill', layer === 'risk' && !extrude);
    show('risk-3d', layer === 'risk' && extrude);
    map.easeTo({ pitch: layer === 'risk' && extrude ? 55 : 0, duration: 600 });
  }, [ready, layer, extrude]);

  return <div ref={container} className="map" role="region" aria-label="Map of Seattle" />;
}
