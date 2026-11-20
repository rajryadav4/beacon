// Scores the route options at the time of travel and applies the recommendation rules
// (class app: directions.js rescore + applyDecision). Pure functions, no DOM.

import { bandOfHour, clockLabel, isoSeattle, seattleClock, type Band } from './clock';
import { ROLE_LABEL, type Role } from './map/style';
import { preferenceFromWeight, recommend } from './recommend';
import type { Mode, RiskModel, RouteScore } from './risk';
import type { RawRoute } from './routing';

export interface Departure { now: boolean; hour: number; minute: number; band: Band; iso: string }

export interface ScoredRoute extends RawRoute {
  id: string;
  score: RouteScore;
  exposure: number | null;
  withinLimit: boolean;
  role: Role;
  tags: string[];
  choice: 'safest' | 'fastest' | 'balanced';
}

/** "Leave now" or "Leave at HH:MM" (a time already past means tomorrow). */
export function departure(when: { now: boolean; time: string }): Departure {
  const c = seattleClock();
  if (!when.now && /^\d{2}:\d{2}$/.test(when.time)) {
    const [hour, minute] = when.time.split(':').map(Number);
    const tomorrow = hour * 60 + minute < c.hour * 60 + c.minute;
    return { now: false, hour, minute, band: bandOfHour(hour), iso: isoSeattle(hour, minute, tomorrow ? 1 : 0) };
  }
  return { now: true, hour: c.hour, minute: c.minute, band: bandOfHour(c.hour), iso: isoSeattle(c.hour, c.minute, 0) };
}

export function arrival(d: Departure, seconds: number): string {
  const total = (d.hour * 60 + d.minute + Math.round(seconds / 60)) % (24 * 60);
  return clockLabel(Math.floor(total / 60), total % 60);
}

/** The next quarter hour, for the "Leave at" input. */
export function nextQuarter(): string {
  const now = seattleClock();
  const q = (now.hour * 60 + now.minute + 15 - ((now.minute + 15) % 15)) % (24 * 60);
  return `${String(Math.floor(q / 60)).padStart(2, '0')}:${String(q % 60).padStart(2, '0')}`;
}

/** Scores every route, picks the recommended one, sets the map roles and tags. Recommended first. */
export function scoreRoutes(raw: RawRoute[], model: RiskModel, mode: Mode, d: Departure, safetyWeight: number) {
  const scored = raw.map((r, i) => {
    const exp = model.routeExposure(r.coords, r.duration, d.hour, d.minute);
    return { ...r, id: `R${i + 1}`, score: model.scoreRoute(r.coords, mode, d.band), exposure: exp.exposure };
  });
  const decision = recommend(scored, mode, preferenceFromWeight(safetyWeight));
  const byId = new Map(decision.routes.map((r) => [r.id, r]));
  const list: ScoredRoute[] = scored.map((s) => {
    const r = byId.get(s.id);
    return { ...s, exposure: r?.exposure ?? null, withinLimit: r?.withinLimit !== false, role: 'mid', tags: [], choice: 'balanced' };
  });
  const quickest = (a: ScoredRoute, b: ScoredRoute) => (b.duration < a.duration ? b : a);
  const best = list.find((s) => s.id === decision.recommendedId) ?? list.reduce(quickest);
  const fastest = list.reduce(quickest);
  const known = list.filter((s) => s.exposure !== null);
  const safest = known.length
    ? known.reduce((a, b) => ((b.exposure as number) < (a.exposure as number) || (b.exposure === a.exposure && b.duration < a.duration) ? b : a))
    : null;
  // Of the others, the one with most exposure is red (most dangerous), the rest orange.
  const others = list.filter((s) => s !== best).sort((a, b) => a.duration - b.duration);
  best.role = 'best';
  const risk = (s: ScoredRoute) => (s.exposure !== null ? s.exposure : s.score.adjusted);
  if (others.length === 1) {
    others[0].role = risk(others[0]) > risk(best) ? 'worst' : 'mid';
  } else if (others.length >= 2) {
    const byRisk = [...others].sort((a, b) => risk(b) - risk(a));
    byRisk[0].role = 'worst';
    for (const s of byRisk.slice(1)) s.role = 'mid';
  }
  const routes = [best, ...others];
  for (const s of routes) s.tags.push(ROLE_LABEL[s.role]);
  if (routes.length > 1) {
    fastest.tags.push('Fastest');
    if (safest) safest.tags.push('Least crime exposure');
    for (const s of routes) if (!s.withinLimit) s.tags.push('Over your time limit');
  }
  for (const s of routes) s.choice = s === safest ? 'safest' : s === fastest ? 'fastest' : 'balanced';
  return { routes, explanation: decision.explanation };
}
