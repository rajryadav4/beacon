package crimeradar.servlet;

import java.io.IOException;
import java.net.URI;
import java.time.Duration;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import crimeradar.model.Coordinate;
import crimeradar.model.RouteRequest;
import crimeradar.model.TravelMode;
import crimeradar.service.OpenRouteServiceClient;
import crimeradar.service.RecommendationService;
import crimeradar.service.RecommendationSettings;
import crimeradar.service.RouteRecommendationEngine;
import crimeradar.service.RouteRiskScorer;
import crimeradar.service.RoutingException;
import crimeradar.service.RoutingService;
import jakarta.servlet.ServletException;
import jakarta.servlet.annotation.WebServlet;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

/**
 * Minimal JSON endpoint for the JSP app; no changes to existing page layout.
 * Person 1 registers a thread-safe scorer as ServletContext attribute
 * "crimeradar.routeRiskScorer".
 */
@WebServlet(value = "/recommendroutes", loadOnStartup = 1)
public class RecommendRoutes extends HttpServlet {
    public static final String RISK_SCORER_ATTRIBUTE = "crimeradar.routeRiskScorer";
    public static final String ROUTING_SERVICE_ATTRIBUTE = "crimeradar.routingService";
    private static final ZoneId SEATTLE = ZoneId.of("America/Los_Angeles");
    private static final Gson JSON = new GsonBuilder().serializeNulls().create();
    private RoutingService routing;
    private RecommendationService recommendations;

    @Override
    public void init() throws ServletException {
        try {
            recommendations = new RecommendationService(RecommendationSettings.fromProperties(System.getProperties()));
            var injected = getServletContext().getAttribute(ROUTING_SERVICE_ATTRIBUTE);
            if (injected instanceof RoutingService service) {
                routing = service;
            } else {
                String key = System.getenv("ORS_API_KEY");
                if (key != null && !key.isBlank()) {
                    String uri = System.getenv("ORS_DIRECTIONS_URI");
                    routing = new OpenRouteServiceClient(
                            uri == null || uri.isBlank() ? OpenRouteServiceClient.DEFAULT_DIRECTIONS_URI
                                    : URI.create(uri),
                            key,
                            Duration.ofSeconds(
                                    Long.parseLong(System.getProperty("crimeradar.ors.connectTimeoutSeconds", "5"))),
                            Duration.ofSeconds(
                                    Long.parseLong(System.getProperty("crimeradar.ors.requestTimeoutSeconds", "20"))));
                }
            }
        } catch (IllegalArgumentException e) {
            throw new ServletException("Invalid CrimeRadar recommendation/routing configuration.", e);
        }
    }

    @Override
    public void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        resp.setContentType("application/json");
        resp.setCharacterEncoding("UTF-8");
        resp.setHeader("Cache-Control", "no-store");
        try {
            var request = parseRequest(req);
            if (routing == null) {
                writeError(resp, 503, "Routing is not configured. Set ORS_API_KEY on the application server.");
                return;
            }
            var configured = getServletContext().getAttribute(RISK_SCORER_ATTRIBUTE);
            RouteRiskScorer scorer = configured instanceof RouteRiskScorer s ? s : (routes, departure) -> List.of();
            var result = new RouteRecommendationEngine(routing, scorer, recommendations).recommend(request);
            resp.getWriter().write(JSON.toJson(result));
        } catch (IllegalArgumentException e) {
            writeError(resp, 400, "Invalid route request: " + e.getMessage());
        } catch (RoutingException e) {
            writeError(resp, 502, e.getMessage());
        }
    }

    static RouteRequest parseRequest(HttpServletRequest req) {
        Coordinate origin = new Coordinate(number(req, "originLon"), number(req, "originLat"));
        Coordinate destination = new Coordinate(number(req, "destinationLon"), number(req, "destinationLat"));
        TravelMode mode;
        try {
            mode = TravelMode.valueOf(required(req, "mode").toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("mode must be walking, cycling, or driving.");
        }
        String departure = req.getParameter("departureTime");
        LocalDateTime time;
        try {
            time = departure == null || departure.isBlank() ? LocalDateTime.now(SEATTLE)
                    : LocalDateTime.parse(departure);
        } catch (DateTimeParseException e) {
            throw new IllegalArgumentException("departureTime must be ISO local date-time in America/Los_Angeles.");
        }
        if (SEATTLE.getRules().getValidOffsets(time).isEmpty()) {
            throw new IllegalArgumentException(
                    "departureTime does not exist in America/Los_Angeles due to daylight saving time.");
        }
        return new RouteRequest(origin, destination, mode, time);
    }

    private static String required(HttpServletRequest req, String name) {
        String value = req.getParameter(name);
        if (value == null || value.isBlank())
            throw new IllegalArgumentException("Missing parameter " + name + ".");
        return value.trim();
    }

    private static double number(HttpServletRequest req, String name) {
        try {
            return Double.parseDouble(required(req, name));
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException(name + " must be numeric.");
        }
    }

    private static void writeError(HttpServletResponse resp, int status, String message) throws IOException {
        resp.setStatus(status);
        resp.getWriter().write(JSON.toJson(Map.of("error", message)));
    }
}
