package crimeradar.model;

import java.util.List;

/** Optional scorer-supplied metadata. Null confidence/coverage means unknown, not zero. */
public record DataQuality(Double confidence, Double matchedGeometryFraction,
                          boolean demonstrationData, List<String> messages) {
    public DataQuality {
        validateFraction(confidence);
        validateFraction(matchedGeometryFraction);
        messages = messages == null ? List.of() : List.copyOf(messages);
    }

    private static void validateFraction(Double value) {
        if (value != null && (!Double.isFinite(value) || value < 0 || value > 1)) {
            throw new IllegalArgumentException("Confidence and coverage must be between 0 and 1.");
        }
    }
}
