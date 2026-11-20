package crimeradar.service;

import crimeradar.util.Json;
import com.sun.net.httpserver.HttpServer;
import crimeradar.model.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import static org.junit.jupiter.api.Assertions.*;

class OpenRouteServiceClientTest {
    private HttpServer server;
    private ExecutorService executor;
    private URI base;
    private final AtomicInteger calls = new AtomicInteger();
    private final AtomicReference<String> path = new AtomicReference<>();
    private final AtomicReference<String> body = new AtomicReference<>();
    private final AtomicReference<String> auth = new AtomicReference<>();
    private volatile int status = 200;
    private volatile boolean recoverOnRetry;
    private volatile long delayMillis;
    private volatile String retryAfter;
    private volatile String response = validResponse();

    @BeforeEach void startServer() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        executor = Executors.newCachedThreadPool(); server.setExecutor(executor);
        server.createContext("/directions/", exchange -> {
            int call = calls.incrementAndGet();
            path.set(exchange.getRequestURI().getPath());
            auth.set(exchange.getRequestHeaders().getFirst("Authorization"));
            body.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            try {
                Thread.sleep(delayMillis);
                byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "application/geo+json");
                if (retryAfter != null) exchange.getResponseHeaders().set("Retry-After", retryAfter);
                exchange.sendResponseHeaders(recoverOnRetry && call > 1 ? 200 : status, bytes.length);
                exchange.getResponseBody().write(bytes);
            } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            finally { exchange.close(); }
        });
        server.start();
        base = URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/directions/");
    }
    @AfterEach void stopServer() {
        if (server != null) server.stop(0);
        if (executor != null) executor.shutdownNow();
    }
    private OpenRouteServiceClient client() { return new OpenRouteServiceClient(base, "test-key", Duration.ofSeconds(1), Duration.ofSeconds(2)); }
    private RouteRequest request(TravelMode mode) {
        return new RouteRequest(new Coordinate(-122.33, 47.60), new Coordinate(-122.32, 47.62), mode,
                LocalDateTime.of(2026, 11, 18, 17, 0));
    }
    @SuppressWarnings("unchecked")
    private static Map<String, Object> obj(Object o) { return (Map<String, Object>) o; }
    @SuppressWarnings("unchecked")
    private static List<Object> arr(Object o) { return (List<Object>) o; }
    private static double num(Object o) { return ((Number) o).doubleValue(); }
    private static String validResponse() {
        return """
                {"type":"FeatureCollection","metadata":{"attribution":"ORS; OSM"},"features":[
                  {"type":"Feature","properties":{"summary":{"distance":1234.5,"duration":650.2},
                    "warnings":[{"code":1,"message":"Check road conditions"}]},
                   "geometry":{"type":"LineString","coordinates":[[-122.33,47.60],[-122.32,47.62]]}},
                  {"type":"Feature","properties":{"summary":{"distance":1300,"duration":700}},
                   "geometry":{"type":"LineString","coordinates":[[-122.33,47.60],[-122.325,47.61],[-122.32,47.62]]}}]}
                """;
    }
    @ParameterizedTest @EnumSource(TravelMode.class) void requestAndResponseMapping(TravelMode mode) throws Exception {
        var result = client().generateRoutes(request(mode));
        assertEquals("/directions/" + mode.orsProfile() + "/geojson", path.get());
        assertEquals("test-key", auth.get());
        Map<String, Object> sent = obj(Json.parse(body.get()));
        assertEquals(-122.33, num(arr(arr(sent.get("coordinates")).get(0)).get(0)));
        assertEquals(3, num(obj(sent.get("alternative_routes")).get("target_count")));
        assertEquals("fastest", sent.get("preference"));
        assertFalse(sent.containsKey("departure"));
        assertEquals(2, result.routes().size());
        var route = result.routes().get(0);
        assertEquals(mode, route.travelMode()); assertEquals(1234.5, route.distanceMeters()); assertEquals(650.2, route.durationSeconds());
        assertEquals(new Coordinate(-122.33, 47.60), route.geometry().get(0));
        assertNull(route.historicalExposureScore());
        assertTrue(result.warnings().stream().anyMatch(w -> w.contains("Check road conditions")));
        assertTrue(result.warnings().stream().anyMatch(w -> w.contains("without live traffic")));
        assertEquals(route.routeId(), client().generateRoutes(request(mode)).routes().get(0).routeId());
    }
    @ParameterizedTest @ValueSource(ints = {400, 401, 403, 404, 422, 429, 500})
    void nonSuccessDoesNotRetryOrLeakProviderBody(int code) {
        status = code; response = "secret upstream body test-key";
        var error = assertThrows(RoutingException.class, () -> client().generateRoutes(request(TravelMode.WALKING)));
        assertTrue(error.getMessage().contains("HTTP " + code));
        assertFalse(error.getMessage().contains("test-key")); assertEquals(1, calls.get());
    }
    @ParameterizedTest @ValueSource(ints = {502, 503, 504}) void transientFailureRetriesOnlyOnce(int code) throws Exception {
        status = code; recoverOnRetry = true;
        assertEquals(2, client().generateRoutes(request(TravelMode.WALKING)).routes().size()); assertEquals(2, calls.get());
    }
    @Test void persistentTransientFailureStopsAfterTwoCalls() {
        status = 503;
        assertThrows(RoutingException.class, () -> client().generateRoutes(request(TravelMode.WALKING))); assertEquals(2, calls.get());
    }
    @Test void retryAfterDoesNotTriggerAnEarlyRetry() {
        status = 503; retryAfter = "60";
        assertThrows(RoutingException.class, () -> client().generateRoutes(request(TravelMode.WALKING)));
        assertEquals(1, calls.get());
    }
    @Test void emptyRoutesAreAValidEmptyResponse() throws Exception {
        response = "{\"type\":\"FeatureCollection\",\"features\":[]}";
        assertTrue(client().generateRoutes(request(TravelMode.WALKING)).routes().isEmpty());
    }
    @ParameterizedTest @ValueSource(strings = {"", "<html>Error</html>", "{}", "{\"type\":\"FeatureCollection\"}",
            "{\"type\":\"FeatureCollection\",\"features\":[{}]}", "{\"type\":\"FeatureCollection\",\"features\":null}",
            "{\"type\":\"FeatureCollection\",\"features\":[]} trailing"})
    void malformedResponsesFailClearly(String malformed) {
        response = malformed;
        assertTrue(assertThrows(RoutingException.class, () -> client().generateRoutes(request(TravelMode.WALKING)))
                .getMessage().contains("invalid GeoJSON")); assertEquals(1, calls.get());
    }
    @Test void invalidNumericAndGeometryValuesRejected() {
        for (String invalid : List.of(validResponse().replace("650.2", "-1"), validResponse().replace("650.2", "\"650\""),
                validResponse().replace("-122.33", "-222.33"), validResponse().replace("LineString", "Polygon"))) {
            response = invalid;
            assertThrows(RoutingException.class, () -> client().generateRoutes(request(TravelMode.WALKING)));
        }
    }
    @Test void requestTimeoutIsBoundedAndNotRetried() {
        delayMillis = 500;
        var shortTimeout = new OpenRouteServiceClient(base, "test-key", Duration.ofSeconds(1), Duration.ofMillis(100));
        assertTimeoutPreemptively(Duration.ofSeconds(2), () -> assertTrue(assertThrows(RoutingException.class,
                () -> shortTimeout.generateRoutes(request(TravelMode.DRIVING))).getMessage().contains("timed out")));
        assertTrue(calls.get() <= 1);
    }
    @Test void connectionFailureHasClearMessage() {
        server.stop(0);
        assertTrue(assertThrows(RoutingException.class, () -> client().generateRoutes(request(TravelMode.WALKING)))
                .getMessage().contains("Could not connect"));
    }
    @Test void requestValidationDoesNotUseNetwork() {
        assertThrows(IllegalArgumentException.class, () -> new Coordinate(Double.NaN, 47));
        assertThrows(IllegalArgumentException.class, () -> new Coordinate(-122, 91));
        assertThrows(IllegalArgumentException.class, () -> new RouteRequest(request(TravelMode.WALKING).origin(),
                request(TravelMode.WALKING).origin(), TravelMode.WALKING, LocalDateTime.now()));
        assertThrows(IllegalArgumentException.class, () -> client().generateRoutes(null));
        assertThrows(IllegalArgumentException.class, () -> client().generateRoutes(new RouteRequest(new Coordinate(0, 0),
                new Coordinate(5, 5), TravelMode.WALKING, LocalDateTime.now())));
        assertEquals(0, calls.get());
    }
    @Test void clientConfigurationValidation() {
        assertThrows(IllegalArgumentException.class, () -> new OpenRouteServiceClient(""));
        assertThrows(IllegalArgumentException.class, () -> new OpenRouteServiceClient(URI.create("http://example.com/"),
                "key", Duration.ofSeconds(1), Duration.ofSeconds(1)));
        assertThrows(IllegalArgumentException.class, () -> new OpenRouteServiceClient(base, "key", Duration.ZERO, Duration.ofSeconds(1)));
    }
}
