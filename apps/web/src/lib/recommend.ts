// Route decision rules: which route to recommend and why.
// Ported from the class app (assets/js/recommend.js), which mirrors the Java RecommendationService and is
// checked against tests/route-rules-cases.json. Keep the two in step (docs/API.md section 5).

import type { Mode } from './risk';

export type Preference = 'fastest' | 'balanced' | 'safer';

/** Detour limits per preset: [max fraction of the fastest time, max extra seconds]; gain = min. exposure drop. */
export const PRESETS: Record<Preference, Record<Mode, [number, number]> & { gain: number }> = {
  fastest: { walk: [0, 0], bike: [0, 0], car: [0, 0], gain: 0.15 },
  balanced: { walk: [0.25, 300], bike: [0.20, 360], car: [0.20, 480], gain: 0.15 },
  safer: { walk: [0.50, 600], bike: [0.40, 720], car: [0.40, 900], gain: 0.10 },
};

const MODE_LABEL: Record<Mode, string> = { walk: 'walking', bike: 'cycling', car: 'driving' };

/** Safety weight (0..1) to a preset. */
export function preferenceFromWeight(weight: number): Preference {
  const w = Number.isFinite(weight) ? Math.min(1, Math.max(0, weight)) : 0.7;
  return w < 0.34 ? 'fastest' : w < 0.67 ? 'balanced' : 'safer';
}

export interface RouteInput { id: string; duration: number; distance: number; exposure: number | null }
interface ValidRoute extends RouteInput { exposure: number | null }
export interface Decision {
  recommendedId: string | null;
  fastestId: string | null;
  lowestExposureId: string | null;
  preference: Preference;
  maximumAllowedSeconds: number | null;
  explanation: string;
  routes: { id: string; exposure: number | null; withinLimit: boolean; vsFastestPercent: number | null }[];
}

const validScore = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function minutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m < 1 ? 'under 1 min' : `${m} min`;
}

const improvement = (fastest: ValidRoute, route: ValidRoute) =>
  (fastest.exposure === 0 || fastest.exposure === null || route.exposure === null ? 0 : (fastest.exposure - route.exposure) / fastest.exposure);

export function recommend(routes: RouteInput[], mode: Mode, preference: Preference = 'balanced'): Decision {
  const preset = PRESETS[preference] ?? PRESETS.balanced;
  const [fraction, maxExtra] = preset[mode] ?? preset.walk;
  const valid: ValidRoute[] = routes
    .filter((r) => r && r.id && r.duration > 0 && r.distance > 0)
    .map((r) => ({ ...r, exposure: validScore(r.exposure) ? r.exposure : null }))
    .sort((a, b) => a.duration - b.duration || a.distance - b.distance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!valid.length) {
    return {
      recommendedId: null, fastestId: null, lowestExposureId: null, preference, maximumAllowedSeconds: null,
      explanation: 'No valid routes available for the selected travel mode.', routes: [],
    };
  }
  const fastest = valid[0];
  const budget = Math.min(fastest.duration * fraction, maxExtra);
  const maxSeconds = fastest.duration + budget;
  const eligible = valid.filter((r) => r.duration <= maxSeconds);
  const lowestOf = (list: ValidRoute[]) => list.reduce<ValidRoute | null>(
    (low, r) => (r.exposure !== null && (low === null || low.exposure === null || r.exposure < low.exposure) ? r : low), null);
  const lowest = lowestOf(eligible);
  const fe = fastest.exposure;
  const meaningful = (r: ValidRoute | null): boolean =>
    r !== null && r.exposure !== null && fe !== null && r.exposure < fe && r.exposure <= fe * (1 - preset.gain);
  const label = MODE_LABEL[mode] ?? 'walking';

  let recommended = fastest;
  let explanation: string;
  if (fe === null) {
    explanation = 'Recommended the fastest route because its crime exposure could not be evaluated.';
  } else if (lowest && meaningful(lowest)) {
    recommended = lowest;
    explanation = `This ${label} route adds ${minutes(lowest.duration - fastest.duration)} to the fastest option `
      + `(${minutes(lowest.duration)} instead of ${minutes(fastest.duration)}) and has `
      + `${Math.round(improvement(fastest, lowest) * 100)}% lower crime exposure.`;
  } else if (valid.length === 1) {
    explanation = `Only one ${label} route was found for this trip, so it is recommended.`;
  } else if (valid.every((r) => r.exposure === 0)) {
    explanation = 'No crime is predicted along any of these routes, so the fastest route is recommended.';
  } else {
    const overall = lowestOf(valid);
    if (overall !== null && !eligible.includes(overall) && meaningful(overall)) {
      explanation = `The fastest route is recommended. A route with ${Math.round(improvement(fastest, overall) * 100)}% `
        + `lower crime exposure exists, but it takes ${minutes(overall.duration)}, over your limit of ${minutes(maxSeconds)}.`;
    } else if (lowest !== null && lowest !== fastest && lowest.exposure !== null && lowest.exposure < fe) {
      explanation = 'The fastest route is recommended. Other routes within your time limit are only '
        + `${Math.round(improvement(fastest, lowest) * 100)}% lower in crime exposure, below the `
        + `${Math.round(preset.gain * 100)}% needed to be worth a detour.`;
    } else if (eligible.some((r) => r.exposure === null)) {
      explanation = 'The fastest route is recommended. Some other routes within your time limit could not be scored, '
        + 'and none of the scored ones has lower crime exposure.';
    } else {
      explanation = 'The fastest route also has the lowest crime exposure, so there is no reason to detour.';
    }
  }

  return {
    recommendedId: recommended.id,
    fastestId: fastest.id,
    lowestExposureId: lowest ? lowest.id : null,
    preference,
    maximumAllowedSeconds: maxSeconds,
    explanation,
    routes: routes.map((r) => {
      const exposure = validScore(r.exposure) ? r.exposure : null;
      return {
        id: r.id,
        exposure,
        withinLimit: r.duration <= maxSeconds,
        vsFastestPercent: exposure !== null && fe !== null && fe > 0 ? (100 * (exposure - fe)) / fe : null,
      };
    }),
  };
}
