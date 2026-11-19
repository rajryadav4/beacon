package crimeradar.service;

import java.time.LocalDateTime;
import java.util.List;

import crimeradar.model.RouteOption;
import crimeradar.model.RouteRiskScore;

/**
 *
 * Departure is Seattle local time (America/Los_Angeles). Return one score per
 * routeId
 * on a common nonnegative scale, with null/omitted scores for unavailable
 * exposure.
 * If matching or source data cannot support a comparable score, return null or
 * omit that route's score; never use zero to mean missing. A valid zero means
 * zero exposure on the scoring model's scale, not guaranteed safety.
 * Mark synthetic development results with DataQuality.demonstrationData=true.
 * Implementations shared by servlets must be thread safe and release JDBC
 * resources.
 */
@FunctionalInterface
public interface RouteRiskScorer {
    List<RouteRiskScore> calculateRouteRisks(List<RouteOption> routes, LocalDateTime departureTime)
            throws RiskScoringException;
}
