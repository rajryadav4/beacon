package crimeradar.tools;

import crimeradar.model.RouteRecommendations.RecommendationType;
import crimeradar.recommendation.Bounds;
import crimeradar.recommendation.CandidateRoute;
import crimeradar.recommendation.CellCount;
import crimeradar.recommendation.CrimeGrid;
import crimeradar.recommendation.CrimeGroup;
import crimeradar.recommendation.DataWindow;
import crimeradar.recommendation.ExposureCalculator;
import crimeradar.recommendation.GeoPoint;
import crimeradar.recommendation.OpenRouteServiceClient;
import crimeradar.recommendation.RecommendationResult;
import crimeradar.recommendation.RecommendationResult.Reason;
import crimeradar.recommendation.RecommendationService;
import crimeradar.recommendation.RecommendationSettings;
import crimeradar.recommendation.RouteExposure;
import crimeradar.recommendation.RoutingException;
import crimeradar.recommendation.ScoredRoute;
import crimeradar.recommendation.TimeBlock;
import crimeradar.recommendation.TravelMode;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Set;

/**
 * Offline tests for the route recommender: no MySQL and no routing API needed.
 *
 * Run: right-click > Run As > Java Application. Prints PASS/FAIL per test and exits with
 * status 1 if anything fails.
 */
public class RecommendationEngineTest {

	private static int passed = 0;
	private static int failed = 0;
	private static final RecommendationService SERVICE = new RecommendationService();

	public static void main(String[] args) {
		// Decision rules
		run("Same exposure: the faster route wins", RecommendationEngineTest::sameExposureFasterWins);
		run("Small improvement: keep the fastest route", RecommendationEngineTest::smallImprovementKeepsFastest);
		run("Big improvement for 2 extra minutes: take it", RecommendationEngineTest::bigImprovementWithinLimit);
		run("A much safer but much longer route is never recommended", RecommendationEngineTest::tooSlowIsExcluded);
		run("All safer routes too slow: explain it", RecommendationEngineTest::alternativesTooSlow);
		run("Travel mode is never switched", RecommendationEngineTest::modeIsNeverSwitched);
		run("Zero detour allowed: fastest route", RecommendationEngineTest::zeroDetour);
		run("The smaller of % and minutes limits applies", RecommendationEngineTest::smallerLimitApplies);
		run("Equal exposure among alternatives: the faster one", RecommendationEngineTest::tieGoesToFaster);
		run("No incidents anywhere: fastest route", RecommendationEngineTest::noIncidents);
		run("No routes: clear error", RecommendationEngineTest::noRoutes);
		// Crime grid and exposure
		run("A route through a hotspot scores higher", RecommendationEngineTest::hotspotRaisesExposure);
		run("Time of day changes the score", RecommendationEngineTest::timeOfDayMatters);
		run("A trip spanning 8 PM uses both time blocks", RecommendationEngineTest::tripCrossesTimeBlocks);
		run("Mode weights: drivers weigh property crime more", RecommendationEngineTest::modeWeights);
		run("Route outside Seattle is flagged low confidence", RecommendationEngineTest::outsideSeattleLowConfidence);
		// Routing response and data window
		run("Reads openrouteservice GeoJSON", RecommendationEngineTest::parsesGeoJson);
		run("Bad routing response gives a clear error", RecommendationEngineTest::badGeoJson);
		run("Data window skips the late-reporting week", RecommendationEngineTest::dataWindow);

		System.out.println();
		System.out.println(passed + " passed, " + failed + " failed");
		if (failed > 0) {
			System.exit(1);
		}
	}

	// ---------- decision rules ----------

	private static void sameExposureFasterWins() {
		ScoredRoute a = route(TravelMode.WALKING, 12, 50);
		ScoredRoute b = route(TravelMode.WALKING, 14, 50);
		RecommendationResult r = SERVICE.recommend(List.of(b, a), walking());
		check(r.recommended() == a, "expected the 12-minute route");
		check(r.reason() == Reason.FASTEST_IS_LOWEST, "reason was " + r.reason());
	}

	private static void smallImprovementKeepsFastest() {
		ScoredRoute a = route(TravelMode.WALKING, 12, 50);
		ScoredRoute b = route(TravelMode.WALKING, 14, 46); // 8% lower, below 15%
		RecommendationResult r = SERVICE.recommend(List.of(a, b), walking());
		check(r.recommended() == a, "expected the fastest route");
		check(r.reason() == Reason.IMPROVEMENT_TOO_SMALL, "reason was " + r.reason());
		check(r.explanation().contains("8%"), r.explanation());
	}

