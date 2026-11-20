package crimeradar.servlet;

import crimeradar.util.Json;
import crimeradar.model.*;
import crimeradar.service.*;
import org.apache.catalina.startup.Tomcat;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import java.net.*;
import java.net.http.*;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.jupiter.api.Assertions.*;

/** Runs the real servlet and JSP compiler on embedded Tomcat 9 (javax) with mock external services. */
class RecommendRoutesWebTest {
    @TempDir Path temp;
    private Tomcat tomcat;
    private URI base;
    private final AtomicReference<RoutingService> routing = new AtomicReference<>(request -> new RoutingResponse(
            List.of(new RouteOption("route-a", request.travelMode(), 1000, 600,
                    List.of(request.origin(), request.destination()), null, null)), List.of()));
    private org.apache.catalina.Context context;
    private static final String QUERY = "?originLon=-122.33&originLat=47.60&destinationLon=-122.32&destinationLat=47.62&mode=walking&departureTime=2026-11-18T17:00:00";

    @BeforeEach void start() throws Exception {
        Path web = Files.createDirectory(temp.resolve("web"));
        Files.copy(Path.of("src/main/webapp/FindIncidents.jsp"), web.resolve("FindIncidents.jsp"));
        tomcat = new Tomcat(); tomcat.setBaseDir(temp.resolve("tomcat").toString()); tomcat.setPort(0);
        tomcat.getConnector().setProperty("address", "127.0.0.1");
        context = tomcat.addWebapp("/CrimeRadar", web.toString());
        context.setParentClassLoader(getClass().getClassLoader());
        context.getServletContext().setAttribute(RecommendRoutes.ROUTING_SERVICE_ATTRIBUTE,
                (RoutingService) request -> routing.get().generateRoutes(request));
        Tomcat.addServlet(context, "recommend", new RecommendRoutes());
        context.addServletMappingDecoded("/recommendroutes", "recommend");
        // Keep routing unset regardless of a developer's real ORS_API_KEY.
        // This exercises the HTTP handler's missing-configuration response.
        Tomcat.addServlet(context, "unconfigured", new RecommendRoutes() {
            @Override public void init() { }
        });
        context.addServletMappingDecoded("/unconfigured", "unconfigured");
        tomcat.start();
        base = URI.create("http://127.0.0.1:" + tomcat.getConnector().getLocalPort() + "/CrimeRadar/");
    }
    @SuppressWarnings("unchecked")
    private static Map<String, Object> obj(Object o) { return (Map<String, Object>) o; }
    private static Map<String, Object> json(String body) { return obj(Json.parse(body)); }
    @AfterEach void stop() throws Exception { if (tomcat != null) { tomcat.stop(); tomcat.destroy(); } }
    private HttpResponse<String> get(String path) throws Exception {
        return HttpClient.newHttpClient().send(HttpRequest.newBuilder(base.resolve(path)).timeout(Duration.ofSeconds(20)).GET().build(),
                HttpResponse.BodyHandlers.ofString());
    }
    @Test void servletReturnsRealResultAndMissingScoreWarning() throws Exception {
        var response = get("recommendroutes" + QUERY);
        assertEquals(200, response.statusCode());
        assertTrue(response.headers().firstValue("Content-Type").orElseThrow().contains("application/json"));
        assertEquals("no-store", response.headers().firstValue("Cache-Control").orElseThrow());
        var json = json(response.body());
        assertEquals("WALKING", obj(json.get("recommendedRoute")).get("travelMode"));
        assertNull(obj(json.get("recommendedRoute")).get("historicalExposureScore"));
        assertTrue(((String) json.get("explanation")).contains("could not be evaluated"));
    }
    @Test void personOneCanRegisterScorerWithoutChangingRecommendationCode() throws Exception {
        context.getServletContext().setAttribute(RecommendRoutes.RISK_SCORER_ATTRIBUTE, (RouteRiskScorer) (routes, time) -> {
            assertEquals(17, time.getHour());
            return List.of(new RouteRiskScore(routes.get(0).routeId(), 42d,
                    new DataQuality(null, null, true, List.of("Web test fixture"))));
        });
        var json = json(get("recommendroutes" + QUERY.replace("walking", "cycling")).body());
        assertEquals("CYCLING", obj(json.get("recommendedRoute")).get("travelMode"));
        assertEquals(42, ((Number) obj(json.get("recommendedRoute")).get("historicalExposureScore")).doubleValue());
        assertTrue(json.get("warnings").toString().contains("DEMONSTRATION DATA"));
    }
    @Test void invalidInputsReturn400BeforeRouting() throws Exception {
        routing.set(r -> { fail("Routing must not be called for invalid input"); return null; });
        for (String query : List.of("", QUERY.replace("walking", "flying"), QUERY.replace("47.60", "NaN"),
                QUERY.replace("47.60", "Infinity"), QUERY.replace("47.60", "91"),
                QUERY.replace("-122.33", "-181"), QUERY.replace("47.60", "47.62").replace("-122.33", "-122.32"),
                QUERY.replace("2026-11-18T17:00:00", "tomorrow"),
                QUERY.replace("2026-11-18T17:00:00", "2026-02-30T17:00:00"),
                QUERY.replace("2026-11-18T17:00:00", "2026-03-08T02:30:00"))) {
            HttpResponse<String> response = get("recommendroutes" + query);
            assertEquals(400, response.statusCode());
            assertTrue(json(response.body()).containsKey("error"));
        }
    }
    @Test void missingRoutingConfigurationReturns503AndInvalidRequestsStillReturn400() throws Exception {
        HttpResponse<String> response = get("unconfigured" + QUERY);
        assertEquals(503, response.statusCode());
        assertTrue(((String) json(response.body()).get("error")).contains("ORS_API_KEY"));
        assertEquals(400, get("unconfigured").statusCode());
    }
    @Test void scoringOutageReturns200WithAnHonestFallback() throws Exception {
        context.getServletContext().setAttribute(RecommendRoutes.RISK_SCORER_ATTRIBUTE,
                (RouteRiskScorer) (routes, time) -> { throw new RiskScoringException("Database unavailable"); });
        HttpResponse<String> response = get("recommendroutes" + QUERY);
        assertEquals(200, response.statusCode());
        Map<String, Object> json = json(response.body());
        assertEquals("route-a", obj(json.get("recommendedRoute")).get("routeId"));
        assertNull(obj(json.get("recommendedRoute")).get("historicalExposureScore"));
        assertTrue(json.get("warnings").toString().contains("temporarily unavailable"));
    }
    @Test void routingFailureBecomes502() throws Exception {
        routing.set(r -> { throw new RoutingException("Routing provider returned HTTP 429."); });
        var response = get("recommendroutes" + QUERY);
        assertEquals(502, response.statusCode()); assertTrue(response.body().contains("HTTP 429"));
    }
    @Test void noRoutesReturnsStructuredEmptyResult() throws Exception {
        routing.set(r -> new RoutingResponse(List.of(), List.of("No routes")));
        var response = get("recommendroutes" + QUERY);
        assertEquals(200, response.statusCode());
        assertNull(json(response.body()).get("recommendedRoute"));
    }
    @Test void existingIncidentJspCompilesWithJstl() throws Exception {
        var response = get("FindIncidents.jsp");
        assertEquals(200, response.statusCode()); assertTrue(response.body().contains("Crime Radar: Find Incidents"));
        assertTrue(response.body().contains("neighborhoodid"));
    }
}
