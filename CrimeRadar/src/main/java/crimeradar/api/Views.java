package crimeradar.api;

import crimeradar.model.AppUsers;
import crimeradar.model.TripDetails;
import crimeradar.model.UserPlaces;
import crimeradar.model.UserPreferences;

import java.time.format.DateTimeFormatter;
import java.util.Map;

/** Builds the JSON shapes User, Preferences, Place and Trip from docs/API.md section 3. */
final class Views {
	private static final DateTimeFormatter DEPART = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm");

	private Views() {
	}

	static Map<String, Object> preferences(UserPreferences p) {
		return ApiServlet.map("mode", p.modeKey, "safetyWeight", p.safetyWeight.doubleValue(),
			"alerts", p.alertsOn);
	}

	static Map<String, Object> user(AppUsers u, UserPreferences p) {
		return ApiServlet.map("id", u.getUserId(), "displayName", u.getDisplayName(),
			"email", u.getEmail(), "createdAt", ApiServlet.isoUtc(u.getCreatedAt()),
			"preferences", preferences(p));
	}

	static Map<String, Object> place(UserPlaces p) {
		return ApiServlet.map("id", p.placeId, "kind", p.kind.name().toLowerCase(),
			"label", p.label, "address", p.address, "lat", p.latitude.doubleValue(),
			"lng", p.longitude.doubleValue());
	}

	static Map<String, Object> trip(TripDetails t) {
		return ApiServlet.map("id", t.recommendationId, "fromLabel", t.fromLabel,
			"toLabel", t.toLabel, "toLat", t.toLat.doubleValue(), "toLng", t.toLng.doubleValue(),
			"mode", t.modeKey, "departAt", t.departAt.format(DEPART),
			"riskScore", t.riskScore.doubleValue(), "riskLevel", t.riskLevel,
			"choice", t.choice.toLowerCase(), "createdAt", ApiServlet.isoUtc(t.createdAt));
	}
}