	private static void bigImprovementWithinLimit() {
		ScoredRoute a = route(TravelMode.WALKING, 12, 80);
		ScoredRoute b = route(TravelMode.WALKING, 14, 45); // 44% lower, +2 min
		RecommendationResult r = SERVICE.recommend(List.of(a, b), walking());
		check(r.recommended() == b, "expected the 14-minute route");
		check(r.reason() == Reason.SAFER_ALTERNATIVE, "reason was " + r.reason());
		check(r.type() == RecommendationType.SAFEST, "type was " + r.type());
		check(r.explanation().contains("2 min") && r.explanation().contains("44%"),
			r.explanation());
	}

	private static void tooSlowIsExcluded() {
		// The example from the plan: 12 min / 14 min / 22 min. Limit = 12 + min(3, 5) = 15.
		ScoredRoute a = route(TravelMode.WALKING, 12, 80);
		ScoredRoute b = route(TravelMode.WALKING, 14, 45);
		ScoredRoute c = route(TravelMode.WALKING, 22, 20);
		RecommendationResult r = SERVICE.recommend(List.of(a, b, c), walking());
		check(close(r.maxAllowedMinutes(), 15), "limit was " + r.maxAllowedMinutes());
		check(r.recommended() == b, "expected B, the safest route within 15 min");
		check(r.lowestExposure() == c, "C should still be reported as lowest exposure");
		check(!r.isWithinTimeLimit(c), "C should be over the limit");
		check(r.type() == RecommendationType.BALANCED, "type was " + r.type());
	}

	private static void alternativesTooSlow() {
		ScoredRoute a = route(TravelMode.WALKING, 12, 80);
		ScoredRoute c = route(TravelMode.WALKING, 22, 20);
		RecommendationResult r = SERVICE.recommend(List.of(a, c), walking());
		check(r.recommended() == a, "expected the fastest route");
		check(r.reason() == Reason.ALTERNATIVES_TOO_SLOW, "reason was " + r.reason());
		check(r.explanation().contains("22 min") && r.explanation().contains("15 min"),
			r.explanation());
	}

	private static void modeIsNeverSwitched() {
		ScoredRoute walk = route(TravelMode.WALKING, 12, 80);
		ScoredRoute drive = route(TravelMode.DRIVING, 5, 1);
		RecommendationResult r = SERVICE.recommend(List.of(walk, drive), walking());
		check(r.recommended() == walk, "a driving route was recommended to a walker");
		check(r.options().size() == 1, "driving route should be filtered out");
		check(r.reason() == Reason.ONLY_ONE_ROUTE, "reason was " + r.reason());
	}

	private static void zeroDetour() {
		RecommendationSettings noDetour = new RecommendationSettings(TravelMode.WALKING, 0, 0, 15);
		ScoredRoute a = route(TravelMode.WALKING, 12, 80);
		ScoredRoute b = route(TravelMode.WALKING, 12.5, 10);
		RecommendationResult r = SERVICE.recommend(List.of(a, b), noDetour);
		check(r.recommended() == a, "no detour allowed, expected the fastest route");
		check(r.reason() == Reason.ALTERNATIVES_TOO_SLOW, "reason was " + r.reason());
	}

	private static void smallerLimitApplies() {
		// 30-min walk: 25% would allow 7.5 min, but the 5-minute cap is smaller.
		ScoredRoute a = route(TravelMode.WALKING, 30, 80);
		ScoredRoute b = route(TravelMode.WALKING, 34.9, 10);
		ScoredRoute c = route(TravelMode.WALKING, 35.5, 5);
		RecommendationResult r = SERVICE.recommend(List.of(a, b, c), walking());
		check(close(r.maxAllowedMinutes(), 35), "limit was " + r.maxAllowedMinutes());
		check(r.recommended() == b, "expected the 34.9-minute route");
	}

	private static void tieGoesToFaster() {
		ScoredRoute a = route(TravelMode.WALKING, 12, 80);
		ScoredRoute b = route(TravelMode.WALKING, 14, 40);
		ScoredRoute c = route(TravelMode.WALKING, 13, 40);
		RecommendationResult r = SERVICE.recommend(List.of(a, b, c), walking());
		check(r.recommended() == c, "expected the 13-minute route");
	}

