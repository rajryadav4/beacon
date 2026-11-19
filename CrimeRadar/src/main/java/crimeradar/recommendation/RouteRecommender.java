package crimeradar.recommendation;

import crimeradar.dal.CrimeStatsDao;

import java.sql.SQLException;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

/**
 * The whole recommendation flow, used by the RecommendRoute servlet:
 * routes from the routing service, crime statistics from MySQL, then the decision rules.
 */
public class RouteRecommender {

	/** Start and destination closer than this are treated as the same place. */
	private static final double MIN_TRIP_METERS = 30.0;

	private final RoutingClient routingClient;
	private final CrimeStatsDao crimeStatsDao;
	private final RecommendationService service = new RecommendationService();

	public RouteRecommender(RoutingClient routingClient, CrimeStatsDao crimeStatsDao) {
		this.routingClient = routingClient;
		this.crimeStatsDao = crimeStatsDao;
	}

	/** The decision plus the data window it was based on (null when there is no crime data). */
	public record Outcome(RecommendationResult result, DataWindow window,
			LocalDateTime departure) {
	}

	public Outcome recommend(GeoPoint start, GeoPoint end, LocalDateTime departure,
			RecommendationSettings settings) throws RoutingException, SQLException {
		if (start.distanceMeters(end) < MIN_TRIP_METERS) {
			throw new IllegalArgumentException("Start and destination are the same place.");
		}
		List<CandidateRoute> routes = routingClient.findRoutes(start, end, settings.mode());

		DataWindow window = crimeStatsDao.getDataWindow();
		CrimeGrid grid = CrimeGrid.empty();
		if (window != null) {
			List<GeoPoint> allPoints = new ArrayList<>();
			for (CandidateRoute route : routes) {
				allPoints.addAll(route.geometry());
			}
			// Two extra cells on every side so edge cells still get their 3x3 neighbors.
			Bounds box = Bounds.around(allPoints).expand(2 * CrimeGrid.CELL_LAT_DEGREES,
				2 * CrimeGrid.CELL_LNG_DEGREES);
			grid = CrimeGrid.build(crimeStatsDao.getCellCounts(window, box),
				crimeStatsDao.getCityBlockCounts(window), settings.mode(), window.recentDays());
		}

		List<ScoredRoute> scored = new ArrayList<>();
		for (CandidateRoute route : routes) {
			scored.add(new ScoredRoute(route,
				ExposureCalculator.measure(route, grid, departure, Bounds.SEATTLE)));
		}
		return new Outcome(service.recommend(scored, settings), window, departure);
	}
}
