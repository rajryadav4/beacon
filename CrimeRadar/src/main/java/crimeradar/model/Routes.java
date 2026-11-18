package crimeradar.model;

import java.math.BigDecimal;

public class Routes {
	protected long routeId;
	protected String routeName;
	protected BigDecimal startLatitude;
	protected BigDecimal startLongitude;
	protected BigDecimal endLatitude;
	protected BigDecimal endLongitude;
	// Nullable in the table, so Integer rather than int.
	protected Integer distanceMeters;

	public Routes(long routeId, String routeName, BigDecimal startLatitude,
			BigDecimal startLongitude, BigDecimal endLatitude, BigDecimal endLongitude,
			Integer distanceMeters) {
		this.routeId = routeId;
		this.routeName = routeName;
		this.startLatitude = startLatitude;
		this.startLongitude = startLongitude;
		this.endLatitude = endLatitude;
		this.endLongitude = endLongitude;
		this.distanceMeters = distanceMeters;
	}

	public Routes(long routeId) {
		this.routeId = routeId;
	}

	public Routes(String routeName, BigDecimal startLatitude, BigDecimal startLongitude,
			BigDecimal endLatitude, BigDecimal endLongitude, Integer distanceMeters) {
		this.routeName = routeName;
		this.startLatitude = startLatitude;
		this.startLongitude = startLongitude;
		this.endLatitude = endLatitude;
		this.endLongitude = endLongitude;
		this.distanceMeters = distanceMeters;
	}

	public long getRouteId() {
		return routeId;
	}

	public void setRouteId(long routeId) {
		this.routeId = routeId;
	}

	public String getRouteName() {
		return routeName;
	}

	public void setRouteName(String routeName) {
		this.routeName = routeName;
	}

	public BigDecimal getStartLatitude() {
		return startLatitude;
	}

	public void setStartLatitude(BigDecimal startLatitude) {
		this.startLatitude = startLatitude;
	}

	public BigDecimal getStartLongitude() {
		return startLongitude;
	}

	public void setStartLongitude(BigDecimal startLongitude) {
		this.startLongitude = startLongitude;
	}

	public BigDecimal getEndLatitude() {
		return endLatitude;
	}

	public void setEndLatitude(BigDecimal endLatitude) {
		this.endLatitude = endLatitude;
	}

	public BigDecimal getEndLongitude() {
		return endLongitude;
	}

	public void setEndLongitude(BigDecimal endLongitude) {
		this.endLongitude = endLongitude;
	}

	public Integer getDistanceMeters() {
		return distanceMeters;
	}

	public void setDistanceMeters(Integer distanceMeters) {
		this.distanceMeters = distanceMeters;
	}
}
