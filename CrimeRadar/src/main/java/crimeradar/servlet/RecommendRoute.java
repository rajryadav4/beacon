package crimeradar.servlet;

import crimeradar.dal.CrimeStatsDao;
import crimeradar.recommendation.Bounds;
import crimeradar.recommendation.DataWindow;
import crimeradar.recommendation.GeoPoint;
import crimeradar.recommendation.OpenRouteServiceClient;
import crimeradar.recommendation.RecommendationResult;
import crimeradar.recommendation.RecommendationSettings;
import crimeradar.recommendation.RouteRecommender;
import crimeradar.recommendation.RoutingException;
import crimeradar.recommendation.ScoredRoute;
import crimeradar.recommendation.TimeBlock;
import crimeradar.recommendation.TravelMode;

import java.io.IOException;
import java.math.BigDecimal;
import java.sql.SQLException;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeSet;

import javax.servlet.ServletException;
import javax.servlet.annotation.WebServlet;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

/**
 * Safer-route recommendations.
 *
 * GET /recommend shows the trip form and map. With startLat, startLng, endLat, endLng (plus
 * optional mode, departure, maxDetour, maxExtra) it also compares the route alternatives and
 * shows the recommended one with its reason.
 */
@WebServlet("/recommend")
public class RecommendRoute extends HttpServlet {

	private static final ZoneId SEATTLE_TIME = ZoneId.of("America/Los_Angeles");
	/** Trips must start and end in or near Seattle, where the crime data is. */
	private static final Bounds SERVICE_AREA = Bounds.SEATTLE.expand(0.02, 0.03);
	/** Warn when the newest incident is older than this. */
	private static final int STALE_AFTER_DAYS = 14;
	private static final DateTimeFormatter FORM_TIME =
		DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm");
	private static final DateTimeFormatter DATE_TEXT =
		DateTimeFormatter.ofPattern("MMM d, yyyy", Locale.US);

	protected CrimeStatsDao crimeStatsDao;

	@Override
	public void init() throws ServletException {
		crimeStatsDao = CrimeStatsDao.getInstance();
	}

	@Override
	public void doGet(HttpServletRequest req, HttpServletResponse resp)
			throws ServletException, IOException {
		// Map for storing messages.
		Map<String, String> messages = new HashMap<String, String>();
		req.setAttribute("messages", messages);

		TravelMode mode = TravelMode.WALKING;
		try {
			mode = TravelMode.parse(req.getParameter("mode"));
		} catch (IllegalArgumentException e) {
			messages.put("error", e.getMessage());
		}
		echoForm(req, mode);

		if (messages.isEmpty() && hasTrip(req)) {
			try {
				GeoPoint start = readPoint(req, "startLat", "startLng", "start");
				GeoPoint end = readPoint(req, "endLat", "endLng", "destination");
				LocalDateTime departure = readDeparture(req.getParameter("departure"));
				RecommendationSettings settings = new RecommendationSettings(mode,
					readNumber(req, "maxDetour", mode.defaultMaxDetourPercent(), "Maximum detour"),
					readNumber(req, "maxExtra", mode.defaultMaxExtraMinutes(),
						"Maximum extra time"),
					RecommendationSettings.DEFAULT_MIN_IMPROVEMENT_PERCENT);
				RouteRecommender recommender = new RouteRecommender(
					OpenRouteServiceClient.fromConfig(), crimeStatsDao);
				showOutcome(req, recommender.recommend(start, end, departure, settings));
			} catch (IllegalArgumentException | RoutingException e) {
				messages.put("error", e.getMessage());
			} catch (SQLException e) {
				e.printStackTrace();
				messages.put("error", "Could not read crime data from MySQL: " + e.getMessage());
			}
		}

		req.getRequestDispatcher("/RecommendRoute.jsp").forward(req, resp);
	}

