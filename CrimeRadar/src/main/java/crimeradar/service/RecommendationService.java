package crimeradar.service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

import crimeradar.model.Coordinate;
import crimeradar.model.RecommendationResult;
import crimeradar.model.RecommendationResult.ComparisonMetrics;
import crimeradar.model.RouteOption;
import crimeradar.model.RouteRiskScore;
import crimeradar.model.TravelMode;

/** Pure recommendation policy: no HTTP, SQL, or fabricated exposure data. */
public final class RecommendationService {
    private static final Comparator<RouteOption> FASTEST = Comparator.comparingDouble(RouteOption::durationSeconds)
            .thenComparingDouble(RouteOption::distanceMeters).thenComparing(RouteOption::routeId);
    private final RecommendationSettings settings;

    public RecommendationService(RecommendationSettings settings) {
        this.settings = Objects.requireNonNull(settings);
    }

    public RecommendationService() {
        this(RecommendationSettings.defaults());
    }

    public RecommendationResult recommend(List<RouteOption> candidates, TravelMode mode) {
        Objects.requireNonNull(mode, "Travel mode is required.");
        List<String> warnings = new ArrayList<>();
        List<RouteOption> routes = normalize(candidates, mode, warnings);
        if (routes.isEmpty()) {
            return new RecommendationResult(null, null, null, List.of(),
                    "No valid routes available for the selected travel mode.",
                    new ComparisonMetrics(0, 0, 0, 0, 0, null), warnings);
        }
        RouteOption fastest = routes.getFirst();
        double budget = settings.detourLimits().get(mode).allowedAdditionalSeconds(fastest.durationSeconds());
        List<RouteOption> eligible = practicalRoutes(routes, fastest, budget);
        RouteOption lowest = lowestScoredRoute(eligible);
        boolean missingScores = false;
        for (RouteOption route : eligible) {
            if (!validScore(route.historicalExposureScore())) {
                missingScores = true;
            }
        }
        if (missingScores) {
            warnings.add(
                    "Historical exposure is unavailable for one or more practical routes; missing scores are not zero.");
        }
        if (routes.size() != eligible.size()) {
            warnings.add("Alternatives exceeding the maximum time detour were excluded.");
        }
        warnings.add("Historical exposure scores are not probabilities of crime or guarantees of safety.");
        RouteOption recommended = fastest;
        String explanation;
        if (!validScore(fastest.historicalExposureScore())) {
            explanation = "Selected the fastest valid route because historical exposure could not be evaluated against it.";
        } else if (offersMeaningfulImprovement(fastest, lowest)) {
            recommended = lowest;
            explanation = String.format(Locale.ROOT,
                    "Selected a route with %.1f%% lower historical exposure and %.0f additional seconds, within the detour limit.",
                    improvement(fastest, lowest) * 100, lowest.durationSeconds() - fastest.durationSeconds());
        } else {
            explanation = "Selected the fastest route; no scored practical alternative offers a meaningful historical exposure improvement.";
        }
        Double reduction = validScore(fastest.historicalExposureScore())
                && validScore(recommended.historicalExposureScore())
                        ? improvement(fastest, recommended)
                        : null;
        double additional = recommended.durationSeconds() - fastest.durationSeconds();
        List<RouteOption> alternatives = new ArrayList<>();
        for (RouteOption route : eligible) {
            if (!route.routeId().equals(recommended.routeId())) {
                alternatives.add(route);
            }
        }
        return new RecommendationResult(recommended, fastest, lowest, alternatives, explanation,
                new ComparisonMetrics(routes.size(), eligible.size(), budget, additional,
                        additional / fastest.durationSeconds(), reduction),
                warnings);
    }

    private static List<RouteOption> practicalRoutes(List<RouteOption> routes, RouteOption fastest, double budget) {
        List<RouteOption> eligible = new ArrayList<>();
        double maximumDuration = fastest.durationSeconds() + budget;
        for (RouteOption route : routes) {
            // Compare total durations to avoid rounding from subtracting decimal times.
            // Do not add a tolerance: a zero-detour preference must exclude every slower
            // route.
            if (route.durationSeconds() <= maximumDuration) {
                eligible.add(route);
            }
        }
        return eligible;
    }

