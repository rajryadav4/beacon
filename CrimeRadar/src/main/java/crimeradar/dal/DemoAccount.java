package crimeradar.dal;

import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.List;

/**
 * The public demo account (demo@crimeradar.app). Every visitor shares it, so its data is
 * put back to the seed values at every demo login and by scripts/setup-db.ps1.
 */
public final class DemoAccount {
	public static final String EMAIL = "demo@crimeradar.app";
	public static final String PASSWORD = "CrimeRadar2026!";
	public static final String DISPLAY_NAME = "Demo User";

	private DemoAccount() {
	}

	public static boolean isDemoEmail(String email) {
		return EMAIL.equalsIgnoreCase(email);
	}

	/**
	 * In one transaction: delete all places and trips (TripDetails, RouteRecommendations and
	 * the Routes rows those trips created), then restore Home, Work and the default
	 * preferences (walk, 0.70, alerts on).
	 */
	public static void reset(long userId) throws SQLException {
		ConnectionManager cm = new ConnectionManager();
		Connection c = null;
		try {
			c = cm.getConnection();
			c.setAutoCommit(false);

			List<Long> routeIds = new ArrayList<Long>();
			try (PreparedStatement p = c.prepareStatement(
					"SELECT rr.RouteId FROM RouteRecommendations rr "
						+ "JOIN TripDetails td ON td.RecommendationId=rr.RecommendationId "
						+ "WHERE rr.UserId=?")) {
				p.setLong(1, userId);
				try (ResultSet rs = p.executeQuery()) {
					while (rs.next()) {
						routeIds.add(rs.getLong(1));
					}
				}
			}
			// TripDetails rows go with their RouteRecommendations (ON DELETE CASCADE).
			try (PreparedStatement p = c.prepareStatement(
					"DELETE rr FROM RouteRecommendations rr "
						+ "JOIN TripDetails td ON td.RecommendationId=rr.RecommendationId "
						+ "WHERE rr.UserId=?")) {
				p.setLong(1, userId);
				p.executeUpdate();
			}
			try (PreparedStatement p = c.prepareStatement("DELETE FROM Routes WHERE RouteId=?")) {
				for (Long id : routeIds) {
					p.setLong(1, id);
					p.addBatch();
				}
				p.executeBatch();
			}

			try (PreparedStatement p = c.prepareStatement("DELETE FROM UserPlaces WHERE UserId=?")) {
				p.setLong(1, userId);
				p.executeUpdate();
			}
			Timestamp now = new Timestamp(System.currentTimeMillis());
			try (PreparedStatement p = c.prepareStatement(
					"INSERT INTO UserPlaces(UserId,Kind,Label,Address,Latitude,Longitude,CreatedAt) "
						+ "VALUES(?,?,?,?,?,?,?)")) {
				place(p, userId, "HOME", "Home", "Capitol Hill, Seattle, WA", "47.623500",
					"-122.320000", now);
				place(p, userId, "WORK", "Work",
					"Northeastern University Seattle, 401 Terry Ave N, Seattle, WA 98109",
					"47.622600", "-122.337500", now);
			}

			try (PreparedStatement p = c.prepareStatement(
					"INSERT INTO UserPreferences(UserId,ModeKey,SafetyWeight,AlertsOn,UpdatedAt) "
						+ "VALUES(?,'walk',0.70,TRUE,?) ON DUPLICATE KEY UPDATE ModeKey='walk',"
						+ "SafetyWeight=0.70,AlertsOn=TRUE,UpdatedAt=VALUES(UpdatedAt)")) {
				p.setLong(1, userId);
				p.setTimestamp(2, now);
				p.executeUpdate();
			}
			c.commit();
		} catch (SQLException | RuntimeException e) {
			if (c != null) {
				c.rollback();
			}
			throw e;
		} finally {
			if (c != null) {
				c.close();
			}
		}
	}

	private static void place(PreparedStatement p, long userId, String kind, String label,
			String address, String lat, String lng, Timestamp now) throws SQLException {
		p.setLong(1, userId);
		p.setString(2, kind);
		p.setString(3, label);
		p.setString(4, address);
		p.setBigDecimal(5, new BigDecimal(lat));
		p.setBigDecimal(6, new BigDecimal(lng));
		p.setTimestamp(7, now);
		p.executeUpdate();
	}
}
