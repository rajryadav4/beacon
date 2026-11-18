package crimeradar.dal;

import crimeradar.model.AppUsers;
import crimeradar.model.EmergencyContacts;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;

public class EmergencyContactsDao {
	protected ConnectionManager connectionManager;

	private static EmergencyContactsDao instance = null;

	protected EmergencyContactsDao() {
		connectionManager = new ConnectionManager();
	}

	public static EmergencyContactsDao getInstance() {
		if (instance == null) {
			instance = new EmergencyContactsDao();
		}
		return instance;
	}

	private static final String SELECT_COLUMNS =
		"SELECT ContactId,UserId,ContactName,PhoneNumber,Relationship FROM EmergencyContacts ";

	public EmergencyContacts create(EmergencyContacts contact) throws SQLException {
		String insertContact =
			"INSERT INTO EmergencyContacts(UserId,ContactName,PhoneNumber,Relationship) "
				+ "VALUES(?,?,?,?);";
		Connection connection = null;
		PreparedStatement insertStmt = null;
		try {
			connection = connectionManager.getConnection();
			insertStmt = connection.prepareStatement(insertContact,
				Statement.RETURN_GENERATED_KEYS);
			insertStmt.setLong(1, contact.getAppUser().getUserId());
			insertStmt.setString(2, contact.getContactName());
			insertStmt.setString(3, contact.getPhoneNumber());
			insertStmt.setString(4, contact.getRelationship());
			insertStmt.executeUpdate();
			contact.setContactId(DaoUtils.getGeneratedKey(insertStmt));
			return contact;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, insertStmt, null);
		}
	}

	public EmergencyContacts getEmergencyContactById(long contactId) throws SQLException {
		Connection connection = null;
		PreparedStatement selectStmt = null;
		ResultSet results = null;
		try {
			connection = connectionManager.getConnection();
			selectStmt = connection.prepareStatement(SELECT_COLUMNS + "WHERE ContactId=?;");
			selectStmt.setLong(1, contactId);
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

	public List<EmergencyContacts> getEmergencyContactsForUser(AppUsers appUser)
			throws SQLException {
		List<EmergencyContacts> contacts = new ArrayList<EmergencyContacts>();
		Connection connection = null;
		PreparedStatement selectStmt = null;
		ResultSet results = null;
		try {
			connection = connectionManager.getConnection();
			selectStmt = connection.prepareStatement(
				SELECT_COLUMNS + "WHERE UserId=? ORDER BY ContactName;");
			selectStmt.setLong(1, appUser.getUserId());
			results = selectStmt.executeQuery();
			while (results.next()) {
				contacts.add(fromResultSet(results, appUser));
			}
			return contacts;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, selectStmt, results);
		}
	}

	public EmergencyContacts updatePhoneNumber(EmergencyContacts contact, String newPhoneNumber)
			throws SQLException {
		String updateContact = "UPDATE EmergencyContacts SET PhoneNumber=? WHERE ContactId=?;";
		Connection connection = null;
		PreparedStatement updateStmt = null;
		try {
			connection = connectionManager.getConnection();
			updateStmt = connection.prepareStatement(updateContact);
			updateStmt.setString(1, newPhoneNumber);
			updateStmt.setLong(2, contact.getContactId());
			updateStmt.executeUpdate();
			contact.setPhoneNumber(newPhoneNumber);
			return contact;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, updateStmt, null);
		}
	}

	public EmergencyContacts delete(EmergencyContacts contact) throws SQLException {
		String deleteContact = "DELETE FROM EmergencyContacts WHERE ContactId=?;";
		Connection connection = null;
		PreparedStatement deleteStmt = null;
		try {
			connection = connectionManager.getConnection();
			deleteStmt = connection.prepareStatement(deleteContact);
			deleteStmt.setLong(1, contact.getContactId());
			deleteStmt.executeUpdate();
			return null;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, deleteStmt, null);
		}
	}

	private static EmergencyContacts fromResultSet(ResultSet results, AppUsers appUser)
			throws SQLException {
		return new EmergencyContacts(
			results.getLong("ContactId"),
			appUser,
			results.getString("ContactName"),
			results.getString("PhoneNumber"),
			results.getString("Relationship"));
	}
}
