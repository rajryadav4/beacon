// Shared app services: the risk model, the map, the toast, the user's location and their saved data.

import { createContext, useContext } from 'react';
import type { Hazard, Landmark } from './api';
import type { LatLng } from './lib/geo';
import type { MapController } from './lib/map/controller';
import type { RiskModel } from './lib/risk';
import type { Prefs, SavedPlace, TripRecord } from './lib/storage';

export interface UserLocation extends LatLng {
  source: 'gps' | 'map' | 'demo';
  accuracyM?: number;
}

export interface ToastOpts { actionLabel?: string; onAction?: () => void; duration?: number }

export interface AppServices {
  model: RiskModel;
  ctrl: MapController;
  landmarks: Landmark[];
  live: boolean;
  hazards: Hazard[];
  toast: (message: string, opts?: ToastOpts) => void;
  location: UserLocation | null;
  setLocation: (loc: UserLocation | null) => void;
  /** Ask for the device location (only ever from a user action); resolves with it and sets it. */
  locate: () => Promise<UserLocation>;
  /** Pick mode: the next map tap calls `cb`. A banner explains it and can cancel. */
  startPick: (label: string, cb: (p: LatLng) => void) => void;
  /** 3D view: tilted camera, 3D buildings and terrain. */
  threeD: boolean;
  setThreeD: (on: boolean) => void;
  prefs: Prefs;
  setPrefs: (p: Prefs) => void;
  places: SavedPlace[];
  setPlaces: (list: SavedPlace[]) => void;
  trips: TripRecord[];
  addTrip: (t: TripRecord) => void;
}

export const AppContext = createContext<AppServices | null>(null);

export function useApp(): AppServices {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp outside AppContext');
  return ctx;
}

/** Ask the browser for the current position. Only ever called from a user action. */
export function requestGps(timeout = 12000): Promise<UserLocation> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('This browser cannot share its location. Long-press or right-click the map instead.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy, source: 'gps' }),
      (err) => reject(new Error(err.code === err.PERMISSION_DENIED
        ? 'Location access is off. Allow it in the browser settings, or tap the map to set your location.'
        : 'Could not get your location. Tap the map to set it instead.')),
      { enableHighAccuracy: true, timeout, maximumAge: 60000 },
    );
  });
}
