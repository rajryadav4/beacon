package crimeradar.service;

/** Expected scoring outage. Unexpected programming errors are not swallowed. */
public class RiskScoringException extends Exception {
    public RiskScoringException(String message) {
        super(message);
    }

    public RiskScoringException(String message, Throwable cause) {
        super(message, cause);
    }
}
