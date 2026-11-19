package crimeradar.api;

import crimeradar.dal.TripsDao;
import crimeradar.model.TripDetails;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.List;

import javax.servlet.annotation.WebServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

/** POST api/me/trips saves a trip. GET api/me/trips?limit=10 lists the newest trips. */
@WebServlet(name = "TripsServlet", urlPatterns = "/api/me/trips")
public class TripsServlet extends ApiServlet {
	private static final long serialVersionUID = 1L;

	private static final int DEFAULT_LIMIT = 10;
	private static final int MAX_LIMIT = 50;

	@Override
	protected void get(HttpServletRequest req, HttpServletResponse resp) throws Exception {
		long userId = requireUserId(req);
		int limit = DEFAULT_LIMIT;
		if (req.getParameter("limit") != null) {
			limit = integer(req, "limit", 1, MAX_LIMIT);
		}
		List<Object> out = new ArrayList<Object>();
		for (TripDetails t : TripsDao.getInstance().listByUser(userId, limit)) {
			out.add(Views.trip(t));
		}
		json(resp, 200, map("trips", out));
	}

	@Override
	protected void post(HttpServletRequest req, HttpServletResponse resp) throws Exception {
		long userId = requireUserId(req);
		TripDetails t = new TripDetails();
		t.userId = userId;
		t.fromLabel = text(req, "fromLabel", 1, 150);
		t.fromLat = decimal(req, "fromLat", -90, 90, 7);
		t.fromLng = decimal(req, "fromLng", -180, 180, 7);
		t.toLabel = text(req, "toLabel", 1, 150);
		t.toLat = decimal(req, "toLat", -90, 90, 7);
		t.toLng = decimal(req, "toLng", -180, 180, 7);
		t.modeKey = oneOf(req, "mode", "walk", "bike", "car");
		t.departAt = departAt(req);
		t.distanceMeters = integer(req, "distanceMeters", 0, 10000000);
		t.durationSeconds = integer(req, "durationSeconds", 0, 10000000);
		BigDecimal score = decimal(req, "riskScore", 0, 100, 2);
		t.riskScore = score;
		t.riskLevel = oneOf(req, "riskLevel", "low", "elevated", "high");
		t.choice = oneOf(req, "choice", "safest", "fastest", "balanced").toUpperCase();
		TripsDao.getInstance().create(t);
		json(resp, 201, map("trip", Views.trip(t)));
	}

	private static LocalDateTime departAt(HttpServletRequest req) {
		String v = text(req, "departAt", 1, 30);
		try {
			LocalDateTime t = LocalDateTime.parse(v).withSecond(0).withNano(0);
			if (t.getYear() < 2000 || t.getYear() > 2100) {
				throw new ApiException(400, "Field 'departAt' is out of range.");
			}
			return t;
		} catch (DateTimeParseException e) {
			throw new ApiException(400, "Field 'departAt' must look like 2026-11-19T21:30.");
		}
	}
}
