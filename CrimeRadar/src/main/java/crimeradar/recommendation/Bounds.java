package crimeradar.recommendation;

import java.util.Collection;

/** A latitude/longitude bounding box. */
public record Bounds(double minLat, double maxLat, double minLng, double maxLng) {

	/** Rough box around the City of Seattle, where CrimeRadar has SPD crime data. */
	public static final Bounds SEATTLE = new Bounds(47.48, 47.74, -122.46, -122.22);

	public Bounds {
		if (minLat > maxLat || minLng > maxLng) {
			throw new IllegalArgumentException("Bounds minimum is greater than maximum.");
		}
	}

	/** The smallest box containing every point. */
	public static Bounds around(Collection<GeoPoint> points) {
		if (points == null || points.isEmpty()) {
			throw new IllegalArgumentException("Need at least one point.");
		}
		double minLat = Double.POSITIVE_INFINITY;
		double maxLat = Double.NEGATIVE_INFINITY;
		double minLng = Double.POSITIVE_INFINITY;
		double maxLng = Double.NEGATIVE_INFINITY;
		for (GeoPoint p : points) {
			minLat = Math.min(minLat, p.lat());
			maxLat = Math.max(maxLat, p.lat());
			minLng = Math.min(minLng, p.lng());
			maxLng = Math.max(maxLng, p.lng());
		}
		return new Bounds(minLat, maxLat, minLng, maxLng);
	}

	public Bounds expand(double latDegrees, double lngDegrees) {
		return new Bounds(minLat - latDegrees, maxLat + latDegrees,
			minLng - lngDegrees, maxLng + lngDegrees);
	}

	public boolean contains(GeoPoint p) {
		return p.lat() >= minLat && p.lat() <= maxLat && p.lng() >= minLng && p.lng() <= maxLng;
	}
}
