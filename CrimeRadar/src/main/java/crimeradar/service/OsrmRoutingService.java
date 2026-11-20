package crimeradar.service;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

import crimeradar.model.Coordinate;
import crimeradar.model.RouteOption;
import crimeradar.model.RouteRequest;
import crimeradar.model.RoutingResponse;
import crimeradar.model.TravelMode;
import crimeradar.util.Json;

/**
 * Routes from the free OSRM servers at routing.openstreetmap.de (no API key), the same servers the
 * browser UI uses. Up to 3 alternatives per request. OSRM sees only the start and end points.
 */
public final class OsrmRoutingService implements RoutingService {
    public static final URI DEFAULT_BASE_URI = URI.create("https://routing.openstreetmap.de/");

    private final HttpClient client;
    private final URI baseUri;
    private final Duration requestTimeout;

    public OsrmRoutingService() {
        this(DEFAULT_BASE_URI, Duration.ofSeconds(5), Duration.ofSeconds(20));
    }

    public OsrmRoutingService(URI baseUri, Duration connectTimeout, Duration requestTimeout) {
        if (baseUri == null || baseUri.getHost() == null || !baseUri.getPath().endsWith("/")) {
            throw new IllegalArgumentException("OSRM base URI must have a host and end in '/'.");
        }
        this.client = HttpClient.newBuilder().connectTimeout(connectTimeout)
                .followRedirects(HttpClient.Redirect.NEVER).build();
        this.baseUri = baseUri;
        this.requestTimeout = requestTimeout;
    }

    @Override
    public RoutingResponse generateRoutes(RouteRequest request) throws RoutingException {
        if (request == null) {
            throw new IllegalArgumentException("A route request is required.");
        }
        String path = String.format(Locale.ROOT, "%s/route/v1/driving/%.6f,%.6f;%.6f,%.6f",
                request.travelMode().osrmService(),
                request.origin().longitude(), request.origin().latitude(),
                request.destination().longitude(), request.destination().latitude());
        URI uri = baseUri.resolve(path + "?overview=full&geometries=geojson&steps=false&alternatives=3");
        HttpRequest httpRequest = HttpRequest.newBuilder(uri).timeout(requestTimeout)
                .header("Accept", "application/json").GET().build();
        try {
            HttpResponse<String> response = client.send(httpRequest,
                    HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() == 429) {
                throw new RoutingException("Routing provider returned HTTP 429. Too many requests; try again shortly.");
            }
            if (response.statusCode() >= 500) {
                throw new RoutingException("Routing provider returned HTTP " + response.statusCode()
                        + ". The routing service could not fulfill the request.");
            }
            return mapResponse(response.body(), request.travelMode());
        } catch (HttpTimeoutException e) {
            throw new RoutingException("Routing request timed out; please try again later.", e);
        } catch (IOException e) {
            throw new RoutingException("Could not connect to the routing provider.", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RoutingException("Routing request was interrupted.", e);
        }
    }

    /** Reads an OSRM /route response. Package-private for tests. */
    static RoutingResponse mapResponse(String body, TravelMode mode) throws RoutingException {
        Map<String, Object> root;
        try {
            root = OpenRouteServiceClient.object(Json.parse(body));
        } catch (RuntimeException e) {
            throw new RoutingException("Routing provider returned an invalid route response.", e);
        }
        Object code = root.get("code");
        if ("NoRoute".equals(code)) {
            return new RoutingResponse(List.of(), List.of("No " + mode.label() + " route was found between these points."));
        }
        if (!"Ok".equals(code)) {
            Object message = root.get("message");
            throw new RoutingException("Routing provider could not route this trip"
                    + (message instanceof String ? ": " + message : "."));
        }
        try {
            List<RouteOption> routes = new ArrayList<>();
            for (Object value : OpenRouteServiceClient.array(root.get("routes"))) {
                Map<String, Object> route = OpenRouteServiceClient.object(value);
                double distance = OpenRouteServiceClient.number(route.get("distance"));
                double duration = OpenRouteServiceClient.number(route.get("duration"));
                Map<String, Object> geometry = OpenRouteServiceClient.object(route.get("geometry"));
                if (!"LineString".equals(geometry.get("type"))) {
                    throw new IllegalArgumentException("Expected a LineString.");
                }
                List<Coordinate> path = new ArrayList<>();
                for (Object point : OpenRouteServiceClient.array(geometry.get("coordinates"))) {
                    List<Object> lngLat = OpenRouteServiceClient.array(point);
                    if (lngLat.size() < 2) {
                        throw new IllegalArgumentException("Bad coordinate.");
                    }
                    path.add(new Coordinate(OpenRouteServiceClient.number(lngLat.get(0)),
                            OpenRouteServiceClient.number(lngLat.get(1))));
                }
                if (distance <= 0 || duration <= 0 || path.stream().distinct().count() < 2) {
                    continue;
                }
                String id = "osrm-" + UUID.nameUUIDFromBytes((mode.name() + path).getBytes(StandardCharsets.UTF_8));
                routes.add(new RouteOption(id, mode, distance, duration, path, null, null));
            }
            List<String> warnings = new ArrayList<>();
            warnings.add("Travel durations are estimates without live traffic or future traffic predictions.");
            warnings.add("Routing attribution: OSRM (routing.openstreetmap.de); OpenStreetMap contributors.");
            if (routes.isEmpty()) {
                warnings.add("Routing provider returned no routes for these endpoints.");
            }
            return new RoutingResponse(routes, warnings);
        } catch (RuntimeException e) {
            throw new RoutingException("Routing provider returned an invalid route response.", e);
        }
    }
}
