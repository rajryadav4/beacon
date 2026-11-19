package crimeradar.recommendation;

/**
 * How the user is travelling. Each mode has its own detour limits and crime weights.
 *
 * Routes are only ever compared with routes of the same mode: CrimeRadar never switches
 * a walker to driving because driving scores lower.
 *
 * The limits and weights are product defaults, not validated safety thresholds. Tune them
 * after testing real trips.
 */
public enum TravelMode {
	// label, openrouteservice profile, max detour %, max extra minutes,
	// weights for crimes against PERSON / PROPERTY / OTHER
	WALKING("Walking", "foot-walking", 25.0, 5.0, 1.0, 0.4, 0.3),
	// Cyclists care about person crime and bike theft (property).
	CYCLING("Cycling", "cycling-regular", 20.0, 6.0, 1.0, 0.5, 0.3),
	// Drivers are mostly exposed when parked: car prowls and vehicle theft (property).
	DRIVING("Driving", "driving-car", 20.0, 8.0, 0.4, 1.0, 0.2);

	private final String label;
	private final String orsProfile;
	private final double defaultMaxDetourPercent;
	private final double defaultMaxExtraMinutes;
	private final double personWeight;
	private final double propertyWeight;
	private final double otherWeight;

	TravelMode(String label, String orsProfile, double defaultMaxDetourPercent,
			double defaultMaxExtraMinutes, double personWeight, double propertyWeight,
			double otherWeight) {
		this.label = label;
		this.orsProfile = orsProfile;
		this.defaultMaxDetourPercent = defaultMaxDetourPercent;
		this.defaultMaxExtraMinutes = defaultMaxExtraMinutes;
		this.personWeight = personWeight;
		this.propertyWeight = propertyWeight;
		this.otherWeight = otherWeight;
	}

	public String label() {
		return label;
	}

	public String orsProfile() {
		return orsProfile;
	}

	public double defaultMaxDetourPercent() {
		return defaultMaxDetourPercent;
	}

	public double defaultMaxExtraMinutes() {
		return defaultMaxExtraMinutes;
	}

	/** How much one incident of this group counts toward exposure for this mode. */
	public double weight(CrimeGroup group) {
		switch (group) {
			case PERSON:
				return personWeight;
			case PROPERTY:
				return propertyWeight;
			default:
				return otherWeight;
		}
	}

	/** Parses a request parameter such as "walking"; blank means WALKING. */
	public static TravelMode parse(String value) {
		if (value == null || value.trim().isEmpty()) {
			return WALKING;
		}
		try {
			return valueOf(value.trim().toUpperCase());
		} catch (IllegalArgumentException e) {
			throw new IllegalArgumentException("Unknown travel mode: " + value);
		}
	}
}
