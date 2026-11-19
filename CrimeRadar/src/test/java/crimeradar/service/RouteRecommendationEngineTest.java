package crimeradar.service;

import crimeradar.model.*;
import org.junit.jupiter.api.Test;
import java.time.LocalDateTime;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static crimeradar.service.RecommendationServiceTest.route;

class RouteRecommendationEngineTest {
    private final RouteRequest request = new RouteRequest(new Coordinate(-122.33, 47.60), new Coordinate(-122.32, 47.62),
            TravelMode.WALKING, LocalDateTime.of(2026, 11, 18, 17, 0));
    private final RoutingService routing = r -> new RoutingResponse(List.of(route("a", 600, 0d), route("b", 700, 0d)), List.of("Provider warning"));

    @Test void completeWorkflowWithClearlyLabeledMockScores() throws Exception {
        var result = new RouteRecommendationEngine(routing, new MockRouteRiskScorer(Map.of("a", 100d, "b", 70d)),
                new RecommendationService()).recommend(request);
        assertEquals("b", result.recommendedRoute().routeId());
        assertTrue(result.warnings().contains("Provider warning"));
        assertTrue(result.warnings().stream().anyMatch(w -> w.startsWith("DEMONSTRATION DATA")));
    }
    @Test void scorerReceivesTimeModeAndUniqueUnscoredGeometry() throws Exception {
        RoutingService source = r -> new RoutingResponse(List.of(route("a", 600, 123d), route("a", 600, 123d),
                route("car", TravelMode.DRIVING, 10, 0d)), List.of());
        RouteRiskScorer scorer = (routes, departure) -> {
            assertEquals(request.departureTime(), departure); assertEquals(1, routes.size());
            assertEquals(TravelMode.WALKING, routes.getFirst().travelMode());
            assertNull(routes.getFirst().historicalExposureScore()); assertFalse(routes.getFirst().geometry().isEmpty());
            return List.of();
        };
        new RouteRecommendationEngine(source, scorer, new RecommendationService()).recommend(request);
    }
    @Test void providerExposureDoesNotCreateConflictingDuplicatesOrQualityWarnings() throws Exception {
        RouteOption first = route("a", 600, 100d);
        RouteOption duplicate = first.withRisk(new RouteRiskScore("a", 0d,
                new DataQuality(null, null, true, List.of("Untrusted provider scoring metadata"))));
        RoutingService source = r -> new RoutingResponse(List.of(first, duplicate), List.of());
        RouteRiskScorer scorer = (routes, departure) -> {
            assertEquals(1, routes.size());
            assertEquals(first.geometry(), routes.getFirst().geometry());
            assertNull(routes.getFirst().historicalExposureScore());
            assertNull(routes.getFirst().dataQuality());
            return List.of(new RouteRiskScore("a", 42d, null));
        };

        RecommendationResult result = new RouteRecommendationEngine(source, scorer, new RecommendationService())
                .recommend(request);
        assertEquals(42d, result.recommendedRoute().historicalExposureScore());
        assertFalse(result.warnings().stream().anyMatch(w -> w.contains("provider scoring metadata")
                || w.contains("conflicting") || w.startsWith("DEMONSTRATION DATA")));
    }
    @Test void nullScoringResponseAndUnrelatedScoresLeaveExposureUnavailable() throws Exception {
        for (RouteRiskScorer scorer : List.<RouteRiskScorer>of((routes, time) -> null,
                (routes, time) -> List.of(new RouteRiskScore("unknown-route", 0d, null)))) {
            RecommendationResult result = new RouteRecommendationEngine(routing, scorer, new RecommendationService())
                    .recommend(request);
            assertEquals("a", result.recommendedRoute().routeId());
            assertNull(result.recommendedRoute().historicalExposureScore());
            assertNull(result.comparisonMetrics().exposureImprovementFraction());
        }
    }
    @Test void outageFallsBackWithoutInventingScores() throws Exception {
        var result = new RouteRecommendationEngine(routing, (routes, time) -> { throw new RiskScoringException("SQL unavailable"); },
                new RecommendationService()).recommend(request);
        assertEquals("a", result.recommendedRoute().routeId()); assertNull(result.recommendedRoute().historicalExposureScore());
        assertTrue(result.warnings().stream().anyMatch(w -> w.contains("temporarily unavailable")));
    }
    @Test void duplicateScoresAreNotArbitrarilyChosen() throws Exception {
        var result = new RouteRecommendationEngine(routing, (routes, time) -> List.of(new RouteRiskScore("a", 100d, null),
                new RouteRiskScore("a", 1d, null), new RouteRiskScore("b", 0d, null)), new RecommendationService()).recommend(request);
        assertEquals("a", result.recommendedRoute().routeId()); assertNull(result.fastestRoute().historicalExposureScore());
    }
    @Test void noRoutesDoesNotCallScorer() throws Exception {
        var result = new RouteRecommendationEngine(r -> new RoutingResponse(List.of(), List.of()),
                (routes, time) -> { fail("Should not score empty routes"); return null; }, new RecommendationService()).recommend(request);
        assertNull(result.recommendedRoute());
    }
    @Test void routingErrorPropagates() {
        assertThrows(RoutingException.class, () -> new RouteRecommendationEngine(r -> { throw new RoutingException("Provider down"); },
                new MockRouteRiskScorer(Map.of()), new RecommendationService()).recommend(request));
    }
}
