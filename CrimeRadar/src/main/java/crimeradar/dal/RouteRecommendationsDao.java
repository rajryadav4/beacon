package crimeradar.dal;

import crimeradar.model.AppUsers;
import crimeradar.model.RouteRecommendations;
import crimeradar.model.RouteRecommendations.RecommendationType;
import crimeradar.model.Routes;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;

public class RouteRecommendationsDao {
	protected ConnectionManager connectionManager;

	private static RouteRecommendationsDao instance = null;

	protected RouteRecommendationsDao() {
		connectionManager = new ConnectionManager();
	}

	public static RouteRecommendationsDao getInstance() {
		if (instance == null) {
			instance = new RouteRecommendationsDao();
		}
		return instance;
	}

	private static final String SELECT_COLUMNS =
		"SELECT RecommendationId,UserId,RouteId,RequestedAt,EstimatedRisk,RecommendationType "
			+ "FROM RouteRecommendations ";

	/** Save the instance. RequestedAt defaults to now and the type to BALANCED. */
	public RouteRecommendations create(RouteRecommendations recommendation)
			throws SQLException {
		String insertRecommendation =
			"INSERT INTO RouteRecommendations(UserId,RouteId,RequestedAt,EstimatedRisk,"
				+ "RecommendationType) VALUES(?,?,?,?,?);";
		Connection connection = null;
		PreparedStatement insertStmt = null;
		try {
			if (recommendation.getRequestedAt() == null) {
				recommendation.setRequestedAt(new Date());
			}
			if (recommendation.getRecommendationType() == null) {
				recommendation.setRecommendationType(RecommendationType.BALANCED);
			}
			connection = connectionManager.getConnection();
			insertStmt = connection.prepareStatement(insertRecommendation,
				Statement.RETURN_GENERATED_KEYS);
			AppUsers appUser = recommendation.getAppUser();
			insertStmt.setObject(1, appUser == null ? null : appUser.getUserId(), Types.BIGINT);
			insertStmt.setLong(2, recommendation.getRoute().getRouteId());
			insertStmt.setTimestamp(3, DaoUtils.toTimestamp(recommendation.getRequestedAt()));
			insertStmt.setBigDecimal(4, recommendation.getEstimatedRisk());
			insertStmt.setString(5, recommendation.getRecommendationType().name());
			insertStmt.executeUpdate();
			recommendation.setRecommendationId(DaoUtils.getGeneratedKey(insertStmt));
			return recommendation;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, insertStmt, null);
		}
	}

	public RouteRecommendations getRouteRecommendationById(long recommendationId)
			throws SQLException {
		Connection connection = null;
		PreparedStatement selectStmt = null;
		ResultSet results = null;
		try {
			connection = connectionManager.getConnection();
			selectStmt = connection.prepareStatement(
				SELECT_COLUMNS + "WHERE RecommendationId=?;");
			selectStmt.setLong(1, recommendationId);
			results = selectStmt.executeQuery();
			if (results.next()) {
				Long userId = results.getObject("UserId", Long.class);
				AppUsers appUser = userId == null ? null
					: AppUsersDao.getInstance().getAppUserById(userId);
				return fromResultSet(results, appUser);
			}
			return null;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, selectStmt, results);
		}
	}

	/** The user's recommendations, newest first. */
	public List<RouteRecommendations> getRouteRecommendationsForUser(AppUsers appUser)
			throws SQLException {
		List<RouteRecommendations> recommendations = new ArrayList<RouteRecommendations>();
		Connection connection = null;
		PreparedStatement selectStmt = null;
		ResultSet results = null;
		try {
			connection = connectionManager.getConnection();
			selectStmt = connection.prepareStatement(
				SELECT_COLUMNS + "WHERE UserId=? ORDER BY RequestedAt DESC;");
			selectStmt.setLong(1, appUser.getUserId());
			results = selectStmt.executeQuery();
			while (results.next()) {
				recommendations.add(fromResultSet(results, appUser));
			}
			return recommendations;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, selectStmt, results);
		}
	}

	public RouteRecommendations delete(RouteRecommendations recommendation)
			throws SQLException {
		String deleteRecommendation = "DELETE FROM RouteRecommendations WHERE RecommendationId=?;";
		Connection connection = null;
		PreparedStatement deleteStmt = null;
		try {
			connection = connectionManager.getConnection();
			deleteStmt = connection.prepareStatement(deleteRecommendation);
			deleteStmt.setLong(1, recommendation.getRecommendationId());
			deleteStmt.executeUpdate();
			return null;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, deleteStmt, null);
		}
	}

	private static RouteRecommendations fromResultSet(ResultSet results, AppUsers appUser)
			throws SQLException {
		Routes route = RoutesDao.getInstance().getRouteById(results.getLong("RouteId"));
		return new RouteRecommendations(
			results.getLong("RecommendationId"),
			appUser,
			route,
			results.getTimestamp("RequestedAt"),
			results.getBigDecimal("EstimatedRisk"),
			RecommendationType.valueOf(results.getString("RecommendationType")));
	}
}
