package crimeradar.model;

import java.util.List;

/** Lowest exposure and alternatives are limited to routes within the detour budget.
 * A null route means none is available; null improvement means comparison was unavailable.
 */
public record RecommendationResult(RouteOption recommendedRoute, RouteOption fastestRoute,
        RouteOption lowestExposureRoute, List<RouteOption> alternativeRoutes, String explanation,
        ComparisonMetrics comparisonMetrics, List<String> warnings) {
    public RecommendationResult {
        alternativeRoutes = List.copyOf(alternativeRoutes);
        warnings = List.copyOf(warnings);
    }

    public record ComparisonMetrics(int validRouteCount, int eligibleRouteCount,
            double maximumAdditionalSeconds, double additionalSeconds,
            double additionalTimeFraction, Double exposureImprovementFraction) {}
}
