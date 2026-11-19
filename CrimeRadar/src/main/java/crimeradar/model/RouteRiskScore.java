package crimeradar.model;

/** Join key is the transient routeId, not a Routes database primary key. */
public record RouteRiskScore(String routeId, Double historicalExposureScore, DataQuality dataQuality) {}
