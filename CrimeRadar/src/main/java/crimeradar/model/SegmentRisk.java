package crimeradar.model;

import java.math.BigDecimal;

/**
 * One segment's contribution to its route's risk score: segment km x incidents/day in the
 * segment's neighborhood. The contributions of a route's segments add up to its RiskScore.
 */
public class SegmentRisk {
	protected int segmentOrder;
	// Null when the segment has no neighborhood (it then contributes zero risk).
	protected String neighborhoodName;
	protected int distanceMeters;
	protected int incidentsInWindow;
	protected BigDecimal incidentsPerDay;
	protected BigDecimal contribution;

	public SegmentRisk(int segmentOrder, String neighborhoodName, int distanceMeters,
			int incidentsInWindow, BigDecimal incidentsPerDay, BigDecimal contribution) {
		this.segmentOrder = segmentOrder;
		this.neighborhoodName = neighborhoodName;
		this.distanceMeters = distanceMeters;
		this.incidentsInWindow = incidentsInWindow;
		this.incidentsPerDay = incidentsPerDay;
		this.contribution = contribution;
	}

	public int getSegmentOrder() {
		return segmentOrder;
	}

	public String getNeighborhoodName() {
		return neighborhoodName;
	}

	public int getDistanceMeters() {
		return distanceMeters;
	}

	public int getIncidentsInWindow() {
		return incidentsInWindow;
	}

	public BigDecimal getIncidentsPerDay() {
		return incidentsPerDay;
	}

	public BigDecimal getContribution() {
		return contribution;
	}
}
