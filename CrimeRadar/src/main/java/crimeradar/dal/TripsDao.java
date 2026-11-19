package crimeradar.dal;

import crimeradar.model.TripDetails;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;

/** Saved trips: Routes + RouteRecommendations + TripDetails. */
public class TripsDao {
	protected ConnectionManager connectionManager;

	private static TripsDao instance = null;

	protected TripsDao() {
		connectionManager = new ConnectionManager();
	}

	public static synchronized TripsDao getInstance() {
		if (instance == null) {
			instance = new TripsDao();
		}
		return instance;
	}

	/** Writes the three rows in one transaction. Sets recommendationId and createdAt. */
	public TripDetails create(TripDetails trip) throws SQLException {
		Connection connection = null;
		try {
			connection = connectionManager.getConnection();
			connection.setAutoCommit(false);
			Timestamp now = new Timestamp(System.currentTimeMillis());

			String routeName = trip.fromLabel + " to " + trip.toLabel;
			if (routeName.length() > 150) {
				routeName = routeName.substring(0, 150);
			}
			long routeId;
			try (PreparedStatement ins = connection.prepareStatement(
					"INSERT INTO Routes(RouteName,StartLatitude,StartLongitude,EndLatitude,"
						+ "EndLongitude,DistanceMeters) VALUES(?,?,?,?,?,?);",
					Statement.RETURN_GENERATED_KEYS)) {
				ins.setString(1, routeName);
				ins.setBigDecimal(2, trip.fromLat);
				ins.setBigDecimal(3, trip.fromLng);
				ins.setBigDecimal(4, trip.toLat);
				ins.setBigDecimal(5, trip.toLng);
				ins.setInt(6, trip.distanceMeters);
				ins.executeUpdate();
				routeId = DaoUtils.getGeneratedKey(ins);
			}
			try (PreparedStatement ins = connection.prepareStatement(
					"INSERT INTO RouteRecommendations(UserId,RouteId,RequestedAt,EstimatedRisk,"
						+ "RecommendationType) VALUES(?,?,?,?,?);",
					Statement.RETURN_GENERATED_KEYS)) {
				ins.setLong(1, trip.userId);
				ins.setLong(2, routeId);
				ins.setTimestamp(3, now);
				ins.setBigDecimal(4, trip.riskScore);
				ins.setString(5, trip.choice);
				ins.executeUpdate();
				trip.recommendationId = DaoUtils.getGeneratedKey(ins);
			}
			try (PreparedStatement ins = connection.prepareStatement(
					"INSERT INTO TripDetails(RecommendationId,FromLabel,ToLabel,ModeKey,DepartAt,"
						+ "DurationSeconds,RiskScore,RiskLevel) VALUES(?,?,?,?,?,?,?,?);")) {
				ins.setLong(1, trip.recommendationId);
				ins.setString(2, trip.fromLabel);
				ins.setString(3, trip.toLabel);
				ins.setString(4, trip.modeKey);
				ins.setObject(5, trip.departAt);
				ins.setInt(6, trip.durationSeconds);
				ins.setBigDecimal(7, trip.riskScore);
				ins.setString(8, trip.riskLevel);
				ins.executeUpdate();
			}
			connection.commit();
			trip.createdAt = new Date(now.getTime());
			return trip;
		} catch (SQLException e) {
			if (connection != null) {
				connection.rollback();
			}
			throw e;
		} finally {
			if (connection != null) {
				connection.close();
			}
		}
	}

	/**
	 * Newest trips first. Uses ix_RouteRecommendations_UserTime, then primary-key lookups
	 * into TripDetails and Routes.
	 */
	public List<TripDetails> listByUser(long userId, int limit) throws SQLException {
		String sql = "SELECT rr.RecommendationId,rr.UserId,rr.RequestedAt,rr.RecommendationType,"
			+ "td.FromLabel,td.ToLabel,td.ModeKey,td.DepartAt,td.DurationSeconds,td.RiskScore,"
			+ "td.RiskLevel,r.StartLatitude,r.StartLongitude,r.EndLatitude,r.EndLongitude,"
			+ "r.DistanceMeters "
			+ "FROM RouteRecommendations rr "
			+ "JOIN TripDetails td ON td.RecommendationId=rr.RecommendationId "
			+ "JOIN Routes r ON r.RouteId=rr.RouteId "
			+ "WHERE rr.UserId=? ORDER BY rr.RequestedAt DESC,rr.RecommendationId DESC LIMIT ?;";
		List<TripDetails> trips = new ArrayList<TripDetails>();
		try (Connection connection = connectionManager.getConnection();
				PreparedStatement stmt = connection.prepareStatement(sql)) {
			stmt.setLong(1, userId);
			stmt.setInt(2, limit);
			try (ResultSet rs = stmt.executeQuery()) {
				while (rs.next()) {
					TripDetails t = new TripDetails();
					t.recommendationId = rs.getLong("RecommendationId");
					t.userId = rs.getLong("UserId");
					t.createdAt = rs.getTimestamp("RequestedAt");
					t.choice = rs.getString("RecommendationType");
					t.fromLabel = rs.getString("FromLabel");
					t.toLabel = rs.getString("ToLabel");
					t.modeKey = rs.getString("ModeKey");
					t.departAt = rs.getObject("DepartAt", LocalDateTime.class);
					t.durationSeconds = rs.getInt("DurationSeconds");
					t.riskScore = rs.getBigDecimal("RiskScore");
					t.riskLevel = rs.getString("RiskLevel");
					t.fromLat = rs.getBigDecimal("StartLatitude");
					t.fromLng = rs.getBigDecimal("StartLongitude");
					t.toLat = rs.getBigDecimal("EndLatitude");
					t.toLng = rs.getBigDecimal("EndLongitude");
					t.distanceMeters = rs.getInt("DistanceMeters");
					trips.add(t);
				}
			}
		}
		return trips;
	}
}
