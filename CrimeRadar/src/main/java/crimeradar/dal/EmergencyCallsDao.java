package crimeradar.dal;

import crimeradar.model.DataSources;
import crimeradar.model.EmergencyCalls;
import crimeradar.model.Neighborhoods;
import crimeradar.model.PolicePrecincts;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.List;

public class EmergencyCallsDao {
	protected ConnectionManager connectionManager;

	private static EmergencyCallsDao instance = null;

	protected EmergencyCallsDao() {
		connectionManager = new ConnectionManager();
	}

	public static EmergencyCallsDao getInstance() {
		if (instance == null) {
			instance = new EmergencyCallsDao();
		}
		return instance;
	}

	// ~30,000 rows, so parents are joined in rather than looked up per call.
	private static final String SELECT_COLUMNS =
		"SELECT e.CallId,e.SourceCallId,e.CallTime,e.CallType,e.Latitude,e.Longitude,"
			+ "ds.SourceId,ds.SourceName,ds.DatasetIdentifier,ds.SourceURL,ds.LastImportedAt,"
			+ "n.NeighborhoodId,n.NeighborhoodName,p.PrecinctId,p.PrecinctName "
			+ "FROM EmergencyCalls e "
			+ "JOIN DataSources ds ON ds.SourceId=e.SourceId "
			+ "LEFT JOIN Neighborhoods n ON n.NeighborhoodId=e.NeighborhoodId "
			+ "LEFT JOIN PolicePrecincts p ON p.PrecinctId=n.PrecinctId ";

	public EmergencyCalls create(EmergencyCalls emergencyCall) throws SQLException {
		String insertCall =
			"INSERT INTO EmergencyCalls(SourceId,SourceCallId,CallTime,CallType,NeighborhoodId,"
				+ "Latitude,Longitude) VALUES(?,?,?,?,?,?,?);";
		Connection connection = null;
		PreparedStatement insertStmt = null;
		try {
			connection = connectionManager.getConnection();
			insertStmt = connection.prepareStatement(insertCall, Statement.RETURN_GENERATED_KEYS);
			insertStmt.setInt(1, emergencyCall.getDataSource().getSourceId());
			insertStmt.setString(2, emergencyCall.getSourceCallId());
			insertStmt.setTimestamp(3, DaoUtils.toTimestamp(emergencyCall.getCallTime()));
			insertStmt.setString(4, emergencyCall.getCallType());
			Neighborhoods neighborhood = emergencyCall.getNeighborhood();
			insertStmt.setObject(5, neighborhood == null ? null : neighborhood.getNeighborhoodId(),
				Types.INTEGER);
			insertStmt.setBigDecimal(6, emergencyCall.getLatitude());
			insertStmt.setBigDecimal(7, emergencyCall.getLongitude());
			insertStmt.executeUpdate();
			emergencyCall.setCallId(DaoUtils.getGeneratedKey(insertStmt));
			return emergencyCall;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, insertStmt, null);
		}
	}

	public EmergencyCalls getEmergencyCallById(long callId) throws SQLException {
		List<EmergencyCalls> calls = getList(SELECT_COLUMNS + "WHERE e.CallId=?;", callId);
		return calls.isEmpty() ? null : calls.get(0);
	}

	/** Most recent calls in the neighborhood, newest first, at most {@code limit} rows. */
	public List<EmergencyCalls> getEmergencyCallsForNeighborhood(Neighborhoods neighborhood,
			int limit) throws SQLException {
		return getList(SELECT_COLUMNS
			+ "WHERE e.NeighborhoodId=? ORDER BY e.CallTime DESC LIMIT ?;",
			neighborhood.getNeighborhoodId(), limit);
	}

	public EmergencyCalls delete(EmergencyCalls emergencyCall) throws SQLException {
		String deleteCall = "DELETE FROM EmergencyCalls WHERE CallId=?;";
		Connection connection = null;
		PreparedStatement deleteStmt = null;
		try {
			connection = connectionManager.getConnection();
			deleteStmt = connection.prepareStatement(deleteCall);
			deleteStmt.setLong(1, emergencyCall.getCallId());
			deleteStmt.executeUpdate();
			return null;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, deleteStmt, null);
		}
	}

	private List<EmergencyCalls> getList(String query, Object... params) throws SQLException {
		List<EmergencyCalls> calls = new ArrayList<EmergencyCalls>();
		Connection connection = null;
		PreparedStatement selectStmt = null;
		ResultSet results = null;
		try {
			connection = connectionManager.getConnection();
			selectStmt = connection.prepareStatement(query);
			for (int i = 0; i < params.length; i++) {
				selectStmt.setObject(i + 1, params[i]);
			}
			results = selectStmt.executeQuery();
			while (results.next()) {
				DataSources dataSource = new DataSources(
					results.getInt("SourceId"),
					results.getString("SourceName"),
					results.getString("DatasetIdentifier"),
					results.getString("SourceURL"),
					results.getTimestamp("LastImportedAt"));
				Neighborhoods neighborhood = null;
				Integer neighborhoodId = results.getObject("NeighborhoodId", Integer.class);
				if (neighborhoodId != null) {
					Integer precinctId = results.getObject("PrecinctId", Integer.class);
					PolicePrecincts precinct = precinctId == null ? null
						: new PolicePrecincts(precinctId, results.getString("PrecinctName"));
					neighborhood = new Neighborhoods(neighborhoodId,
						results.getString("NeighborhoodName"), precinct);
				}
				calls.add(new EmergencyCalls(
					results.getLong("CallId"),
					dataSource,
					results.getString("SourceCallId"),
					results.getTimestamp("CallTime"),
					results.getString("CallType"),
					neighborhood,
					results.getBigDecimal("Latitude"),
					results.getBigDecimal("Longitude")));
			}
			return calls;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, selectStmt, results);
		}
	}
}
