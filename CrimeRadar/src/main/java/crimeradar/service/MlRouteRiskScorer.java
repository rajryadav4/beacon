package crimeradar.service;

import java.sql.SQLException;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.function.LongSupplier;

import crimeradar.dal.MapDataDao;
import crimeradar.model.Coordinate;
import crimeradar.model.DataQuality;
import crimeradar.model.RouteOption;
import crimeradar.model.RouteRiskScore;

/**
 * Person 1's scorer: historical crime exposure of each route from the ML risk model.
 *
 * <pre>
 *   exposure = sum over 25 m steps of (step km x ExpectedRisk of the step's grid cell,
 *              in the time band when the traveller reaches that step)
 * </pre>
 *
 * Total, not average: a long detour through quiet streets is not rewarded just for being long.
 * Arrival time per step: a trip leaving at 5:50 PM is scored with afternoon risk at the start and
 * evening risk after 6 PM. Scores are relative (for comparing routes of one trip), never a
 * probability.
 *
 * Steps off the Seattle grid have no data. Their share is reported in
 * DataQuality.matchedGeometryFraction; a route with less than half of its length on the grid gets
 * no score (null), never zero.
 *
 * The model snapshot is cached and reloaded when MapDataDao.signature() changes (a new model or a
 * re-import), checked at most once a minute. Thread safe.
 */
public final class MlRouteRiskScorer implements RouteRiskScorer {

    /** Where the model snapshot comes from. The default reads MySQL through MapDataDao. */
    public interface Source {
        /** A cheap value that changes whenever the risk data changes. */
        String signature() throws SQLException;

        /** The active model, or null when none is imported. */
        RiskGrid load() throws SQLException;
    }

    static final double STEP_METERS = 25;
    static final double MIN_MATCHED_FRACTION = 0.5;
    static final double FULL_MATCH_FRACTION = 0.95;
    static final long RECHECK_MILLIS = 60_000;

    private final Source source;
    private final LongSupplier clock;
    private RiskGrid grid;
    private String signature;
    private long checkedAt;

    public MlRouteRiskScorer() {
        this(databaseSource(), System::currentTimeMillis);
    }

    public MlRouteRiskScorer(Source source, LongSupplier clock) {
        this.source = Objects.requireNonNull(source);
        this.clock = Objects.requireNonNull(clock);
    }

    /** A scorer over a fixed grid (tests, offline tools). */
    public static MlRouteRiskScorer fixed(RiskGrid grid) {
        return new MlRouteRiskScorer(new Source() {
            @Override public String signature() { return "fixed"; }
            @Override public RiskGrid load() { return grid; }
        }, () -> 0L);
    }

    public static Source databaseSource() {
        return new Source() {
            @Override
            public String signature() throws SQLException {
                return MapDataDao.getInstance().signature();
            }

            @Override
            public RiskGrid load() throws SQLException {
                MapDataDao dao = MapDataDao.getInstance();
                MapDataDao.ModelRun run = dao.loadActiveModel();
                if (run == null) {
                    return null;
                }
                return RiskGrid.of(run.version, run.trainedAt, dao.loadRisk(run.version));
            }
        };
    }

    @Override
    public List<RouteRiskScore> calculateRouteRisks(List<RouteOption> routes, LocalDateTime departureTime)
            throws RiskScoringException {
        if (departureTime == null) {
            throw new IllegalArgumentException("Departure time is required.");
        }
        RiskGrid snapshot = currentGrid();
        List<RouteRiskScore> scores = new ArrayList<>();
        for (RouteOption route : routes == null ? List.<RouteOption>of() : routes) {
            if (route != null && route.routeId() != null) {
                scores.add(score(route, snapshot, departureTime));
            }
        }
        return scores;
    }

    /** The cached model, reloaded when its signature changed. */
    synchronized RiskGrid currentGrid() throws RiskScoringException {
        long now = clock.getAsLong();
        if (grid == null || now - checkedAt >= RECHECK_MILLIS) {
            try {
                String current = source.signature();
                if (grid == null || !Objects.equals(current, signature)) {
                    RiskGrid loaded = source.load();
                    if (loaded == null) {
                        grid = null;
                        throw new RiskScoringException(
                                "No active risk model is loaded. Run scripts/setup-db.ps1 to import ml/output.");
                    }
                    grid = loaded;
                    signature = current;
                }
                checkedAt = now;
            } catch (SQLException e) {
                if (grid == null) {
                    throw new RiskScoringException("The risk model could not be read from the database.", e);
                }
                // Keep scoring with the last good snapshot; try the database again next minute.
                checkedAt = now;
            } catch (RuntimeException e) {
                if (grid == null) {
                    throw new RiskScoringException("The risk model data is invalid.", e);
                }
                checkedAt = now;
            }
        }
        return grid;
    }

    /** Exposure of one route. Package-private for tests. */
    static RouteRiskScore score(RouteOption route, RiskGrid grid, LocalDateTime departure) {
        List<Coordinate> path = route.geometry();
        double totalMeters = 0;
        for (int i = 0; i + 1 < path.size(); i++) {
            totalMeters += distanceMeters(path.get(i), path.get(i + 1));
        }
        if (path.size() < 2 || !(totalMeters > 0) || !(route.durationSeconds() > 0)) {
            return new RouteRiskScore(route.routeId(), null, new DataQuality(null, null, false,
                    List.of("A route without a usable path or duration was not scored.")));
        }
        double exposure = 0;
        double matchedMeters = 0;
        double travelled = 0;
        for (int i = 0; i + 1 < path.size(); i++) {
            Coordinate a = path.get(i);
            Coordinate b = path.get(i + 1);
            double segment = distanceMeters(a, b);
            if (segment <= 0) {
                continue;
            }
            int steps = Math.max(1, (int) Math.ceil(segment / STEP_METERS));
            double step = segment / steps;
            for (int s = 0; s < steps; s++) {
                double f = (s + 0.5) / steps;
                double lat = a.latitude() + (b.latitude() - a.latitude()) * f;
                double lng = a.longitude() + (b.longitude() - a.longitude()) * f;
                int cell = RiskGrid.cellId(lat, lng);
                if (cell < 0) {
                    continue;
                }
                double metersSoFar = travelled + segment * f;
                long secondsIn = Math.round(route.durationSeconds() * metersSoFar / totalMeters);
                int band = RiskGrid.band(departure.plusSeconds(secondsIn).getHour());
                exposure += step / 1000.0 * grid.risk(cell, band);
                matchedMeters += step;
            }
            travelled += segment;
        }
        double matched = Math.min(1.0, matchedMeters / totalMeters);
        List<String> messages = new ArrayList<>();
        messages.add("Crime exposure uses risk model " + grid.modelVersion() + ".");
        if (matched < MIN_MATCHED_FRACTION) {
            messages.add("A route that is mostly outside Seattle was not scored: CrimeRadar has no crime data there.");
            return new RouteRiskScore(route.routeId(), null, new DataQuality(null, matched, false, messages));
        }
        if (matched < FULL_MATCH_FRACTION) {
            messages.add("Part of a route is outside Seattle, where CrimeRadar has no crime data.");
        }
        return new RouteRiskScore(route.routeId(), exposure, new DataQuality(null, matched, false, messages));
    }

    /** Great-circle distance in meters. */
    static double distanceMeters(Coordinate a, Coordinate b) {
        double lat1 = Math.toRadians(a.latitude());
        double lat2 = Math.toRadians(b.latitude());
        double dLat = lat2 - lat1;
        double dLng = Math.toRadians(b.longitude() - a.longitude());
        double h = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
    }
}
