package crimeradar.dal;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Read-only queries for the map data (api/meta, api/grid, api/neighborhoods).
 * They read only the small summary tables. None of them touches CrimeIncidents.
 */
public class MapDataDao {
	protected ConnectionManager connectionManager;

	private static MapDataDao instance = null;

	protected MapDataDao() {
		connectionManager = new ConnectionManager();
	}

	public static synchronized MapDataDao getInstance() {
		if (instance == null) {
			instance = new MapDataDao();
		}
		return instance;
	}

	/** The active model run, or null when no ML output has been imported. */
	public static class ModelRun {
		public String version;
		public Timestamp trainedAt;
		public String algorithm;
		public String metricsJson;
	}

	/** One neighborhood row summed over all bands and groups. */
	public static class NeighborhoodRow {
		public int id;
		public String name;
		public String precinct;
		public int[] counts = new int[32];
		public long located;
		public long total;
		public double sumLat;
		public double sumLng;
	}

	/** SELECT 1 for the health check. */
	public boolean ping() {
		try (Connection connection = connectionManager.getConnection();
				Statement stmt = connection.createStatement();
				ResultSet rs = stmt.executeQuery("SELECT 1")) {
			return rs.next();
		} catch (SQLException e) {
			return false;
		}
	}

	/** A cheap string that changes when the summary tables or the model change (PK lookups). */
	public String signature() throws SQLException {
		String sql = "SELECT "
			+ "(SELECT MetaValue FROM AppMeta WHERE MetaKey='builtAt'),"
			+ "(SELECT MetaValue FROM AppMeta WHERE MetaKey='riskImportedAt'),"
			+ "(SELECT ModelVersion FROM ModelRuns WHERE ActiveKey=1);";
		try (Connection connection = connectionManager.getConnection();
				Statement stmt = connection.createStatement();
				ResultSet rs = stmt.executeQuery(sql)) {
			rs.next();
			return rs.getString(1) + "|" + rs.getString(2) + "|" + rs.getString(3);
		}
	}

	public Map<String, String> loadMeta() throws SQLException {
		Map<String, String> meta = new HashMap<String, String>();
		try (Connection connection = connectionManager.getConnection();
				Statement stmt = connection.createStatement();
				ResultSet rs = stmt.executeQuery("SELECT MetaKey,MetaValue FROM AppMeta")) {
			while (rs.next()) {
				meta.put(rs.getString(1), rs.getString(2));
			}
		}
		return meta;
	}

	/** {name, datasetId, url} of the SPD data source, or nulls if missing. */
	public String[] loadSource() throws SQLException {
		try (Connection connection = connectionManager.getConnection();
				Statement stmt = connection.createStatement();
				ResultSet rs = stmt.executeQuery("SELECT SourceName,DatasetIdentifier,SourceURL "
					+ "FROM DataSources WHERE DatasetIdentifier='tazs-3rd5'")) {
			if (rs.next()) {
				return new String[] { rs.getString(1), rs.getString(2), rs.getString(3) };
			}
		}
		return new String[] { "SPD Crime Data: 2008-Present", "tazs-3rd5",
			"https://data.seattle.gov/d/tazs-3rd5" };
	}

	/** Each row: id, key, label, severity. */
	public List<Object[]> loadGroups() throws SQLException {
		return loadRows("SELECT GroupId,GroupKey,Label,Severity FROM CrimeGroups ORDER BY GroupId",
			4);
	}

	/** Each row: id, key, label, hours. */
	public List<Object[]> loadBands() throws SQLException {
		return loadRows("SELECT BandId,BandKey,Label,HoursLabel FROM TimeBands ORDER BY BandId",
			4);
	}

	/** Each row: key, label, vulnerability. */
	public List<Object[]> loadModes() throws SQLException {
		return loadRows("SELECT ModeKey,Label,Vulnerability FROM TravelModes ORDER BY ModeKey",
			3);
	}

	private List<Object[]> loadRows(String sql, int columns) throws SQLException {
		List<Object[]> rows = new ArrayList<Object[]>();
		try (Connection connection = connectionManager.getConnection();
				Statement stmt = connection.createStatement();
				ResultSet rs = stmt.executeQuery(sql)) {
			while (rs.next()) {
				Object[] row = new Object[columns];
				for (int i = 0; i < columns; i++) {
					row[i] = rs.getObject(i + 1);
				}
				rows.add(row);
			}
		}
		return rows;
	}

	public ModelRun loadActiveModel() throws SQLException {
		String sql = "SELECT ModelVersion,TrainedAt,Algorithm,MetricsJson FROM ModelRuns "
			+ "WHERE ActiveKey=1;";
		try (Connection connection = connectionManager.getConnection();
				Statement stmt = connection.createStatement();
				ResultSet rs = stmt.executeQuery(sql)) {
			if (!rs.next()) {
				return null;
			}
			ModelRun run = new ModelRun();
			run.version = rs.getString(1);
			run.trainedAt = rs.getTimestamp(2);
			run.algorithm = rs.getString(3);
			run.metricsJson = rs.getString(4);
			return run;
		}
	}

