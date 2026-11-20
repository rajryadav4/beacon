package crimeradar.service;

import java.util.EnumMap;
import java.util.Locale;
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

    /**
     * The user's "Route choice". The smaller of the two limits always applies, so even SAFER never
     * turns a 12-minute walk into a 22-minute one.
     */
    public enum Preference {
        /** Never detour: always the fastest route. */
        FASTEST,
        /** Walking 25% or 5 min, cycling 20% or 6 min, driving 20% or 8 min; 15% gain needed. */
        BALANCED,
        /** Walking 50% or 10 min, cycling 40% or 12 min, driving 40% or 15 min; 10% gain needed. */
        SAFER;

        /** UserPreferences.SafetyWeight (0..1): below 0.34 FASTEST, below 0.67 BALANCED, else SAFER. */
        public static Preference fromSafetyWeight(double safetyWeight) {
            if (!Double.isFinite(safetyWeight) || safetyWeight < 0 || safetyWeight > 1) {
                throw new IllegalArgumentException("safetyWeight must be between 0 and 1.");
            }
            return safetyWeight < 0.34 ? FASTEST : safetyWeight < 0.67 ? BALANCED : SAFER;
        }

        public static Preference parse(String value) {
            if (value != null) {
                for (Preference p : values()) {
                    if (p.name().equalsIgnoreCase(value.trim())) {
                        return p;
                    }
                }
            }
            throw new IllegalArgumentException("preference must be fastest, balanced, or safer.");
        }

        public String key() {
            return name().toLowerCase(Locale.ROOT);
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

    /** Limits for a preset. BALANCED equals {@link #defaults()}. */
    public static RecommendationSettings forPreference(Preference preference) {
        Map<TravelMode, DetourLimit> limits = new EnumMap<>(TravelMode.class);
        switch (preference) {
            case FASTEST:
                for (TravelMode mode : TravelMode.values()) {
                    limits.put(mode, new DetourLimit(0, 0));
                }
                return new RecommendationSettings(limits, 0.15);
            case SAFER:
                limits.put(TravelMode.WALKING, new DetourLimit(.50, 600));
                limits.put(TravelMode.CYCLING, new DetourLimit(.40, 720));
                limits.put(TravelMode.DRIVING, new DetourLimit(.40, 900));
                return new RecommendationSettings(limits, 0.10);
            case BALANCED:
            default:
                return defaults();
        }
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
