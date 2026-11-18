package crimeradar.dal;

import crimeradar.model.AppUsers;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;

public class AppUsersDao {
	protected ConnectionManager connectionManager;

	private static AppUsersDao instance = null;

	protected AppUsersDao() {
		connectionManager = new ConnectionManager();
	}

	public static AppUsersDao getInstance() {
		if (instance == null) {
			instance = new AppUsersDao();
		}
		return instance;
	}

	private static final String SELECT_COLUMNS =
		"SELECT UserId,DisplayName,Email,PasswordHash,CreatedAt FROM AppUsers ";

	/**
	 * Hex SHA-256 of the password, the same format the seed data uses (MySQL SHA2(..., 256)).
	 * Unsalted, which is fine for a course project but not for production.
	 */
	public static String hashPassword(String password) {
		try {
			byte[] digest = MessageDigest.getInstance("SHA-256")
				.digest(password.getBytes(StandardCharsets.UTF_8));
			StringBuilder hex = new StringBuilder();
			for (byte b : digest) {
				hex.append(String.format("%02x", b));
			}
			return hex.toString();
		} catch (NoSuchAlgorithmException e) {
			throw new IllegalStateException(e);
		}
	}

	/** Save the AppUsers instance. CreatedAt defaults to now when it is not set. */
	public AppUsers create(AppUsers appUser) throws SQLException {
		String insertAppUser =
			"INSERT INTO AppUsers(DisplayName,Email,PasswordHash,CreatedAt) VALUES(?,?,?,?);";
		Connection connection = null;
		PreparedStatement insertStmt = null;
		try {
			if (appUser.getCreatedAt() == null) {
				appUser.setCreatedAt(new Date());
			}
			connection = connectionManager.getConnection();
			insertStmt = connection.prepareStatement(insertAppUser,
				Statement.RETURN_GENERATED_KEYS);
			insertStmt.setString(1, appUser.getDisplayName());
			insertStmt.setString(2, appUser.getEmail());
			insertStmt.setString(3, appUser.getPasswordHash());
			insertStmt.setTimestamp(4, DaoUtils.toTimestamp(appUser.getCreatedAt()));
			insertStmt.executeUpdate();
			appUser.setUserId(DaoUtils.getGeneratedKey(insertStmt));
			return appUser;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, insertStmt, null);
		}
	}

	public AppUsers getAppUserById(long userId) throws SQLException {
		List<AppUsers> appUsers = getList(SELECT_COLUMNS + "WHERE UserId=?;", userId);
		return appUsers.isEmpty() ? null : appUsers.get(0);
	}

	public AppUsers getAppUserByEmail(String email) throws SQLException {
		List<AppUsers> appUsers = getList(SELECT_COLUMNS + "WHERE Email=?;", email);
		return appUsers.isEmpty() ? null : appUsers.get(0);
	}

	public List<AppUsers> getAppUsersByDisplayName(String displayName) throws SQLException {
		return getList(SELECT_COLUMNS + "WHERE DisplayName=? ORDER BY UserId;", displayName);
	}

	public AppUsers updateDisplayName(AppUsers appUser, String newDisplayName)
			throws SQLException {
		String updateAppUser = "UPDATE AppUsers SET DisplayName=? WHERE UserId=?;";
		Connection connection = null;
		PreparedStatement updateStmt = null;
		try {
			connection = connectionManager.getConnection();
			updateStmt = connection.prepareStatement(updateAppUser);
			updateStmt.setString(1, newDisplayName);
			updateStmt.setLong(2, appUser.getUserId());
			updateStmt.executeUpdate();
			appUser.setDisplayName(newDisplayName);
			return appUser;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, updateStmt, null);
		}
	}

	/**
	 * Delete the AppUsers instance in one transaction. The schema has no ON DELETE CASCADE, so
	 * the user's EmergencyContacts and SOSAlerts are deleted first; RouteRecommendations are
	 * kept but detached (UserId set to NULL, which the schema allows for anonymous requests).
	 */
	public AppUsers delete(AppUsers appUser) throws SQLException {
		String[] statements = {
			"DELETE FROM EmergencyContacts WHERE UserId=?;",
			"DELETE FROM SOSAlerts WHERE UserId=?;",
			"UPDATE RouteRecommendations SET UserId=NULL WHERE UserId=?;",
			"DELETE FROM AppUsers WHERE UserId=?;",
		};
		Connection connection = null;
		try {
			connection = connectionManager.getConnection();
			connection.setAutoCommit(false);
			for (String statement : statements) {
				PreparedStatement stmt = connection.prepareStatement(statement);
				try {
					stmt.setLong(1, appUser.getUserId());
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

	private List<AppUsers> getList(String query, Object param) throws SQLException {
		List<AppUsers> appUsers = new ArrayList<AppUsers>();
		Connection connection = null;
		PreparedStatement selectStmt = null;
		ResultSet results = null;
		try {
			connection = connectionManager.getConnection();
			selectStmt = connection.prepareStatement(query);
			selectStmt.setObject(1, param);
			results = selectStmt.executeQuery();
			while (results.next()) {
				appUsers.add(new AppUsers(
					results.getLong("UserId"),
					results.getString("DisplayName"),
					results.getString("Email"),
					results.getString("PasswordHash"),
					results.getTimestamp("CreatedAt")));
			}
			return appUsers;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, selectStmt, results);
		}
	}
}
