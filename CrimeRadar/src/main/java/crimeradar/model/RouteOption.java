package crimeradar.model;

import java.util.List;

/** Transient provider route, separate from the persisted Routes table model.
 * Geometry is an ordered WGS84 LineString. Scores must share the scorer's common scale.
 * Numeric validity is checked by RecommendationService at the input boundary.
 */
public record RouteOption(String routeId, TravelMode travelMode, double distanceMeters,
                          double durationSeconds, List<Coordinate> geometry,
                          Double historicalExposureScore, DataQuality dataQuality) {
    public RouteOption {
        geometry = geometry == null ? List.of() : List.copyOf(geometry);
    }

    public RouteOption withRisk(RouteRiskScore score) {
        return new RouteOption(routeId, travelMode, distanceMeters, durationSeconds, geometry,
                score == null ? null : score.historicalExposureScore(), score == null ? null : score.dataQuality());
    }
}