	/** Puts the submitted values (or defaults) back on the form. */
	private static void echoForm(HttpServletRequest req, TravelMode mode) {
		req.setAttribute("modes", TravelMode.values());
		req.setAttribute("mode", mode.name());
		for (String name : new String[] {"startLat", "startLng", "endLat", "endLng"}) {
			req.setAttribute(name, valueOr(req.getParameter(name), ""));
		}
		req.setAttribute("departure", valueOr(req.getParameter("departure"),
			LocalDateTime.now(SEATTLE_TIME).truncatedTo(ChronoUnit.MINUTES).format(FORM_TIME)));
		req.setAttribute("maxDetour", valueOr(req.getParameter("maxDetour"),
			plain(mode.defaultMaxDetourPercent())));
		req.setAttribute("maxExtra", valueOr(req.getParameter("maxExtra"),
			plain(mode.defaultMaxExtraMinutes())));
		req.setAttribute("modeDefaultsJson", modeDefaultsJson());
	}

	private static boolean hasTrip(HttpServletRequest req) {
		for (String name : new String[] {"startLat", "startLng", "endLat", "endLng"}) {
			String value = req.getParameter(name);
			if (value == null || value.trim().isEmpty()) {
				return false;
			}
		}
		return true;
	}

	private static GeoPoint readPoint(HttpServletRequest req, String latName, String lngName,
			String what) {
		GeoPoint point;
		try {
			point = new GeoPoint(Double.parseDouble(req.getParameter(latName).trim()),
				Double.parseDouble(req.getParameter(lngName).trim()));
		} catch (IllegalArgumentException e) {
			throw new IllegalArgumentException("The " + what + " location is not valid.");
		}
		if (!SERVICE_AREA.contains(point)) {
			throw new IllegalArgumentException("Choose a " + what
				+ " in Seattle. CrimeRadar only has Seattle crime data.");
		}
		return point;
	}

	private static LocalDateTime readDeparture(String value) {
		if (value == null || value.trim().isEmpty()) {
			return LocalDateTime.now(SEATTLE_TIME);
		}
		try {
			return LocalDateTime.parse(value.trim());
		} catch (DateTimeParseException e) {
			throw new IllegalArgumentException("The departure time is not valid.");
		}
	}

	private static double readNumber(HttpServletRequest req, String name, double fallback,
			String what) {
		String value = req.getParameter(name);
		if (value == null || value.trim().isEmpty()) {
			return fallback;
		}
		try {
			return Double.parseDouble(value.trim());
		} catch (NumberFormatException e) {
			throw new IllegalArgumentException(what + " must be a number.");
		}
	}

	private static void showOutcome(HttpServletRequest req, RouteRecommender.Outcome outcome) {
		RecommendationResult result = outcome.result();
		List<RouteOptionView> views = new ArrayList<RouteOptionView>();
		StringBuilder routesJson = new StringBuilder("[");
		List<ScoredRoute> options = result.options();
		for (int i = 0; i < options.size(); i++) {
			ScoredRoute option = options.get(i);
			String label = "Route " + (char) ('A' + i);
			boolean recommended = option == result.recommended();
			boolean withinLimit = result.isWithinTimeLimit(option);
			views.add(new RouteOptionView(
				label,
				tags(result, option),
				Math.round(option.durationMinutes()) + " min",
				distanceText(option.route().distanceMeters()),
				String.format(Locale.ROOT, "%.2f", option.score()),
				versusFastest(result, option),
				recommended ? "Recommended"
					: withinLimit ? "Within your time limit" : "Over your time limit",
				recommended,
				withinLimit));
			if (i > 0) {
				routesJson.append(',');
			}
			routesJson.append("{\"label\":\"").append(label)
				.append("\",\"recommended\":").append(recommended)
				.append(",\"withinLimit\":").append(withinLimit)
				.append(",\"path\":[");
			List<GeoPoint> path = option.route().geometry();
			for (int p = 0; p < path.size(); p++) {
				if (p > 0) {
					routesJson.append(',');
				}
				routesJson.append(String.format(Locale.ROOT, "[%.6f,%.6f]",
					path.get(p).lat(), path.get(p).lng()));
			}
			routesJson.append("]}");
		}
		routesJson.append(']');

		req.setAttribute("options", views);
		req.setAttribute("routesJson", routesJson.toString());
		req.setAttribute("explanation", result.explanation());
		req.setAttribute("maxAllowedText", Math.round(result.maxAllowedMinutes()) + " min");
		req.setAttribute("notes", notes(outcome));
	}

