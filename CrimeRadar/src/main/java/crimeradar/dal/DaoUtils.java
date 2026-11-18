package crimeradar.dal;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Timestamp;
import java.util.Date;

/** Small helpers shared by the DAOs in this package. */
class DaoUtils {

	private DaoUtils() {
	}

	/** Converts a java.util.Date for a DATETIME parameter; null stays null (SQL NULL). */
	static Timestamp toTimestamp(Date date) {
		return date == null ? null : new Timestamp(date.getTime());
	}

	/** Converts a java.util.Date for a DATE parameter; null stays null (SQL NULL). */
	static java.sql.Date toSqlDate(Date date) {
		return date == null ? null : new java.sql.Date(date.getTime());
	}

	/** Reads the first auto-generated key after an INSERT run with RETURN_GENERATED_KEYS. */
	static long getGeneratedKey(Statement insertStmt) throws SQLException {
		ResultSet resultKey = null;
		try {
			resultKey = insertStmt.getGeneratedKeys();
			if (resultKey.next()) {
				return resultKey.getLong(1);
			}
			throw new SQLException("Unable to retrieve auto-generated key.");
		} finally {
			if (resultKey != null) {
				resultKey.close();
			}
		}
	}

	/** Closes JDBC resources in reverse order of creation; any argument may be null. */
	static void close(Connection connection, Statement statement, ResultSet results)
			throws SQLException {
		if (results != null) {
			results.close();
		}
		if (statement != null) {
			statement.close();
		}
		if (connection != null) {
			connection.close();
		}
	}
}
