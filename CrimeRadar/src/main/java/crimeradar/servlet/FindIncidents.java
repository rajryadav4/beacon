package crimeradar.servlet;

import crimeradar.dal.CrimeIncidentsDao;
import crimeradar.dal.NeighborhoodsDao;
import crimeradar.model.CrimeIncidents;
import crimeradar.model.Neighborhoods;

import java.io.IOException;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import javax.servlet.ServletException;
import javax.servlet.annotation.WebServlet;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

/**
 * FindIncidents is the primary entry point into the application.
 *
 * GET /findincidents shows a neighborhood picker. GET /findincidents?neighborhoodid=N also lists
 * the most recent incidents in that neighborhood.
 */
@WebServlet("/findincidents")
public class FindIncidents extends HttpServlet {

	private static final int MAX_RESULTS = 50;

	protected NeighborhoodsDao neighborhoodsDao;
	protected CrimeIncidentsDao crimeIncidentsDao;

	@Override
	public void init() throws ServletException {
		neighborhoodsDao = NeighborhoodsDao.getInstance();
		crimeIncidentsDao = CrimeIncidentsDao.getInstance();
	}

	@Override
	public void doGet(HttpServletRequest req, HttpServletResponse resp)
			throws ServletException, IOException {
		// Map for storing messages.
		Map<String, String> messages = new HashMap<String, String>();
		req.setAttribute("messages", messages);

		List<CrimeIncidents> crimeIncidents = new ArrayList<CrimeIncidents>();
		try {
			req.setAttribute("neighborhoods", neighborhoodsDao.getAllNeighborhoods());

			String neighborhoodIdParam = req.getParameter("neighborhoodid");
			if (neighborhoodIdParam != null && !neighborhoodIdParam.trim().isEmpty()) {
				Neighborhoods neighborhood = null;
				try {
					neighborhood = neighborhoodsDao.getNeighborhoodById(
						Integer.parseInt(neighborhoodIdParam.trim()));
				} catch (NumberFormatException e) {
					// Fall through to the "not found" message below.
				}
				if (neighborhood == null) {
					messages.put("error", "Unknown neighborhood.");
				} else {
					crimeIncidents = crimeIncidentsDao.getCrimeIncidentsForNeighborhood(
						neighborhood, MAX_RESULTS);
					req.setAttribute("neighborhood", neighborhood);
					messages.put("success", "Showing the " + crimeIncidents.size()
						+ " most recent incidents in " + neighborhood.getNeighborhoodName());
				}
			}
		} catch (SQLException e) {
			e.printStackTrace();
			throw new IOException(e);
		}
		req.setAttribute("crimeIncidents", crimeIncidents);

		req.getRequestDispatcher("/FindIncidents.jsp").forward(req, resp);
	}
}
