package crimeradar.tools;

import crimeradar.dal.AppUsersDao;
import crimeradar.dal.ConnectionManager;
import crimeradar.dal.DemoAccount;
import crimeradar.model.AppUsers;
import crimeradar.util.Json;
import crimeradar.util.Passwords;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Builds the CrimeRadar app tables. Run it from the repository root (scripts/setup-db.ps1).
 *
 * <pre>
 *   (no flag)      run sql/app_tables.sql, import ml/output, seed the demo account
 *   --risk-only    only re-import ml/output/cell_risk.csv and metrics.json
 *   --reset        also drop the user tables (preferences, places, trips) first
 *   --drop-only    drop every app table and stop (do this before re-running crime_radar_all.sql)
 * </pre>
 *
 * It is safe to run again. It needs sql/crime_radar_all.sql to have been run first.
 */
public class SetupAppSchema {

	/** Every app table, children first. */
	private static final String[] ALL_TABLES = { "TripDetails", "UserPlaces", "UserPreferences",
		"CellRiskScores", "ModelRuns", "NeighborhoodStats", "NeighborhoodPrecincts", "CellStats",
		"GridCells",
		"CategoryGroups", "AppMeta", "TravelModes", "TimeBands", "CrimeGroups" };
	private static final String[] USER_TABLES = { "TripDetails", "UserPlaces", "UserPreferences" };

	public static void main(String[] args) {
		List<String> flags = Arrays.asList(args);
		boolean riskOnly = flags.contains("--risk-only");
		boolean reset = flags.contains("--reset");
		boolean dropOnly = flags.contains("--drop-only");
		try (Connection c = new ConnectionManager().getConnection()) {
			Path root = findRoot();
			if (dropOnly) {
				dropTables(c, ALL_TABLES);
				System.out.println("Dropped all app tables. Now you can re-run sql/crime_radar_all.sql.");
				return;
			}
			if (!riskOnly) {
				if (reset) {
					dropTables(c, USER_TABLES);
				}
				runScript(c, root.resolve("sql").resolve("app_tables.sql"));
			}
			importRisk(c, root);
			if (!riskOnly) {
				seedDemo();
			}
			printCounts(c);
		} catch (SQLException e) {
			System.err.println();
			System.err.println("DATABASE ERROR " + e.getErrorCode() + " (" + e.getSQLState() + "): "
				+ e.getMessage());
			if ("28000".equals(e.getSQLState()) || e.getErrorCode() == 1045) {
				System.err.println("BLOCKED: MySQL refused the login. Put your MySQL password in "
					+ "CrimeRadar/src/main/java/db.properties and run this again.");
			} else if ("42S02".equals(e.getSQLState()) || e.getErrorCode() == 1146
					|| e.getErrorCode() == 1049) {
				System.err.println("BLOCKED: the milestone tables are missing. "
					+ "Run sql/crime_radar_all.sql first.");
			}
			System.exit(2);
		} catch (Exception e) {
			System.err.println("ERROR: " + e);
			System.exit(1);
		}
	}

	// ------------------------------------------------------------------ script

	private static Path findRoot() {
		Path p = Paths.get("").toAbsolutePath();
		while (p != null) {
			if (Files.exists(p.resolve("sql").resolve("app_tables.sql"))) {
				return p;
			}
			p = p.getParent();
		}
		throw new IllegalStateException(
			"Cannot find sql/app_tables.sql. Run this from the CrimeRadar repository folder.");
	}

	private static void dropTables(Connection c, String[] tables) throws SQLException {
		try (Statement stmt = c.createStatement()) {
			stmt.execute("DROP VIEW IF EXISTS vw_CleanIncidents");
			for (String t : tables) {
				stmt.execute("DROP TABLE IF EXISTS " + t);
			}
		}
	}

