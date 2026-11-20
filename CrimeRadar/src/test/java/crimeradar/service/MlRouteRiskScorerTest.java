package crimeradar.service;

import crimeradar.model.*;
import org.junit.jupiter.api.Test;
import java.sql.SQLException;
import java.time.LocalDateTime;
import java.util.*;
import java.util.concurrent.atomic.*;
import static org.junit.jupiter.api.Assertions.*;

/** Person 1: exposure from the ML risk grid. No database: grids are built by hand. */
class MlRouteRiskScorerTest {
    // Broadway & Pine, Capitol Hill, and a quiet block about 800 m east.
    private static final double HOT_LAT = 47.6150, HOT_LNG = -122.3208;
    private static final int HOT_CELL = RiskGrid.cellId(HOT_LAT, HOT_LNG);
    private static final LocalDateTime EVENING = LocalDateTime.of(2026, 11, 19, 20, 0);
    private static final LocalDateTime MORNING = LocalDateTime.of(2026, 11, 19, 9, 0);

    /** Risk 50/yr in the hot cell in every band except evening (band 3), where it is 200. */
    private static RiskGrid hotGrid() {
        return RiskGrid.of("test-model", new Date(0), List.of(
                new double[] { HOT_CELL, 0, 50 }, new double[] { HOT_CELL, 1, 50 },
                new double[] { HOT_CELL, 2, 50 }, new double[] { HOT_CELL, 3, 200 }));
    }

    private static RouteOption northSouth(String id, double lng, double seconds) {
        return new RouteOption(id, TravelMode.WALKING, 1110, seconds,
                List.of(new Coordinate(lng, 47.610), new Coordinate(lng, 47.620)), null, null);
    }

    private static Map<String, RouteRiskScore> score(RiskGrid grid, LocalDateTime when, RouteOption... routes)
            throws RiskScoringException {
        Map<String, RouteRiskScore> byId = new HashMap<>();
        for (RouteRiskScore s : MlRouteRiskScorer.fixed(grid).calculateRouteRisks(List.of(routes), when)) {
            byId.put(s.routeId(), s);
        }
        return byId;
    }

    @Test void gridMatchesTheAppFormula() {
        // sql/app_tables.sql: row = FLOOR((lat - 47.48) / 0.002), col = FLOOR((lng + 122.46) / 0.003), id = row*100+col
        assertEquals(67 * 100 + 46, RiskGrid.cellId(47.6150, -122.3208));
        assertEquals(-1, RiskGrid.cellId(47.90, -122.30));
        assertEquals(0, RiskGrid.band(5)); assertEquals(1, RiskGrid.band(6));
        assertEquals(2, RiskGrid.band(17)); assertEquals(3, RiskGrid.band(18));
    }

    @Test void routeThroughHotspotScoresHigherAndQuietRouteScoresZero() throws Exception {
        var s = score(hotGrid(), EVENING, northSouth("hot", HOT_LNG, 840), northSouth("quiet", -122.3100, 840));
        assertTrue(s.get("hot").historicalExposureScore() > 0);
        assertEquals(0.0, s.get("quiet").historicalExposureScore());
        assertEquals(1.0, s.get("hot").dataQuality().matchedGeometryFraction(), 1e-9);
        assertFalse(s.get("hot").dataQuality().demonstrationData());
    }

    @Test void exposureIsKmTimesRiskInTheBandOfArrival() throws Exception {
        double evening = score(hotGrid(), EVENING, northSouth("r", HOT_LNG, 840)).get("r").historicalExposureScore();
        double morning = score(hotGrid(), MORNING, northSouth("r", HOT_LNG, 840)).get("r").historicalExposureScore();
        assertEquals(4.0, evening / morning, 1e-6);
        // The route crosses the hot cell for about 0.22 km (one 0.002-degree row): 0.22 km x 200.
        assertEquals(44.5, evening, 1.0);
    }

    @Test void arrivalTimeBandIsUsedNotDepartureBand() throws Exception {
        // Leave 17:55, 30-minute walk south to north: the hot cell (middle of the route) is reached after 18:00.
        var southToNorth = new RouteOption("r", TravelMode.WALKING, 1110, 1800,
                List.of(new Coordinate(HOT_LNG, 47.600), new Coordinate(HOT_LNG, 47.630)), null, null);
        double leaving1755 = score(hotGrid(), LocalDateTime.of(2026, 11, 19, 17, 55), southToNorth)
                .get("r").historicalExposureScore();
        double leaving1300 = score(hotGrid(), LocalDateTime.of(2026, 11, 19, 13, 0), southToNorth)
                .get("r").historicalExposureScore();
        assertEquals(4.0, leaving1755 / leaving1300, 1e-6);
    }

    @Test void totalNotAverage_aLongerRouteThroughTheSameHotspotIsNotCheaper() throws Exception {
        var shortRoute = northSouth("short", HOT_LNG, 840);
        var longRoute = new RouteOption("long", TravelMode.WALKING, 3000, 2000, List.of(
                new Coordinate(HOT_LNG, 47.610), new Coordinate(HOT_LNG, 47.620), new Coordinate(-122.3100, 47.620),
                new Coordinate(-122.3100, 47.640)), null, null);
        var s = score(hotGrid(), EVENING, shortRoute, longRoute);
        assertEquals(s.get("short").historicalExposureScore(), s.get("long").historicalExposureScore(), 1.0);
    }

