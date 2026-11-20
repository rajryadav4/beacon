package crimeradar.model;

import java.util.Locale;

/**
 * How the user travels. Routes are only ever compared with routes of the same mode.
 * Each mode knows its name in openrouteservice, in OSRM (routing.openstreetmap.de) and in the
 * app (UserPreferences.ModeKey / TravelModes table: walk, bike, car).
 */
public enum TravelMode {
    WALKING("foot-walking", "routed-foot", "walk", "walking"),
    CYCLING("cycling-regular", "routed-bike", "bike", "cycling"),
    DRIVING("driving-car", "routed-car", "car", "driving");

    private final String orsProfile;
    private final String osrmService;
    private final String appKey;
    private final String label;

    TravelMode(String orsProfile, String osrmService, String appKey, String label) {
        this.orsProfile = orsProfile;
        this.osrmService = osrmService;
        this.appKey = appKey;
        this.label = label;
    }

    public String orsProfile() { return orsProfile; }

    public String osrmService() { return osrmService; }

    /** The app's short key: walk, bike or car. */
    public String appKey() { return appKey; }

    /** Lower-case word for explanations: walking, cycling, driving. */
    public String label() { return label; }

    /** Accepts WALKING/walking/walk, CYCLING/cycling/bike, DRIVING/driving/car. */
    public static TravelMode parse(String value) {
        if (value != null) {
            String v = value.trim().toLowerCase(Locale.ROOT);
            for (TravelMode mode : values()) {
                if (mode.label.equals(v) || mode.appKey.equals(v)) {
                    return mode;
                }
            }
        }
        throw new IllegalArgumentException("mode must be walking, cycling, or driving.");
    }
}
