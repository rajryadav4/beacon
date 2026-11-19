package crimeradar.api;

import crimeradar.dal.MapDataDao;

import javax.servlet.annotation.WebServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

/** GET api/health: 200 {"ok":true,"db":true}, or 503 when the database does not answer. */
@WebServlet(name = "HealthServlet", urlPatterns = "/api/health")
public class HealthServlet extends ApiServlet {
	private static final long serialVersionUID = 1L;

	@Override
	protected void get(HttpServletRequest req, HttpServletResponse resp) throws Exception {
		boolean db = MapDataDao.getInstance().ping();
		resp.setHeader("Cache-Control", "no-store");
		json(resp, db ? 200 : 503, map("ok", db, "db", db));
	}
}
