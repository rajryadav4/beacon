package crimeradar.dal;

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

public class NeighborhoodsDao {
	protected ConnectionManager connectionManager;

	private static NeighborhoodsDao instance = null;

	protected NeighborhoodsDao() {
		connectionManager = new ConnectionManager();
	}

	public static NeighborhoodsDao getInstance() {
		if (instance == null) {
			instance = new NeighborhoodsDao();
		}
		return instance;
	}

	// Join the precinct in the same query so listing all neighborhoods is one round trip.
	private static final String SELECT_COLUMNS =
		"SELECT n.NeighborhoodId,n.NeighborhoodName,p.PrecinctId,p.PrecinctName "
			+ "FROM Neighborhoods n LEFT JOIN PolicePrecincts p ON p.PrecinctId=n.PrecinctId ";

	public Neighborhoods create(Neighborhoods neighborhood) throws SQLException {
		String insertNeighborhood =
			"INSERT INTO Neighborhoods(NeighborhoodName,PrecinctId) VALUES(?,?);";
		Connection connection = null;
		PreparedStatement insertStmt = null;
		try {
			connection = connectionManager.getConnection();
			insertStmt = connection.prepareStatement(insertNeighborhood,
				Statement.RETURN_GENERATED_KEYS);
			insertStmt.setString(1, neighborhood.getNeighborhoodName());
			PolicePrecincts precinct = neighborhood.getPolicePrecinct();
			insertStmt.setObject(2, precinct == null ? null : precinct.getPrecinctId(),
				Types.INTEGER);
			insertStmt.executeUpdate();
			neighborhood.setNeighborhoodId((int) DaoUtils.getGeneratedKey(insertStmt));
			return neighborhood;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, insertStmt, null);
		}
	}

	public Neighborhoods getNeighborhoodById(int neighborhoodId) throws SQLException {
		List<Neighborhoods> neighborhoods =
			getList(SELECT_COLUMNS + "WHERE n.NeighborhoodId=?;", neighborhoodId);
		return neighborhoods.isEmpty() ? null : neighborhoods.get(0);
	}

	public Neighborhoods getNeighborhoodByName(String neighborhoodName) throws SQLException {
		List<Neighborhoods> neighborhoods =
			getList(SELECT_COLUMNS + "WHERE n.NeighborhoodName=?;", neighborhoodName);
		return neighborhoods.isEmpty() ? null : neighborhoods.get(0);
	}

	public List<Neighborhoods> getNeighborhoodsForPrecinct(PolicePrecincts policePrecinct)
			throws SQLException {
		return getList(SELECT_COLUMNS + "WHERE n.PrecinctId=? ORDER BY n.NeighborhoodName;",
			policePrecinct.getPrecinctId());
	}

	public List<Neighborhoods> getAllNeighborhoods() throws SQLException {
		return getList(SELECT_COLUMNS + "ORDER BY n.NeighborhoodName;", null);
	}

	/** Reassign the neighborhood to another precinct (null to clear it). */
	public Neighborhoods updatePolicePrecinct(Neighborhoods neighborhood,
			PolicePrecincts newPolicePrecinct) throws SQLException {
		String updateNeighborhood = "UPDATE Neighborhoods SET PrecinctId=? WHERE NeighborhoodId=?;";
		Connection connection = null;
		PreparedStatement updateStmt = null;
		try {
			connection = connectionManager.getConnection();
			updateStmt = connection.prepareStatement(updateNeighborhood);
			updateStmt.setObject(1,
				newPolicePrecinct == null ? null : newPolicePrecinct.getPrecinctId(),
				Types.INTEGER);
			updateStmt.setInt(2, neighborhood.getNeighborhoodId());
			updateStmt.executeUpdate();
			neighborhood.setPolicePrecinct(newPolicePrecinct);
			return neighborhood;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, updateStmt, null);
		}
	}

	/**
	 * Delete the Neighborhoods instance. Fails with a foreign key error while incidents, calls,
	 * resources, risk scores or route segments still reference it.
	 */
	public Neighborhoods delete(Neighborhoods neighborhood) throws SQLException {
		String deleteNeighborhood = "DELETE FROM Neighborhoods WHERE NeighborhoodId=?;";
		Connection connection = null;
		PreparedStatement deleteStmt = null;
		try {
			connection = connectionManager.getConnection();
			deleteStmt = connection.prepareStatement(deleteNeighborhood);
			deleteStmt.setInt(1, neighborhood.getNeighborhoodId());
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
	private List<Neighborhoods> getList(String query, Object param) throws SQLException {
		List<Neighborhoods> neighborhoods = new ArrayList<Neighborhoods>();
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
				Integer precinctId = results.getObject("PrecinctId", Integer.class);
				PolicePrecincts precinct = precinctId == null ? null
					: new PolicePrecincts(precinctId, results.getString("PrecinctName"));
				neighborhoods.add(new Neighborhoods(
					results.getInt("NeighborhoodId"),
					results.getString("NeighborhoodName"),
					precinct));
			}
			return neighborhoods;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, selectStmt, results);
		}
	}
}
