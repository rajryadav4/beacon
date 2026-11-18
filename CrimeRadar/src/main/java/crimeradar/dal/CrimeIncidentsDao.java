package crimeradar.dal;

import crimeradar.model.CrimeCategories;
import crimeradar.model.CrimeIncidents;
import crimeradar.model.DataSources;
import crimeradar.model.Neighborhoods;
import crimeradar.model.PolicePrecincts;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;

public class CrimeIncidentsDao {
	protected ConnectionManager connectionManager;

	private static CrimeIncidentsDao instance = null;

	protected CrimeIncidentsDao() {
		connectionManager = new ConnectionManager();
	}

	public static CrimeIncidentsDao getInstance() {
		if (instance == null) {
			instance = new CrimeIncidentsDao();
		}
		return instance;
	}

	/*
	 * CrimeIncidents has ~150,000 rows, so the parent rows are joined into one query instead of
	 * looked up per incident through the other DAOs. The neighborhood's own precinct is aliased
	 * (NbhdPrecinct*) so it does not collide with the incident's PrecinctId column.
	 */
	private static final String SELECT_COLUMNS =
		"SELECT i.IncidentId,i.SourceOffenseId,i.ReportNumber,i.OccurredAt,i.ReportedAt,"
			+ "i.BlockAddress,i.Latitude,i.Longitude,i.Beat,"
			+ "ds.SourceId,ds.SourceName,ds.DatasetIdentifier,ds.SourceURL,ds.LastImportedAt,"
			+ "c.CategoryId,c.CategoryName,c.NIBRSGroup,c.CrimeAgainstCategory,"
			+ "n.NeighborhoodId,n.NeighborhoodName,"
			+ "np.PrecinctId AS NbhdPrecinctId,np.PrecinctName AS NbhdPrecinctName,"
			+ "p.PrecinctId,p.PrecinctName "
			+ "FROM CrimeIncidents i "
			+ "JOIN DataSources ds ON ds.SourceId=i.SourceId "
			+ "JOIN CrimeCategories c ON c.CategoryId=i.CategoryId "
			+ "LEFT JOIN Neighborhoods n ON n.NeighborhoodId=i.NeighborhoodId "
			+ "LEFT JOIN PolicePrecincts np ON np.PrecinctId=n.PrecinctId "
			+ "LEFT JOIN PolicePrecincts p ON p.PrecinctId=i.PrecinctId ";

