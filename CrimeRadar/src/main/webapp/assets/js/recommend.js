// Route decision rules: which route to recommend and why.
// The server (POST api/routes/recommend, crimeradar.service.RecommendationService) is the source of truth.
// This copy runs in offline mode and gives an instant answer while the server replies.
// Keep it in step with the Java rules: both are checked against tests/route-rules-cases.json
// (node tools/check_route_rules.mjs and RouteRulesSharedCasesTest).

/** Detour limits per preset: [max fraction of the fastest time, max extra seconds]; gain = min. exposure drop. */
export const PRESETS = {
  fastest: { walk: [0, 0], bike: [0, 0], car: [0, 0], gain: 0.15 },
  balanced: { walk: [0.25, 300], bike: [0.20, 360], car: [0.20, 480], gain: 0.15 },
  safer: { walk: [0.50, 600], bike: [0.40, 720], car: [0.40, 900], gain: 0.10 },
};

const MODE_LABEL = { walk: 'walking', bike: 'cycling', car: 'driving' };

/** UserPreferences.SafetyWeight (0..1) to a preset, as in RecommendationSettings.Preference. */
export function preferenceFromWeight(weight) {
  const w = Number.isFinite(weight) ? Math.min(1, Math.max(0, weight)) : 0.7;
  return w < 0.34 ? 'fastest' : w < 0.67 ? 'balanced' : 'safer';
}

const validScore = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function minutes(seconds) {
  const m = Math.round(seconds / 60);
  return m < 1 ? 'under 1 min' : `${m} min`;
}

const improvement = (fastest, route) => (fastest.exposure === 0 ? 0 : (fastest.exposure - route.exposure) / fastest.exposure);

/**
 * @param routes [{ id, duration (s), distance (m), exposure (number, or null when unknown) }]
 * @param mode 'walk' | 'bike' | 'car'
 * @param preference 'fastest' | 'balanced' | 'safer'
 * @returns {{ recommendedId, fastestId, lowestExposureId, preference, maximumAllowedSeconds, explanation,
 *            routes: { id, exposure, withinLimit, vsFastestPercent }[] }}
 */
export function recommend(routes, mode, preference = 'balanced') {
  const preset = PRESETS[preference] || PRESETS.balanced;
  const [fraction, maxExtra] = preset[mode] || preset.walk;
  const valid = routes
    .filter((r) => r && r.id && r.duration > 0 && r.distance > 0)
    .map((r) => ({ ...r, exposure: validScore(r.exposure) ? r.exposure : null }))
    .sort((a, b) => a.duration - b.duration || a.distance - b.distance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!valid.length) {
    return { recommendedId: null, fastestId: null, lowestExposureId: null, preference, maximumAllowedSeconds: null,
      explanation: 'No valid routes available for the selected travel mode.', routes: [] };
  }
  const fastest = valid[0];
  const budget = Math.min(fastest.duration * fraction, maxExtra);
  const maxSeconds = fastest.duration + budget;
  const eligible = valid.filter((r) => r.duration <= maxSeconds);
  const lowestOf = (list) => list.reduce((low, r) => (r.exposure !== null && (low === null || r.exposure < low.exposure) ? r : low), null);
  const lowest = lowestOf(eligible);
  const meaningful = (r) => r !== null && r.exposure < fastest.exposure && r.exposure <= fastest.exposure * (1 - preset.gain);
  const label = MODE_LABEL[mode] || 'walking';

  let recommended = fastest;
  let explanation;
  if (fastest.exposure === null) {
    explanation = 'Recommended the fastest route because its crime exposure could not be evaluated.';
  } else if (meaningful(lowest)) {
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
    } else if (lowest !== null && lowest !== fastest && lowest.exposure < fastest.exposure) {
      explanation = `The fastest route is recommended. Other routes within your time limit are only `
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
        vsFastestPercent: exposure !== null && fastest.exposure > 0 ? (100 * (exposure - fastest.exposure)) / fastest.exposure : null,
      };
    }),
  };
}
