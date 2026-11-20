package crimeradar.api;

import crimeradar.model.*;
import crimeradar.service.*;
import crimeradar.service.RecommendationSettings.Preference;
import crimeradar.util.Json;
import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

/** The JSON contract of POST api/routes/recommend, without a servlet container. */
class RouteRecommendServletTest {

    @SuppressWarnings("unchecked")
    private static Map<String, Object> body(String json) { return (Map<String, Object>) Json.parse(json); }

    private static final String TWO_ROUTES = """
            {"mode":"walk","departAt":"2026-11-19T21:15","safetyWeight":0.5,"routes":[
              {"id":"R1","duration":720,"distance":1000,"coords":[[47.6100,-122.3208],[47.6200,-122.3208]]},
              {"id":"R2","duration":840,"distance":1200,"coords":[[47.6100,-122.3208],[47.6150,-122.3100],[47.6200,-122.3208]]}]}
            """;

    @Test void parsesAValidRequest() {
        Map<String, Object> b = body(TWO_ROUTES);
        assertEquals(TravelMode.WALKING, RouteRecommendServlet.parseMode(b.get("mode")));
        assertEquals(21, RouteRecommendServlet.parseDeparture(b.get("departAt")).getHour());
        assertEquals(Preference.BALANCED, RouteRecommendServlet.parsePreference(b));
        List<RouteOption> routes = RouteRecommendServlet.parseRoutes(b.get("routes"), TravelMode.WALKING);
        assertEquals(2, routes.size());
        // [lat, lng] in, Coordinate(longitude, latitude) inside.
        assertEquals(new Coordinate(-122.3208, 47.61), routes.get(0).geometry().get(0));
    }

    @Test void rejectsBadInputWith400() {
        for (String json : List.of(
                "{\"mode\":\"fly\"}",
                "{\"mode\":\"walk\",\"routes\":[]}",
                "{\"mode\":\"walk\",\"routes\":[{\"duration\":-1,\"distance\":10,\"coords\":[[47.6,-122.3],[47.61,-122.3]]}]}",
                "{\"mode\":\"walk\",\"routes\":[{\"duration\":60,\"distance\":10,\"coords\":[[47.6,-122.3]]}]}",
                "{\"mode\":\"walk\",\"routes\":[{\"duration\":60,\"distance\":10,\"coords\":[[95,-122.3],[47.61,-122.3]]}]}",
                "{\"mode\":\"walk\",\"departAt\":\"tonight\"}",
                "{\"mode\":\"walk\",\"preference\":\"bravest\"}")) {
            Map<String, Object> b = body(json);
            ApiException e = assertThrows(ApiException.class, () -> {
                TravelMode mode = RouteRecommendServlet.parseMode(b.get("mode"));
                RouteRecommendServlet.parseDeparture(b.get("departAt"));
                RouteRecommendServlet.parsePreference(b);
                RouteRecommendServlet.parseRoutes(b.get("routes"), mode);
            }, json);
            assertEquals(400, e.getStatus(), json);
        }
        List<Object> six = new ArrayList<>();
        for (int i = 0; i < 6; i++) six.add(body(TWO_ROUTES).get("routes"));
        assertThrows(ApiException.class, () -> RouteRecommendServlet.parseRoutes(six, TravelMode.WALKING));
    }

    @Test void responseListsEveryRouteWithExposureAndLimit() throws Exception {
        Map<String, Object> b = body(TWO_ROUTES);
        List<RouteOption> routes = RouteRecommendServlet.parseRoutes(b.get("routes"), TravelMode.WALKING);
        Map<String, RouteRiskScore> scores = Map.of(
                "R1", new RouteRiskScore("R1", 80d, new DataQuality(null, 1.0, false, List.of())),
                "R2", new RouteRiskScore("R2", 40d, new DataQuality(null, 1.0, false, List.of())));
        RecommendationResult result = new RecommendationService().recommend(List.of(
                routes.get(0).withRisk(scores.get("R1")), routes.get(1).withRisk(scores.get("R2"))), TravelMode.WALKING);
        Map<String, Object> out = RouteRecommendServlet.response(result, routes, scores, Preference.BALANCED);
        assertEquals("R2", out.get("recommendedId"));
        assertEquals("R1", out.get("fastestId"));
        assertEquals(900.0, out.get("maximumAllowedSeconds")); // 720 + min(25% = 180, 300)
        assertTrue(((String) out.get("explanation")).contains("50% lower"));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> per = (List<Map<String, Object>>) out.get("routes");
        assertEquals(80.0, per.get(0).get("exposure"));
        assertEquals(-50.0, per.get(1).get("vsFastestPercent"));
        assertEquals(true, per.get(1).get("withinLimit"));
        assertNotNull(Json.write(out));
    }
}
