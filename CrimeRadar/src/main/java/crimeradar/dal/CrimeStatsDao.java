package crimeradar.dal;

import crimeradar.recommendation.Bounds;
import crimeradar.recommendation.CellCount;
import crimeradar.recommendation.CrimeGrid;
import crimeradar.recommendation.CrimeGroup;
import crimeradar.recommendation.DataWindow;
import crimeradar.recommendation.TimeBlock;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Read-only crime statistics for the route recommender. Aggregation happens in MySQL, so
 * only a few hundred summary rows reach Java instead of individual incidents.
 *
 * Date parameters are bound as LocalDateTime so Connector/J passes the DATETIME values
 * through without time-zone conversion.
 */
public class CrimeStatsDao {
	protected ConnectionManager connectionManager;

	private static CrimeStatsDao instance = null;

	protected CrimeStatsDao() {
		connectionManager = new ConnectionManager();
	}

	public static CrimeStatsDao getInstance() {
		if (instance == null) {
			instance = new CrimeStatsDao();
		}
		return instance;
	}

	// Groups CrimeAgainstCategory into PERSON / PROPERTY / OTHER (see CrimeGroup).
	private static final String AGAINST_GROUP =
		"CASE cc.CrimeAgainstCategory WHEN 'PERSON' THEN 'PERSON' "
			+ "WHEN 'PROPERTY' THEN 'PROPERTY' ELSE 'OTHER' END";

	// Grid cell of an incident. Must match CrimeGrid.row() / CrimeGrid.col().
	private static final String CELL_ROW = String.format(Locale.ROOT,
		"FLOOR(ci.Latitude / %s)", CrimeGrid.CELL_LAT_DEGREES);
	private static final String CELL_COL = String.format(Locale.ROOT,
		"FLOOR(ci.Longitude / %s)", CrimeGrid.CELL_LNG_DEGREES);

	/**
	 * The window the scores are based on, anchored to the newest incident.
	 * Returns null when CrimeIncidents is empty.
	 */
	public DataWindow getDataWindow() throws SQLException {
		String selectLatest = "SELECT MAX(OccurredAt) AS LatestIncident FROM CrimeIncidents;";
		Connection connection = null;
		PreparedStatement selectStmt = null;
		ResultSet results = null;
		try {
			connection = connectionManager.getConnection();
			selectStmt = connection.prepareStatement(selectLatest);
			results = selectStmt.executeQuery();
			if (results.next()) {
				LocalDateTime latest = results.getObject("LatestIncident", LocalDateTime.class);
				return latest == null ? null : DataWindow.fromLatestIncident(latest);
			}
			return null;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, selectStmt, results);
		}
	}

	/**
	 * Incident counts per grid cell, crime group and 4-hour time block inside the box.
	 * Incidents stamped exactly 00:00:00 usually have an unknown time, so they get time block
	 * -1: they still count toward a cell's risk level but not its time-of-day pattern.
	 */
	public List<CellCount> getCellCounts(DataWindow window, Bounds box) throws SQLException {
		String selectCounts =
			"SELECT " + CELL_ROW + " AS CellRow, " + CELL_COL + " AS CellCol, "
				+ AGAINST_GROUP + " AS AgainstGroup, "
				+ "CASE WHEN TIME(ci.OccurredAt) = '00:00:00' THEN -1 "
				+ "ELSE FLOOR(HOUR(ci.OccurredAt) / 4) END AS TimeBlock, "
				+ "SUM(CASE WHEN ci.OccurredAt >= ? THEN 1 ELSE 0 END) AS RecentCount, "
				+ "COUNT(*) AS ShapeCount "
				+ "FROM CrimeIncidents ci "
				+ "INNER JOIN CrimeCategories cc ON cc.CategoryId = ci.CategoryId "
				+ "WHERE ci.Latitude BETWEEN ? AND ? "
				+ "AND ci.Longitude BETWEEN ? AND ? "
				+ "AND ci.OccurredAt >= ? AND ci.OccurredAt < ? "
				+ "GROUP BY CellRow, CellCol, AgainstGroup, TimeBlock;";
		List<CellCount> counts = new ArrayList<CellCount>();
		Connection connection = null;
		PreparedStatement selectStmt = null;
		ResultSet results = null;
		try {
			connection = connectionManager.getConnection();
			selectStmt = connection.prepareStatement(selectCounts);
			selectStmt.setObject(1, window.recentStart());
			selectStmt.setDouble(2, box.minLat());
			selectStmt.setDouble(3, box.maxLat());
			selectStmt.setDouble(4, box.minLng());
			selectStmt.setDouble(5, box.maxLng());
			selectStmt.setObject(6, window.shapeStart());
			selectStmt.setObject(7, window.end());
			results = selectStmt.executeQuery();
			while (results.next()) {
				counts.add(new CellCount(
					results.getInt("CellRow"),
					results.getInt("CellCol"),
					CrimeGroup.fromDatabase(results.getString("AgainstGroup")),
					results.getInt("TimeBlock"),
					results.getLong("RecentCount"),
					results.getLong("ShapeCount")));
			}
			return counts;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, selectStmt, results);
		}
	}

	/**
	 * Citywide incidents with a known time in the longer window, as
	 * [CrimeGroup.ordinal()][time block]. Sparse cells fall back on this pattern.
	 */
	public long[][] getCityBlockCounts(DataWindow window) throws SQLException {
		String selectCounts =
			"SELECT " + AGAINST_GROUP + " AS AgainstGroup, "
				+ "FLOOR(HOUR(ci.OccurredAt) / 4) AS TimeBlock, COUNT(*) AS Incidents "
				+ "FROM CrimeIncidents ci "
				+ "INNER JOIN CrimeCategories cc ON cc.CategoryId = ci.CategoryId "
				+ "WHERE ci.OccurredAt >= ? AND ci.OccurredAt < ? "
				+ "AND TIME(ci.OccurredAt) <> '00:00:00' "
				+ "GROUP BY AgainstGroup, TimeBlock;";
		long[][] counts = new long[CrimeGroup.values().length][TimeBlock.COUNT];
		Connection connection = null;
		PreparedStatement selectStmt = null;
		ResultSet results = null;
		try {
			connection = connectionManager.getConnection();
			selectStmt = connection.prepareStatement(selectCounts);
			selectStmt.setObject(1, window.shapeStart());
			selectStmt.setObject(2, window.end());
			results = selectStmt.executeQuery();
			while (results.next()) {
				CrimeGroup group = CrimeGroup.fromDatabase(results.getString("AgainstGroup"));
				int block = results.getInt("TimeBlock");
				if (block >= 0 && block < TimeBlock.COUNT) {
					counts[group.ordinal()][block] += results.getLong("Incidents");
				}
			}
			return counts;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, selectStmt, results);
		}
	}
}
