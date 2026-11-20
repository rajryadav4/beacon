package crimeradar.servlet;

import crimeradar.dal.RouteRiskDao;
import crimeradar.dal.RoutesDao;
import crimeradar.model.Routes;
import crimeradar.model.SegmentRisk;

import java.io.IOException;
import java.math.BigDecimal;
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
 * Advanced feature, drill-down. GET /routedetail?routeid=N&days=90 breaks a route's risk score
 * into its segments, showing how much each neighborhood contributes.
 */
@WebServlet("/routedetail")
public class RouteDetail extends HttpServlet {

	protected RoutesDao routesDao;
	protected RouteRiskDao routeRiskDao;

	@Override
	public void init() throws ServletException {
		routesDao = RoutesDao.getInstance();
		routeRiskDao = RouteRiskDao.getInstance();
	}

	@Override
	public void doGet(HttpServletRequest req, HttpServletResponse resp)
			throws ServletException, IOException {
		Map<String, String> messages = new HashMap<String, String>();
		req.setAttribute("messages", messages);
		int days = SafeRoutes.parseChoice(req.getParameter("days"), 90, 30, 90, 365);
		req.setAttribute("days", days);

		Routes route = null;
		try {
			route = routesDao.getRouteById(Long.parseLong(req.getParameter("routeid").trim()));
		} catch (NumberFormatException | NullPointerException e) {
			// Handled as "not found" below.
		} catch (SQLException e) {
			e.printStackTrace();
			throw new IOException(e);
		}

		if (route == null) {
			messages.put("error", "Route not found.");
		} else {
			try {
				List<SegmentRisk> segmentRisks = routeRiskDao.getSegmentRisksForRoute(route, days);
				BigDecimal totalRisk = BigDecimal.ZERO;
				long totalMeters = 0;
				BigDecimal maxContribution = BigDecimal.ZERO;
				for (SegmentRisk s : segmentRisks) {
					totalRisk = totalRisk.add(s.getContribution());
					totalMeters += s.getDistanceMeters();
					if (s.getContribution().compareTo(maxContribution) > 0) {
						maxContribution = s.getContribution();
					}
				}
				req.setAttribute("route", route);
				req.setAttribute("segmentRisks", segmentRisks);
				req.setAttribute("totalRisk", totalRisk);
				req.setAttribute("totalMeters", totalMeters);
				req.setAttribute("maxContribution", maxContribution);
				req.setAttribute("latestIncident", routeRiskDao.getLatestIncidentTime());
			} catch (SQLException e) {
				e.printStackTrace();
				throw new IOException(e);
			}
		}
		req.getRequestDispatcher("/RouteDetail.jsp").forward(req, resp);
	}
}
