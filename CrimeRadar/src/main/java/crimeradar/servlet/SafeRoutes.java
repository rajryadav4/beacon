package crimeradar.servlet;

import crimeradar.dal.RouteRiskDao;
import crimeradar.model.RouteRisk;

import java.io.IOException;
import java.sql.SQLException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import javax.servlet.ServletException;
import javax.servlet.annotation.WebServlet;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

/**
 * Advanced feature: route risk score.
 *
 * GET /saferoutes scores every route (sum over segments of km x neighborhood incidents/day over
 * the last N days) and lists them safest first. Optional parameters:
 *   q      route name contains this text
 *   days   scoring window: 30, 90 (default) or 365
 *   rankby total (default) or perkm
 *   order  safest (default) or riskiest
 *   limit  rows to show: 10, 25 (default), 50 or 100
 */
@WebServlet("/saferoutes")
public class SafeRoutes extends HttpServlet {

	protected RouteRiskDao routeRiskDao;

	@Override
	public void init() throws ServletException {
		routeRiskDao = RouteRiskDao.getInstance();
	}

	@Override
	public void doGet(HttpServletRequest req, HttpServletResponse resp)
			throws ServletException, IOException {
		Map<String, String> messages = new HashMap<String, String>();
		req.setAttribute("messages", messages);

		String query = req.getParameter("q");
		query = query == null ? "" : query.trim();
		int days = parseChoice(req.getParameter("days"), 90, 30, 90, 365);
		int limit = parseChoice(req.getParameter("limit"), 25, 10, 25, 50, 100);
		String rankBy = "perkm".equals(req.getParameter("rankby")) ? "perkm" : "total";
		boolean riskiestFirst = "riskiest".equals(req.getParameter("order"));

		try {
			long start = System.nanoTime();
			List<RouteRisk> routeRisks = routeRiskDao.getRoutesRankedByRisk(
				days, query, rankBy, riskiestFirst, limit);
			long elapsedMs = (System.nanoTime() - start) / 1_000_000;
			int scoredRoutes = routeRiskDao.countScoredRoutes(query);

			req.setAttribute("routeRisks", routeRisks);
			req.setAttribute("scoredRoutes", scoredRoutes);
			req.setAttribute("elapsedMs", elapsedMs);
			req.setAttribute("latestIncident", routeRiskDao.getLatestIncidentTime());

			if (routeRisks.isEmpty()) {
				messages.put("error", query.isEmpty() ? "No routes with segments to score."
					: "No routes match \"" + query + "\".");
			} else {
				messages.put("success", "Scored " + scoredRoutes + " route(s) in " + elapsedMs
					+ " ms. Showing the " + routeRisks.size() + " "
					+ (riskiestFirst ? "riskiest" : "safest") + ".");
			}
		} catch (SQLException e) {
			e.printStackTrace();
			throw new IOException(e);
		}

		req.setAttribute("q", query);
		req.setAttribute("days", days);
		req.setAttribute("limit", limit);
		req.setAttribute("rankby", rankBy);
		req.setAttribute("order", riskiestFirst ? "riskiest" : "safest");
		req.getRequestDispatcher("/SafeRoutes.jsp").forward(req, resp);
	}

	/** Parses value and returns it if it is one of the allowed choices, else the default. */
	static int parseChoice(String value, int defaultValue, int... allowed) {
		if (value == null) {
			return defaultValue;
		}
		try {
			int parsed = Integer.parseInt(value.trim());
			for (int choice : allowed) {
				if (choice == parsed) {
					return parsed;
				}
			}
		} catch (NumberFormatException e) {
			// Fall through to the default.
		}
		return defaultValue;
	}
}
