package crimeradar.api;

import crimeradar.dal.UserPreferencesDao;
import crimeradar.model.UserPreferences;

import java.math.BigDecimal;

import javax.servlet.annotation.WebServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

/** POST api/me/preferences: mode, safetyWeight (0-1), alerts. Missing fields keep their value. */
@WebServlet(name = "PreferencesServlet", urlPatterns = "/api/me/preferences")
public class PreferencesServlet extends ApiServlet {
	private static final long serialVersionUID = 1L;

	@Override
	protected void post(HttpServletRequest req, HttpServletResponse resp) throws Exception {
		long userId = requireUserId(req);
		UserPreferencesDao dao = UserPreferencesDao.getInstance();
		UserPreferences prefs = dao.get(userId);

		if (req.getParameter("mode") != null) {
			prefs.modeKey = oneOf(req, "mode", "walk", "bike", "car");
		}
		if (req.getParameter("safetyWeight") != null) {
			BigDecimal w = decimal(req, "safetyWeight", 0, 1, 2);
			prefs.safetyWeight = w;
		}
		if (req.getParameter("alerts") != null) {
			prefs.alertsOn = "true".equals(oneOf(req, "alerts", "true", "false"));
		}
		dao.save(prefs);
		json(resp, 200, map("preferences", Views.preferences(prefs)));
	}

	@Override
	protected void get(HttpServletRequest req, HttpServletResponse resp) throws Exception {
		long userId = requireUserId(req);
		UserPreferences prefs = UserPreferencesDao.getInstance().get(userId);
		json(resp, 200, map("preferences", Views.preferences(prefs)));
	}
}
