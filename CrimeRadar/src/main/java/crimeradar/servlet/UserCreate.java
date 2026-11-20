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
 * CRUD: Create. GET /usercreate shows the sign-up form; POST inserts a row into AppUsers.
 * The password is stored as a SHA-256 hash, never in plain text.
 */
@WebServlet("/usercreate")
public class UserCreate extends HttpServlet {

	protected AppUsersDao appUsersDao;

	@Override
	public void init() throws ServletException {
		appUsersDao = AppUsersDao.getInstance();
	}

	@Override
	public void doGet(HttpServletRequest req, HttpServletResponse resp)
			throws ServletException, IOException {
		req.setAttribute("messages", new HashMap<String, String>());
		req.getRequestDispatcher("/UserCreate.jsp").forward(req, resp);
	}

	@Override
	public void doPost(HttpServletRequest req, HttpServletResponse resp)
			throws ServletException, IOException {
		Map<String, String> messages = new HashMap<String, String>();
		req.setAttribute("messages", messages);

		String displayName = trim(req.getParameter("displayname"));
		String email = trim(req.getParameter("email"));
		String password = req.getParameter("password");

		if (displayName.isEmpty() || displayName.length() > 100) {
			messages.put("error", "Display name is required (up to 100 characters).");
		} else if (!email.matches("[^@\\s]+@[^@\\s]+\\.[^@\\s]+") || email.length() > 255) {
			messages.put("error", "Enter a valid email address.");
		} else if (password == null || password.length() < 6) {
			messages.put("error", "Password must be at least 6 characters.");
		} else {
			try {
				if (appUsersDao.getAppUserByEmail(email) != null) {
					messages.put("error", "A user with email " + email + " already exists.");
				} else {
					AppUsers appUser = new AppUsers(displayName, email,
						AppUsersDao.hashPassword(password));
					appUser = appUsersDao.create(appUser);
					req.setAttribute("appUser", appUser);
					messages.put("success", "Created user #" + appUser.getUserId() + ": "
						+ displayName + " <" + email + ">.");
				}
			} catch (SQLException e) {
				e.printStackTrace();
				throw new IOException(e);
			}
		}
		// Keep what was typed so the user can fix an error without retyping.
		req.setAttribute("displayname", displayName);
		req.setAttribute("email", email);
		req.getRequestDispatcher("/UserCreate.jsp").forward(req, resp);
	}

	private static String trim(String s) {
		return s == null ? "" : s.trim();
	}
}
