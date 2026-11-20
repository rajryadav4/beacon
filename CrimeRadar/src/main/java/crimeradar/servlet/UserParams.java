package crimeradar.servlet;

import crimeradar.dal.AppUsersDao;
import crimeradar.model.AppUsers;

import java.sql.SQLException;
import java.util.Map;

import javax.servlet.http.HttpServletRequest;

/** Shared request handling for the user pages. */
final class UserParams {

	private UserParams() {
	}

	/**
	 * Reads the userid parameter and loads that user. Returns null and puts an error in messages
	 * when the parameter is missing, malformed or names no user.
	 */
	static AppUsers lookUpUser(HttpServletRequest req, AppUsersDao appUsersDao,
			Map<String, String> messages) throws SQLException {
		String userIdParam = req.getParameter("userid");
		if (userIdParam == null || userIdParam.trim().isEmpty()) {
			messages.put("error", "No user selected.");
			return null;
		}
		long userId;
		try {
			userId = Long.parseLong(userIdParam.trim());
		} catch (NumberFormatException e) {
			messages.put("error", "Invalid user id: " + userIdParam);
			return null;
		}
		AppUsers appUser = appUsersDao.getAppUserById(userId);
		if (appUser == null) {
			messages.put("error", "User #" + userId + " does not exist.");
		}
		return appUser;
	}
}
