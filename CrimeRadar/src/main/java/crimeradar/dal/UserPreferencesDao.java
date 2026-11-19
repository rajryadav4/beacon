package crimeradar.dal;

import crimeradar.model.UserPreferences;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;

public class UserPreferencesDao {
	protected ConnectionManager connectionManager;

	private static UserPreferencesDao instance = null;

	protected UserPreferencesDao() {
		connectionManager = new ConnectionManager();
	}

	public static synchronized UserPreferencesDao getInstance() {
		if (instance == null) {
			instance = new UserPreferencesDao();
		}
		return instance;
	}

	/** Returns the saved preferences, or the defaults (walk, 0.70, alerts on) if none. */
	public UserPreferences get(long userId) throws SQLException {
		String sql = "SELECT ModeKey,SafetyWeight,AlertsOn FROM UserPreferences WHERE UserId=?;";
		try (Connection connection = connectionManager.getConnection();
				PreparedStatement stmt = connection.prepareStatement(sql)) {
			stmt.setLong(1, userId);
			try (ResultSet rs = stmt.executeQuery()) {
				UserPreferences prefs = new UserPreferences();
				prefs.userId = userId;
				if (rs.next()) {
					prefs.modeKey = rs.getString("ModeKey");
					prefs.safetyWeight = rs.getBigDecimal("SafetyWeight");
					prefs.alertsOn = rs.getBoolean("AlertsOn");
				}
				return prefs;
			}
		}
	}

	/** Insert or update the one row for this user. */
	public UserPreferences save(UserPreferences prefs) throws SQLException {
		String sql = "INSERT INTO UserPreferences(UserId,ModeKey,SafetyWeight,AlertsOn,UpdatedAt) "
			+ "VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE ModeKey=VALUES(ModeKey),"
			+ "SafetyWeight=VALUES(SafetyWeight),AlertsOn=VALUES(AlertsOn),"
			+ "UpdatedAt=VALUES(UpdatedAt);";
		try (Connection connection = connectionManager.getConnection();
				PreparedStatement stmt = connection.prepareStatement(sql)) {
			stmt.setLong(1, prefs.userId);
			stmt.setString(2, prefs.modeKey);
			stmt.setBigDecimal(3, prefs.safetyWeight);
			stmt.setBoolean(4, prefs.alertsOn);
			stmt.setTimestamp(5, new Timestamp(System.currentTimeMillis()));
			stmt.executeUpdate();
			return prefs;
		}
	}
}
