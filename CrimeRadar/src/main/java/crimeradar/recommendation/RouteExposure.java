package crimeradar.recommendation;

import java.util.Set;

/**
 * How much reported crime a route passes through.
 *
 * @param exposure      sum over the route of (km travelled x crime density), lower is better.
 *                      A relative score for comparing routes, not a probability of harm.
 * @param exposurePerKm exposure divided by route length
 * @param coverage      share of the route (0..1) inside the area that has crime data
 * @param timeBlocks    the time blocks the trip falls in, given its departure time
 */
public record RouteExposure(double exposure, double exposurePerKm, double coverage,
		Set<TimeBlock> timeBlocks) {

	public RouteExposure {
		timeBlocks = Set.copyOf(timeBlocks);
	}
}
