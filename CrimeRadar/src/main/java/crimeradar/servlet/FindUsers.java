package crimeradar.servlet;

import crimeradar.dal.AppUsersDao;
import crimeradar.model.AppUsers;

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
 * CRUD: Read. GET /findusers?q=text lists users whose display name or email contains the text.
 * With no text it lists the newest users. Each row links to update and delete.
 */
@WebServlet("/findusers")
public class FindUsers extends HttpServlet {

	private static final int MAX_RESULTS = 50;

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

		String query = req.getParameter("q");
		query = query == null ? "" : query.trim();
		try {
			List<AppUsers> appUsers = appUsersDao.searchAppUsers(query, MAX_RESULTS);
			req.setAttribute("appUsers", appUsers);
			if (query.isEmpty()) {
				messages.put("success", "Showing the " + appUsers.size() + " newest users.");
			} else if (appUsers.isEmpty()) {
				messages.put("error", "No users match \"" + query + "\".");
			} else {
				messages.put("success", "Found " + appUsers.size() + " user(s) matching \""
					+ query + "\".");
			}
		} catch (SQLException e) {
			e.printStackTrace();
			throw new IOException(e);
		}
		req.setAttribute("q", query);
		req.getRequestDispatcher("/FindUsers.jsp").forward(req, resp);
	}
}