	private static void runScript(Connection c, Path file) throws Exception {
		String script = new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
		List<String> statements = SqlScript.split(script);
		System.out.println("Running " + file.getFileName() + " (" + statements.size()
			+ " statements)...");
		try (Statement stmt = c.createStatement()) {
			int n = 0;
			for (String sql : statements) {
				n++;
				long t0 = System.currentTimeMillis();
				try {
					stmt.execute(sql);
				} catch (SQLException e) {
					System.err.println("Failed statement " + n + ":\n" + abbreviate(sql));
					throw e;
				}
				long ms = System.currentTimeMillis() - t0;
				if (ms > 1500) {
					System.out.println("  statement " + n + " took " + ms / 1000.0 + " s: "
						+ firstLine(sql));
				}
			}
		}
		System.out.println("Done.");
	}

	private static String firstLine(String sql) {
		String s = sql.trim().replaceAll("\\s+", " ");
		return s.length() > 70 ? s.substring(0, 70) + "..." : s;
	}

	private static String abbreviate(String sql) {
		return sql.length() > 600 ? sql.substring(0, 600) + "..." : sql;
	}

	// ------------------------------------------------------------------ ML import

	private static void importRisk(Connection c, Path root) throws Exception {
		Path csv = root.resolve("ml").resolve("output").resolve("cell_risk.csv");
		Path metricsFile = root.resolve("ml").resolve("output").resolve("metrics.json");
		if (!Files.exists(csv)) {
			System.out.println("No ml/output/cell_risk.csv yet: skipped the model import "
				+ "(the map shows zero risk until it exists).");
			return;
		}
		List<String> lines = Files.readAllLines(csv, StandardCharsets.UTF_8);
		if (lines.isEmpty()) {
			System.out.println("cell_risk.csv is empty: skipped.");
			return;
		}
		String[] header = lines.get(0).trim().toLowerCase().split(",");
		int iCell = indexOf(header, "cell_id");
		int iBand = indexOf(header, "band");
		int iRisk = indexOf(header, "expected_risk");
		int iLevel = indexOf(header, "level");
		if (iCell < 0 || iBand < 0 || iRisk < 0) {
			throw new IllegalStateException(
				"cell_risk.csv needs the columns cell_id, band, expected_risk (level is optional).");
		}

		List<double[]> rows = new ArrayList<double[]>(); // cell, band, risk, level(-1 = unknown)
		int skipped = 0;
		for (int i = 1; i < lines.size(); i++) {
			String line = lines.get(i).trim();
			if (line.isEmpty()) {
				continue;
			}
			String[] f = line.split(",", -1);
			try {
				int cell = (int) Math.round(Double.parseDouble(clean(f[iCell])));
				int band = (int) Math.round(Double.parseDouble(clean(f[iBand])));
				double risk = Math.max(0, Double.parseDouble(clean(f[iRisk])));
				int level = iLevel >= 0 && iLevel < f.length ? levelCode(clean(f[iLevel])) : -1;
				int row = cell / 100;
				int col = cell % 100;
				if (cell < 0 || row >= 135 || col >= 80 || band < 0 || band > 3
						|| Double.isNaN(risk) || Double.isInfinite(risk)) {
					skipped++;
					continue;
				}
				rows.add(new double[] { cell, band, risk, level });
			} catch (RuntimeException e) {
				skipped++;
			}
		}
		fillMissingLevels(rows);

		// Model run details from metrics.json (optional).
		String version = "risk-" + LocalDate.now();
		String algorithm = "unknown";
		LocalDateTime trainedAt = LocalDateTime.now();
		String metricsText = null;
		if (Files.exists(metricsFile)) {
			metricsText = new String(Files.readAllBytes(metricsFile), StandardCharsets.UTF_8);
			Object parsed = Json.parse(metricsText);
			if (parsed instanceof Map) {
				Map<?, ?> m = (Map<?, ?>) parsed;
				// ml/train_risk_model.py writes version, algorithm, trainedOn, metrics and
				// baseline under "metaModel". Older layouts keep them at the top level.
				Map<?, ?> mm = m.get("metaModel") instanceof Map ? (Map<?, ?>) m.get("metaModel") : m;
				version = firstString(mm, version, "modelVersion", "version");
				algorithm = firstString(mm, algorithm, "algorithm");
				trainedAt = parseTime(firstString(m, null, "trainedAt", "generatedAt"), trainedAt);
			}
		}
		version = version.length() > 50 ? version.substring(0, 50) : version;
		algorithm = algorithm.length() > 150 ? algorithm.substring(0, 150) : algorithm;

		boolean oldAuto = c.getAutoCommit();
		c.setAutoCommit(false);
		try {
			try (Statement s = c.createStatement()) {
				s.executeUpdate("UPDATE ModelRuns SET IsActive=FALSE");
			}
			try (PreparedStatement p = c.prepareStatement(
					"DELETE FROM CellRiskScores WHERE ModelVersion=?")) {
				p.setString(1, version);
				p.executeUpdate();
			}
			try (PreparedStatement p = c.prepareStatement(
					"DELETE FROM ModelRuns WHERE ModelVersion=?")) {
				p.setString(1, version);
				p.executeUpdate();
			}
			try (PreparedStatement p = c.prepareStatement(
					"INSERT INTO ModelRuns(ModelVersion,TrainedAt,Algorithm,MetricsJson,IsActive) "
						+ "VALUES(?,?,?,?,TRUE)")) {
				p.setString(1, version);
				p.setObject(2, trainedAt);
				p.setString(3, algorithm);
				p.setString(4, metricsText);
				p.executeUpdate();
			}

			// Cells the model scores but that have no incidents still need a GridCells row.
			Set<Integer> cells = new LinkedHashSet<Integer>();
			for (double[] r : rows) {
				cells.add((int) r[0]);
			}
			try (PreparedStatement p = c.prepareStatement(
					"INSERT IGNORE INTO GridCells(CellId,RowIdx,ColIdx,CenterLat,CenterLng) "
						+ "VALUES(?,?,?,?,?)")) {
				int n = 0;
				for (int cell : cells) {
					int row = cell / 100;
					int col = cell % 100;
					p.setInt(1, cell);
					p.setInt(2, row);
					p.setInt(3, col);
					p.setBigDecimal(4, BigDecimal.valueOf(47.48 + (row + 0.5) * 0.002)
						.setScale(6, java.math.RoundingMode.HALF_UP));
					p.setBigDecimal(5, BigDecimal.valueOf(-122.46 + (col + 0.5) * 0.003)
						.setScale(6, java.math.RoundingMode.HALF_UP));
					p.addBatch();
					if (++n % 2000 == 0) {
						p.executeBatch();
					}
				}
				p.executeBatch();
			}

			String[] levels = { "low", "elevated", "high" };
			try (PreparedStatement p = c.prepareStatement(
					"INSERT INTO CellRiskScores(ModelVersion,CellId,TimeBand,ExpectedRisk,RiskLevel) "
						+ "VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE ExpectedRisk=VALUES(ExpectedRisk),"
						+ "RiskLevel=VALUES(RiskLevel)")) {
				int n = 0;
				for (double[] r : rows) {
					p.setString(1, version);
					p.setInt(2, (int) r[0]);
					p.setInt(3, (int) r[1]);
					p.setBigDecimal(4, BigDecimal.valueOf(r[2]).setScale(4,
						java.math.RoundingMode.HALF_UP));
					p.setString(5, levels[(int) r[3]]);
					p.addBatch();
					if (++n % 2000 == 0) {
						p.executeBatch();
					}
				}
				p.executeBatch();
			}
			try (PreparedStatement p = c.prepareStatement(
					"REPLACE INTO AppMeta(MetaKey,MetaValue) VALUES('riskImportedAt',?)")) {
				p.setString(1, Instant.now().toString());
				p.executeUpdate();
			}
			c.commit();
		} catch (SQLException | RuntimeException e) {
			c.rollback();
			throw e;
		} finally {
			c.setAutoCommit(oldAuto);
		}
		System.out.println("Imported model " + version + ": " + rows.size() + " cell-band rows"
			+ (skipped > 0 ? " (" + skipped + " bad rows skipped)" : "") + ".");
	}

