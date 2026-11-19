package crimeradar.service;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

import crimeradar.model.RecommendationResult;
import crimeradar.model.RouteOption;
import crimeradar.model.RouteRequest;
import crimeradar.model.RouteRiskScore;
import crimeradar.model.RoutingResponse;

/**
 * Coordinates routing, Person 1 scoring, and the pure recommendation policy.
 */
public final class RouteRecommendationEngine {
    private final RoutingService routing;
    private final RouteRiskScorer scoring;
    private final RecommendationService recommendations;

    public RouteRecommendationEngine(RoutingService routing, RouteRiskScorer scoring,
            RecommendationService recommendations) {
        this.routing = Objects.requireNonNull(routing);
        this.scoring = Objects.requireNonNull(scoring);
        this.recommendations = Objects.requireNonNull(recommendations);
    }

    public RecommendationResult recommend(RouteRequest request) throws RoutingException {
        Objects.requireNonNull(request);
        RoutingResponse response = routing.generateRoutes(request);
        List<String> warnings = new ArrayList<>(response.warnings());
        List<RouteOption> unscored = new ArrayList<>();
        for (RouteOption route : response.routes()) {
            // Clear provider scores BEFORE duplicate checks and quality warnings.
            // Only Person 1's scorer may supply exposure data and its metadata.
            unscored.add(route.withRisk(null));
        }
        List<RouteOption> candidates = RecommendationService.normalize(unscored, request.travelMode(), warnings);
        Map<String, RouteRiskScore> scoresById = collectScores(candidates, request.departureTime(), warnings);
        List<RouteOption> scored = new ArrayList<>();
        for (RouteOption route : candidates) {
            scored.add(route.withRisk(scoresById.get(route.routeId())));
        }
        RecommendationResult result = recommendations.recommend(scored, request.travelMode());
        warnings.addAll(result.warnings());
        return new RecommendationResult(result.recommendedRoute(), result.fastestRoute(), result.lowestExposureRoute(),
                result.alternativeRoutes(), result.explanation(), result.comparisonMetrics(),
                new ArrayList<>(new LinkedHashSet<>(warnings)));
    }

    private Map<String, RouteRiskScore> collectScores(List<RouteOption> candidates, LocalDateTime departureTime,
            List<String> warnings) {
        Map<String, RouteRiskScore> scoresById = new HashMap<>();
        Set<String> duplicated = new HashSet<>();
        if (!candidates.isEmpty()) {
            try {
                List<RouteRiskScore> scores = scoring.calculateRouteRisks(candidates, departureTime);
                if (scores != null) {
                    for (RouteRiskScore score : scores) {
                        if (score == null || score.routeId() == null) {
                            continue;
                        }
                        if (scoresById.putIfAbsent(score.routeId(), score) != null) {
                            duplicated.add(score.routeId());
                        }
                    }
                }
                // An ambiguous join must not pick an arbitrary exposure value.
                for (String routeId : duplicated) {
                    scoresById.remove(routeId);
                }
                if (!duplicated.isEmpty()) {
                    warnings.add("Duplicate scoring results were treated as unavailable.");
                }
            } catch (RiskScoringException e) {
                warnings.add("Historical exposure scoring is temporarily unavailable; using travel time only.");
            }
        }
        return scoresById;
    }
}
