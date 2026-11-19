package crimeradar.recommendation;

/** A latitude/longitude pair in decimal degrees (WGS84). */
public record GeoPoint(double lat, double lng) {

	private static final double EARTH_RADIUS_METERS = 6_371_000.0;

	public GeoPoint {
		if (!Double.isFinite(lat) || lat < -90 || lat > 90) {
			throw new IllegalArgumentException("Latitude out of range: " + lat);
		}
		if (!Double.isFinite(lng) || lng < -180 || lng > 180) {
			throw new IllegalArgumentException("Longitude out of range: " + lng);
		}
	}

	/** Great-circle (haversine) distance in meters. */
	public double distanceMeters(GeoPoint other) {
		double lat1 = Math.toRadians(lat);
		double lat2 = Math.toRadians(other.lat);
		double dLat = lat2 - lat1;
		double dLng = Math.toRadians(other.lng - lng);
		double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
			+ Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
		return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1.0, Math.sqrt(a)));
	}

	/** The point a fraction {@code f} (0..1) of the way from this point to {@code other}. */
	public GeoPoint interpolate(GeoPoint other, double f) {
		return new GeoPoint(lat + (other.lat - lat) * f, lng + (other.lng - lng) * f);
	}
}
