package crimeradar.service;

/**
 * Messages are safe to return to clients: never include API keys or raw
 * provider bodies.
 */
public class RoutingException extends Exception {
    public RoutingException(String message) {
        super(message);
    }

    public RoutingException(String message, Throwable cause) {
        super(message, cause);
    }
}
