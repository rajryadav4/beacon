package crimeradar.dal;

import crimeradar.model.PolicePrecincts;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;

public class PolicePrecinctsDao {
	protected ConnectionManager connectionManager;

	private static PolicePrecinctsDao instance = null;

	protected PolicePrecinctsDao() {
		connectionManager = new ConnectionManager();
	}

	public static PolicePrecinctsDao getInstance() {
		if (instance == null) {
			instance = new PolicePrecinctsDao();
		}
		return instance;
	}

	public PolicePrecincts create(PolicePrecincts policePrecinct) throws SQLException {
		String insertPrecinct = "INSERT INTO PolicePrecincts(PrecinctName) VALUES(?);";
		Connection connection = null;
		PreparedStatement insertStmt = null;
		try {
			connection = connectionManager.getConnection();
			insertStmt = connection.prepareStatement(insertPrecinct,
				Statement.RETURN_GENERATED_KEYS);
			insertStmt.setString(1, policePrecinct.getPrecinctName());
			insertStmt.executeUpdate();
			policePrecinct.setPrecinctId((int) DaoUtils.getGeneratedKey(insertStmt));
			return policePrecinct;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, insertStmt, null);
		}
	}

	public PolicePrecincts getPolicePrecinctById(int precinctId) throws SQLException {
		List<PolicePrecincts> precincts = getList(
			"SELECT PrecinctId,PrecinctName FROM PolicePrecincts WHERE PrecinctId=?;", precinctId);
		return precincts.isEmpty() ? null : precincts.get(0);
	}

	public PolicePrecincts getPolicePrecinctByName(String precinctName) throws SQLException {
		List<PolicePrecincts> precincts = getList(
			"SELECT PrecinctId,PrecinctName FROM PolicePrecincts WHERE PrecinctName=?;",
			precinctName);
		return precincts.isEmpty() ? null : precincts.get(0);
	}

	public List<PolicePrecincts> getAllPolicePrecincts() throws SQLException {
		return getList(
			"SELECT PrecinctId,PrecinctName FROM PolicePrecincts ORDER BY PrecinctName;", null);
	}

	/**
	 * Delete the PolicePrecincts instance. Fails with a foreign key error while Neighborhoods or
	 * CrimeIncidents rows still reference it.
	 */
	public PolicePrecincts delete(PolicePrecincts policePrecinct) throws SQLException {
		String deletePrecinct = "DELETE FROM PolicePrecincts WHERE PrecinctId=?;";
		Connection connection = null;
		PreparedStatement deleteStmt = null;
		try {
			connection = connectionManager.getConnection();
			deleteStmt = connection.prepareStatement(deletePrecinct);
			deleteStmt.setInt(1, policePrecinct.getPrecinctId());
			deleteStmt.executeUpdate();
			return null;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, deleteStmt, null);
		}
	}

	/** Runs a query with at most one parameter (null for none). */
	private List<PolicePrecincts> getList(String query, Object param) throws SQLException {
		List<PolicePrecincts> precincts = new ArrayList<PolicePrecincts>();
		Connection connection = null;
		PreparedStatement selectStmt = null;
		ResultSet results = null;
		try {
			connection = connectionManager.getConnection();
			selectStmt = connection.prepareStatement(query);
			if (param != null) {
				selectStmt.setObject(1, param);
			}
			results = selectStmt.executeQuery();
			while (results.next()) {
				precincts.add(new PolicePrecincts(
					results.getInt("PrecinctId"), results.getString("PrecinctName")));
			}
			return precincts;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, selectStmt, results);
		}
	}
}