	private static String tags(RecommendationResult result, ScoredRoute option) {
		List<String> tags = new ArrayList<String>();
		if (option == result.fastest()) {
			tags.add("Fastest");
		}
		if (option == result.lowestExposure()) {
			tags.add("Lowest exposure");
		}
		return String.join(" · ", tags);
	}

	private static String versusFastest(RecommendationResult result, ScoredRoute option) {
		if (option == result.fastest()) {
			return "—";
		}
		long percent = Math.round(result.percentVersusFastest(option));
		if (percent == 0) {
			return "about the same";
		}
		return (percent < 0 ? "−" : "+") + Math.abs(percent) + "%";
	}

	private static String distanceText(double meters) {
		return meters < 1000 ? Math.round(meters) + " m"
			: String.format(Locale.ROOT, "%.1f km", meters / 1000.0);
	}

	private static List<String> notes(RouteRecommender.Outcome outcome) {
		List<String> notes = new ArrayList<String>();
		RecommendationResult result = outcome.result();
		TreeSet<TimeBlock> blocks =
			new TreeSet<TimeBlock>(result.recommended().exposure().timeBlocks());
		List<String> blockLabels = new ArrayList<String>();
		for (TimeBlock block : blocks) {
			blockLabels.add(block.label());
		}
		notes.add("Scored for the time you'll be travelling (" + String.join(" and ", blockLabels)
			+ "), using that time of day's crime pattern.");

		DataWindow window = outcome.window();
		if (window == null) {
			notes.add("No crime data is loaded, so routes are compared by travel time only.");
		} else {
			notes.add("Based on reported incidents from "
				+ window.recentStart().toLocalDate().format(DATE_TEXT) + " to "
				+ window.end().toLocalDate().format(DATE_TEXT) + ". The newest "
				+ DataWindow.LAG_DAYS + " days are left out because reports arrive late.");
			if (window.isStale(LocalDate.now(SEATTLE_TIME), STALE_AFTER_DAYS)) {
				notes.add("Crime data was last updated "
					+ window.latestIncident().toLocalDate().format(DATE_TEXT)
					+ ". Recent incidents may be missing until the data is refreshed.");
			}
		}
		if (result.lowConfidence()) {
			notes.add("Part of the recommended route is outside Seattle, where CrimeRadar has "
				+ "no crime data, so treat this recommendation with caution.");
		}
		return notes;
	}

	/** Per-mode default limits for the form's JavaScript, e.g. {"WALKING":{"detour":25,...}}. */
	private static String modeDefaultsJson() {
		StringBuilder json = new StringBuilder("{");
		TravelMode[] modes = TravelMode.values();
		for (int i = 0; i < modes.length; i++) {
			if (i > 0) {
				json.append(',');
			}
			json.append('"').append(modes[i].name()).append("\":{\"detour\":")
				.append(plain(modes[i].defaultMaxDetourPercent())).append(",\"extra\":")
				.append(plain(modes[i].defaultMaxExtraMinutes())).append('}');
		}
		return json.append('}').toString();
	}

	private static String valueOr(String value, String fallback) {
		return value == null || value.trim().isEmpty() ? fallback : value.trim();
	}

	/** 25.0 becomes "25", 7.5 stays "7.5". */
	private static String plain(double value) {
		return BigDecimal.valueOf(value).stripTrailingZeros().toPlainString();
	}
}
