package crimeradar.dal;

import crimeradar.model.RouteRisk;
import crimeradar.model.Routes;
import crimeradar.model.SegmentRisk;

import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;

/**
 * Advanced feature: route risk scoring (business query Q11).
 *
 * A neighborhood's crime rate is its incidents per day over a scoring window. A route's risk is
 * the sum over its segments of (segment km x that rate). Nothing is stored: scores are computed
 * from CrimeIncidents on every request, so they follow the data as it changes.
 *
 * The window ends at the newest incident in CrimeIncidents rather than at NOW(). The SPD extract
 * is a snapshot, so anchoring to NOW() would shrink the window (and every score) as the snapshot
 * ages; anchoring to the data keeps results stable for a demo.
 */
public class RouteRiskDao {
	protected ConnectionManager connectionManager;

	private static RouteRiskDao instance = null;

	protected RouteRiskDao() {
		connectionManager = new ConnectionManager();
	}

	public static RouteRiskDao getInstance() {
		if (instance == null) {
			instance = new RouteRiskDao();
		}
		return instance;
	}

	// Incidents per neighborhood over the window [newest incident - ? days, newest incident].
	// Parameters: windowDays (divisor), windowDays (interval).
	private static final String NEIGHBORHOOD_RATE_CTE =
		"WITH Anchor AS (SELECT MAX(OccurredAt) AS LatestAt FROM CrimeIncidents), "
			+ "NeighborhoodCrimeRate AS ("
			+ "  SELECT n.NeighborhoodId, n.NeighborhoodName, "
			+ "         COUNT(ci.IncidentId) AS IncidentsInWindow, "
			+ "         COUNT(ci.IncidentId) / ? AS IncidentsPerDay "
			+ "  FROM Neighborhoods n "
			+ "  CROSS JOIN Anchor a "
			+ "  LEFT JOIN CrimeIncidents ci "
			+ "         ON ci.NeighborhoodId = n.NeighborhoodId "
			+ "        AND ci.OccurredAt > a.LatestAt - INTERVAL ? DAY "
			+ "        AND ci.OccurredAt <= a.LatestAt "
			+ "  GROUP BY n.NeighborhoodId, n.NeighborhoodName) ";

