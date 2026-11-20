package crimeradar.servlet;

import crimeradar.dal.AppUsersDao;
import crimeradar.dal.EmergencyContactsDao;
import crimeradar.dal.SOSAlertsDao;
import crimeradar.model.AppUsers;

import java.io.IOException;
import java.sql.SQLException;
import java.util.HashMap;
import java.util.Map;

import javax.servlet.ServletException;
import javax.servlet.annotation.WebServlet;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

/**
 * CRUD: Delete. GET /userdelete?userid=N asks for confirmation and shows what will be removed;
 * POST deletes the user. AppUsersDao.delete runs in one transaction: it removes the user's
 * EmergencyContacts and SOSAlerts, detaches their RouteRecommendations, then deletes the user.
 */
@WebServlet("/userdelete")
public class UserDelete extends HttpServlet {

	protected AppUsersDao appUsersDao;
	protected EmergencyContactsDao emergencyContactsDao;
	protected SOSAlertsDao sosAlertsDao;

	@Override
	public void init() throws ServletException {
		appUsersDao = AppUsersDao.getInstance();
		emergencyContactsDao = EmergencyContactsDao.getInstance();
		sosAlertsDao = SOSAlertsDao.getInstance();
	}

	@Override
	public void doGet(HttpServletRequest req, HttpServletResponse resp)
			throws ServletException, IOException {
		Map<String, String> messages = new HashMap<String, String>();
		req.setAttribute("messages", messages);
		try {
			AppUsers appUser = UserParams.lookUpUser(req, appUsersDao, messages);
			if (appUser != null) {
				req.setAttribute("appUser", appUser);
				req.setAttribute("contactCount",
					emergencyContactsDao.getEmergencyContactsForUser(appUser).size());
				req.setAttribute("alertCount", sosAlertsDao.getSOSAlertsForUser(appUser).size());
			}
		} catch (SQLException e) {
			e.printStackTrace();
			throw new IOException(e);
		}
		req.getRequestDispatcher("/UserDelete.jsp").forward(req, resp);
	}

	@Override
	public void doPost(HttpServletRequest req, HttpServletResponse resp)
			throws ServletException, IOException {
		Map<String, String> messages = new HashMap<String, String>();
		req.setAttribute("messages", messages);
		try {
			AppUsers appUser = UserParams.lookUpUser(req, appUsersDao, messages);
			if (appUser != null) {
				appUsersDao.delete(appUser);
				// Read it back to prove the row is gone.
				if (appUsersDao.getAppUserById(appUser.getUserId()) == null) {
					messages.put("success", "Deleted user #" + appUser.getUserId() + " ("
						+ appUser.getDisplayName() + ", " + appUser.getEmail() + ").");
					req.setAttribute("deleted", Boolean.TRUE);
				} else {
					messages.put("error", "User #" + appUser.getUserId()
						+ " could not be deleted.");
					req.setAttribute("appUser", appUser);
				}
			}
		} catch (SQLException e) {
			e.printStackTrace();
			throw new IOException(e);
		}
		req.getRequestDispatcher("/UserDelete.jsp").forward(req, resp);
	}
}
