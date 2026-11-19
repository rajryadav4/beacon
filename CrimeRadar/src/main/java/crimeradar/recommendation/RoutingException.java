package crimeradar.recommendation;

/** The routing service could not produce routes; the message is safe to show to users. */
public class RoutingException extends Exception {

	private static final long serialVersionUID = 1L;

	public RoutingException(String message) {
		super(message);
	}

	public RoutingException(String message, Throwable cause) {
		super(message, cause);
	}
}
