package crimeradar.recommendation;

import java.util.List;

/** One route alternative from the routing service: its street path, distance and duration. */
public record CandidateRoute(TravelMode mode, double distanceMeters, double durationSeconds,
		List<GeoPoint> geometry) {

	public CandidateRoute {
		if (mode == null) {
			throw new IllegalArgumentException("Route needs a travel mode.");
		}
		if (geometry == null || geometry.size() < 2) {
			throw new IllegalArgumentException("Route geometry needs at least two points.");
		}
		geometry = List.copyOf(geometry);
	}

	public double durationMinutes() {
		return durationSeconds / 60.0;
	}
}
