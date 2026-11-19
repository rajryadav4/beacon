package crimeradar.recommendation;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;

/**
 * Gets route alternatives from the hosted openrouteservice Directions API (free tier,
 * API key required: https://openrouteservice.org/dev/#/signup).
 *
 * The key is read from routing.properties on the classpath (src/main/java/routing.properties,
 * git-ignored), or from the ORS_API_KEY environment variable.
 */
public class OpenRouteServiceClient implements RoutingClient {

	private static final String PROPERTIES_FILE = "routing.properties";
	private static final String BASE_URL = "https://api.openrouteservice.org/v2/directions/";
	/** The hosted API returns at most 3 alternatives per request. */
	private static final int ALTERNATIVES = 3;

	private final String apiKey;
	private final HttpClient http;

	public OpenRouteServiceClient(String apiKey) {
		if (apiKey == null || apiKey.trim().isEmpty()) {
			throw new IllegalArgumentException("An openrouteservice API key is required.");
		}
		this.apiKey = apiKey.trim();
		this.http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
	}

	/** Builds a client from routing.properties or the ORS_API_KEY environment variable. */
	public static OpenRouteServiceClient fromConfig() throws RoutingException {
		String key = null;
		try (InputStream in = OpenRouteServiceClient.class.getClassLoader()
				.getResourceAsStream(PROPERTIES_FILE)) {
			if (in != null) {
				Properties properties = new Properties();
				properties.load(in);
				key = properties.getProperty("ors.apiKey");
			}
		} catch (IOException e) {
			throw new RoutingException("Could not read " + PROPERTIES_FILE + ".", e);
		}
		if (key == null || key.trim().isEmpty() || key.contains("your-")) {
			key = System.getenv("ORS_API_KEY");
		}
		if (key == null || key.trim().isEmpty()) {
			throw new RoutingException("Route recommendations need a free openrouteservice API "
				+ "key. Copy src/main/java/routing.properties.example to routing.properties "
				+ "and set ors.apiKey.");
		}
		return new OpenRouteServiceClient(key);
	}

	@Override
	public List<CandidateRoute> findRoutes(GeoPoint start, GeoPoint end, TravelMode mode)
			throws RoutingException {
		// openrouteservice takes [longitude, latitude] pairs.
		String body = String.format(Locale.ROOT,
			"{\"coordinates\":[[%.6f,%.6f],[%.6f,%.6f]],"
				+ "\"alternative_routes\":{\"target_count\":%d,\"share_factor\":0.6,"
				+ "\"weight_factor\":1.6},\"instructions\":false}",
			start.lng(), start.lat(), end.lng(), end.lat(), ALTERNATIVES);
		HttpRequest request = HttpRequest.newBuilder()
			.uri(URI.create(BASE_URL + mode.orsProfile() + "/geojson"))
			.timeout(Duration.ofSeconds(20))
			.header("Authorization", apiKey)
			.header("Content-Type", "application/json; charset=utf-8")
			.header("Accept", "application/geo+json, application/json")
			.POST(HttpRequest.BodyPublishers.ofString(body))
			.build();
		HttpResponse<String> response;
		try {
			response = http.send(request, HttpResponse.BodyHandlers.ofString());
		} catch (IOException e) {
			throw new RoutingException("Could not reach the routing service. "
				+ "Check your internet connection and try again.", e);
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			throw new RoutingException("The routing request was interrupted.", e);
		}
		if (response.statusCode() != 200) {
			throw new RoutingException("The routing service returned an error (HTTP "
				+ response.statusCode() + "): " + errorMessage(response.body()));
		}
		return parseGeoJson(response.body(), mode);
	}

	/** Reads routes out of an openrouteservice GeoJSON response. Public for testing. */
	public static List<CandidateRoute> parseGeoJson(String json, TravelMode mode)
			throws RoutingException {
		Object root;
		try {
			root = MiniJson.parse(json);
		} catch (IllegalArgumentException e) {
			throw new RoutingException("The routing service sent a response CrimeRadar "
				+ "could not read.", e);
		}
		List<CandidateRoute> routes = new ArrayList<>();
		for (Object featureValue : MiniJson.asArray(MiniJson.asObject(root).get("features"))) {
			Map<String, Object> feature = MiniJson.asObject(featureValue);
			Map<String, Object> summary = MiniJson.asObject(
				MiniJson.asObject(feature.get("properties")).get("summary"));
			double distance = MiniJson.asNumber(summary.get("distance"), 0);
			double duration = MiniJson.asNumber(summary.get("duration"), 0);
			List<GeoPoint> path = new ArrayList<>();
			for (Object coordinate : MiniJson.asArray(
					MiniJson.asObject(feature.get("geometry")).get("coordinates"))) {
				List<Object> lngLat = MiniJson.asArray(coordinate);
				if (lngLat.size() >= 2) {
					path.add(new GeoPoint(MiniJson.asNumber(lngLat.get(1), Double.NaN),
						MiniJson.asNumber(lngLat.get(0), Double.NaN)));
				}
			}
			if (path.size() >= 2 && duration > 0) {
				routes.add(new CandidateRoute(mode, distance, duration, path));
			}
		}
		if (routes.isEmpty()) {
			throw new RoutingException("No " + mode.label().toLowerCase(Locale.ROOT)
				+ " route was found between these points.");
		}
		return routes;
	}

	/** Pulls a readable message out of an error response. */
	private static String errorMessage(String body) {
		try {
			Object error = MiniJson.asObject(MiniJson.parse(body)).get("error");
			if (error instanceof String) {
				return (String) error;
			}
			Object message = MiniJson.asObject(error).get("message");
			if (message instanceof String) {
				return (String) message;
			}
		} catch (IllegalArgumentException e) {
			// Not JSON; fall through.
		}
		return "unexpected response";
	}
}
