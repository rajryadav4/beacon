package crimeradar.servlet;

import java.io.IOException;
import java.net.URI;
import java.time.Duration;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.Map;

import crimeradar.model.Coordinate;
import crimeradar.model.RouteRequest;
import crimeradar.model.TravelMode;
import crimeradar.service.OpenRouteServiceClient;
import crimeradar.service.OsrmRoutingService;
import crimeradar.service.RecommendationJson;
import crimeradar.service.RecommendationService;
import crimeradar.service.RecommendationSettings;
import crimeradar.service.RouteRecommendationEngine;
import crimeradar.service.RouteRiskScorer;
import crimeradar.service.RoutingException;
import crimeradar.service.RoutingService;
import crimeradar.util.Json;

import javax.servlet.ServletException;
import javax.servlet.annotation.WebServlet;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

/**
 * GET /recommendroutes: routes the trip on the server and returns the recommendation as JSON.
 * Routing: openrouteservice when ORS_API_KEY is set, otherwise OSRM (no key).
 * Scoring: the RouteRiskScorer in ServletContext attribute "crimeradar.routeRiskScorer"
 * (RouteServicesListener registers the ML risk scorer). Optional parameter preference
 * (fastest, balanced, safer) picks the detour limits; without it the deployment defaults apply.
 * The Safe routes screen uses POST /api/routes/recommend instead (it sends its own routes).
 */
@WebServlet(value = "/recommendroutes", loadOnStartup = 1)
public class RecommendRoutes extends HttpServlet {
    public static final String RISK_SCORER_ATTRIBUTE = "crimeradar.routeRiskScorer";
    public static final String ROUTING_SERVICE_ATTRIBUTE = "crimeradar.routingService";
    private static final ZoneId SEATTLE = ZoneId.of("America/Los_Angeles");
    private static final long serialVersionUID = 1L;
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
                } else {
                    routing = new OsrmRoutingService();
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
                writeError(resp, 503, "Routing is not configured. Set ORS_API_KEY or allow OSRM routing on the application server.");
                return;
            }
            var configured = getServletContext().getAttribute(RISK_SCORER_ATTRIBUTE);
            RouteRiskScorer scorer = configured instanceof RouteRiskScorer s ? s : (routes, departure) -> List.of();
            String preference = req.getParameter("preference");
            RecommendationService policy = preference == null || preference.isBlank() ? recommendations
                    : new RecommendationService(RecommendationSettings.forPreference(
                            RecommendationSettings.Preference.parse(preference)));
            var result = new RouteRecommendationEngine(routing, scorer, policy).recommend(request);
            resp.getWriter().write(Json.write(RecommendationJson.result(result)));
        } catch (IllegalArgumentException e) {
            writeError(resp, 400, "Invalid route request: " + e.getMessage());
        } catch (RoutingException e) {
            writeError(resp, 502, e.getMessage());
        }
    }

    static RouteRequest parseRequest(HttpServletRequest req) {
        Coordinate origin = new Coordinate(number(req, "originLon"), number(req, "originLat"));
        Coordinate destination = new Coordinate(number(req, "destinationLon"), number(req, "destinationLat"));
        TravelMode mode = TravelMode.parse(required(req, "mode"));
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
        resp.getWriter().write(Json.write(Map.of("error", message)));
    }
}
