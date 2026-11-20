package crimeradar.model;

import java.math.BigDecimal;

/**
 * A computed (not stored) risk result for one route: the advanced feature from Milestone 1.
 *
 * RiskScore = SUM over the route's segments of (segment km x incidents/day in the segment's
 * neighborhood over the scoring window). RiskPerKm normalizes that by route length so short and
 * long routes can be compared.
 */
public class RouteRisk {
	protected int rank;
	protected Routes route;
	protected int segmentCount;
	protected long totalSegmentMeters;
	protected BigDecimal riskScore;
	protected BigDecimal riskPerKm;

	public RouteRisk(int rank, Routes route, int segmentCount, long totalSegmentMeters,
			BigDecimal riskScore, BigDecimal riskPerKm) {
		this.rank = rank;
		this.route = route;
		this.segmentCount = segmentCount;
		this.totalSegmentMeters = totalSegmentMeters;
		this.riskScore = riskScore;
		this.riskPerKm = riskPerKm;
	}

	public int getRank() {
		return rank;
	}

	public Routes getRoute() {
		return route;
	}

	public int getSegmentCount() {
		return segmentCount;
	}

	public long getTotalSegmentMeters() {
		return totalSegmentMeters;
	}

	public BigDecimal getRiskScore() {
		return riskScore;
	}

	public BigDecimal getRiskPerKm() {
		return riskPerKm;
	}
}
