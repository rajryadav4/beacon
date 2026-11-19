package crimeradar.dal;

import crimeradar.model.UserPlaces;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.List;

public class UserPlacesDao {
	/** A user can keep this many SAVED places (HOME and WORK are one each). */
	public static final int MAX_SAVED = 50;

	protected ConnectionManager connectionManager;

	private static UserPlacesDao instance = null;

	protected UserPlacesDao() {
		connectionManager = new ConnectionManager();
	}

	public static synchronized UserPlacesDao getInstance() {
		if (instance == null) {
			instance = new UserPlacesDao();
		}
		return instance;
	}

	/** Thrown when a user already has MAX_SAVED saved places. */
	public static class LimitReachedException extends SQLException {
		private static final long serialVersionUID = 1L;

		public LimitReachedException() {
			super("Too many saved places.");
		}
	}

	/** Home first, then work, then saved places, newest first. Uses ix_UserPlaces_UserCreated. */
	public List<UserPlaces> listByUser(long userId) throws SQLException {
		String sql = "SELECT PlaceId,UserId,Kind,Label,Address,Latitude,Longitude,CreatedAt "
			+ "FROM UserPlaces WHERE UserId=? ORDER BY FIELD(Kind,'HOME','WORK','SAVED'),"
			+ "CreatedAt DESC,PlaceId DESC;";
		List<UserPlaces> places = new ArrayList<UserPlaces>();
		try (Connection connection = connectionManager.getConnection();
				PreparedStatement stmt = connection.prepareStatement(sql)) {
			stmt.setLong(1, userId);
			try (ResultSet rs = stmt.executeQuery()) {
				while (rs.next()) {
					places.add(read(rs));
				}
			}
		}
		return places;
	}

	/**
	 * Save a place in one transaction. A new HOME or WORK replaces the old one
	 * (the unique index on UserId + SingleKind allows only one of each).
	 */
	public UserPlaces create(UserPlaces place) throws SQLException {
		Connection connection = null;
		try {
			connection = connectionManager.getConnection();
			connection.setAutoCommit(false);
			if (place.kind == UserPlaces.Kind.SAVED) {
				try (PreparedStatement count = connection.prepareStatement(
						"SELECT COUNT(*) FROM UserPlaces WHERE UserId=? AND Kind='SAVED' "
							+ "FOR UPDATE;")) {
					count.setLong(1, place.userId);
					try (ResultSet rs = count.executeQuery()) {
						rs.next();
						if (rs.getInt(1) >= MAX_SAVED) {
							throw new LimitReachedException();
						}
					}
				}
			} else {
				try (PreparedStatement del = connection.prepareStatement(
						"DELETE FROM UserPlaces WHERE UserId=? AND Kind=?;")) {
					del.setLong(1, place.userId);
					del.setString(2, place.kind.name());
					del.executeUpdate();
				}
			}
			Timestamp now = new Timestamp(System.currentTimeMillis());
			try (PreparedStatement ins = connection.prepareStatement(
					"INSERT INTO UserPlaces(UserId,Kind,Label,Address,Latitude,Longitude,CreatedAt) "
						+ "VALUES(?,?,?,?,?,?,?);", Statement.RETURN_GENERATED_KEYS)) {
				ins.setLong(1, place.userId);
				ins.setString(2, place.kind.name());
				ins.setString(3, place.label);
				ins.setString(4, place.address);
				ins.setBigDecimal(5, place.latitude);
				ins.setBigDecimal(6, place.longitude);
				ins.setTimestamp(7, now);
				ins.executeUpdate();
				place.placeId = DaoUtils.getGeneratedKey(ins);
			}
			connection.commit();
			place.createdAt = now;
			return place;
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

	/** Delete one place of this user. Returns false if it is not the user's place. */
	public boolean delete(long userId, long placeId) throws SQLException {
		String sql = "DELETE FROM UserPlaces WHERE PlaceId=? AND UserId=?;";
		try (Connection connection = connectionManager.getConnection();
				PreparedStatement stmt = connection.prepareStatement(sql)) {
			stmt.setLong(1, placeId);
			stmt.setLong(2, userId);
			return stmt.executeUpdate() > 0;
		}
	}

	private static UserPlaces read(ResultSet rs) throws SQLException {
		UserPlaces p = new UserPlaces();
		p.placeId = rs.getLong("PlaceId");
		p.userId = rs.getLong("UserId");
		p.kind = UserPlaces.Kind.valueOf(rs.getString("Kind"));
		p.label = rs.getString("Label");
		p.address = rs.getString("Address");
		p.latitude = rs.getBigDecimal("Latitude");
		p.longitude = rs.getBigDecimal("Longitude");
		p.createdAt = rs.getTimestamp("CreatedAt");
		return p;
	}
}
