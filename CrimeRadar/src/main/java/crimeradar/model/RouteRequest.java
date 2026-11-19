package crimeradar.model;

import java.time.LocalDateTime;

/** Departure is Seattle local time; ORS estimates are not time-dependent traffic predictions. */
public record RouteRequest(Coordinate origin, Coordinate destination, TravelMode travelMode,
                           LocalDateTime departureTime) {
    public RouteRequest {
        if (origin == null || destination == null || travelMode == null || departureTime == null) {
            throw new IllegalArgumentException("Origin, destination, travel mode, and departure time are required.");
        }
        if (origin.equals(destination)) throw new IllegalArgumentException("Origin and destination must differ.");
    }
}
