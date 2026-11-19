package crimeradar.tools;

import crimeradar.dal.ConnectionManager;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;

/**
 * Developer helper: runs the SQL given as arguments and prints the results as tab-separated
 * text. Uses the same db.properties as the app (no mysql command-line client needed).
 *
 * Example: java -cp ... crimeradar.tools.SqlConsole "SELECT COUNT(*) FROM CellStats"
 */
public class SqlConsole {

	public static void main(String[] args) throws Exception {
		if (args.length == 0) {
			System.err.println("Usage: SqlConsole \"SQL statement; another statement\" ...");
			System.exit(1);
		}
		try (Connection connection = new ConnectionManager().getConnection();
				Statement stmt = connection.createStatement()) {
			for (String arg : args) {
				for (String sql : SqlScript.split(arg)) {
					run(stmt, sql);
				}
			}
		} catch (SQLException e) {
			System.err.println("SQL error " + e.getErrorCode() + " (" + e.getSQLState() + "): "
				+ e.getMessage());
			System.exit(2);
		}
	}

	private static void run(Statement stmt, String sql) throws SQLException {
		boolean hasResult = stmt.execute(sql);
		if (!hasResult) {
			System.out.println("OK, " + stmt.getUpdateCount() + " rows affected");
			return;
		}
		try (ResultSet rs = stmt.getResultSet()) {
			ResultSetMetaData md = rs.getMetaData();
			int cols = md.getColumnCount();
			StringBuilder header = new StringBuilder();
			for (int i = 1; i <= cols; i++) {
				header.append(i > 1 ? "\t" : "").append(md.getColumnLabel(i));
			}
			System.out.println(header);
			while (rs.next()) {
				StringBuilder row = new StringBuilder();
				for (int i = 1; i <= cols; i++) {
					row.append(i > 1 ? "\t" : "").append(rs.getString(i));
				}
				System.out.println(row);
			}
		}
	}
}
