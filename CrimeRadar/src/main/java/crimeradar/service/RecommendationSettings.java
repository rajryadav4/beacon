package crimeradar.service;

import java.util.EnumMap;
import java.util.Map;
import java.util.Properties;

import crimeradar.model.TravelMode;

/**
 * All times are seconds; percentage settings are fractions (0.15 means 15%).
 */
public record RecommendationSettings(Map<TravelMode, DetourLimit> detourLimits,
        double meaningfulImprovementFraction) {
    public record DetourLimit(double maximumFraction, double maximumAdditionalSeconds) {
        public DetourLimit {
            if (!Double.isFinite(maximumFraction) || maximumFraction < 0
                    || !Double.isFinite(maximumAdditionalSeconds) || maximumAdditionalSeconds < 0) {
                throw new IllegalArgumentException("Detour limits must be finite and nonnegative.");
            }
        }

        public double allowedAdditionalSeconds(double fastestSeconds) {
            return Math.min(fastestSeconds * maximumFraction, maximumAdditionalSeconds);
        }
    }

    public RecommendationSettings {
        detourLimits = Map.copyOf(detourLimits);
        if (detourLimits.size() != TravelMode.values().length
                || !Double.isFinite(meaningfulImprovementFraction)
                || meaningfulImprovementFraction < 0 || meaningfulImprovementFraction > 1) {
            throw new IllegalArgumentException("Provide all travel modes and an improvement fraction between 0 and 1.");
        }
    }

    public static RecommendationSettings defaults() {
        return fromProperties(new Properties());
    }

    /**
     * Properties may be supplied by deployment; zero limits express a no-detour
     * preference.
     */
    public static RecommendationSettings fromProperties(Properties properties) {
        Map<TravelMode, DetourLimit> limits = new EnumMap<>(TravelMode.class);
        limits.put(TravelMode.WALKING, limit(properties, "walking", .25, 300));
        limits.put(TravelMode.CYCLING, limit(properties, "cycling", .20, 360));
        limits.put(TravelMode.DRIVING, limit(properties, "driving", .20, 480));
        return new RecommendationSettings(limits,
                Double.parseDouble(properties.getProperty("recommendation.meaningfulImprovementFraction", "0.15")));
    }

    private static DetourLimit limit(Properties properties, String mode, double fraction, double seconds) {
        String prefix = "recommendation." + mode;
        return new DetourLimit(
                Double.parseDouble(
                        properties.getProperty(prefix + ".maximumDetourFraction", Double.toString(fraction))),
                Double.parseDouble(
                        properties.getProperty(prefix + ".maximumAdditionalSeconds", Double.toString(seconds))));
    }
}
