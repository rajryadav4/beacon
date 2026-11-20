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
        RouteOption fastest = routes.get(0);
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
            explanation = "Recommended the fastest route because its crime exposure could not be evaluated.";
        } else if (offersMeaningfulImprovement(fastest, lowest)) {
            recommended = lowest;
            explanation = String.format(Locale.ROOT,
                    "This %s route adds %s to the fastest option (%s instead of %s) and has %d%% lower crime exposure.",
                    mode.label(), minutes(lowest.durationSeconds() - fastest.durationSeconds()),
                    minutes(lowest.durationSeconds()), minutes(fastest.durationSeconds()),
                    Math.round(improvement(fastest, lowest) * 100));
        } else {
            explanation = fastestExplanation(mode, routes, eligible, fastest, lowest, budget);
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

    /** Why the fastest route was kept, in plain words. The fastest route has a valid score here. */
    private String fastestExplanation(TravelMode mode, List<RouteOption> routes, List<RouteOption> eligible,
            RouteOption fastest, RouteOption lowest, double budget) {
        if (routes.size() == 1) {
            return "Only one " + mode.label() + " route was found for this trip, so it is recommended.";
        }
        boolean allScored = true;
        boolean allZero = true;
        for (RouteOption route : routes) {
            Double score = route.historicalExposureScore();
            allScored &= validScore(score);
            allZero &= validScore(score) && score == 0;
        }
        if (allScored && allZero) {
            return "No crime is predicted along any of these routes, so the fastest route is recommended.";
        }
        RouteOption lowestOverall = lowestScoredRoute(routes);
        if (lowestOverall != null && !eligible.contains(lowestOverall)
                && offersMeaningfulImprovement(fastest, lowestOverall)) {
            return String.format(Locale.ROOT,
                    "The fastest route is recommended. A route with %d%% lower crime exposure exists, "
                            + "but it takes %s, over your limit of %s.",
                    Math.round(improvement(fastest, lowestOverall) * 100), minutes(lowestOverall.durationSeconds()),
                    minutes(fastest.durationSeconds() + budget));
        }
        if (lowest != null && lowest != fastest
                && lowest.historicalExposureScore() < fastest.historicalExposureScore()) {
            return String.format(Locale.ROOT,
                    "The fastest route is recommended. Other routes within your time limit are only %d%% lower "
                            + "in crime exposure, below the %d%% needed to be worth a detour.",
                    Math.round(improvement(fastest, lowest) * 100),
                    Math.round(settings.meaningfulImprovementFraction() * 100));
        }
        for (RouteOption route : eligible) {
            if (!validScore(route.historicalExposureScore())) {
                return "The fastest route is recommended. Some other routes within your time limit could not be "
                        + "scored, and none of the scored ones has lower crime exposure.";
            }
        }
        return "The fastest route also has the lowest crime exposure, so there is no reason to detour.";
    }

    /** Minutes for people: "12 min", "under 1 min". */
    static String minutes(double seconds) {
        long rounded = Math.round(seconds / 60.0);
        return rounded < 1 ? "under 1 min" : rounded + " min";
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
        Coordinate first = route.geometry().get(0);
        for (Coordinate coordinate : route.geometry()) {
            if (!first.equals(coordinate)) {
                return true;
            }
        }
        return false;
    }
}
