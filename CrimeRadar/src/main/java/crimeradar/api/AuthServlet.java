package crimeradar.api;

import crimeradar.dal.AppUsersDao;
import crimeradar.dal.DemoAccount;
import crimeradar.dal.UserPreferencesDao;
import crimeradar.model.AppUsers;
import crimeradar.model.UserPreferences;
import crimeradar.util.Passwords;

import java.sql.SQLException;
import java.sql.SQLIntegrityConstraintViolationException;
import java.util.regex.Pattern;

import javax.servlet.annotation.WebServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.servlet.http.HttpSession;

/**
 * POST api/auth/register, POST api/auth/login, POST api/auth/logout, GET api/auth/me.
 */
@WebServlet(name = "AuthServlet", urlPatterns = "/api/auth/*")
public class AuthServlet extends ApiServlet {
	private static final long serialVersionUID = 1L;

	private static final Pattern EMAIL =
		Pattern.compile("^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9.-]{1,190}\\.[A-Za-z]{2,24}$");
	private static final int MIN_PASSWORD = 8;
	private static final int MAX_PASSWORD = 128;
	private static final String GENERIC_LOGIN_ERROR = "Email or password is incorrect.";

	@Override
	protected void get(HttpServletRequest req, HttpServletResponse resp) throws Exception {
		if (!"/me".equals(req.getPathInfo())) {
			throw new ApiException(404, "Not found.");
		}
		Long userId = currentUserId(req);
		if (userId == null) {
			throw new ApiException(401, "Not signed in.");
		}
		AppUsers user = AppUsersDao.getInstance().getAppUserById(userId);
		if (user == null) {
			HttpSession session = req.getSession(false);
			if (session != null) {
				session.invalidate();
			}
			throw new ApiException(401, "Not signed in.");
		}
		UserPreferences prefs = UserPreferencesDao.getInstance().get(user.getUserId());
		json(resp, 200, map("user", Views.user(user, prefs)));
	}

	@Override
	protected void post(HttpServletRequest req, HttpServletResponse resp) throws Exception {
		String path = req.getPathInfo();
		if ("/register".equals(path)) {
			register(req, resp);
		} else if ("/login".equals(path)) {
			login(req, resp);
		} else if ("/logout".equals(path)) {
			HttpSession session = req.getSession(false);
			if (session != null) {
				session.invalidate();
			}
			resp.setStatus(204);
		} else {
			throw new ApiException(404, "Not found.");
		}
	}

	private void register(HttpServletRequest req, HttpServletResponse resp) throws Exception {
		String displayName = text(req, "displayName", 1, 100);
		String email = text(req, "email", 3, 255).toLowerCase();
		String password = rawText(req, "password", MAX_PASSWORD);
		if (!EMAIL.matcher(email).matches()) {
			throw new ApiException(400, "Enter a valid email address.");
		}
		if (password.length() < MIN_PASSWORD) {
			throw new ApiException(400, "Password must have at least " + MIN_PASSWORD + " characters.");
		}
		AppUsersDao users = AppUsersDao.getInstance();
		if (users.getAppUserByEmail(email) != null) {
			throw new ApiException(409, "An account with this email already exists.");
		}
		AppUsers user = new AppUsers(displayName, email, Passwords.hash(password));
		try {
			users.create(user);
		} catch (SQLIntegrityConstraintViolationException e) {
			throw new ApiException(409, "An account with this email already exists.");
		}
		UserPreferences prefs = new UserPreferences();
		prefs.userId = user.getUserId();
		UserPreferencesDao.getInstance().save(prefs);
		signIn(req, user.getUserId());
		json(resp, 201, map("user", Views.user(user, prefs)));
	}

	private void login(HttpServletRequest req, HttpServletResponse resp) throws Exception {
		String email = text(req, "email", 1, 255).toLowerCase();
		String password = rawText(req, "password", MAX_PASSWORD);
		// The public demo account is shared by every visitor: no throttle for it.
		boolean demo = DemoAccount.isDemoEmail(email);
		String key = LoginThrottle.key(email, req.getRemoteAddr());
		if (!demo) {
			long wait = LoginThrottle.tryAttempt(key); // counts this attempt, atomically
			if (wait > 0) {
				resp.setHeader("Retry-After", Long.toString(wait));
				throw new ApiException(429, "Too many failed attempts. Try again in a few minutes.");
			}
		}

		AppUsersDao users = AppUsersDao.getInstance();
		AppUsers user = users.getAppUserByEmail(email);
		boolean ok;
		if (user == null) {
			Passwords.dummyVerify(password); // same cost as a real check
			ok = false;
		} else {
			ok = Passwords.verify(password, user.getPasswordHash());
		}
		if (!ok) {
			throw new ApiException(401, GENERIC_LOGIN_ERROR);
		}
		LoginThrottle.clear(key);
		if (demo) {
			DemoAccount.reset(user.getUserId()); // the next visitor starts from the seed data
		}
		if (Passwords.needsUpgrade(user.getPasswordHash())) {
			try {
				users.updatePasswordHash(user.getUserId(), Passwords.hash(password));
			} catch (SQLException e) {
				log("Could not upgrade password hash for user " + user.getUserId(), e);
			}
		}
		signIn(req, user.getUserId());
		UserPreferences prefs = UserPreferencesDao.getInstance().get(user.getUserId());
		json(resp, 200, map("user", Views.user(user, prefs)));
	}

	/** Start the session for this user. The session id changes (stops session fixation). */
	private static void signIn(HttpServletRequest req, long userId) {
		HttpSession session = req.getSession(true);
		req.changeSessionId();
		session.setAttribute(SESSION_USER, Long.valueOf(userId));
		session.setMaxInactiveInterval(60 * 60 * 8);
	}
}
