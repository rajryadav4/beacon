package crimeradar.recommendation;

import crimeradar.model.RouteRecommendations.RecommendationType;

import java.util.List;

/**
 * What RecommendationService decided and why.
 *
 * @param recommended        the route to suggest
 * @param fastest            the quickest route of the selected mode
 * @param lowestExposure     the route with the least exposure, even if it is too slow
 * @param options            every valid route, quickest first
 * @param maxAllowedMinutes  the slowest a route may be and still be recommended
 * @param improvementPercent how much lower the recommended route's exposure is than the
 *                           fastest route's (0 when the fastest route is recommended)
 * @param reason             which rule decided
 * @param type               matches the RouteRecommendations.RecommendationType column
 * @param explanation        a plain-English "why this route" sentence
 * @param lowConfidence      true when much of the recommended route is outside the crime data
 */
public record RecommendationResult(ScoredRoute recommended, ScoredRoute fastest,
		ScoredRoute lowestExposure, List<ScoredRoute> options, double maxAllowedMinutes,
		double improvementPercent, Reason reason, RecommendationType type, String explanation,
		boolean lowConfidence) {

	/** Which rule decided the recommendation. */
	public enum Reason {
		/** The routing service returned a single route. */
		ONLY_ONE_ROUTE,
		/** No incidents along any option, so speed decides. */
		NO_REPORTED_INCIDENTS,
		/** A slightly slower route within the time limit is meaningfully lower in exposure. */
		SAFER_ALTERNATIVE,
		/** The fastest route is also the lowest in exposure. */
		FASTEST_IS_LOWEST,
		/** Lower-exposure routes exist, but all of them break the time limit. */
		ALTERNATIVES_TOO_SLOW,
		/** Routes within the time limit are lower in exposure, but not by enough to detour. */
		IMPROVEMENT_TOO_SMALL
	}

	public RecommendationResult {
		options = List.copyOf(options);
	}

	public boolean isWithinTimeLimit(ScoredRoute route) {
		return route.durationMinutes() <= maxAllowedMinutes + 1e-9;
	}

	/** Exposure compared with the fastest route, in % (negative means lower). */
	public double percentVersusFastest(ScoredRoute route) {
		if (fastest.score() <= 0) {
			return 0;
		}
		return 100.0 * (route.score() - fastest.score()) / fastest.score();
	}
}
