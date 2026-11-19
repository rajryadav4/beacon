package crimeradar.api;

/** An error that becomes {"error": message} with the given HTTP status. */
public class ApiException extends RuntimeException {
	private static final long serialVersionUID = 1L;

	private final int status;

	public ApiException(int status, String message) {
		super(message);
		this.status = status;
	}

	public int getStatus() {
		return status;
	}
}
