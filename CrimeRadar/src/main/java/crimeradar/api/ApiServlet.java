package crimeradar.api;

import crimeradar.util.Json;

import java.io.IOException;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.Map;

import javax.servlet.ServletException;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.servlet.http.HttpSession;

/**
 * Base class for the JSON API servlets. Subclasses override get/post/delete.
 * Errors become {"error": "..."} with the right status; nothing else leaks to the client.
 */
public abstract class ApiServlet extends HttpServlet {
	private static final long serialVersionUID = 1L;

	public static final String JSON_TYPE = "application/json; charset=UTF-8";
	public static final String SESSION_USER = "crimeradar.userId";

	protected void get(HttpServletRequest req, HttpServletResponse resp) throws Exception {
		throw new ApiException(405, "Method not allowed.");
	}

	protected void post(HttpServletRequest req, HttpServletResponse resp) throws Exception {
		throw new ApiException(405, "Method not allowed.");
	}

	protected void delete(HttpServletRequest req, HttpServletResponse resp) throws Exception {
		throw new ApiException(405, "Method not allowed.");
	}

	@Override
	protected void service(HttpServletRequest req, HttpServletResponse resp)
			throws ServletException, IOException {
		try {
			String method = req.getMethod();
			if ("GET".equals(method) || "HEAD".equals(method)) {
				get(req, resp);
			} else if ("POST".equals(method)) {
				post(req, resp);
			} else if ("DELETE".equals(method)) {
				delete(req, resp);
			} else {
				throw new ApiException(405, "Method not allowed.");
			}
		} catch (ApiException e) {
			if (!resp.isCommitted()) {
				resp.resetBuffer();
				error(resp, e.getStatus(), e.getMessage());
			}
		} catch (SQLException e) {
			log("Database error on " + req.getMethod() + " " + req.getRequestURI(), e);
			if (!resp.isCommitted()) {
				resp.resetBuffer();
				error(resp, 503, "The database is not available. Please try again.");
			}
		} catch (Exception e) {
			log("Server error on " + req.getMethod() + " " + req.getRequestURI(), e);
			if (!resp.isCommitted()) {
				resp.resetBuffer();
				error(resp, 500, "Something went wrong.");
			}
		}
	}

	// ------------------------------------------------------------ responses

	public static void error(HttpServletResponse resp, int status, String message)
			throws IOException {
		Map<String, Object> body = new LinkedHashMap<String, Object>();
		body.put("error", message);
		json(resp, status, body);
	}

	public static void json(HttpServletResponse resp, int status, Object body)
			throws IOException {
		byte[] bytes = Json.write(body).getBytes(StandardCharsets.UTF_8);
		resp.setStatus(status);
		resp.setContentType(JSON_TYPE);
		resp.setHeader("X-Content-Type-Options", "nosniff");
		resp.setContentLength(bytes.length);
		resp.getOutputStream().write(bytes);
	}

	public static Map<String, Object> map(Object... keysAndValues) {
		Map<String, Object> m = new LinkedHashMap<String, Object>();
		for (int i = 0; i < keysAndValues.length; i += 2) {
			m.put((String) keysAndValues[i], keysAndValues[i + 1]);
		}
		return m;
	}

	/** ISO UTC time such as 2026-11-19T09:30:00Z. */
	public static String isoUtc(Date date) {
		return Instant.ofEpochMilli(date.getTime()).truncatedTo(ChronoUnit.SECONDS).toString();
	}

	// ------------------------------------------------------------ session

	/** The signed-in user id, or null. Never creates a session. */
	public static Long currentUserId(HttpServletRequest req) {
		HttpSession session = req.getSession(false);
		if (session == null) {
			return null;
		}
		Object id = session.getAttribute(SESSION_USER);
		return id instanceof Long ? (Long) id : null;
	}

	public static long requireUserId(HttpServletRequest req) {
		Long id = currentUserId(req);
		if (id == null) {
			throw new ApiException(401, "Please sign in.");
		}
		return id.longValue();
	}

	// ------------------------------------------------------------ input checks

	/** A trimmed text field. Rejects control characters and text longer than max. */
	public static String text(HttpServletRequest req, String name, int min, int max) {
		String v = req.getParameter(name);
		if (v == null) {
			v = "";
		}
		v = v.trim();
		if (v.length() < min) {
			throw new ApiException(400, "Field '" + name + "' is required.");
		}
		if (v.length() > max) {
			throw new ApiException(400, "Field '" + name + "' is too long (max " + max + ").");
		}
		for (int i = 0; i < v.length(); i++) {
			if (Character.isISOControl(v.charAt(i))) {
				throw new ApiException(400, "Field '" + name + "' has invalid characters.");
			}
		}
		return v;
	}

	/** A password: not trimmed, length 1..max. */
	public static String rawText(HttpServletRequest req, String name, int max) {
		String v = req.getParameter(name);
		if (v == null || v.isEmpty()) {
			throw new ApiException(400, "Field '" + name + "' is required.");
		}
		if (v.length() > max) {
			throw new ApiException(400, "Field '" + name + "' is too long (max " + max + ").");
		}
		return v;
	}

	// Plain decimal text only (no exponent). The regex runs first, so huge or odd numbers
	// such as 1e99999999 are rejected at once and never reach BigDecimal.
	private static final java.util.regex.Pattern DECIMAL_TEXT =
		java.util.regex.Pattern.compile("^-?[0-9]{1,6}([.][0-9]{1,15})?$");
	private static final java.util.regex.Pattern INTEGER_TEXT =
		java.util.regex.Pattern.compile("^-?[0-9]{1,9}([.]0{1,6})?$");

	public static BigDecimal decimal(HttpServletRequest req, String name, double min,
			double max, int scale) {
		String v = req.getParameter(name);
		if (v == null || !DECIMAL_TEXT.matcher(v.trim()).matches()) {
			throw new ApiException(400, "Field '" + name + "' must be a number.");
		}
		BigDecimal d = new BigDecimal(v.trim());
		if (d.doubleValue() < min || d.doubleValue() > max) {
			throw new ApiException(400,
				"Field '" + name + "' must be between " + min + " and " + max + ".");
		}
		return d.setScale(scale, RoundingMode.HALF_UP);
	}

	public static int integer(HttpServletRequest req, String name, int min, int max) {
		String v = req.getParameter(name);
		if (v == null || !INTEGER_TEXT.matcher(v.trim()).matches()) {
			throw new ApiException(400, "Field '" + name + "' must be a whole number.");
		}
		int n = new BigDecimal(v.trim()).setScale(0, RoundingMode.HALF_UP).intValue();
		if (n < min || n > max) {
			throw new ApiException(400,
				"Field '" + name + "' must be between " + min + " and " + max + ".");
		}
		return n;
	}

	/** A value that must be one of the allowed lowercase words. Returns it lowercase. */
	public static String oneOf(HttpServletRequest req, String name, String... allowed) {
		String v = req.getParameter(name);
		if (v != null) {
			v = v.trim().toLowerCase();
			for (String a : allowed) {
				if (a.equals(v)) {
					return v;
				}
			}
		}
		throw new ApiException(400,
			"Field '" + name + "' must be one of: " + String.join(", ", allowed) + ".");
	}
}