	private static int indexOf(String[] header, String name) {
		for (int i = 0; i < header.length; i++) {
			if (header[i].trim().replace("\"", "").equals(name)) {
				return i;
			}
		}
		return -1;
	}

	private static String clean(String s) {
		return s.trim().replace("\"", "");
	}

	/** 0 low, 1 elevated, 2 high, -1 unknown. */
	private static int levelCode(String s) {
		String v = s.toLowerCase();
		if (v.equals("low") || v.equals("0")) {
			return 0;
		}
		if (v.equals("elevated") || v.equals("medium") || v.equals("1")) {
			return 1;
		}
		if (v.equals("high") || v.equals("2")) {
			return 2;
		}
		return -1;
	}

	/** When the CSV has no usable level, use LOW < q90 <= ELEVATED < q97 <= HIGH. */
	private static void fillMissingLevels(List<double[]> rows) {
		boolean missing = false;
		for (double[] r : rows) {
			if (r[3] < 0) {
				missing = true;
				break;
			}
		}
		if (!missing) {
			return;
		}
		double[] values = new double[rows.size()];
		for (int i = 0; i < values.length; i++) {
			values[i] = rows.get(i)[2];
		}
		Arrays.sort(values);
		double q75 = values.length == 0 ? 0 : values[(int) Math.floor(0.90 * (values.length - 1))];
		double q90 = values.length == 0 ? 0 : values[(int) Math.floor(0.97 * (values.length - 1))];
		for (double[] r : rows) {
			if (r[3] < 0) {
				r[3] = r[2] >= q90 ? 2 : (r[2] >= q75 ? 1 : 0);
			}
		}
	}

