package crimeradar.service;

import java.io.IOException;
import java.math.BigDecimal;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import crimeradar.model.Coordinate;
import crimeradar.model.RouteOption;
import crimeradar.model.RouteRequest;
import crimeradar.model.RoutingResponse;
import crimeradar.model.TravelMode;
import crimeradar.util.Json;

/**
 * ORS Directions GeoJSON adapter. No live traffic or future traffic
 * assumptions.
 * At most one retry for explicit transient gateway/service errors; never retry
 * quota,
 * authentication, malformed responses, timeouts, or ambiguous connection
 * failures.
 */
public final class OpenRouteServiceClient implements RoutingService {
    public static final URI DEFAULT_DIRECTIONS_URI = URI
            .create("https://api.heigit.org/openrouteservice/v2/directions/");
    private static final double MAX_ALTERNATIVE_DISTANCE_METERS = 100_000;
    private final HttpClient client;
    private final URI directionsUri;
    private final String apiKey;
    private final Duration requestTimeout;

    public OpenRouteServiceClient(String apiKey) {
        this(DEFAULT_DIRECTIONS_URI, apiKey, Duration.ofSeconds(5), Duration.ofSeconds(20));
    }

    public OpenRouteServiceClient(URI directionsUri, String apiKey, Duration connectTimeout, Duration requestTimeout) {
        if (apiKey == null || apiKey.isBlank() || apiKey.contains("\n") || apiKey.contains("\r")) {
            throw new IllegalArgumentException("Set ORS_API_KEY on the server before requesting routes.");
        }
        if (directionsUri == null || directionsUri.getHost() == null || !directionsUri.getPath().endsWith("/")
                || directionsUri.getUserInfo() != null || directionsUri.getQuery() != null
                || directionsUri.getFragment() != null
                || !("https".equals(directionsUri.getScheme()) || ("http".equals(directionsUri.getScheme())
                        && Set.of("localhost", "127.0.0.1", "[::1]").contains(directionsUri.getHost())))) {
            throw new IllegalArgumentException(
                    "ORS directions URI must use HTTPS and end in '/'; HTTP is allowed only for loopback tests.");
        }
        if (connectTimeout == null || connectTimeout.isNegative() || connectTimeout.isZero()
                || requestTimeout == null || requestTimeout.isNegative() || requestTimeout.isZero()) {
            throw new IllegalArgumentException("Routing timeouts must be positive.");
        }
        this.client = HttpClient.newBuilder().connectTimeout(connectTimeout).followRedirects(HttpClient.Redirect.NEVER)
                .build();
        this.directionsUri = directionsUri;
        this.apiKey = apiKey;
        this.requestTimeout = requestTimeout;
    }

