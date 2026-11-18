package crimeradar.dal;

import java.io.IOException;
import java.io.InputStream;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.Properties;

/**
 * Use ConnectionManager to connect to your database instance.
 *
 * ConnectionManager uses the MySQL Connector/J driver to connect to your local MySQL instance.
 * The driver jar lives in src/main/webapp/WEB-INF/lib.
 *
 * Credentials are read from db.properties at the root of the classpath
 * (src/main/java/db.properties). That file is git-ignored so passwords never reach the repo;
 * copy db.properties.example to db.properties and fill in your own values.
 */
public class ConnectionManager {

	private static final String PROPERTIES_FILE = "db.properties";

	// User to connect to your database instance.
	private final String user;
	// Password for the user.
	private final String password;
	// URI to your database server.
	private final String hostName;
	// Port to your database server. By default, this is 3306.
	private final int port;
	// Name of the MySQL schema that contains your tables.
	private final String schema;
	// The SPD data stores Seattle local times, so read DATETIME columns as Pacific time.
	private final String timezone = "America/Los_Angeles";

	public ConnectionManager() {
		Properties dbProperties = loadProperties();
		this.user = dbProperties.getProperty("db.user", "root");
		this.password = dbProperties.getProperty("db.password", "");
		this.hostName = dbProperties.getProperty("db.host", "localhost");
		this.port = Integer.parseInt(dbProperties.getProperty("db.port", "3306"));
		this.schema = dbProperties.getProperty("db.schema", "CrimeRadar");
	}

	private static Properties loadProperties() {
		Properties dbProperties = new Properties();
		InputStream in = ConnectionManager.class.getClassLoader()
			.getResourceAsStream(PROPERTIES_FILE);
		if (in == null) {
			throw new IllegalStateException(PROPERTIES_FILE + " not found on the classpath. "
				+ "Copy src/main/java/db.properties.example to src/main/java/db.properties "
				+ "and set your MySQL password.");
		}
		try {
			dbProperties.load(in);
			in.close();
		} catch (IOException e) {
			throw new IllegalStateException("Could not read " + PROPERTIES_FILE, e);
		}
		return dbProperties;
	}

	/** Get the connection to the database instance. */
	public Connection getConnection() throws SQLException {
		Connection connection = null;
		try {
			Properties connectionProperties = new Properties();
			connectionProperties.put("user", this.user);
			connectionProperties.put("password", this.password);
			connectionProperties.put("serverTimezone", this.timezone);
			// Ensure the JDBC driver is loaded by retrieving the runtime Class descriptor.
			// Otherwise, Tomcat may have issues loading libraries in the proper order.
			try {
				Class.forName("com.mysql.cj.jdbc.Driver");
			} catch (ClassNotFoundException e) {
				e.printStackTrace();
				throw new SQLException(e);
			}
			connection = DriverManager.getConnection(
				"jdbc:mysql://" + this.hostName + ":" + this.port + "/" + this.schema
					+ "?useSSL=false&allowPublicKeyRetrieval=true",
				connectionProperties);
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		}
		return connection;
	}

	/** Close the connection to the database instance. */
	public void closeConnection(Connection connection) throws SQLException {
		try {
			connection.close();
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		}
	}
}
