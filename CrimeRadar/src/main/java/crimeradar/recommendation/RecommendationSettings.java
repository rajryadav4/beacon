package crimeradar.recommendation;

/**
 * The user's limits for a recommendation.
 *
 * @param mode                  travel mode; only routes of this mode are compared
 * @param maxDetourPercent      longest acceptable extra time, as a % of the fastest route
 * @param maxExtraMinutes       longest acceptable extra time in minutes; the smaller of the
 *                              two limits applies
 * @param minImprovementPercent how much lower (in %) a slower route's exposure must be before
 *                              it is worth recommending over the fastest route
 */
public record RecommendationSettings(TravelMode mode, double maxDetourPercent,
		double maxExtraMinutes, double minImprovementPercent) {

	/** Default for minImprovementPercent. Tune after testing real trips. */
	public static final double DEFAULT_MIN_IMPROVEMENT_PERCENT = 15.0;

	public RecommendationSettings {
		if (mode == null) {
			throw new IllegalArgumentException("Choose a travel mode.");
		}
		if (!Double.isFinite(maxDetourPercent) || maxDetourPercent < 0 || maxDetourPercent > 100) {
			throw new IllegalArgumentException("Maximum detour must be between 0% and 100%.");
		}
		if (!Double.isFinite(maxExtraMinutes) || maxExtraMinutes < 0 || maxExtraMinutes > 60) {
			throw new IllegalArgumentException("Maximum extra time must be between 0 and 60 minutes.");
		}
		if (!Double.isFinite(minImprovementPercent) || minImprovementPercent < 0
				|| minImprovementPercent > 100) {
			throw new IllegalArgumentException("Minimum improvement must be between 0% and 100%.");
		}
	}

	/** The mode's default limits. */
	public static RecommendationSettings defaults(TravelMode mode) {
		return new RecommendationSettings(mode, mode.defaultMaxDetourPercent(),
			mode.defaultMaxExtraMinutes(), DEFAULT_MIN_IMPROVEMENT_PERCENT);
	}
}