    @Test void mostlyOffGridIsUnknownNeverZero() throws Exception {
        var everett = new RouteOption("far", TravelMode.WALKING, 1110, 840,
                List.of(new Coordinate(-122.30, 47.90), new Coordinate(-122.30, 47.91)), null, null);
        var s = score(hotGrid(), EVENING, everett).get("far");
        assertNull(s.historicalExposureScore());
        assertEquals(0.0, s.dataQuality().matchedGeometryFraction());
        assertTrue(s.dataQuality().messages().stream().anyMatch(m -> m.contains("outside Seattle")));
    }

    @Test void partlyOffGridIsScoredWithAWarning() throws Exception {
        // From inside the grid (north edge 47.75) to 0.6 km beyond it: about 70% on the grid.
        var edge = new RouteOption("edge", TravelMode.WALKING, 2000, 1500,
                List.of(new Coordinate(-122.30, 47.7375), new Coordinate(-122.30, 47.7555)), null, null);
        var s = score(hotGrid(), EVENING, edge).get("edge");
        assertNotNull(s.historicalExposureScore());
        assertTrue(s.dataQuality().matchedGeometryFraction() > 0.5 && s.dataQuality().matchedGeometryFraction() < 0.95);
        assertTrue(s.dataQuality().messages().stream().anyMatch(m -> m.contains("Part of a route")));
    }

    @Test void reloadsWhenTheModelSignatureChangesAndAtMostOncePerMinute() throws Exception {
        AtomicLong now = new AtomicLong(0);
        AtomicReference<String> signature = new AtomicReference<>("v1");
        AtomicInteger loads = new AtomicInteger();
        AtomicReference<RiskGrid> grid = new AtomicReference<>(hotGrid());
        var scorer = new MlRouteRiskScorer(new MlRouteRiskScorer.Source() {
            @Override public String signature() { return signature.get(); }
            @Override public RiskGrid load() { loads.incrementAndGet(); return grid.get(); }
        }, now::get);
        var route = List.of(northSouth("r", HOT_LNG, 840));
        double before = scorer.calculateRouteRisks(route, EVENING).get(0).historicalExposureScore();
        // New import: twice the risk. Not seen until the next minute's check.
        signature.set("v2");
        grid.set(RiskGrid.of("v2", new Date(0), List.of(new double[] { HOT_CELL, 3, 400 })));
        now.set(30_000);
        assertEquals(before, scorer.calculateRouteRisks(route, EVENING).get(0).historicalExposureScore());
        now.set(61_000);
        assertEquals(2 * before, scorer.calculateRouteRisks(route, EVENING).get(0).historicalExposureScore(), 1e-9);
        assertEquals(2, loads.get());
    }

    @Test void noActiveModelOrDatabaseDownFailsHonestly() {
        var noModel = new MlRouteRiskScorer(new MlRouteRiskScorer.Source() {
            @Override public String signature() { return "none"; }
            @Override public RiskGrid load() { return null; }
        }, () -> 0L);
        assertThrows(RiskScoringException.class, () -> noModel.calculateRouteRisks(List.of(), EVENING));
        var down = new MlRouteRiskScorer(new MlRouteRiskScorer.Source() {
            @Override public String signature() throws SQLException { throw new SQLException("down"); }
            @Override public RiskGrid load() { return hotGrid(); }
        }, () -> 0L);
        assertThrows(RiskScoringException.class, () -> down.calculateRouteRisks(List.of(), EVENING));
    }

    @Test void databaseOutageAfterLoadingKeepsTheLastModel() throws Exception {
        AtomicLong now = new AtomicLong(0);
        AtomicBoolean dbUp = new AtomicBoolean(true);
        var scorer = new MlRouteRiskScorer(new MlRouteRiskScorer.Source() {
            @Override public String signature() throws SQLException {
                if (!dbUp.get()) throw new SQLException("down");
                return "v1";
            }
            @Override public RiskGrid load() { return hotGrid(); }
        }, now::get);
        var route = List.of(northSouth("r", HOT_LNG, 840));
        double before = scorer.calculateRouteRisks(route, EVENING).get(0).historicalExposureScore();
        dbUp.set(false);
        now.set(120_000);
        assertEquals(before, scorer.calculateRouteRisks(route, EVENING).get(0).historicalExposureScore());
    }

    @Test void invalidRiskRowsAreRejected() {
        assertThrows(IllegalArgumentException.class, () -> RiskGrid.of("x", null, List.of(new double[] { 80, 0, 1 })));
        assertThrows(IllegalArgumentException.class, () -> RiskGrid.of("x", null, List.of(new double[] { 1, 4, 1 })));
        assertThrows(IllegalArgumentException.class, () -> RiskGrid.of("x", null, List.of(new double[] { 1, 0, -1 })));
    }

    @Test void plugsIntoTheEngineThroughTheAgreedInterface() throws Exception {
        RoutingService routing = request -> new RoutingResponse(List.of(northSouth("hot", HOT_LNG, 720),
                northSouth("quiet", -122.3100, 780)), List.of());
        var result = new RouteRecommendationEngine(routing, MlRouteRiskScorer.fixed(hotGrid()), new RecommendationService())
                .recommend(new RouteRequest(new Coordinate(HOT_LNG, 47.61), new Coordinate(HOT_LNG, 47.62),
                        TravelMode.WALKING, EVENING));
        assertEquals("quiet", result.recommendedRoute().routeId());
        assertTrue(result.explanation().contains("adds 1 min"));
        assertTrue(result.warnings().stream().anyMatch(w -> w.contains("risk model test-model")));
    }
}