	public CrimeIncidents create(CrimeIncidents incident) throws SQLException {
		String insertIncident =
			"INSERT INTO CrimeIncidents(SourceId,SourceOffenseId,ReportNumber,OccurredAt,"
				+ "ReportedAt,CategoryId,NeighborhoodId,PrecinctId,BlockAddress,Latitude,"
				+ "Longitude,Beat) VALUES(?,?,?,?,?,?,?,?,?,?,?,?);";
		Connection connection = null;
		PreparedStatement insertStmt = null;
		try {
			connection = connectionManager.getConnection();
			insertStmt = connection.prepareStatement(insertIncident,
				Statement.RETURN_GENERATED_KEYS);
			insertStmt.setInt(1, incident.getDataSource().getSourceId());
			insertStmt.setString(2, incident.getSourceOffenseId());
			insertStmt.setString(3, incident.getReportNumber());
			insertStmt.setTimestamp(4, DaoUtils.toTimestamp(incident.getOccurredAt()));
			insertStmt.setTimestamp(5, DaoUtils.toTimestamp(incident.getReportedAt()));
			insertStmt.setInt(6, incident.getCrimeCategory().getCategoryId());
			Neighborhoods neighborhood = incident.getNeighborhood();
			insertStmt.setObject(7, neighborhood == null ? null : neighborhood.getNeighborhoodId(),
				Types.INTEGER);
			PolicePrecincts precinct = incident.getPolicePrecinct();
			insertStmt.setObject(8, precinct == null ? null : precinct.getPrecinctId(),
				Types.INTEGER);
			insertStmt.setString(9, incident.getBlockAddress());
			insertStmt.setBigDecimal(10, incident.getLatitude());
			insertStmt.setBigDecimal(11, incident.getLongitude());
			insertStmt.setString(12, incident.getBeat());
			insertStmt.executeUpdate();
			incident.setIncidentId(DaoUtils.getGeneratedKey(insertStmt));
			return incident;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, insertStmt, null);
		}
	}

	public CrimeIncidents getCrimeIncidentById(long incidentId) throws SQLException {
		List<CrimeIncidents> incidents = getList(SELECT_COLUMNS + "WHERE i.IncidentId=?;",
			incidentId);
		return incidents.isEmpty() ? null : incidents.get(0);
	}

	/** Most recent incidents in the neighborhood, newest first, at most {@code limit} rows. */
	public List<CrimeIncidents> getCrimeIncidentsForNeighborhood(Neighborhoods neighborhood,
			int limit) throws SQLException {
		return getList(SELECT_COLUMNS
			+ "WHERE i.NeighborhoodId=? ORDER BY i.OccurredAt DESC LIMIT ?;",
			neighborhood.getNeighborhoodId(), limit);
	}

	/** Most recent incidents of the category, newest first, at most {@code limit} rows. */
	public List<CrimeIncidents> getCrimeIncidentsForCategory(CrimeCategories crimeCategory,
			int limit) throws SQLException {
		return getList(SELECT_COLUMNS
			+ "WHERE i.CategoryId=? ORDER BY i.OccurredAt DESC LIMIT ?;",
			crimeCategory.getCategoryId(), limit);
	}

	/**
	 * Incidents in the neighborhood that occurred in [from, to), newest first, at most
	 * {@code limit} rows.
	 */
	public List<CrimeIncidents> getCrimeIncidentsForNeighborhoodBetween(
			Neighborhoods neighborhood, Date from, Date to, int limit) throws SQLException {
		return getList(SELECT_COLUMNS
			+ "WHERE i.NeighborhoodId=? AND i.OccurredAt>=? AND i.OccurredAt<? "
			+ "ORDER BY i.OccurredAt DESC LIMIT ?;",
			neighborhood.getNeighborhoodId(), DaoUtils.toTimestamp(from),
			DaoUtils.toTimestamp(to), limit);
	}

	/** Reclassify the incident under a different category. */
	public CrimeIncidents updateCrimeCategory(CrimeIncidents incident,
			CrimeCategories newCrimeCategory) throws SQLException {
		String updateIncident = "UPDATE CrimeIncidents SET CategoryId=? WHERE IncidentId=?;";
		Connection connection = null;
		PreparedStatement updateStmt = null;
		try {
			connection = connectionManager.getConnection();
			updateStmt = connection.prepareStatement(updateIncident);
			updateStmt.setInt(1, newCrimeCategory.getCategoryId());
			updateStmt.setLong(2, incident.getIncidentId());
			updateStmt.executeUpdate();
			incident.setCrimeCategory(newCrimeCategory);
			return incident;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, updateStmt, null);
		}
	}

	public CrimeIncidents delete(CrimeIncidents incident) throws SQLException {
		String deleteIncident = "DELETE FROM CrimeIncidents WHERE IncidentId=?;";
		Connection connection = null;
		PreparedStatement deleteStmt = null;
		try {
			connection = connectionManager.getConnection();
			deleteStmt = connection.prepareStatement(deleteIncident);
			deleteStmt.setLong(1, incident.getIncidentId());
			deleteStmt.executeUpdate();
			return null;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, deleteStmt, null);
		}
	}

	private List<CrimeIncidents> getList(String query, Object... params) throws SQLException {
		List<CrimeIncidents> incidents = new ArrayList<CrimeIncidents>();
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
				incidents.add(fromResultSet(results));
			}
			return incidents;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, selectStmt, results);
		}
	}

	private static CrimeIncidents fromResultSet(ResultSet results) throws SQLException {
		DataSources dataSource = new DataSources(
			results.getInt("SourceId"),
			results.getString("SourceName"),
			results.getString("DatasetIdentifier"),
			results.getString("SourceURL"),
			results.getTimestamp("LastImportedAt"));
		CrimeCategories category = new CrimeCategories(
			results.getInt("CategoryId"),
			results.getString("CategoryName"),
			results.getString("NIBRSGroup"),
			results.getString("CrimeAgainstCategory"));

		Neighborhoods neighborhood = null;
		Integer neighborhoodId = results.getObject("NeighborhoodId", Integer.class);
		if (neighborhoodId != null) {
			Integer nbhdPrecinctId = results.getObject("NbhdPrecinctId", Integer.class);
			PolicePrecincts nbhdPrecinct = nbhdPrecinctId == null ? null
				: new PolicePrecincts(nbhdPrecinctId, results.getString("NbhdPrecinctName"));
			neighborhood = new Neighborhoods(neighborhoodId,
				results.getString("NeighborhoodName"), nbhdPrecinct);
		}

		Integer precinctId = results.getObject("PrecinctId", Integer.class);
		PolicePrecincts precinct = precinctId == null ? null
			: new PolicePrecincts(precinctId, results.getString("PrecinctName"));

		return new CrimeIncidents(
			results.getLong("IncidentId"),
			dataSource,
			results.getString("SourceOffenseId"),
			results.getString("ReportNumber"),
			results.getTimestamp("OccurredAt"),
			results.getTimestamp("ReportedAt"),
			category,
			neighborhood,
			precinct,
			results.getString("BlockAddress"),
			results.getBigDecimal("Latitude"),
			results.getBigDecimal("Longitude"),
			results.getString("Beat"));
	}
}