    private static RouteOption lowestScoredRoute(List<RouteOption> routes) {
        RouteOption lowest = null;
        for (RouteOption route : routes) {
            if (validScore(route.historicalExposureScore())
                    && (lowest == null || route.historicalExposureScore() < lowest.historicalExposureScore())) {
                lowest = route;
            }
        }
        // Routes are already sorted by duration, distance, then ID, so equal scores
        // keep that order.
        return lowest;
    }

    private boolean offersMeaningfulImprovement(RouteOption fastest, RouteOption lowest) {
        if (lowest == null || lowest.historicalExposureScore() >= fastest.historicalExposureScore()) {
            return false;
        }
        // Compare scores directly, avoiding division and an arbitrary threshold
        // tolerance.
        double maximumScore = fastest.historicalExposureScore() * (1 - settings.meaningfulImprovementFraction());
        return lowest.historicalExposureScore() <= maximumScore;
    }

    private static double improvement(RouteOption fastest, RouteOption route) {
        return fastest.historicalExposureScore() == 0 ? 0
                : (fastest.historicalExposureScore() - route.historicalExposureScore())
                        / fastest.historicalExposureScore();
    }

    public static boolean validScore(Double value) {
        return value != null && Double.isFinite(value) && value >= 0;
    }

    /**
     * Also used before scoring, so Person 1 receives unique valid geometries for
     * the chosen mode.
     */
    static List<RouteOption> normalize(List<RouteOption> candidates, TravelMode mode, List<String> warnings) {
        Map<String, RouteOption> byId = new HashMap<>();
        Set<String> conflicting = new HashSet<>();
        for (RouteOption route : candidates == null ? List.<RouteOption>of() : candidates) {
            if (route == null || route.travelMode() != mode) {
                continue;
            }
            if (!validRoute(route)) {
                warnings.add("Ignored an invalid route (identifier, distance, duration, or geometry).");
                continue;
            }
            RouteOption previous = byId.putIfAbsent(route.routeId(), route);
            if (previous != null && !previous.equals(route)) {
                conflicting.add(route.routeId());
            }
        }
        for (String routeId : conflicting) {
            byId.remove(routeId);
        }
        if (!conflicting.isEmpty()) {
            warnings.add("Ignored conflicting duplicate route identifiers.");
        }
        List<RouteOption> sorted = new ArrayList<>(byId.values());
        sorted.sort(FASTEST);
        Set<List<Coordinate>> seenGeometry = new HashSet<>();
        List<RouteOption> routes = new ArrayList<>();
        for (RouteOption route : sorted) {
            if (!seenGeometry.add(route.geometry())) {
                continue;
            }
            if (route.historicalExposureScore() != null && !validScore(route.historicalExposureScore())) {
                warnings.add(
                        "Invalid historical exposure was treated as unavailable for route " + route.routeId() + ".");
                route = route.withRisk(new RouteRiskScore(route.routeId(), null, route.dataQuality()));
            }
            if (route.dataQuality() != null) {
                warnings.addAll(route.dataQuality().messages());
                if (route.dataQuality().demonstrationData()) {
                    warnings.add("DEMONSTRATION DATA: exposure scores are synthetic, not crime statistics.");
                }
            }
            routes.add(route);
        }
        return List.copyOf(routes);
    }

    private static boolean validRoute(RouteOption route) {
        if (route.routeId() == null || route.routeId().isBlank()
                || !Double.isFinite(route.durationSeconds()) || route.durationSeconds() <= 0
                || !Double.isFinite(route.distanceMeters()) || route.distanceMeters() <= 0
                || route.geometry().size() < 2) {
            return false;
        }
        Coordinate first = route.geometry().getFirst();
        for (Coordinate coordinate : route.geometry()) {
            if (!first.equals(coordinate)) {
                return true;
            }
        }
        return false;
    }
}
