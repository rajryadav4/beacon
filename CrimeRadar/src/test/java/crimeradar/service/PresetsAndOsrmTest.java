package crimeradar.service;

import crimeradar.model.*;
import crimeradar.service.RecommendationSettings.Preference;
import crimeradar.util.Json;
import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class PresetsAndOsrmTest {

    @Test void safetyWeightPicksAPreset() {
        assertEquals(Preference.FASTEST, Preference.fromSafetyWeight(0));
        assertEquals(Preference.FASTEST, Preference.fromSafetyWeight(0.33));
        assertEquals(Preference.BALANCED, Preference.fromSafetyWeight(0.34));
        assertEquals(Preference.BALANCED, Preference.fromSafetyWeight(0.66));
        assertEquals(Preference.SAFER, Preference.fromSafetyWeight(0.70)); // the app's default
        assertThrows(IllegalArgumentException.class, () -> Preference.fromSafetyWeight(1.5));
        assertEquals(Preference.SAFER, Preference.parse("Safer"));
        assertThrows(IllegalArgumentException.class, () -> Preference.parse("bravest"));
    }

    @Test void presetLimits() {
        assertEquals(RecommendationSettings.defaults(), RecommendationSettings.forPreference(Preference.BALANCED));
        var fastest = RecommendationSettings.forPreference(Preference.FASTEST);
        for (TravelMode mode : TravelMode.values()) {
            assertEquals(0, fastest.detourLimits().get(mode).allowedAdditionalSeconds(3600));
        }
        var safer = RecommendationSettings.forPreference(Preference.SAFER);
        assertEquals(360, safer.detourLimits().get(TravelMode.WALKING).allowedAdditionalSeconds(720)); // 50% of 12 min
        assertEquals(600, safer.detourLimits().get(TravelMode.WALKING).allowedAdditionalSeconds(3600)); // 10-min cap
        assertEquals(0.10, safer.meaningfulImprovementFraction());
    }

    @Test void travelModeNames() {
        assertEquals(TravelMode.CYCLING, TravelMode.parse("bike"));
        assertEquals(TravelMode.DRIVING, TravelMode.parse("DRIVING"));
        assertEquals(TravelMode.WALKING, TravelMode.parse(" walk "));
        assertEquals("routed-foot", TravelMode.WALKING.osrmService());
        assertThrows(IllegalArgumentException.class, () -> TravelMode.parse("flying"));
        assertThrows(IllegalArgumentException.class, () -> TravelMode.parse(null));
    }

    @Test void readsAnOsrmResponse() throws Exception {
        String body = """
                {"code":"Ok","routes":[
                  {"distance":1234.5,"duration":650.2,"geometry":{"type":"LineString","coordinates":[[-122.33,47.60],[-122.32,47.62]]}},
                  {"distance":1300,"duration":700,"geometry":{"type":"LineString","coordinates":[[-122.33,47.60],[-122.325,47.61],[-122.32,47.62]]}}],
                 "waypoints":[]}
                """;
        RoutingResponse r = OsrmRoutingService.mapResponse(body, TravelMode.CYCLING);
        assertEquals(2, r.routes().size());
        RouteOption first = r.routes().get(0);
        assertEquals(TravelMode.CYCLING, first.travelMode());
        assertEquals(1234.5, first.distanceMeters());
        assertEquals(650.2, first.durationSeconds());
        assertEquals(new Coordinate(-122.33, 47.60), first.geometry().get(0));
        assertTrue(first.routeId().startsWith("osrm-"));
        assertNotEquals(first.routeId(), r.routes().get(1).routeId());
        assertNull(first.historicalExposureScore()); // only the scorer supplies exposure
    }

    @Test void osrmNoRouteAndErrors() throws Exception {
        assertTrue(OsrmRoutingService.mapResponse("{\"code\":\"NoRoute\"}", TravelMode.WALKING).routes().isEmpty());
        var e = assertThrows(RoutingException.class,
                () -> OsrmRoutingService.mapResponse("{\"code\":\"InvalidQuery\",\"message\":\"Bad coords\"}", TravelMode.WALKING));
        assertTrue(e.getMessage().contains("Bad coords"));
        assertThrows(RoutingException.class, () -> OsrmRoutingService.mapResponse("not json", TravelMode.WALKING));
        assertThrows(RoutingException.class, () -> OsrmRoutingService.mapResponse(
                "{\"code\":\"Ok\",\"routes\":[{\"distance\":\"far\"}]}", TravelMode.WALKING));
    }

    @Test void recommendationJsonKeepsTheRecordShape() {
        var route = new RouteOption("a", TravelMode.WALKING, 1000, 600,
                List.of(new Coordinate(-122.33, 47.60), new Coordinate(-122.32, 47.62)), null, null);
        var result = new RecommendationService().recommend(List.of(route), TravelMode.WALKING);
        String json = Json.write(RecommendationJson.result(result));
        @SuppressWarnings("unchecked")
        Map<String, Object> m = (Map<String, Object>) Json.parse(json);
        assertEquals(Set.of("recommendedRoute", "fastestRoute", "lowestExposureRoute", "alternativeRoutes",
                "explanation", "comparisonMetrics", "warnings"), m.keySet());
        @SuppressWarnings("unchecked")
        Map<String, Object> rec = (Map<String, Object>) m.get("recommendedRoute");
        assertEquals("WALKING", rec.get("travelMode"));
        assertTrue(rec.containsKey("historicalExposureScore"));
        assertNull(rec.get("historicalExposureScore"));
        assertTrue(json.contains("\"longitude\":-122.33"));
    }
}
