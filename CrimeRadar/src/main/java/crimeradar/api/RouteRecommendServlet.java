package crimeradar.api;

import crimeradar.model.Coordinate;
import crimeradar.model.RecommendationResult;
import crimeradar.model.RouteOption;
import crimeradar.model.RouteRequest;
import crimeradar.model.RouteRiskScore;
import crimeradar.model.RoutingResponse;
import crimeradar.model.TravelMode;
import crimeradar.service.RecommendationJson;
import crimeradar.service.RecommendationService;
import crimeradar.service.RecommendationSettings;
import crimeradar.service.RecommendationSettings.Preference;
import crimeradar.service.RouteRecommendationEngine;
import crimeradar.service.RouteRiskScorer;
import crimeradar.service.RoutingException;
import crimeradar.servlet.RecommendRoutes;
import crimeradar.util.Json;

import java.io.BufferedReader;
import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import javax.servlet.annotation.WebServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

/**
 * POST api/routes/recommend: the Safe routes screen sends the routes it already has (from OSRM in
 * the browser) and gets back which one to take and why. No account needed.
 *
 * <pre>
 * {"mode":"walk", "departAt":"2026-11-19T21:15", "safetyWeight":0.7,   (or "preference":"balanced")
 *  "routes":[{"id":"r0","duration":720,"distance":980,"coords":[[47.615,-122.3208], ...]}]}
 * </pre>
 *
 * Limits: 1 to 5 routes, 2 to 5,000 points each, coordinates as [lat, lng]. See docs/API.md.
 */
@WebServlet(name = "RouteRecommendServlet", urlPatterns = "/api/routes/recommend")
public class RouteRecommendServlet extends ApiServlet {
	private static final long serialVersionUID = 1L;

	static final int MAX_ROUTES = 5;
	static final int MAX_POINTS = 5000;
	static final int MAX_BODY_CHARS = 2_000_000;
	private static final ZoneId SEATTLE = ZoneId.of("America/Los_Angeles");

	@Override
	protected void post(HttpServletRequest req, HttpServletResponse resp) throws Exception {
		Map<String, Object> body = readBody(req);
		TravelMode mode = parseMode(body.get("mode"));
		LocalDateTime departAt = parseDeparture(body.get("departAt"));
		Preference preference = parsePreference(body);
		List<RouteOption> routes = parseRoutes(body.get("routes"), mode);

		Object configured = getServletContext().getAttribute(RecommendRoutes.RISK_SCORER_ATTRIBUTE);
		RouteRiskScorer scorer = configured instanceof RouteRiskScorer
			? (RouteRiskScorer) configured : (r, t) -> Collections.<RouteRiskScore>emptyList();
		Map<String, RouteRiskScore> captured = new HashMap<String, RouteRiskScore>();
		RouteRiskScorer capturing = (candidates, time) -> {
			List<RouteRiskScore> scores = scorer.calculateRouteRisks(candidates, time);
			if (scores != null) {
				for (RouteRiskScore s : scores) {
					if (s != null && s.routeId() != null) {
						captured.put(s.routeId(), s);
					}
				}
			}
			return scores;
		};

		List<Coordinate> first = routes.get(0).geometry();
		RouteRequest request;
		try {
			request = new RouteRequest(first.get(0), first.get(first.size() - 1), mode, departAt);
		} catch (IllegalArgumentException e) {
			throw new ApiException(400, "Start and destination must differ.");
		}
		RecommendationResult result;
		try {
			result = new RouteRecommendationEngine(r -> new RoutingResponse(routes, List.of()), capturing,
				new RecommendationService(RecommendationSettings.forPreference(preference))).recommend(request);
		} catch (RoutingException e) {
			throw new ApiException(500, "Routes could not be compared.");
		}

		resp.setHeader("Cache-Control", "no-store");
		json(resp, 200, response(result, routes, captured, preference));
	}

	static Map<String, Object> response(RecommendationResult result, List<RouteOption> routes,
			Map<String, RouteRiskScore> scores, Preference preference) {
		RouteOption fastest = result.fastestRoute();
		RouteOption recommended = result.recommendedRoute();
		Double fastestExposure = fastest == null ? null : fastest.historicalExposureScore();
		double maxSeconds = fastest == null ? 0
			: fastest.durationSeconds() + result.comparisonMetrics().maximumAdditionalSeconds();
		Map<String, Object> out = new LinkedHashMap<String, Object>();
		out.put("recommendedId", recommended == null ? null : recommended.routeId());
		out.put("fastestId", fastest == null ? null : fastest.routeId());
		out.put("lowestExposureId",
			result.lowestExposureRoute() == null ? null : result.lowestExposureRoute().routeId());
		out.put("preference", preference.key());
		out.put("maximumAllowedSeconds", fastest == null ? null : maxSeconds);
		out.put("explanation", result.explanation());
		out.put("warnings", result.warnings());
		List<Object> perRoute = new ArrayList<Object>();
		for (RouteOption route : routes) {
			RouteRiskScore score = scores.get(route.routeId());
			Double exposure = score == null ? null : score.historicalExposureScore();
			if (exposure != null && !RecommendationService.validScore(exposure)) {
				exposure = null;
			}
			Map<String, Object> r = new LinkedHashMap<String, Object>();
			r.put("id", route.routeId());
			r.put("exposure", exposure);
			r.put("withinLimit", fastest != null && route.durationSeconds() <= maxSeconds);
			r.put("vsFastestPercent", exposure != null && fastestExposure != null && fastestExposure > 0
				? 100.0 * (exposure - fastestExposure) / fastestExposure : null);
			r.put("dataQuality", RecommendationJson.dataQuality(score == null ? null : score.dataQuality()));
			perRoute.add(r);
		}
		out.put("routes", perRoute);
		return out;
	}

