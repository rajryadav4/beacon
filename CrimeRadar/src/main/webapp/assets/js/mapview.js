// Map engine choice.
//   GLMapView (mapview-gl.js): MapLibre GL + OpenFreeMap vector map. Needs WebGL and the style service.
//   LeafletMapView (mapview-leaflet.js): raster fallback with the same interface.
// Add ?map=leaflet to the URL to force the fallback (for testing).

import { fetchWithTimeout } from './ui.js';
import { LeafletMapView } from './mapview-leaflet.js';

export { HEAT_LIGHT, HEAT_DARK, LEVEL_COLOR, ROLE_COLOR, ROLE_LABEL } from './mapstyle.js';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

function hasWebGL() {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

export async function createMapView(elementId) {
  const forced = new URLSearchParams(location.search).get('map');
  if (forced !== 'leaflet' && window.maplibregl && hasWebGL()) {
    try {
      const r = await fetchWithTimeout(STYLE_URL, {}, 6000);
      if (r.ok) {
        const style = await r.json();
        const { GLMapView } = await import('./mapview-gl.js');
        return new GLMapView(elementId, style);
      }
    } catch (e) {
      console.warn('Vector map not available, using the raster map.', e);
    }
  }
  return new LeafletMapView(elementId);
}
