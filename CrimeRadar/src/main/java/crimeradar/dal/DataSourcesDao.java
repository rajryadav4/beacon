package crimeradar.dal;

import crimeradar.model.DataSources;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Date;

public class DataSourcesDao {
	protected ConnectionManager connectionManager;

	// Singleton pattern: instantiation is limited to one object.
	private static DataSourcesDao instance = null;

	protected DataSourcesDao() {
		connectionManager = new ConnectionManager();
	}

	public static DataSourcesDao getInstance() {
		if (instance == null) {
			instance = new DataSourcesDao();
		}
		return instance;
	}

	private static final String SELECT_COLUMNS =
		"SELECT SourceId,SourceName,DatasetIdentifier,SourceURL,LastImportedAt FROM DataSources ";

	/** Save the DataSources instance and set its auto-generated SourceId. */
	public DataSources create(DataSources dataSource) throws SQLException {
		String insertDataSource =
			"INSERT INTO DataSources(SourceName,DatasetIdentifier,SourceURL,LastImportedAt) "
				+ "VALUES(?,?,?,?);";
		Connection connection = null;
		PreparedStatement insertStmt = null;
		try {
			connection = connectionManager.getConnection();
			insertStmt = connection.prepareStatement(insertDataSource,
				Statement.RETURN_GENERATED_KEYS);
			insertStmt.setString(1, dataSource.getSourceName());
			insertStmt.setString(2, dataSource.getDatasetIdentifier());
			insertStmt.setString(3, dataSource.getSourceURL());
			insertStmt.setTimestamp(4, DaoUtils.toTimestamp(dataSource.getLastImportedAt()));
			insertStmt.executeUpdate();
			dataSource.setSourceId((int) DaoUtils.getGeneratedKey(insertStmt));
			return dataSource;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, insertStmt, null);
		}
	}

	public DataSources getDataSourceById(int sourceId) throws SQLException {
		return getSingle(SELECT_COLUMNS + "WHERE SourceId=?;", sourceId);
	}

	public DataSources getDataSourceByDatasetIdentifier(String datasetIdentifier)
			throws SQLException {
		return getSingle(SELECT_COLUMNS + "WHERE DatasetIdentifier=?;", datasetIdentifier);
	}

	/** Record a new import time, e.g. after refreshing the data from the source. */
	public DataSources updateLastImportedAt(DataSources dataSource, Date newLastImportedAt)
			throws SQLException {
		String updateDataSource = "UPDATE DataSources SET LastImportedAt=? WHERE SourceId=?;";
		Connection connection = null;
		PreparedStatement updateStmt = null;
		try {
			connection = connectionManager.getConnection();
			updateStmt = connection.prepareStatement(updateDataSource);
			updateStmt.setTimestamp(1, DaoUtils.toTimestamp(newLastImportedAt));
			updateStmt.setInt(2, dataSource.getSourceId());
			updateStmt.executeUpdate();
			dataSource.setLastImportedAt(newLastImportedAt);
			return dataSource;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, updateStmt, null);
		}
	}

	/**
	 * Delete the DataSources instance. Fails with a foreign key error while CrimeIncidents or
	 * EmergencyCalls rows still reference it.
	 */
	public DataSources delete(DataSources dataSource) throws SQLException {
		String deleteDataSource = "DELETE FROM DataSources WHERE SourceId=?;";
		Connection connection = null;
		PreparedStatement deleteStmt = null;
		try {
			connection = connectionManager.getConnection();
			deleteStmt = connection.prepareStatement(deleteDataSource);
			deleteStmt.setInt(1, dataSource.getSourceId());
			deleteStmt.executeUpdate();
			// Return null so the caller can no longer operate on the DataSources instance.
			return null;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, deleteStmt, null);
		}
	}

	private DataSources getSingle(String query, Object param) throws SQLException {
		Connection connection = null;
		PreparedStatement selectStmt = null;
		ResultSet results = null;
		try {
			connection = connectionManager.getConnection();
			selectStmt = connection.prepareStatement(query);
			selectStmt.setObject(1, param);
			results = selectStmt.executeQuery();
			if (results.next()) {
				return new DataSources(
					results.getInt("SourceId"),
					results.getString("SourceName"),
					results.getString("DatasetIdentifier"),
					results.getString("SourceURL"),
					results.getTimestamp("LastImportedAt"));
			}
			return null;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, selectStmt, results);
		}
	}
}