	private static void noIncidents() {
		ScoredRoute a = route(TravelMode.WALKING, 12, 0);
		ScoredRoute b = route(TravelMode.WALKING, 14, 0);
		RecommendationResult r = SERVICE.recommend(List.of(b, a), walking());
		check(r.recommended() == a, "expected the fastest route");
		check(r.reason() == Reason.NO_REPORTED_INCIDENTS, "reason was " + r.reason());
	}

	private static void noRoutes() {
		try {
			SERVICE.recommend(new ArrayList<ScoredRoute>(), walking());
		} catch (IllegalArgumentException e) {
			check(e.getMessage().contains("walking"), e.getMessage());
			return;
		}
		throw new AssertionError("expected an IllegalArgumentException");
	}

	// ---------- crime grid and exposure ----------

	// A hotspot cell around Broadway & Pine, Capitol Hill.
	private static final GeoPoint HOTSPOT = new GeoPoint(47.6150, -122.3208);

	private static CrimeGrid hotspotGrid(CrimeGroup group, int block, long recent, long shape,
			TravelMode mode) {
		List<CellCount> counts = List.of(new CellCount(CrimeGrid.row(HOTSPOT.lat()),
			CrimeGrid.col(HOTSPOT.lng()), group, block, recent, shape));
		return CrimeGrid.build(counts, evenCityCounts(), mode, DataWindow.RECENT_DAYS);
	}

	private static long[][] evenCityCounts() {
		long[][] city = new long[CrimeGroup.values().length][TimeBlock.COUNT];
		for (long[] row : city) {
			Arrays.fill(row, 100);
		}
		return city;
	}

	/** North-south walk through the given longitude, 47.610 to 47.620 (about 1.1 km). */
	private static CandidateRoute northSouth(double lng, double minutes) {
		return new CandidateRoute(TravelMode.WALKING, 1110, minutes * 60,
			List.of(new GeoPoint(47.610, lng), new GeoPoint(47.620, lng)));
	}

	private static void hotspotRaisesExposure() {
		CrimeGrid grid = hotspotGrid(CrimeGroup.PERSON, 4, 180, 180, TravelMode.WALKING);
		LocalDateTime evening = LocalDateTime.of(2026, 11, 18, 18, 0);
		RouteExposure through = ExposureCalculator.measure(northSouth(-122.3208, 14), grid,
			evening, Bounds.SEATTLE);
		RouteExposure away = ExposureCalculator.measure(northSouth(-122.3100, 14), grid,
			evening, Bounds.SEATTLE);
		check(through.exposure() > 0, "route through the hotspot should have exposure");
		check(away.exposure() == 0, "route 800 m away should be clear, was " + away.exposure());
		check(close(through.coverage(), 1.0), "coverage was " + through.coverage());
	}

	private static void timeOfDayMatters() {
		// All of the hotspot's crime historically happens 8 PM to midnight.
		CrimeGrid grid = hotspotGrid(CrimeGroup.PERSON, TimeBlock.NIGHT.ordinal(), 180, 500,
			TravelMode.WALKING);
		CandidateRoute route = northSouth(-122.3208, 14);
		double night = ExposureCalculator.measure(route, grid,
			LocalDateTime.of(2026, 11, 18, 21, 0), Bounds.SEATTLE).exposure();
		double morning = ExposureCalculator.measure(route, grid,
			LocalDateTime.of(2026, 11, 18, 9, 0), Bounds.SEATTLE).exposure();
		check(night > 10 * morning, "night " + night + " vs morning " + morning);
	}

	private static void tripCrossesTimeBlocks() {
		CrimeGrid grid = CrimeGrid.empty();
		RouteExposure e = ExposureCalculator.measure(northSouth(-122.3208, 30), grid,
			LocalDateTime.of(2026, 11, 18, 19, 50), Bounds.SEATTLE);
		check(e.timeBlocks().equals(Set.of(TimeBlock.EVENING, TimeBlock.NIGHT)),
			"blocks were " + e.timeBlocks());
	}

	private static void modeWeights() {
		CandidateRoute route = northSouth(-122.3208, 14);
		LocalDateTime evening = LocalDateTime.of(2026, 11, 18, 18, 0);
		double walking = ExposureCalculator.measure(route,
			hotspotGrid(CrimeGroup.PROPERTY, 4, 180, 180, TravelMode.WALKING),
			evening, Bounds.SEATTLE).exposure();
		double driving = ExposureCalculator.measure(route,
			hotspotGrid(CrimeGroup.PROPERTY, 4, 180, 180, TravelMode.DRIVING),
			evening, Bounds.SEATTLE).exposure();
		check(close(walking / driving, 0.4), "walking/driving ratio was " + walking / driving);
	}

