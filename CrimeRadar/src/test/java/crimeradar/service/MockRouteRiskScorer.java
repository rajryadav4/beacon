package crimeradar.service;

import crimeradar.model.*;
import java.time.LocalDateTime;
import java.util.*;

/** Test/development fixture only; never registered in the deployed WAR. */
public final class MockRouteRiskScorer implements RouteRiskScorer {
    private final Map<String, Double> demonstrationScores;
    public MockRouteRiskScorer(Map<String, Double> demonstrationScores) { this.demonstrationScores = Map.copyOf(demonstrationScores); }
    @Override public List<RouteRiskScore> calculateRouteRisks(List<RouteOption> routes, LocalDateTime departureTime) {
        return routes.stream().map(r -> new RouteRiskScore(r.routeId(), demonstrationScores.get(r.routeId()),
                new DataQuality(null, null, true, List.of("Demonstration fixture; no real crime statistics.")))).toList();
    }
}
