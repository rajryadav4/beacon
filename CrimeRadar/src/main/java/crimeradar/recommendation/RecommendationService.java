package crimeradar.recommendation;

import crimeradar.model.RouteRecommendations.RecommendationType;

import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.stream.Collectors;

/**
 * Picks the safest <em>reasonable</em> route. Pure logic: no database or network, so it can be
 * tested with hand-made routes (see crimeradar.tools.RecommendationEngineTest).
 *
 * Rules, in order:
 * <ol>
 *   <li>Only compare routes of the user's travel mode. Never switch modes.</li>
 *   <li>Find the fastest route.</li>
 *   <li>Allowed extra time = the smaller of (fastest x maxDetourPercent) and maxExtraMinutes.
 *       Routes slower than that are never recommended, however safe.</li>
 *   <li>Among routes within the limit, take the one with the least exposure.</li>
 *   <li>Recommend it only if its exposure is at least minImprovementPercent lower than the
 *       fastest route's. Otherwise recommend the fastest route: a detour for a tiny
 *       improvement isn't worth it.</li>
 * </ol>
 * Ties go to the faster route.
 */
public class RecommendationService {

	private static final double EPSILON = 1e-9;

	private static final Comparator<ScoredRoute> QUICKEST_FIRST =
		Comparator.comparingDouble(ScoredRoute::durationMinutes)
			.thenComparingDouble(ScoredRoute::score);

	private static final Comparator<ScoredRoute> LOWEST_EXPOSURE_FIRST =
		Comparator.comparingDouble(ScoredRoute::score)
			.thenComparingDouble(ScoredRoute::durationMinutes);

	/** Share of the recommended route that must have crime data for a confident result. */
	static final double MIN_COVERAGE = 0.8;

	public RecommendationResult recommend(List<ScoredRoute> candidates,
			RecommendationSettings settings) {
		if (candidates == null || settings == null) {
			throw new IllegalArgumentException("Candidates and settings are required.");
		}
		TravelMode mode = settings.mode();
		List<ScoredRoute> options = candidates.stream()
			.filter(r -> r.route().mode() == mode)
			.filter(r -> r.route().durationSeconds() > 0)
			.filter(r -> Double.isFinite(r.score()) && r.score() >= 0)
			.sorted(QUICKEST_FIRST)
			.collect(Collectors.toList());
		if (options.isEmpty()) {
			throw new IllegalArgumentException(
				"No " + mode.label().toLowerCase(Locale.ROOT) + " routes were found for this trip.");
		}

		ScoredRoute fastest = options.get(0);
		double allowedExtra = Math.min(
			fastest.durationMinutes() * settings.maxDetourPercent() / 100.0,
			settings.maxExtraMinutes());
		double maxAllowed = fastest.durationMinutes() + allowedExtra;

		ScoredRoute bestWithinLimit = options.stream()
			.filter(r -> r.durationMinutes() <= maxAllowed + EPSILON)
			.min(LOWEST_EXPOSURE_FIRST)
			.orElse(fastest);
		ScoredRoute lowestExposure = options.stream().min(LOWEST_EXPOSURE_FIRST).orElse(fastest);
		double improvement = percentLower(fastest.score(), bestWithinLimit.score());
		boolean noIncidents = options.stream().allMatch(r -> r.score() <= EPSILON);

		ScoredRoute recommended = fastest;
		RecommendationResult.Reason reason;
		if (options.size() == 1) {
			reason = RecommendationResult.Reason.ONLY_ONE_ROUTE;
		} else if (noIncidents) {
			reason = RecommendationResult.Reason.NO_REPORTED_INCIDENTS;
		} else if (bestWithinLimit != fastest
				&& improvement >= settings.minImprovementPercent() - EPSILON) {
			recommended = bestWithinLimit;
			reason = RecommendationResult.Reason.SAFER_ALTERNATIVE;
		} else if (lowestExposure == fastest) {
			reason = RecommendationResult.Reason.FASTEST_IS_LOWEST;
		} else if (bestWithinLimit == fastest) {
			reason = RecommendationResult.Reason.ALTERNATIVES_TOO_SLOW;
		} else {
			reason = RecommendationResult.Reason.IMPROVEMENT_TOO_SMALL;
		}

		RecommendationType type;
		if (recommended == fastest) {
			type = recommended == lowestExposure ? RecommendationType.BALANCED
				: RecommendationType.FASTEST;
		} else {
			type = recommended == lowestExposure ? RecommendationType.SAFEST
				: RecommendationType.BALANCED;
		}

		double recommendedImprovement = percentLower(fastest.score(), recommended.score());
		String explanation = explain(reason, settings, recommended, fastest, lowestExposure,
			maxAllowed, improvement);
		boolean lowConfidence = recommended.exposure().coverage() < MIN_COVERAGE;
		return new RecommendationResult(recommended, fastest, lowestExposure, options, maxAllowed,
			recommendedImprovement, reason, type, explanation, lowConfidence);
	}

	/** How much lower {@code other} is than {@code base}, in %. Zero when base is zero. */
	static double percentLower(double base, double other) {
		return base > EPSILON ? 100.0 * (base - other) / base : 0.0;
	}

	private static String explain(RecommendationResult.Reason reason,
			RecommendationSettings settings, ScoredRoute recommended, ScoredRoute fastest,
			ScoredRoute lowestExposure, double maxAllowed, double improvement) {
		String mode = settings.mode().label().toLowerCase(Locale.ROOT);
		switch (reason) {
			case ONLY_ONE_ROUTE:
				return "Only one " + mode + " route was found for this trip, so it is recommended.";
			case NO_REPORTED_INCIDENTS:
				return "No incidents were reported along any of these routes in the data window, "
					+ "so the fastest route is recommended.";
			case SAFER_ALTERNATIVE:
				return String.format(Locale.ROOT,
					"This %s route adds %s to the fastest option (%s instead of %s) and has "
						+ "%d%% lower crime exposure.",
					mode,
					minutes(recommended.durationMinutes() - fastest.durationMinutes()),
					minutes(recommended.durationMinutes()),
					minutes(fastest.durationMinutes()),
					Math.round(percentLower(fastest.score(), recommended.score())));
			case FASTEST_IS_LOWEST:
				return "The fastest route also has the lowest crime exposure, "
					+ "so there is no reason to detour.";
			case ALTERNATIVES_TOO_SLOW:
				return String.format(Locale.ROOT,
					"The fastest route is recommended. A route with %d%% lower crime exposure "
						+ "exists, but it takes %s, over your limit of %s.",
					Math.round(percentLower(fastest.score(), lowestExposure.score())),
					minutes(lowestExposure.durationMinutes()),
					minutes(maxAllowed));
			case IMPROVEMENT_TOO_SMALL:
			default:
				return String.format(Locale.ROOT,
					"The fastest route is recommended. The other routes within your time limit "
						+ "are only %d%% lower in crime exposure, below the %d%% needed to be "
						+ "worth a detour.",
					Math.round(improvement),
					Math.round(settings.minImprovementPercent()));
		}
	}

	/** Formats minutes for people: "12 min", "under 1 min". */
	static String minutes(double value) {
		long rounded = Math.round(value);
		return rounded < 1 ? "under 1 min" : rounded + " min";
	}
}
