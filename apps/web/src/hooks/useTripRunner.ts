// Trip mode engine: plays a route (Simulate) or follows the device (watchPosition, only while navigating),
// moves the traveller on the map, keeps it in view, warns before high-risk blocks, and works out the
// turn-by-turn guidance (next turn, heading, distance and time to go). Used by Trip mode and survival mode.

import { useEffect, useRef, useState } from 'react';
import { useApp } from '../context';
import type { Band } from '../lib/clock';
import type { DangerAlerts, DangerNotice } from '../lib/danger';
import { reducedMotion } from '../lib/format';
import { bearing, cumulative, inSeattle, pointAt, project, type LatLng, type Pt } from '../lib/geo';
import type { Level, Mode } from '../lib/risk';
import type { RouteStep } from '../lib/routing';

export interface TripPlan {
  id: number;
  coords: Pt[];
  duration: number;
  distance: number;
  steps: RouteStep[];
  from: LatLng & { name: string };
  to: LatLng & { name: string; safe?: boolean };
  mode: Mode;
  band: Band;
  simulate: boolean;
  /** Survival guidance: keep the traveller centred and the camera close. */
  survival?: boolean;
  level?: Level;
  score?: number;
}

export interface TripLog extends DangerNotice { progress: number }

export interface TripProgress {
  d: number;
  f: number;
  pos: Pt;
  heading: number;
  arrived: boolean;
  /** Live only: more than 60 m from the route. */
  offRoute: boolean;
  nextStep: RouteStep | null;
  distToNext: number;
  remainingM: number;
  remainingS: number;
  area: string;
  level: Level;
  log: TripLog[];
  waiting: boolean;
}

const OFF_ROUTE_M = 60;

export function useTripRunner(plan: TripPlan | null, danger: DangerAlerts): TripProgress | null {
  const { ctrl, model, toast } = useApp();
  const [progress, setProgress] = useState<TripProgress | null>(null);
  const live = useRef({ ctrl, model, toast, danger });
  live.current = { ctrl, model, toast, danger };

  useEffect(() => {
    if (!plan) { setProgress(null); return; }
    const { ctrl: map, model: m, danger: alerts } = live.current;
    const coords = plan.coords;
    const acc = cumulative(coords);
    const total = acc[acc.length - 1] || 1;
    const log: TripLog[] = [];
    let lastCheck = 0;
    let lastPaint = 0;
    let lastFollow = 0;
    let arrived = false;
    let raf = 0;
    let watchId: number | null = null;
    let stopped = false;
    alerts.reset();

    const measure = (pos: Pt, d: number, offRoute: boolean, waiting = false): TripProgress => {
      const ahead = pointAt(coords, acc, Math.min(total, d + 25));
      const heading = d >= total - 1 ? bearing(coords[Math.max(0, coords.length - 2)], coords[coords.length - 1]) : bearing(pos, ahead);
      const nextStep = plan.steps.find((s) => s.at > d + 8 && s.type !== 'depart') ?? null;
      const cell = m.cellAt(pos[0], pos[1]);
      const area = (cell && m.hoodName(cell.nb)) || m.areaName(pos[0], pos[1]) || 'Seattle';
      const level = cell ? m.level(m.riskAt(cell, plan.band) * m.vulnerability(plan.mode)) : 'low';
      const f = Math.min(1, d / total);
      return {
        d, f, pos, heading, arrived, offRoute, nextStep,
        distToNext: nextStep ? Math.max(0, nextStep.at - d) : Math.max(0, total - d),
        remainingM: Math.max(0, total - d), remainingS: Math.max(0, plan.duration * (1 - f)),
        area, level, log: [...log], waiting,
      };
    };

    const check = (pos: Pt, d: number) => {
      const ahead = [60, 120].map((x) => pointAt(coords, acc, d + x));
      const hit = alerts.evaluate(pos[0], pos[1], plan.band, plan.mode, ahead);
      const cooldowns = plan.simulate ? { areaCooldown: Infinity, globalCooldown: 3500 } : { areaCooldown: 300000, globalCooldown: 30000 };
      const shown = alerts.maybeWarn(hit, plan.band, plan.mode, cooldowns);
      if (shown) log.push({ ...shown, progress: d / total });
    };

    const step = (pos: Pt, d: number, now: number, offRoute = false) => {
      const p = measure(pos, d, offRoute);
      map.setTraveler(pos, p.heading);
      if (plan.survival) {
        if (now - lastFollow > 1500) { lastFollow = now; map.follow(pos, undefined, 0.04); } // the sheet is small while walking
      } else if (!reducedMotion()) {
        map.panIfNeeded(pos);
      }
      // Survival guidance is about the hazard: no crime beeps on the way to safety.
      if (!plan.survival && now - lastCheck > 300) { lastCheck = now; check(pos, d); }
      if (now - lastPaint > 150 || arrived) { lastPaint = now; setProgress(measure(pos, d, offRoute)); }
    };

    const arrive = () => {
      if (arrived) return;
      arrived = true;
      cancelAnimationFrame(raf);
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      watchId = null;
      const end = coords[coords.length - 1];
      setProgress(measure(end, total, false));
      const n = log.length;
      if (!plan.survival) {
        live.current.toast(n ? `You arrived. Beacon warned you ${n} time${n > 1 ? 's' : ''} on the way.` : 'You arrived. No high-risk blocks on the way.', { duration: 6000 });
      }
    };

    if (plan.survival) map.flyTo(coords[0][0], coords[0][1], 16.2, 0.04);
    else map.fit(coords);
    map.setTraveler(coords[0], measure(coords[0], 0, false).heading);
    setProgress(measure(coords[0], 0, false, !plan.simulate));

    if (plan.simulate) {
      const seconds = Math.min(40, Math.max(14, plan.duration / 25));
      const t0 = performance.now() + 900; // let the camera settle first
      const frame = (now: number) => {
        if (stopped) return;
        const f = Math.max(0, Math.min(1, (now - t0) / (seconds * 1000)));
        const d = f * total;
        step(pointAt(coords, acc, d), d, now);
        if (f < 1) raf = requestAnimationFrame(frame);
        else arrive();
      };
      raf = requestAnimationFrame(frame);
    } else if (!('geolocation' in navigator)) {
      live.current.toast('This browser cannot share its location. Use Simulate to see the guidance.');
    } else {
      watchId = navigator.geolocation.watchPosition((p) => {
        if (stopped || arrived) return;
        const pos: Pt = [p.coords.latitude, p.coords.longitude];
        if (!plan.survival && !inSeattle(pos[0], pos[1])) {
          live.current.toast('You are outside Seattle, so live danger alerts are paused. Use Simulate to see them.', { duration: 7000 });
        }
        const { along, off } = project(coords, acc, pos);
        step(pos, along, performance.now(), off > OFF_ROUTE_M);
        if (total - along < 30 && off < OFF_ROUTE_M) arrive();
      }, (err) => {
        live.current.toast(err.code === 1
          ? 'Location access is off, so live guidance cannot follow you. Use Simulate, or allow location.'
          : 'Waiting for your location…');
      }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    }

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      map.setTraveler(null);
    };
  }, [plan]);

  return progress;
}
