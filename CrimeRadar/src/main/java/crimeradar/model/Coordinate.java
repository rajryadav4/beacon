package crimeradar.model;

/** WGS84 coordinate. GeoJSON serialization uses longitude, latitude order. */
public record Coordinate(double longitude, double latitude) {
    public Coordinate {
        if (!Double.isFinite(longitude) || longitude < -180 || longitude > 180
                || !Double.isFinite(latitude) || latitude < -90 || latitude > 90) {
            throw new IllegalArgumentException("Coordinates must be finite WGS84 longitude/latitude values.");
        }
    }
}
