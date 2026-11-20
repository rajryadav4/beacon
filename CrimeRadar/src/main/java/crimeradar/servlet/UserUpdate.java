package crimeradar.servlet;

import crimeradar.dal.AppUsersDao;
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
 * CRUD: Update. GET /userupdate?userid=N shows the user's current details; POST changes the
 * display name with an UPDATE on AppUsers.
 */
@WebServlet("/userupdate")
public class UserUpdate extends HttpServlet {

	protected AppUsersDao appUsersDao;

	@Override
	public void init() throws ServletException {
		appUsersDao = AppUsersDao.getInstance();
	}

	@Override
	public void doGet(HttpServletRequest req, HttpServletResponse resp)
			throws ServletException, IOException {
		Map<String, String> messages = new HashMap<String, String>();
		req.setAttribute("messages", messages);
		try {
			AppUsers appUser = UserParams.lookUpUser(req, appUsersDao, messages);
			req.setAttribute("appUser", appUser);
		} catch (SQLException e) {
			e.printStackTrace();
			throw new IOException(e);
		}
		req.getRequestDispatcher("/UserUpdate.jsp").forward(req, resp);
	}

	@Override
	public void doPost(HttpServletRequest req, HttpServletResponse resp)
			throws ServletException, IOException {
		Map<String, String> messages = new HashMap<String, String>();
		req.setAttribute("messages", messages);
		try {
			AppUsers appUser = UserParams.lookUpUser(req, appUsersDao, messages);
			if (appUser != null) {
				String newDisplayName = req.getParameter("displayname");
				newDisplayName = newDisplayName == null ? "" : newDisplayName.trim();
				if (newDisplayName.isEmpty() || newDisplayName.length() > 100) {
					messages.put("error", "Display name is required (up to 100 characters).");
				} else {
					String oldDisplayName = appUser.getDisplayName();
					appUser = appUsersDao.updateDisplayName(appUser, newDisplayName);
					messages.put("success", "Updated user #" + appUser.getUserId()
						+ ": display name changed from \"" + oldDisplayName + "\" to \""
						+ newDisplayName + "\".");
				}
			}
			req.setAttribute("appUser", appUser);
		} catch (SQLException e) {
			e.printStackTrace();
			throw new IOException(e);
		}
		req.getRequestDispatcher("/UserUpdate.jsp").forward(req, resp);
	}
}