    @Override
    public RoutingResponse generateRoutes(RouteRequest request) throws RoutingException {
        if (request == null)
            throw new IllegalArgumentException("A route request is required.");
        if (directDistance(request.origin(), request.destination()) > MAX_ALTERNATIVE_DISTANCE_METERS) {
            throw new IllegalArgumentException(
                    "ORS alternative routes are limited to 100 km; choose closer endpoints.");
        }
        String body = Json.write(Map.of("coordinates", List.of(
                List.of(request.origin().longitude(), request.origin().latitude()),
                List.of(request.destination().longitude(), request.destination().latitude())),
                "alternative_routes", Map.of("target_count", 3, "share_factor", .6, "weight_factor", 1.4),
                "preference", "fastest", "instructions", false, "units", "m"));
        var httpRequest = HttpRequest.newBuilder(directionsUri.resolve(request.travelMode().orsProfile() + "/geojson"))
                .timeout(requestTimeout).header("Authorization", apiKey).header("Content-Type", "application/json")
                .header("Accept", "application/geo+json, application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body)).build();
        try {
            for (int attempt = 0; attempt < 2; attempt++) {
                var response = client.send(httpRequest, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
                int status = response.statusCode();
                if (attempt == 0 && Set.of(502, 503, 504).contains(status)
                        && response.headers().firstValue("Retry-After").isEmpty()) {
                    Thread.sleep(200);
                    continue;
                }
                if (status < 200 || status >= 300)
                    throw statusError(status);
                return mapResponse(response.body(), request.travelMode());
            }
            throw new RoutingException("Routing provider remained unavailable after one retry.");
        } catch (HttpTimeoutException e) {
            throw new RoutingException("Routing request timed out; please try again later.", e);
        } catch (IOException e) {
            throw new RoutingException("Could not connect to the routing provider.", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RoutingException("Routing request was interrupted.", e);
        }
    }

    private static RoutingException statusError(int status) {
        String reason = switch (status) {
            case 401, 403 -> " Check the server API key, API access, and daily quota.";
            case 429 -> " Request quota exceeded; wait before trying again.";
            case 400, 404, 422 -> " Check endpoint coordinates and the configured provider endpoint.";
            default -> " The routing provider could not fulfill the request.";
        };
        return new RoutingException("Routing provider returned HTTP " + status + "." + reason);
    }

    static RoutingResponse mapResponse(String body, TravelMode mode) throws RoutingException {
        try {
            Map<String, Object> root = object(Json.parse(body));
            if (!"FeatureCollection".equals(root.get("type")))
                throw new IllegalArgumentException();
            List<Object> features = array(root.get("features"));
            var routes = new ArrayList<RouteOption>();
            var warnings = new ArrayList<String>();
            warnings.add("Travel durations are estimates without live traffic or future traffic predictions.");
            warnings.add("Routing attribution: openrouteservice / HeiGIT; OpenStreetMap contributors.");
            if (root.get("metadata") instanceof Map<?, ?> metadata && metadata.get("attribution") instanceof String a) {
                warnings.add("Provider attribution: " + a);
            }
            for (Object feature : features) {
                Map<String, Object> f = object(feature);
                if (!"Feature".equals(f.get("type")))
                    throw new IllegalArgumentException();
                Map<String, Object> properties = object(f.get("properties"));
                Map<String, Object> summary = object(properties.get("summary"));
                double distance = number(summary.get("distance"));
                double duration = number(summary.get("duration"));
                if (distance <= 0 || duration <= 0)
                    throw new IllegalArgumentException();
                Map<String, Object> geo = object(f.get("geometry"));
                if (!"LineString".equals(geo.get("type")))
                    throw new IllegalArgumentException();
                var geometry = new ArrayList<Coordinate>();
                for (Object coordinate : array(geo.get("coordinates"))) {
                    List<Object> c = array(coordinate);
                    if (c.size() < 2)
                        throw new IllegalArgumentException();
                    geometry.add(new Coordinate(number(c.get(0)), number(c.get(1))));
                }
                if (geometry.stream().distinct().count() < 2)
                    throw new IllegalArgumentException();
                String id = "ors-" + UUID.nameUUIDFromBytes((mode.name() + geometry).getBytes(StandardCharsets.UTF_8));
                routes.add(new RouteOption(id, mode, distance, duration, geometry, null, null));
                if (properties.containsKey("warnings")) {
                    for (Object w : array(properties.get("warnings"))) {
                        Object message = object(w).get("message");
                        if (!(message instanceof String))
                            throw new IllegalArgumentException();
                        warnings.add("Routing provider: " + message);
                    }
                }
            }
            if (routes.isEmpty())
                warnings.add("Routing provider returned no routes for these endpoints.");
            return new RoutingResponse(routes, warnings);
        } catch (RuntimeException e) {
            throw new RoutingException("Routing provider returned an invalid GeoJSON route response.", e);
        }
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> object(Object value) {
        if (!(value instanceof Map))
            throw new IllegalArgumentException("Expected a JSON object.");
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    static List<Object> array(Object value) {
        if (!(value instanceof List))
            throw new IllegalArgumentException("Expected a JSON array.");
        return (List<Object>) value;
    }

    static double number(Object value) {
        if (!(value instanceof BigDecimal))
            throw new IllegalArgumentException("Expected a JSON number.");
        double d = ((BigDecimal) value).doubleValue();
        if (!Double.isFinite(d))
            throw new IllegalArgumentException();
        return d;
    }

    private static double directDistance(Coordinate a, Coordinate b) {
        double lat = Math.toRadians(b.latitude() - a.latitude());
        double lon = Math.toRadians(b.longitude() - a.longitude());
        double h = Math.pow(Math.sin(lat / 2), 2) + Math.cos(Math.toRadians(a.latitude()))
                * Math.cos(Math.toRadians(b.latitude())) * Math.pow(Math.sin(lon / 2), 2);
        return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
    }
}
