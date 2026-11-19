package crimeradar.recommendation;

import java.util.List;

/** Produces realistic street routes for a trip. Implemented by OpenRouteServiceClient. */
public interface RoutingClient {

	/** Up to a few alternative routes from start to end, all using {@code mode}. */
	List<CandidateRoute> findRoutes(GeoPoint start, GeoPoint end, TravelMode mode)
		throws RoutingException;
}