	// ------------------------------------------------------------ parsing

	@SuppressWarnings("unchecked")
	private static Map<String, Object> readBody(HttpServletRequest req) throws Exception {
		StringBuilder sb = new StringBuilder();
		char[] buf = new char[8192];
		BufferedReader reader = req.getReader();
		int n;
		while ((n = reader.read(buf)) != -1) {
			sb.append(buf, 0, n);
			if (sb.length() > MAX_BODY_CHARS) {
				throw new ApiException(413, "The request is too large.");
			}
		}
		Object parsed;
		try {
			parsed = Json.parse(sb.toString());
		} catch (RuntimeException e) {
			throw new ApiException(400, "The request body must be JSON.");
		}
		if (!(parsed instanceof Map)) {
			throw new ApiException(400, "The request body must be a JSON object.");
		}
		return (Map<String, Object>) parsed;
	}

	static TravelMode parseMode(Object value) {
		try {
			return TravelMode.parse(value instanceof String ? (String) value : null);
		} catch (IllegalArgumentException e) {
			throw new ApiException(400, "mode must be walk, bike or car.");
		}
	}

	static LocalDateTime parseDeparture(Object value) {
		if (value == null) {
			return LocalDateTime.now(SEATTLE);
		}
		try {
			return LocalDateTime.parse((String) value);
		} catch (ClassCastException | DateTimeParseException e) {
			throw new ApiException(400, "departAt must be a Seattle local date-time like 2026-11-19T21:15.");
		}
	}

	static Preference parsePreference(Map<String, Object> body) {
		try {
			if (body.get("preference") instanceof String) {
				return Preference.parse((String) body.get("preference"));
			}
			if (body.get("safetyWeight") instanceof BigDecimal) {
				return Preference.fromSafetyWeight(((BigDecimal) body.get("safetyWeight")).doubleValue());
			}
			return Preference.BALANCED;
		} catch (IllegalArgumentException e) {
			throw new ApiException(400, e.getMessage());
		}
	}

	static List<RouteOption> parseRoutes(Object value, TravelMode mode) {
		if (!(value instanceof List) || ((List<?>) value).isEmpty() || ((List<?>) value).size() > MAX_ROUTES) {
			throw new ApiException(400, "routes must hold 1 to " + MAX_ROUTES + " routes.");
		}
		List<RouteOption> routes = new ArrayList<RouteOption>();
		int index = 0;
		for (Object item : (List<?>) value) {
			if (!(item instanceof Map)) {
				throw new ApiException(400, "Each route must be a JSON object.");
			}
			Map<?, ?> r = (Map<?, ?>) item;
			String id = r.get("id") instanceof String && !((String) r.get("id")).isBlank()
				? ((String) r.get("id")).trim() : "r" + index;
			if (id.length() > 64) {
				throw new ApiException(400, "Route ids must be at most 64 characters.");
			}
			double duration = positive(r.get("duration"), "duration");
			double distance = positive(r.get("distance"), "distance");
			if (!(r.get("coords") instanceof List)) {
				throw new ApiException(400, "Each route needs coords as [[lat, lng], ...].");
			}
			List<?> coords = (List<?>) r.get("coords");
			if (coords.size() < 2 || coords.size() > MAX_POINTS) {
				throw new ApiException(400, "Each route needs 2 to " + MAX_POINTS + " points.");
			}
			List<Coordinate> geometry = new ArrayList<Coordinate>(coords.size());
			for (Object p : coords) {
				if (!(p instanceof List) || ((List<?>) p).size() < 2
						|| !(((List<?>) p).get(0) instanceof BigDecimal) || !(((List<?>) p).get(1) instanceof BigDecimal)) {
					throw new ApiException(400, "Each point must be [lat, lng].");
				}
				double lat = ((BigDecimal) ((List<?>) p).get(0)).doubleValue();
				double lng = ((BigDecimal) ((List<?>) p).get(1)).doubleValue();
				try {
					geometry.add(new Coordinate(lng, lat));
				} catch (IllegalArgumentException e) {
					throw new ApiException(400, "A point is outside valid latitude/longitude.");
				}
			}
			routes.add(new RouteOption(id, mode, distance, duration, geometry, null, null));
			index++;
		}
		return routes;
	}

	private static double positive(Object value, String name) {
		if (!(value instanceof BigDecimal)) {
			throw new ApiException(400, "Each route needs a numeric " + name + ".");
		}
		double d = ((BigDecimal) value).doubleValue();
		if (!Double.isFinite(d) || d <= 0) {
			throw new ApiException(400, "Each route's " + name + " must be positive.");
		}
		return d;
	}
}
