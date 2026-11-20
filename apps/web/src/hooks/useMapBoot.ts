// Start-up: fetch the basemap style and the crime map data, then create the map.

import { useEffect, useState, type RefObject } from 'react';
import type { StyleSpecification } from 'maplibre-gl';
import { api, type Landmark } from '../api';
import { isDarkBand, nowBand } from '../lib/clock';
import { fetchWithTimeout } from '../lib/format';
import { MapController, supportsWebGL } from '../lib/map/controller';
import { STYLE_URL } from '../lib/map/style';
import { RiskModel } from '../lib/risk';

export interface Booted { ctrl: MapController; model: RiskModel; live: boolean; landmarks: Landmark[] }

export function useMapBoot(container: RefObject<HTMLDivElement | null>) {
  const [booted, setBooted] = useState<Booted | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!container.current) return;
    if (!supportsWebGL()) {
      setError('This browser cannot draw the 3D map (WebGL is off). Try another browser.');
      return;
    }
    const abort = new AbortController();
    let ctrl: MapController | null = null;
    setError(null);
    (async () => {
      const styleReq = fetchWithTimeout(STYLE_URL, { signal: abort.signal }, 10000).then((r) => {
        if (!r.ok) throw new Error(`map style HTTP ${r.status}`);
        return r.json() as Promise<StyleSpecification>;
      });
      const [style, data, landmarks] = await Promise.all([styleReq, api.mapData(abort.signal), api.landmarks(abort.signal)]);
      if (abort.signal.aborted || !container.current) return;
      const model = new RiskModel(data.meta, data.grid, data.hoods);
      ctrl = new MapController(container.current, style, isDarkBand(nowBand()));
      if (import.meta.env.DEV) (window as unknown as { beacon: unknown }).beacon = { ctrl, model };
      const made = ctrl;
      // Keep the boot screen until the first map frame is ready (no black flash).
      // (At most 3.5 s: a slow tile server should not hold the whole app.)
      let done = false;
      const show = () => {
        if (done || abort.signal.aborted) return;
        done = true;
        setBooted({ ctrl: made, model, live: data.live, landmarks });
      };
      made.whenReady(show);
      window.setTimeout(show, 3500);
    })().catch((e) => {
      if (abort.signal.aborted) return;
      console.warn('Beacon could not start', e);
      setError('Could not load the map or the crime data. Check the connection, then try again.');
    });
    return () => {
      abort.abort();
      ctrl?.remove();
      setBooted(null);
    };
  }, [container, attempt]);

  return { booted, error, retry: () => setAttempt((n) => n + 1) };
}
