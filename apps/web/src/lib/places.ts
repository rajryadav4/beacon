// Place search: Photon (built for typing) biased to Seattle, Nominatim if Photon fails.
// Both are free OpenStreetMap services with no API key; requests carry only the typed text.

import { SEATTLE_BOX, inSeattle } from './geo';
import { fetchWithTimeout } from './format';

export type PlaceKind = 'home' | 'work' | 'saved' | 'recent' | 'landmark' | 'search' | 'gps' | 'pin' | 'safe' | 'demo';

export interface Place {
  name: string;
  detail?: string;
  lat: number;
  lng: number;
  kind: PlaceKind;
  /** Set when the place is a Beacon safe place (for the survival / safety badge). */
  safeKind?: string;
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: Record<string, string | undefined>;
}

function fromPhoton(f: PhotonFeature): Place {
  const p = f.properties ?? {};
  const [lng, lat] = f.geometry.coordinates;
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const name = p.name || street || p.district || p.city || 'Unnamed place';
  const detail = [p.name && street ? street : null, p.district || p.locality, p.city].filter(Boolean).join(', ');
  return { name, detail, lat, lng, kind: 'search' };
}

async function nominatim(q: string, signal?: AbortSignal): Promise<Place[]> {
  const b = SEATTLE_BOX;
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&bounded=1&viewbox=${b.w},${b.n},${b.e},${b.s}&q=${encodeURIComponent(q)}`;
  const r = await fetchWithTimeout(url, { signal, headers: { 'Accept-Language': 'en' } }, 8000);
  if (!r.ok) throw new Error('Place search is not available right now.');
  const j = (await r.json()) as { name?: string; display_name?: string; lat: string; lon: string }[];
  return j.map((x) => {
    const parts = String(x.display_name ?? '').split(',').map((s) => s.trim());
    return { name: x.name || parts[0], detail: parts.slice(1, 3).join(', '), lat: Number(x.lat), lng: Number(x.lon), kind: 'search' as const };
  });
}

/** Search places inside Seattle. */
export async function searchPlaces(q: string, signal?: AbortSignal): Promise<Place[]> {
  const b = SEATTLE_BOX;
  try {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=7&lang=en&lat=47.6145&lon=-122.334&bbox=${b.w},${b.s},${b.e},${b.n}`;
    const r = await fetchWithTimeout(url, { signal }, 6000);
    if (!r.ok) throw new Error(`Photon HTTP ${r.status}`);
    const j = (await r.json()) as { features?: PhotonFeature[] };
    return (j.features ?? []).map(fromPhoton).filter((p) => inSeattle(p.lat, p.lng));
  } catch (e) {
    if (signal?.aborted) throw e;
    return nominatim(q, signal);
  }
}