	/** The newest OccurredAt in CrimeIncidents: the end of the scoring window. */
	public Date getLatestIncidentTime() throws SQLException {
		Connection connection = null;
		PreparedStatement selectStmt = null;
		ResultSet results = null;
		try {
			connection = connectionManager.getConnection();
			selectStmt = connection.prepareStatement(
				"SELECT MAX(OccurredAt) AS LatestAt FROM CrimeIncidents;");
			results = selectStmt.executeQuery();
			return results.next() ? results.getTimestamp("LatestAt") : null;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, selectStmt, results);
		}
	}

	/** How many routes have at least one segment and so receive a score. */
	public int countScoredRoutes(String routeNameFilter) throws SQLException {
		Connection connection = null;
		PreparedStatement selectStmt = null;
		ResultSet results = null;
		try {
			connection = connectionManager.getConnection();
			selectStmt = connection.prepareStatement(
				"SELECT COUNT(DISTINCT r.RouteId) AS RouteCount FROM Routes r "
					+ "JOIN RouteSegments rs ON rs.RouteId = r.RouteId "
					+ "WHERE COALESCE(r.RouteName, '') LIKE ?;");
			selectStmt.setString(1, likePattern(routeNameFilter));
			results = selectStmt.executeQuery();
			return results.next() ? results.getInt("RouteCount") : 0;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, selectStmt, results);
		}
	}

	/**
	 * Scores every route whose name contains routeNameFilter (empty matches all) and returns the
	 * first `limit` in rank order: safest first, or riskiest first when riskiestFirst is true.
	 *
	 * @param rankBy "total" ranks by RiskScore, "perkm" ranks by RiskPerKm
	 */
	public List<RouteRisk> getRoutesRankedByRisk(int windowDays, String routeNameFilter,
			String rankBy, boolean riskiestFirst, int limit) throws SQLException {
		String orderColumn = "perkm".equals(rankBy) ? "RiskPerKm" : "RiskScore";
		String direction = riskiestFirst ? "DESC" : "ASC";
		String selectRanked = NEIGHBORHOOD_RATE_CTE
			+ "SELECT r.RouteId, r.RouteName, r.StartLatitude, r.StartLongitude, "
			+ "       r.EndLatitude, r.EndLongitude, r.DistanceMeters, "
			+ "       COUNT(rs.SegmentId) AS SegmentCount, "
			+ "       SUM(COALESCE(rs.DistanceMeters, 0)) AS TotalSegmentMeters, "
			+ "       ROUND(SUM(COALESCE(rs.DistanceMeters, 0) / 1000.0 "
			+ "                 * COALESCE(ncr.IncidentsPerDay, 0)), 4) AS RiskScore, "
			+ "       ROUND(SUM(COALESCE(rs.DistanceMeters, 0) / 1000.0 "
			+ "                 * COALESCE(ncr.IncidentsPerDay, 0)) "
			+ "             / NULLIF(SUM(COALESCE(rs.DistanceMeters, 0)) / 1000.0, 0), 4) "
			+ "         AS RiskPerKm "
			+ "FROM Routes r "
			+ "JOIN RouteSegments rs ON rs.RouteId = r.RouteId "
			+ "LEFT JOIN NeighborhoodCrimeRate ncr ON ncr.NeighborhoodId = rs.NeighborhoodId "
			+ "WHERE COALESCE(r.RouteName, '') LIKE ? "
			+ "GROUP BY r.RouteId, r.RouteName, r.StartLatitude, r.StartLongitude, "
			+ "         r.EndLatitude, r.EndLongitude, r.DistanceMeters "
			+ "ORDER BY " + orderColumn + " " + direction + ", r.RouteId "
			+ "LIMIT ?;";
		List<RouteRisk> routeRisks = new ArrayList<RouteRisk>();
		Connection connection = null;
		PreparedStatement selectStmt = null;
		ResultSet results = null;
		try {
			connection = connectionManager.getConnection();
			selectStmt = connection.prepareStatement(selectRanked);
			selectStmt.setInt(1, windowDays);
			selectStmt.setInt(2, windowDays);
			selectStmt.setString(3, likePattern(routeNameFilter));
			selectStmt.setInt(4, limit);
			results = selectStmt.executeQuery();
			int rank = 0;
			while (results.next()) {
				rank++;
				Routes route = new Routes(
					results.getLong("RouteId"),
					results.getString("RouteName"),
					results.getBigDecimal("StartLatitude"),
					results.getBigDecimal("StartLongitude"),
					results.getBigDecimal("EndLatitude"),
					results.getBigDecimal("EndLongitude"),
					results.getObject("DistanceMeters", Integer.class));
				routeRisks.add(new RouteRisk(rank, route,
					results.getInt("SegmentCount"),
					results.getLong("TotalSegmentMeters"),
					results.getBigDecimal("RiskScore"),
					results.getBigDecimal("RiskPerKm")));
			}
			return routeRisks;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, selectStmt, results);
		}
	}

	/** Each segment of the route with its share of the route's risk, in segment order. */
	public List<SegmentRisk> getSegmentRisksForRoute(Routes route, int windowDays)
			throws SQLException {
		String selectSegments = NEIGHBORHOOD_RATE_CTE
			+ "SELECT rs.SegmentOrder, ncr.NeighborhoodName, "
			+ "       COALESCE(rs.DistanceMeters, 0) AS DistanceMeters, "
			+ "       COALESCE(ncr.IncidentsInWindow, 0) AS IncidentsInWindow, "
			+ "       ROUND(COALESCE(ncr.IncidentsPerDay, 0), 4) AS IncidentsPerDay, "
			+ "       ROUND(COALESCE(rs.DistanceMeters, 0) / 1000.0 "
			+ "             * COALESCE(ncr.IncidentsPerDay, 0), 4) AS Contribution "
			+ "FROM RouteSegments rs "
			+ "LEFT JOIN NeighborhoodCrimeRate ncr ON ncr.NeighborhoodId = rs.NeighborhoodId "
			+ "WHERE rs.RouteId = ? "
			+ "ORDER BY rs.SegmentOrder;";
		List<SegmentRisk> segmentRisks = new ArrayList<SegmentRisk>();
		Connection connection = null;
		PreparedStatement selectStmt = null;
		ResultSet results = null;
		try {
			connection = connectionManager.getConnection();
			selectStmt = connection.prepareStatement(selectSegments);
			selectStmt.setInt(1, windowDays);
			selectStmt.setInt(2, windowDays);
			selectStmt.setLong(3, route.getRouteId());
			results = selectStmt.executeQuery();
			while (results.next()) {
				BigDecimal incidentsPerDay = results.getBigDecimal("IncidentsPerDay");
				segmentRisks.add(new SegmentRisk(
					results.getInt("SegmentOrder"),
					results.getString("NeighborhoodName"),
					results.getInt("DistanceMeters"),
					results.getInt("IncidentsInWindow"),
					incidentsPerDay,
					results.getBigDecimal("Contribution")));
			}
			return segmentRisks;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, selectStmt, results);
		}
	}

	private static String likePattern(String text) {
		if (text == null) {
			return "%";
		}
		// Escape LIKE wildcards so the filter matches literally.
		String escaped = text.trim().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
		return "%" + escaped + "%";
	}
}
