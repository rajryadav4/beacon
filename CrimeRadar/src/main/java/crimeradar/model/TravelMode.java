package crimeradar.model;

public enum TravelMode {
    WALKING("foot-walking"), CYCLING("cycling-regular"), DRIVING("driving-car");

    private final String orsProfile;
    TravelMode(String orsProfile) { this.orsProfile = orsProfile; }
    public String orsProfile() { return orsProfile; }
}
