package crimeradar.dal;

import crimeradar.model.AppUsers;
import crimeradar.model.SOSAlerts;
import crimeradar.model.SOSAlerts.AlertStatus;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;

public class SOSAlertsDao {
	protected ConnectionManager connectionManager;

	private static SOSAlertsDao instance = null;

	protected SOSAlertsDao() {
		connectionManager = new ConnectionManager();
	}

	public static SOSAlertsDao getInstance() {
		if (instance == null) {
			instance = new SOSAlertsDao();
		}
		return instance;
	}

	private static final String SELECT_COLUMNS =
		"SELECT AlertId,UserId,AlertTime,Latitude,Longitude,AlertStatus FROM SOSAlerts ";

	/** Save the SOSAlerts instance. AlertTime defaults to now and status to ACTIVE. */
	public SOSAlerts create(SOSAlerts alert) throws SQLException {
		String insertAlert =
			"INSERT INTO SOSAlerts(UserId,AlertTime,Latitude,Longitude,AlertStatus) "
				+ "VALUES(?,?,?,?,?);";
		Connection connection = null;
		PreparedStatement insertStmt = null;
		try {
			if (alert.getAlertTime() == null) {
				alert.setAlertTime(new Date());
			}
			if (alert.getAlertStatus() == null) {
				alert.setAlertStatus(AlertStatus.ACTIVE);
			}
			connection = connectionManager.getConnection();
			insertStmt = connection.prepareStatement(insertAlert, Statement.RETURN_GENERATED_KEYS);
			insertStmt.setLong(1, alert.getAppUser().getUserId());
			insertStmt.setTimestamp(2, DaoUtils.toTimestamp(alert.getAlertTime()));
			insertStmt.setBigDecimal(3, alert.getLatitude());
			insertStmt.setBigDecimal(4, alert.getLongitude());
			insertStmt.setString(5, alert.getAlertStatus().name());
			insertStmt.executeUpdate();
			alert.setAlertId(DaoUtils.getGeneratedKey(insertStmt));
			return alert;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, insertStmt, null);
		}
	}

	public SOSAlerts getSOSAlertById(long alertId) throws SQLException {
		Connection connection = null;
		PreparedStatement selectStmt = null;
		ResultSet results = null;
		try {
			connection = connectionManager.getConnection();
			selectStmt = connection.prepareStatement(SELECT_COLUMNS + "WHERE AlertId=?;");
			selectStmt.setLong(1, alertId);
			results = selectStmt.executeQuery();
			AppUsersDao appUsersDao = AppUsersDao.getInstance();
			if (results.next()) {
				AppUsers appUser = appUsersDao.getAppUserById(results.getLong("UserId"));
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

	/** The user's alerts, newest first. */
	public List<SOSAlerts> getSOSAlertsForUser(AppUsers appUser) throws SQLException {
		List<SOSAlerts> alerts = new ArrayList<SOSAlerts>();
		Connection connection = null;
		PreparedStatement selectStmt = null;
		ResultSet results = null;
		try {
			connection = connectionManager.getConnection();
			selectStmt = connection.prepareStatement(
				SELECT_COLUMNS + "WHERE UserId=? ORDER BY AlertTime DESC;");
			selectStmt.setLong(1, appUser.getUserId());
			results = selectStmt.executeQuery();
			while (results.next()) {
				alerts.add(fromResultSet(results, appUser));
			}
			return alerts;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, selectStmt, results);
		}
	}

	/** e.g. mark an alert RESOLVED or CANCELLED. */
	public SOSAlerts updateAlertStatus(SOSAlerts alert, AlertStatus newAlertStatus)
			throws SQLException {
		String updateAlert = "UPDATE SOSAlerts SET AlertStatus=? WHERE AlertId=?;";
		Connection connection = null;
		PreparedStatement updateStmt = null;
		try {
			connection = connectionManager.getConnection();
			updateStmt = connection.prepareStatement(updateAlert);
			updateStmt.setString(1, newAlertStatus.name());
			updateStmt.setLong(2, alert.getAlertId());
			updateStmt.executeUpdate();
			alert.setAlertStatus(newAlertStatus);
			return alert;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, updateStmt, null);
		}
	}

	public SOSAlerts delete(SOSAlerts alert) throws SQLException {
		String deleteAlert = "DELETE FROM SOSAlerts WHERE AlertId=?;";
		Connection connection = null;
		PreparedStatement deleteStmt = null;
		try {
			connection = connectionManager.getConnection();
			deleteStmt = connection.prepareStatement(deleteAlert);
			deleteStmt.setLong(1, alert.getAlertId());
			deleteStmt.executeUpdate();
			return null;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, deleteStmt, null);
		}
	}

	private static SOSAlerts fromResultSet(ResultSet results, AppUsers appUser)
			throws SQLException {
		return new SOSAlerts(
			results.getLong("AlertId"),
			appUser,
			results.getTimestamp("AlertTime"),
			results.getBigDecimal("Latitude"),
			results.getBigDecimal("Longitude"),
			AlertStatus.valueOf(results.getString("AlertStatus")));
	}
}