	private static String firstString(Map<?, ?> m, String fallback, String... keys) {
		for (String k : keys) {
			Object v = m.get(k);
			if (v instanceof String && !((String) v).isEmpty()) {
				return (String) v;
			}
		}
		return fallback;
	}

	private static LocalDateTime parseTime(String s, LocalDateTime fallback) {
		if (s == null) {
			return fallback;
		}
		try {
			return LocalDateTime.ofInstant(Instant.parse(s), ZoneId.systemDefault());
		} catch (RuntimeException e) {
			// try the next format
		}
		try {
			return LocalDateTime.parse(s);
		} catch (RuntimeException e) {
			// try the next format
		}
		try {
			return LocalDate.parse(s.length() > 10 ? s.substring(0, 10) : s).atStartOfDay();
		} catch (RuntimeException e) {
			return fallback;
		}
	}

	// ------------------------------------------------------------------ demo account

	private static void seedDemo() throws SQLException {
		AppUsersDao users = AppUsersDao.getInstance();
		AppUsers demo = users.getAppUserByEmail(DemoAccount.EMAIL);
		if (demo == null) {
			demo = users.create(new AppUsers(DemoAccount.DISPLAY_NAME, DemoAccount.EMAIL,
				Passwords.hash(DemoAccount.PASSWORD)));
			System.out.println("Created the demo account " + DemoAccount.EMAIL + ".");
		} else {
			users.updatePasswordHash(demo.getUserId(), Passwords.hash(DemoAccount.PASSWORD));
			System.out.println("Demo account " + DemoAccount.EMAIL
				+ " already exists: password and data reset.");
		}
		// Same code as the demo login: Home, Work and preferences back to the seed values.
		DemoAccount.reset(demo.getUserId());
	}

	// ------------------------------------------------------------------ report

	private static void printCounts(Connection c) throws SQLException {
		System.out.println();
		System.out.println("Row counts:");
		String[] tables = { "CrimeIncidents", "CrimeCategories", "Neighborhoods", "CrimeGroups",
			"TimeBands", "TravelModes", "CategoryGroups", "GridCells", "CellStats",
			"NeighborhoodStats", "NeighborhoodPrecincts", "AppMeta", "ModelRuns", "CellRiskScores", "AppUsers",
			"UserPreferences", "UserPlaces", "TripDetails" };
		try (Statement stmt = c.createStatement()) {
			for (String t : tables) {
				try (ResultSet rs = stmt.executeQuery("SELECT COUNT(*) FROM " + t)) {
					rs.next();
					System.out.println(String.format("  %-22s %,d", t, rs.getLong(1)));
				}
			}
		}
	}
}
