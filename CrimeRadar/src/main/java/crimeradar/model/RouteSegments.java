package crimeradar.model;

public class RouteSegments {
	protected long segmentId;
	protected Routes route;
	protected int segmentOrder;
	// Nullable columns.
	protected Neighborhoods neighborhood;
	protected Integer distanceMeters;

	public RouteSegments(long segmentId, Routes route, int segmentOrder,
			Neighborhoods neighborhood, Integer distanceMeters) {
		this.segmentId = segmentId;
		this.route = route;
		this.segmentOrder = segmentOrder;
		this.neighborhood = neighborhood;
		this.distanceMeters = distanceMeters;
	}

	public RouteSegments(long segmentId) {
		this.segmentId = segmentId;
	}

	public RouteSegments(Routes route, int segmentOrder, Neighborhoods neighborhood,
			Integer distanceMeters) {
		this.route = route;
		this.segmentOrder = segmentOrder;
		this.neighborhood = neighborhood;
		this.distanceMeters = distanceMeters;
	}

	public long getSegmentId() {
		return segmentId;
	}

	public void setSegmentId(long segmentId) {
		this.segmentId = segmentId;
	}

	public Routes getRoute() {
		return route;
	}

	public void setRoute(Routes route) {
		this.route = route;
	}

	public int getSegmentOrder() {
		return segmentOrder;
	}

	public void setSegmentOrder(int segmentOrder) {
		this.segmentOrder = segmentOrder;
	}

	public Neighborhoods getNeighborhood() {
		return neighborhood;
	}

	public void setNeighborhood(Neighborhoods neighborhood) {
		this.neighborhood = neighborhood;
	}

	public Integer getDistanceMeters() {
		return distanceMeters;
	}

	public void setDistanceMeters(Integer distanceMeters) {
		this.distanceMeters = distanceMeters;
	}
}