	private static void outsideSeattleLowConfidence() {
		CandidateRoute everett = new CandidateRoute(TravelMode.WALKING, 1110, 840,
			List.of(new GeoPoint(47.90, -122.30), new GeoPoint(47.91, -122.30)));
		RouteExposure e = ExposureCalculator.measure(everett, CrimeGrid.empty(),
			LocalDateTime.of(2026, 11, 18, 12, 0), Bounds.SEATTLE);
		check(e.coverage() == 0, "coverage was " + e.coverage());
		RecommendationResult r = SERVICE.recommend(List.of(new ScoredRoute(everett, e)),
			walking());
		check(r.lowConfidence(), "expected low confidence");
	}

	// ---------- routing response and data window ----------

	private static void parsesGeoJson() throws RoutingException {
		String json = "{\"type\":\"FeatureCollection\",\"features\":["
			+ "{\"type\":\"Feature\",\"properties\":{\"summary\":{\"distance\":1234.5,"
			+ "\"duration\":890.2},\"way_points\":[0,2]},\"geometry\":{\"type\":\"LineString\","
			+ "\"coordinates\":[[-122.3301,47.6101],[-122.3305,47.6110],[-122.3310,47.6120]]}},"
			+ "{\"type\":\"Feature\",\"properties\":{\"summary\":{\"distance\":1400,"
			+ "\"duration\":1010}},\"geometry\":{\"type\":\"LineString\","
			+ "\"coordinates\":[[-122.3301,47.6101],[-122.3290,47.6120]]}}],"
			+ "\"metadata\":{\"attribution\":\"openrouteservice.org | OpenStreetMap \\u00a9\","
			+ "\"query\":{\"profile\":\"foot-walking\",\"units\":null,\"flag\":true}}}";
		List<CandidateRoute> routes = OpenRouteServiceClient.parseGeoJson(json, TravelMode.WALKING);
		check(routes.size() == 2, "expected 2 routes, got " + routes.size());
		CandidateRoute first = routes.get(0);
		check(close(first.distanceMeters(), 1234.5), "distance " + first.distanceMeters());
		check(close(first.durationSeconds(), 890.2), "duration " + first.durationSeconds());
		check(close(first.geometry().get(0).lat(), 47.6101)
			&& close(first.geometry().get(0).lng(), -122.3301),
			"coordinates must be read as [lng, lat]");
	}

	private static void badGeoJson() {
		for (String json : new String[] {"{\"features\":[", "{}", "not json"}) {
			try {
				OpenRouteServiceClient.parseGeoJson(json, TravelMode.WALKING);
				throw new AssertionError("expected RoutingException for: " + json);
			} catch (RoutingException e) {
				check(e.getMessage() != null && !e.getMessage().isEmpty(), "empty message");
			}
		}
	}

	private static void dataWindow() {
		DataWindow w = DataWindow.fromLatestIncident(LocalDateTime.of(2026, 10, 31, 12, 0));
		check(w.end().equals(LocalDateTime.of(2026, 10, 24, 12, 0)), "end " + w.end());
		check(w.recentStart().equals(LocalDateTime.of(2026, 7, 26, 12, 0)),
			"recent start " + w.recentStart());
		check(w.isStale(LocalDate.of(2026, 11, 18), 14), "should be stale");
		check(!w.isStale(LocalDate.of(2026, 11, 5), 14), "should not be stale");
	}

	// ---------- helpers ----------

	private static RecommendationSettings walking() {
		return RecommendationSettings.defaults(TravelMode.WALKING);
	}

	/** A hand-made route with a given duration and exposure score. */
	private static ScoredRoute route(TravelMode mode, double minutes, double exposure) {
		CandidateRoute r = new CandidateRoute(mode, minutes * 80, minutes * 60,
			List.of(new GeoPoint(47.610, -122.330), new GeoPoint(47.620, -122.330)));
		return new ScoredRoute(r, new RouteExposure(exposure, exposure, 1.0,
			Set.of(TimeBlock.EVENING)));
	}

	private static boolean close(double a, double b) {
		return Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b));
	}

	private static void check(boolean condition, String message) {
		if (!condition) {
			throw new AssertionError(message);
		}
	}

	private interface Test {
		void run() throws Exception;
	}

	private static void run(String name, Test test) {
		try {
			test.run();
			passed++;
			System.out.println("PASS  " + name);
		} catch (Throwable t) {
			failed++;
			System.out.println("FAIL  " + name + ": " + t);
		}
	}
}
