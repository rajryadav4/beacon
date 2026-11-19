package crimeradar.recommendation;

/** A route alternative together with its crime exposure. */
public record ScoredRoute(CandidateRoute route, RouteExposure exposure) {

	public double durationMinutes() {
		return route.durationMinutes();
	}

	public double score() {
		return exposure.exposure();
	}
}
