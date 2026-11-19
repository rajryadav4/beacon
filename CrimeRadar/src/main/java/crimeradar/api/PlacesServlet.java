package crimeradar.api;

import crimeradar.dal.UserPlacesDao;
import crimeradar.model.UserPlaces;

import java.util.ArrayList;
import java.util.List;

import javax.servlet.annotation.WebServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

/** GET and POST api/me/places, DELETE api/me/places/{id}. */
@WebServlet(name = "PlacesServlet", urlPatterns = "/api/me/places/*")
public class PlacesServlet extends ApiServlet {
	private static final long serialVersionUID = 1L;

	@Override
	protected void get(HttpServletRequest req, HttpServletResponse resp) throws Exception {
		requireCollectionPath(req);
		long userId = requireUserId(req);
		List<Object> out = new ArrayList<Object>();
		for (UserPlaces p : UserPlacesDao.getInstance().listByUser(userId)) {
			out.add(Views.place(p));
		}
		json(resp, 200, map("places", out));
	}

	@Override
	protected void post(HttpServletRequest req, HttpServletResponse resp) throws Exception {
		requireCollectionPath(req);
		long userId = requireUserId(req);
		String kind = oneOf(req, "kind", "home", "work", "saved");
		String label = req.getParameter("label");
		if ((label == null || label.trim().isEmpty()) && !"saved".equals(kind)) {
			label = "home".equals(kind) ? "Home" : "Work";
		} else {
			label = text(req, "label", 1, 100);
		}
		String address = req.getParameter("address") == null ? ""
			: text(req, "address", 0, 255);
		UserPlaces place = new UserPlaces(userId, UserPlaces.Kind.valueOf(kind.toUpperCase()),
			label.trim(), address, decimal(req, "lat", -90, 90, 6),
			decimal(req, "lng", -180, 180, 6));
		try {
			UserPlacesDao.getInstance().create(place);
		} catch (UserPlacesDao.LimitReachedException e) {
			throw new ApiException(409,
				"You can save up to " + UserPlacesDao.MAX_SAVED + " places. Delete one first.");
		}
		json(resp, 201, map("place", Views.place(place)));
	}

	@Override
	protected void delete(HttpServletRequest req, HttpServletResponse resp) throws Exception {
		long userId = requireUserId(req);
		String path = req.getPathInfo();
		long placeId;
		try {
			if (path == null || path.length() < 2 || path.length() > 20) {
				throw new NumberFormatException();
			}
			placeId = Long.parseLong(path.substring(1));
		} catch (NumberFormatException e) {
			throw new ApiException(404, "Place not found.");
		}
		if (!UserPlacesDao.getInstance().delete(userId, placeId)) {
			throw new ApiException(404, "Place not found.");
		}
		resp.setStatus(204);
	}

	private static void requireCollectionPath(HttpServletRequest req) {
		String path = req.getPathInfo();
		if (path != null && !"/".equals(path)) {
			throw new ApiException(404, "Not found.");
		}
	}
}
