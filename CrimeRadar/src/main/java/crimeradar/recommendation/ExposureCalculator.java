package crimeradar.recommendation;

import java.time.LocalDateTime;
import java.util.EnumSet;
import java.util.List;

/**
 * Scores a route against the crime grid.
 *
 * The route is walked in steps of at most 50 m. Each step adds (step km x density of the cell it
 * is in, at the time the traveller reaches it). Using the arrival time per step means a trip
 * leaving at 7:50 PM is scored with afternoon patterns at the start and night patterns later.
 */
public final class ExposureCalculator {

	static final double STEP_METERS = 50.0;

	private ExposureCalculator() {
	}

	public static RouteExposure measure(CandidateRoute route, CrimeGrid grid,
			LocalDateTime departure, Bounds dataArea) {
		List<GeoPoint> path = route.geometry();
		double totalMeters = 0;
		for (int i = 0; i + 1 < path.size(); i++) {
			totalMeters += path.get(i).distanceMeters(path.get(i + 1));
		}
		EnumSet<TimeBlock> blocks = EnumSet.noneOf(TimeBlock.class);
		if (totalMeters <= 0) {
			blocks.add(TimeBlock.of(departure));
			double coverage = dataArea.contains(path.get(0)) ? 1.0 : 0.0;
			return new RouteExposure(0, 0, coverage, blocks);
		}

		double exposure = 0;
		double coveredMeters = 0;
		double travelledMeters = 0;
		for (int i = 0; i + 1 < path.size(); i++) {
			GeoPoint a = path.get(i);
			GeoPoint b = path.get(i + 1);
			double segmentMeters = a.distanceMeters(b);
			if (segmentMeters <= 0) {
				continue;
			}
			int steps = Math.max(1, (int) Math.ceil(segmentMeters / STEP_METERS));
			double stepMeters = segmentMeters / steps;
			for (int s = 0; s < steps; s++) {
				double fraction = (s + 0.5) / steps;
				GeoPoint mid = a.interpolate(b, fraction);
				double metersSoFar = travelledMeters + segmentMeters * fraction;
				long secondsIn = Math.round(route.durationSeconds() * metersSoFar / totalMeters);
				TimeBlock block = TimeBlock.of(departure.plusSeconds(secondsIn));
				blocks.add(block);
				exposure += stepMeters / 1000.0 * grid.density(mid, block);
				if (dataArea.contains(mid)) {
					coveredMeters += stepMeters;
				}
			}
			travelledMeters += segmentMeters;
		}
		return new RouteExposure(exposure, exposure / (totalMeters / 1000.0),
			coveredMeters / totalMeters, blocks);
	}
}
