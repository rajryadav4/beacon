// Background danger alerts when no trip runs: only if the user kept alerts on AND already allowed location
// (Beacon never asks for location by itself). Ported from the class app's PassiveWatcher.

import { useEffect } from 'react';
import { nowBand } from '../lib/clock';
import type { DangerAlerts } from '../lib/danger';
import { inSeattle } from '../lib/geo';
import type { Mode } from '../lib/risk';

export function usePassiveAlerts(danger: DangerAlerts | null, enabled: boolean, mode: Mode) {
  useEffect(() => {
    if (!danger || !enabled || !('geolocation' in navigator) || !navigator.permissions) return;
    let watchId: number | null = null;
    let stopped = false;
    const timer = window.setTimeout(() => {
      navigator.permissions.query({ name: 'geolocation' }).then((s) => {
        if (stopped || s.state !== 'granted') return;
        watchId = navigator.geolocation.watchPosition((p) => {
          const { latitude: lat, longitude: lng } = p.coords;
          if (!inSeattle(lat, lng)) return;
          const band = nowBand();
          danger.maybeWarn(danger.evaluate(lat, lng, band, mode), band, mode, { areaCooldown: 900000, globalCooldown: 120000 });
        }, () => { /* background alerts are optional */ }, { enableHighAccuracy: false, maximumAge: 30000, timeout: 30000 });
      }).catch(() => { /* permissions API unavailable */ });
    }, 5000); // let the person look around before any alert
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
    };
  }, [danger, enabled, mode]);
}
