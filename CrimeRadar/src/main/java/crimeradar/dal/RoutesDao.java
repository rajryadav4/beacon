package crimeradar.dal;

import crimeradar.model.Routes;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;

public class RoutesDao {
	protected ConnectionManager connectionManager;

	private static RoutesDao instance = null;

	protected RoutesDao() {
		connectionManager = new ConnectionManager();
	}

	public static RoutesDao getInstance() {
		if (instance == null) {
			instance = new RoutesDao();
		}
		return instance;
	}

	public Routes create(Routes route) throws SQLException {
		String insertRoute =
			"INSERT INTO Routes(RouteName,StartLatitude,StartLongitude,EndLatitude,EndLongitude,"
				+ "DistanceMeters) VALUES(?,?,?,?,?,?);";
		Connection connection = null;
		PreparedStatement insertStmt = null;
		try {
			connection = connectionManager.getConnection();
			insertStmt = connection.prepareStatement(insertRoute, Statement.RETURN_GENERATED_KEYS);
			insertStmt.setString(1, route.getRouteName());
			insertStmt.setBigDecimal(2, route.getStartLatitude());
			insertStmt.setBigDecimal(3, route.getStartLongitude());
			insertStmt.setBigDecimal(4, route.getEndLatitude());
			insertStmt.setBigDecimal(5, route.getEndLongitude());
			insertStmt.setObject(6, route.getDistanceMeters(), Types.INTEGER);
			insertStmt.executeUpdate();
			route.setRouteId(DaoUtils.getGeneratedKey(insertStmt));
			return route;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, insertStmt, null);
		}
	}

	public Routes getRouteById(long routeId) throws SQLException {
		String selectRoute =
			"SELECT RouteId,RouteName,StartLatitude,StartLongitude,EndLatitude,EndLongitude,"
				+ "DistanceMeters FROM Routes WHERE RouteId=?;";
		Connection connection = null;
		PreparedStatement selectStmt = null;
		ResultSet results = null;
		try {
			connection = connectionManager.getConnection();
			selectStmt = connection.prepareStatement(selectRoute);
			selectStmt.setLong(1, routeId);
			results = selectStmt.executeQuery();
			if (results.next()) {
				return new Routes(
					results.getLong("RouteId"),
					results.getString("RouteName"),
					results.getBigDecimal("StartLatitude"),
					results.getBigDecimal("StartLongitude"),
					results.getBigDecimal("EndLatitude"),
					results.getBigDecimal("EndLongitude"),
					results.getObject("DistanceMeters", Integer.class));
			}
			return null;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, selectStmt, results);
		}
	}

	public Routes updateRouteName(Routes route, String newRouteName) throws SQLException {
		String updateRoute = "UPDATE Routes SET RouteName=? WHERE RouteId=?;";
		Connection connection = null;
		PreparedStatement updateStmt = null;
		try {
			connection = connectionManager.getConnection();
			updateStmt = connection.prepareStatement(updateRoute);
			updateStmt.setString(1, newRouteName);
			updateStmt.setLong(2, route.getRouteId());
			updateStmt.executeUpdate();
			route.setRouteName(newRouteName);
			return route;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, updateStmt, null);
		}
	}

	/**
	 * Delete the Routes instance in one transaction, together with its RouteSegments and
	 * RouteRecommendations (the schema has no ON DELETE CASCADE).
	 */
	public Routes delete(Routes route) throws SQLException {
		String[] statements = {
			"DELETE FROM RouteSegments WHERE RouteId=?;",
			"DELETE FROM RouteRecommendations WHERE RouteId=?;",
			"DELETE FROM Routes WHERE RouteId=?;",
		};
		Connection connection = null;
		try {
			connection = connectionManager.getConnection();
			connection.setAutoCommit(false);
			for (String statement : statements) {
				PreparedStatement stmt = connection.prepareStatement(statement);
				try {
					stmt.setLong(1, route.getRouteId());
					stmt.executeUpdate();
				} finally {
					stmt.close();
				}
			}
			connection.commit();
			return null;
		} catch (SQLException e) {
			e.printStackTrace();
			if (connection != null) {
				connection.rollback();
			}
			throw e;
		} finally {
			DaoUtils.close(connection, null, null);
		}
	}
}
