package crimeradar.service;

import crimeradar.model.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.junit.jupiter.params.provider.ValueSource;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class RecommendationServiceTest {
    private final RecommendationService service = new RecommendationService();

    static RouteOption route(String id, double seconds, Double exposure) {
        return route(id, TravelMode.WALKING, seconds, exposure);
    }
    static RouteOption route(String id, TravelMode mode, double seconds, Double exposure) {
        return new RouteOption(id, mode, 1000, seconds,
                List.of(new Coordinate(-122.33, 47.60),
                        new Coordinate(-122.33 + (Math.abs(id.hashCode()) % 1000 + 1) * .000001, 47.61),
                        new Coordinate(-122.32, 47.62)), exposure, null);
    }
    private RecommendationResult compare(RouteOption... routes) { return service.recommend(List.of(routes), TravelMode.WALKING); }

    @Test void equalExposurePrefersFastest() {
        assertEquals("a", compare(route("b", 650, 100d), route("a", 600, 100d)).recommendedRoute().routeId());
    }
    @Test void reasonableDetourChoosesLowerExposureAndReportsMetrics() {
        var result = compare(route("a", 600, 100d), route("b", 700, 70d));
        assertEquals("b", result.recommendedRoute().routeId());
        assertEquals("a", result.fastestRoute().routeId());
        assertEquals("b", result.lowestExposureRoute().routeId());
        assertEquals(100, result.comparisonMetrics().additionalSeconds());
        assertEquals(.30, result.comparisonMetrics().exposureImprovementFraction(), 1e-9);
        assertTrue(result.explanation().contains("30%"));
    }
    @Test void percentageDetourRejected() {
        var result = compare(route("a", 600, 100d), route("b", 751, 1d));
        assertEquals("a", result.recommendedRoute().routeId());
        assertEquals(1, result.comparisonMetrics().eligibleRouteCount());
        assertTrue(result.alternativeRoutes().isEmpty());
    }
    @ParameterizedTest @EnumSource(TravelMode.class) void correctModeAndAbsoluteCap(TravelMode mode) {
        var settings = RecommendationSettings.defaults();
        double cap = settings.detourLimits().get(mode).maximumAdditionalSeconds();
        var result = service.recommend(List.of(route("a", mode, 3600, 100d),
                route("b", mode, 3600 + cap, 70d), route("c", mode, 3601 + cap, 1d),
                route("other", mode == TravelMode.WALKING ? TravelMode.DRIVING : TravelMode.WALKING, 10, 0d)), mode);
        assertEquals("b", result.recommendedRoute().routeId());
        assertEquals(mode, result.recommendedRoute().travelMode());
        assertEquals(cap, result.comparisonMetrics().maximumAdditionalSeconds());
    }
    @Test void zeroDetourStillAllowsEqualDurationImprovement() {
        var p = new Properties(); p.setProperty("recommendation.walking.maximumDetourFraction", "0");
        var strict = new RecommendationService(RecommendationSettings.fromProperties(p));
        assertEquals("a", strict.recommend(List.of(route("a", 600, 100d), route("b", 601, 0d)), TravelMode.WALKING).recommendedRoute().routeId());
        assertEquals("b", strict.recommend(List.of(route("a", 600, 100d), route("b", 600, 80d)), TravelMode.WALKING).recommendedRoute().routeId());
    }
    @ParameterizedTest
    @ValueSource(strings = {"maximumDetourFraction", "maximumAdditionalSeconds"})
    void zeroDetourExcludesEvenTheNextRepresentableDuration(String setting) {
        Properties properties = new Properties();
        properties.setProperty("recommendation.walking." + setting, "0");
        RecommendationService strict = new RecommendationService(RecommendationSettings.fromProperties(properties));
        RecommendationResult result = strict.recommend(List.of(route("a", 600, 100d),
                route("b", Math.nextUp(600d), 0d)), TravelMode.WALKING);

        assertEquals("a", result.recommendedRoute().routeId());
        assertEquals(1, result.comparisonMetrics().eligibleRouteCount());
    }
    @Test void justBeyondTheDetourBoundaryIsExcluded() {
        RecommendationResult result = compare(route("a", 600, 100d), route("b", Math.nextUp(750d), 0d));
        assertEquals("a", result.recommendedRoute().routeId());
        assertEquals(1, result.comparisonMetrics().eligibleRouteCount());
    }
    @Test void decimalDurationAtTheDetourBoundaryIsIncluded() {
        RecommendationResult result = compare(route("a", 600.3, 100d), route("b", 750.375, 70d));
        assertEquals("b", result.recommendedRoute().routeId());
        assertEquals(2, result.comparisonMetrics().eligibleRouteCount());
    }
    @Test void exactMeaningfulThresholdIncluded() {
        assertEquals("b", compare(route("a", 600, 100d), route("b", 700, 85d)).recommendedRoute().routeId());
        assertEquals("a", compare(route("a", 600, 100d), route("b", 700, 85.01)).recommendedRoute().routeId());
    }
    @Test void improvementJustBelowThresholdDoesNotQualify() {
        assertEquals("a", compare(route("a", 600, 100d),
                route("b", 700, 85.00000000001)).recommendedRoute().routeId());
    }
    @Test void fractionalScoresAtTheThresholdQualify() {
        assertEquals("b", compare(route("a", 600, 0.1), route("b", 700, 0.085)).recommendedRoute().routeId());
    }
    @Test void zeroThresholdStillRequiresALowerScoreAndFullImprovementAllowsZero() {
        Properties properties = new Properties();
        properties.setProperty("recommendation.meaningfulImprovementFraction", "0");
        RecommendationService anyImprovement = new RecommendationService(RecommendationSettings.fromProperties(properties));
        assertEquals("a", anyImprovement.recommend(List.of(route("a", 600, 100d),
                route("b", 700, 100d)), TravelMode.WALKING).recommendedRoute().routeId());
        properties.setProperty("recommendation.meaningfulImprovementFraction", "1");
        RecommendationService fullImprovement = new RecommendationService(RecommendationSettings.fromProperties(properties));
        assertEquals("b", fullImprovement.recommend(List.of(route("a", 600, 100d),
                route("b", 700, 0d)), TravelMode.WALKING).recommendedRoute().routeId());
    }
    @Test void thresholdIsConfigurable() {
        var p = new Properties(); p.setProperty("recommendation.meaningfulImprovementFraction", "0.30");
        assertEquals("a", new RecommendationService(RecommendationSettings.fromProperties(p))
                .recommend(List.of(route("a", 600, 100d), route("b", 700, 80d)), TravelMode.WALKING).recommendedRoute().routeId());
    }
    @Test void missingBaselineFallsBackAndNeverTreatsUnknownAsZero() {
        var result = compare(route("a", 600, null), route("b", 700, 1d));
        assertEquals("a", result.recommendedRoute().routeId());
        assertNull(result.comparisonMetrics().exposureImprovementFraction());
        assertTrue(result.explanation().contains("could not be evaluated"));
        assertFalse(result.warnings().isEmpty());
    }
    @Test void partialScoresCompareOnlyKnownRoutes() {
        RecommendationResult result = compare(route("a", 600, 100d), route("b", 700, 70d), route("c", 650, null));
        assertEquals("b", result.recommendedRoute().routeId());
        assertTrue(result.warnings().stream().anyMatch(w -> w.contains("missing scores are not zero")));
    }
    @Test void unknownAlternativeDoesNotImplyThereIsNoLowerExposureRoute() {
        RecommendationResult result = compare(route("a", 600, 100d), route("b", 700, null));
        assertEquals("a", result.recommendedRoute().routeId());
        assertTrue(result.explanation().contains("could not be scored"));
    }
    @Test void allScoresMissing() {
        var result = compare(route("a", 600, null), route("b", 700, null));
        assertEquals("a", result.recommendedRoute().routeId()); assertNull(result.lowestExposureRoute());
    }
    @Test void noAvailableRoutes() {
        assertNull(service.recommend(List.of(), TravelMode.WALKING).recommendedRoute());
        assertNull(service.recommend(null, TravelMode.WALKING).recommendedRoute());
        assertNull(compare(route("a", TravelMode.DRIVING, 600, 100d)).recommendedRoute());
    }
    @Test void singleAvailableRoute() {
        var result = compare(route("a", 600, 20d));
        assertEquals("a", result.recommendedRoute().routeId()); assertTrue(result.alternativeRoutes().isEmpty());
    }
    @Test void duplicateAndEquivalentAlternativesRemoved() {
        var a = route("a", 600, 100d);
        var equivalent = new RouteOption("b", a.travelMode(), a.distanceMeters(), a.durationSeconds(), a.geometry(), 100d, null);
        assertEquals(1, compare(a, a, equivalent).comparisonMetrics().validRouteCount());
    }
    @Test void conflictingIdsAreRejected() {
        assertNull(compare(route("a", 600, 10d), route("a", 700, 20d)).recommendedRoute());
    }
    @Test void equalDurationRoutesPreferMeaningfulLowerExposure() {
        assertEquals("b", compare(route("a", 600, 100d), route("b", 600, 80d)).recommendedRoute().routeId());
    }
    @Test void deterministicTieBreakingIndependentOfInputOrder() {
        var routes = new ArrayList<>(List.of(route("c", 600, 100d), route("b", 600, 100d), route("a", 600, 100d)));
        for (int i = 0; i < 20; i++) {
            Collections.shuffle(routes, new Random(i));
            assertEquals("a", service.recommend(routes, TravelMode.WALKING).recommendedRoute().routeId());
        }
        assertEquals("b", compare(route("a", 600, 100d), route("c", 650, 70d), route("b", 650, 70d)).recommendedRoute().routeId());
    }
    @Test void equalDurationsUseDistanceBeforeIdentifier() {
        RouteOption shorter = route("z", 600, 100d);
        RouteOption longer = route("a", 600, 100d);
        longer = new RouteOption(longer.routeId(), longer.travelMode(), 2000, longer.durationSeconds(),
                longer.geometry(), longer.historicalExposureScore(), null);
        assertEquals("z", compare(longer, shorter).fastestRoute().routeId());
        assertEquals("z", compare(shorter, longer).recommendedRoute().routeId());
    }
    @ParameterizedTest @ValueSource(doubles = {0, -1, Double.NaN, Double.POSITIVE_INFINITY})
    void invalidDurationsRejected(double value) { assertNull(compare(route("a", value, 100d)).recommendedRoute()); }

    @ParameterizedTest @ValueSource(doubles = {-1, Double.NaN, Double.POSITIVE_INFINITY})
    void invalidExposureTreatedAsMissing(double value) {
        var result = compare(route("a", 600, value), route("b", 700, 0d));
        assertEquals("a", result.recommendedRoute().routeId()); assertNull(result.fastestRoute().historicalExposureScore());
    }
    @Test void zeroExposureIsValidAndDoesNotDivideByZero() {
        assertEquals(0d, compare(route("a", 600, 0d), route("b", 650, 0d)).comparisonMetrics().exposureImprovementFraction());
    }
    @Test void invalidGeometryAndDistanceAreRejected() {
        var a = route("a", 600, 1d);
        assertNull(compare(new RouteOption("a", a.travelMode(), -1, 600, a.geometry(), 1d, null)).recommendedRoute());
        assertNull(compare(new RouteOption("a", a.travelMode(), 100, 600, List.of(), 1d, null)).recommendedRoute());
        assertNull(compare(new RouteOption("a", a.travelMode(), 100, 600,
                List.of(a.geometry().get(0), a.geometry().get(0)), 1d, null)).recommendedRoute());
        for (double distance : new double[] {0, Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY}) {
            assertNull(compare(new RouteOption("a", a.travelMode(), distance, 600, a.geometry(), 1d, null)).recommendedRoute());
        }
        assertEquals("a", service.recommend(Arrays.asList(null, a), TravelMode.WALKING).recommendedRoute().routeId());
    }
    @Test void demonstrationDataIsLabeled() {
        var a = route("a", 600, 1d).withRisk(new RouteRiskScore("a", 1d,
                new DataQuality(null, null, true, List.of("Test fixture"))));
        assertTrue(compare(a).warnings().stream().anyMatch(w -> w.startsWith("DEMONSTRATION DATA")));
    }
    @Test void invalidSettingsFailEarly() {
        var p = new Properties(); p.setProperty("recommendation.walking.maximumAdditionalSeconds", "-1");
        assertThrows(IllegalArgumentException.class, () -> RecommendationSettings.fromProperties(p));
        assertThrows(IllegalArgumentException.class, () -> new RecommendationSettings(Map.of(), .15));
    }
}
