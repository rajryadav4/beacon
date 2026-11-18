package crimeradar.dal;

import crimeradar.model.Neighborhoods;
import crimeradar.model.SafetyResources;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.List;

public class SafetyResourcesDao {
	protected ConnectionManager connectionManager;

	private static SafetyResourcesDao instance = null;

	protected SafetyResourcesDao() {
		connectionManager = new ConnectionManager();
	}

	public static SafetyResourcesDao getInstance() {
		if (instance == null) {
			instance = new SafetyResourcesDao();
		}
		return instance;
	}

	private static final String SELECT_COLUMNS =
		"SELECT ResourceId,NeighborhoodId,ResourceName,ResourceType,ContactInfo,ResourceURL "
			+ "FROM SafetyResources ";

	public SafetyResources create(SafetyResources safetyResource) throws SQLException {
		String insertResource =
			"INSERT INTO SafetyResources(NeighborhoodId,ResourceName,ResourceType,ContactInfo,"
				+ "ResourceURL) VALUES(?,?,?,?,?);";
		Connection connection = null;
		PreparedStatement insertStmt = null;
		try {
			connection = connectionManager.getConnection();
			insertStmt = connection.prepareStatement(insertResource,
				Statement.RETURN_GENERATED_KEYS);
			Neighborhoods neighborhood = safetyResource.getNeighborhood();
			insertStmt.setObject(1, neighborhood == null ? null : neighborhood.getNeighborhoodId(),
				Types.INTEGER);
			insertStmt.setString(2, safetyResource.getResourceName());
			insertStmt.setString(3, safetyResource.getResourceType());
			insertStmt.setString(4, safetyResource.getContactInfo());
			insertStmt.setString(5, safetyResource.getResourceURL());
			insertStmt.executeUpdate();
			safetyResource.setResourceId((int) DaoUtils.getGeneratedKey(insertStmt));
			return safetyResource;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, insertStmt, null);
		}
	}

	public SafetyResources getSafetyResourceById(int resourceId) throws SQLException {
		Connection connection = null;
		PreparedStatement selectStmt = null;
		ResultSet results = null;
		try {
			connection = connectionManager.getConnection();
			selectStmt = connection.prepareStatement(SELECT_COLUMNS + "WHERE ResourceId=?;");
			selectStmt.setInt(1, resourceId);
			results = selectStmt.executeQuery();
			NeighborhoodsDao neighborhoodsDao = NeighborhoodsDao.getInstance();
			if (results.next()) {
				Integer neighborhoodId = results.getObject("NeighborhoodId", Integer.class);
				Neighborhoods neighborhood = neighborhoodId == null ? null
					: neighborhoodsDao.getNeighborhoodById(neighborhoodId);
				return fromResultSet(results, neighborhood);
			}
			return null;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, selectStmt, results);
		}
	}

	public List<SafetyResources> getSafetyResourcesForNeighborhood(Neighborhoods neighborhood)
			throws SQLException {
		List<SafetyResources> safetyResources = new ArrayList<SafetyResources>();
		Connection connection = null;
		PreparedStatement selectStmt = null;
		ResultSet results = null;
		try {
			connection = connectionManager.getConnection();
			selectStmt = connection.prepareStatement(
				SELECT_COLUMNS + "WHERE NeighborhoodId=? ORDER BY ResourceName;");
			selectStmt.setInt(1, neighborhood.getNeighborhoodId());
			results = selectStmt.executeQuery();
			while (results.next()) {
				safetyResources.add(fromResultSet(results, neighborhood));
			}
			return safetyResources;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, selectStmt, results);
		}
	}

	public SafetyResources updateContactInfo(SafetyResources safetyResource,
			String newContactInfo) throws SQLException {
		String updateResource = "UPDATE SafetyResources SET ContactInfo=? WHERE ResourceId=?;";
		Connection connection = null;
		PreparedStatement updateStmt = null;
		try {
			connection = connectionManager.getConnection();
			updateStmt = connection.prepareStatement(updateResource);
			updateStmt.setString(1, newContactInfo);
			updateStmt.setInt(2, safetyResource.getResourceId());
			updateStmt.executeUpdate();
			safetyResource.setContactInfo(newContactInfo);
			return safetyResource;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, updateStmt, null);
		}
	}

	public SafetyResources delete(SafetyResources safetyResource) throws SQLException {
		String deleteResource = "DELETE FROM SafetyResources WHERE ResourceId=?;";
		Connection connection = null;
		PreparedStatement deleteStmt = null;
		try {
			connection = connectionManager.getConnection();
			deleteStmt = connection.prepareStatement(deleteResource);
			deleteStmt.setInt(1, safetyResource.getResourceId());
			deleteStmt.executeUpdate();
			return null;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, deleteStmt, null);
		}
	}

	private static SafetyResources fromResultSet(ResultSet results, Neighborhoods neighborhood)
			throws SQLException {
		return new SafetyResources(
			results.getInt("ResourceId"),
			neighborhood,
			results.getString("ResourceName"),
			results.getString("ResourceType"),
			results.getString("ContactInfo"),
			results.getString("ResourceURL"));
	}
}