	/** CellId to NeighborhoodId (0 when none), in cell order. Primary-key order scan. */
	public Map<Integer, Integer> loadCellNeighborhoods() throws SQLException {
		Map<Integer, Integer> cells = new LinkedHashMap<Integer, Integer>();
		try (Connection connection = connectionManager.getConnection();
				Statement stmt = connection.createStatement();
				ResultSet rs = stmt.executeQuery(
					"SELECT CellId,NeighborhoodId FROM GridCells ORDER BY CellId")) {
			while (rs.next()) {
				cells.put(rs.getInt(1), rs.getInt(2));
			}
		}
		return cells;
	}

	/** Rows of {cellId, band, group, count}. Primary-key order scan of CellStats. */
	public List<int[]> loadCellStats() throws SQLException {
		List<int[]> rows = new ArrayList<int[]>(150000);
		try (Connection connection = connectionManager.getConnection();
				Statement stmt = connection.createStatement();
				ResultSet rs = stmt.executeQuery(
					"SELECT CellId,TimeBand,GroupId,IncidentCount FROM CellStats "
						+ "ORDER BY CellId,TimeBand,GroupId")) {
			while (rs.next()) {
				rows.add(new int[] { rs.getInt(1), rs.getInt(2), rs.getInt(3), rs.getInt(4) });
			}
		}
		return rows;
	}

	/** Rows of {cellId, band, risk} for one model. Primary-key range on ModelVersion. */
	public List<double[]> loadRisk(String modelVersion) throws SQLException {
		List<double[]> rows = new ArrayList<double[]>();
		String sql = "SELECT CellId,TimeBand,ExpectedRisk FROM CellRiskScores "
			+ "WHERE ModelVersion=? ORDER BY CellId,TimeBand;";
		try (Connection connection = connectionManager.getConnection();
				PreparedStatement stmt = connection.prepareStatement(sql)) {
			stmt.setString(1, modelVersion);
			try (ResultSet rs = stmt.executeQuery()) {
				while (rs.next()) {
					rows.add(new double[] { rs.getInt(1), rs.getInt(2), rs.getDouble(3) });
				}
			}
		}
		return rows;
	}

	/** Cells (GridCells rows) whose dominant neighborhood is each neighborhood id. */
	public Map<Integer, Integer> loadCellCountsByNeighborhood() throws SQLException {
		Map<Integer, Integer> counts = new HashMap<Integer, Integer>();
		try (Connection connection = connectionManager.getConnection();
				Statement stmt = connection.createStatement();
				ResultSet rs = stmt.executeQuery(
					"SELECT NeighborhoodId,COUNT(*) FROM GridCells WHERE NeighborhoodId IS NOT NULL "
						+ "GROUP BY NeighborhoodId")) {
			while (rs.next()) {
				counts.put(rs.getInt(1), rs.getInt(2));
			}
		}
		return counts;
	}

	/** One entry per neighborhood that has stats, with all 32 counts filled in. */
	public List<NeighborhoodRow> loadNeighborhoods() throws SQLException {
		String sql = "SELECT n.NeighborhoodId,n.NeighborhoodName,p.PrecinctName,"
			+ "ns.TimeBand,ns.GroupId,ns.IncidentCount,ns.LocatedCount,ns.SumLat,ns.SumLng "
			+ "FROM NeighborhoodStats ns "
			+ "JOIN Neighborhoods n ON n.NeighborhoodId=ns.NeighborhoodId "
			+ "LEFT JOIN NeighborhoodPrecincts np ON np.NeighborhoodId=n.NeighborhoodId "
			+ "LEFT JOIN PolicePrecincts p ON p.PrecinctId=np.PrecinctId "
			+ "ORDER BY n.NeighborhoodId,ns.TimeBand,ns.GroupId;";
		Map<Integer, NeighborhoodRow> byId = new LinkedHashMap<Integer, NeighborhoodRow>();
		try (Connection connection = connectionManager.getConnection();
				Statement stmt = connection.createStatement();
				ResultSet rs = stmt.executeQuery(sql)) {
			while (rs.next()) {
				int id = rs.getInt(1);
				NeighborhoodRow row = byId.get(id);
				if (row == null) {
					row = new NeighborhoodRow();
					row.id = id;
					row.name = rs.getString(2);
					row.precinct = rs.getString(3);
					byId.put(id, row);
				}
				int idx = rs.getInt(4) * 8 + rs.getInt(5);
				int count = rs.getInt(6);
				row.counts[idx] = count;
				row.total += count;
				row.located += rs.getLong(7);
				row.sumLat += rs.getDouble(8);
				row.sumLng += rs.getDouble(9);
			}
		}
		return new ArrayList<NeighborhoodRow>(byId.values());
	}
}
