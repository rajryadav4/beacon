package crimeradar.tools;

import crimeradar.dal.ConnectionManager;
import crimeradar.util.Json;

import java.io.IOException;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.time.Duration;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Keeps CrimeIncidents fresh from the Seattle open data API (dataset tazs-3rd5).
 * Run it from the repository root (scripts/sync.ps1), twice a day if you like.
 *
 * Steps:
 *  1. Find the newest ReportedAt in CrimeIncidents. Fetch offenses reported since then minus
 *     21 days (reports arrive late), page by page.
 *  2. Clean each row with the same rules as sql/crime_radar_all.sql (dates, lat/lng ranges,
 *     '-' and blanks become UNKNOWN, duplicates by report + offense keep the latest).
 *  3. Insert only new rows (UNIQUE SourceId + SourceOffenseId). Missing precincts,
 *     neighborhoods and categories are created. A new category gets a crime group by the
 *     same rules as CategoryGroups (unknown -> other, excluded -> no group row).
 *  4. Delete incidents older than 4 years (the data window).
 *  5. Rebuild the summary tables (the REFRESH part of sql/app_tables.sql) in one transaction.
 *     That also changes AppMeta builtAt, so the running web app reloads within 30 seconds.
 *
 * Exit codes: 0 ok, 2 database error, 3 API error, 1 other error.
 * Option: --since yyyy-MM-dd (fetch from this report date instead of the newest minus 21 days).
 */
public class SyncIncidents {

	private static final String API = "https://data.seattle.gov/resource/tazs-3rd5.json";
	private static final String USER_AGENT = "seattle-open-data-sync/1.0";
	private static final int PAGE_SIZE = 20000;
	private static final int OVERLAP_DAYS = 21;
	private static final int YEARS = 4;
	private static final String[] FIELDS = { "report_number", "report_date_time", "offense_id",
		"offense_date", "nibrs_group_a_b", "nibrs_crime_against_category", "block_address",
		"latitude", "longitude", "beat", "precinct", "neighborhood",
		"nibrs_offense_code_description" };
	private static final Pattern NUMBER = Pattern.compile("^-?[0-9]+([.][0-9]+)?$");

	/** A failure talking to the API (exit code 3). */
	static class ApiFailure extends Exception {
		private static final long serialVersionUID = 1L;

		ApiFailure(String message, Throwable cause) {
			super(message, cause);
		}
	}

	/** One cleaned incident. */
	private static final class Row {
		String sourceOffenseId;
		String reportNumber;
		LocalDateTime occurred;
		LocalDateTime reported;
		String category;
		String nibrsGroup;
		String against;
		String precinct;
		String neighborhood;
		String block;
		BigDecimal lat;
		BigDecimal lng;
		String beat;
	}

	public static void main(String[] args) {
		LocalDate sinceOverride = null;
		for (int i = 0; i < args.length; i++) {
			if ("--since".equals(args[i]) && i + 1 < args.length) {
				sinceOverride = LocalDate.parse(args[++i]);
			}
		}
		try {
			run(sinceOverride);
		} catch (ApiFailure e) {
			System.err.println("API ERROR: " + e.getMessage());
			System.exit(3);
		} catch (SQLException e) {
			System.err.println("DATABASE ERROR " + e.getErrorCode() + " (" + e.getSQLState() + "): "
				+ e.getMessage());
			if ("28000".equals(e.getSQLState()) || e.getErrorCode() == 1045) {
				System.err.println("BLOCKED: MySQL refused the login. Check db.properties.");
			} else if (e.getErrorCode() == 1146) {
				System.err.println("Run scripts\\setup-db.ps1 first (a table is missing).");
			}
			System.exit(2);
		} catch (Exception e) {
			System.err.println("ERROR: " + e);
			System.exit(1);
		}
	}

	private static void run(LocalDate sinceOverride) throws Exception {
		Path root = findRoot();
		try (Connection c = new ConnectionManager().getConnection()) {
			int sourceId = sourceId(c);
			LocalDate cutoff = LocalDate.now().minusYears(YEARS);

			// 1. where to start
			LocalDateTime newestReported = maxTime(c, "ReportedAt");
			LocalDateTime newestOccurred = maxTime(c, "OccurredAt");
			LocalDateTime since;
			if (sinceOverride != null) {
				since = sinceOverride.atStartOfDay();
			} else if (newestReported != null) {
				since = newestReported.minusDays(OVERLAP_DAYS);
			} else if (newestOccurred != null) {
				since = newestOccurred.minusDays(OVERLAP_DAYS);
			} else {
				since = cutoff.atStartOfDay();
			}
			System.out.println("Newest in database: reported " + newestReported + ", occurred "
				+ newestOccurred);
			System.out.println("Fetching offenses reported since " + since + " ...");

			// 2. fetch and clean
			HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(30))
				.followRedirects(HttpClient.Redirect.NORMAL).build();
			Map<String, Row> rows = new LinkedHashMap<String, Row>();
			long fetched = 0;
			long dropped = 0;
			for (int offset = 0;; offset += PAGE_SIZE) {
				List<?> page = fetchPage(http, since, offset);
				fetched += page.size();
				for (Object o : page) {
					Row r = clean(o);
					if (r == null || r.occurred.toLocalDate().isBefore(cutoff)) {
						dropped++;
						continue;
					}
					Row old = rows.get(r.sourceOffenseId);
					if (old == null || r.occurred.isAfter(old.occurred)) {
						rows.put(r.sourceOffenseId, r);
					}
				}
				System.out.println("  fetched " + fetched + " rows");
				if (page.size() < PAGE_SIZE) {
					break;
				}
			}

			// 3. insert the new ones
			long before = countIncidents(c);
			insertRows(c, root, sourceId, rows.values());
			long inserted = countIncidents(c) - before;

			// 4. keep the 4-year window
			long removed = removeOld(c, cutoff.atStartOfDay());

			// 5. rebuild the summary tables
			refreshSummary(c, root);

			System.out.println();
			System.out.println("Fetched from API:      " + fetched
				+ " (skipped " + dropped + " old or invalid)");
			System.out.println("Inserted (new):        " + inserted);
			System.out.println("Removed (older than " + YEARS + " years): " + removed);
			printTotals(c);
		}
	}

	// ------------------------------------------------------------------ API

	private static List<?> fetchPage(HttpClient http, LocalDateTime since, int offset)
			throws ApiFailure {
		StringBuilder select = new StringBuilder();
		for (String f : FIELDS) {
			select.append(select.length() == 0 ? "" : ",").append(f);
		}
		String url = API + "?" + param("$select", select.toString())
			+ "&" + param("$where", "report_date_time >= '" + since.withNano(0) + "'")
			+ "&" + param("$order", ":id")
			+ "&" + param("$limit", Integer.toString(PAGE_SIZE))
			+ "&" + param("$offset", Integer.toString(offset));
		HttpRequest request = HttpRequest.newBuilder(URI.create(url))
			.header("User-Agent", USER_AGENT).header("Accept", "application/json")
			.timeout(Duration.ofSeconds(180)).GET().build();
		Exception last = null;
		for (int attempt = 1; attempt <= 4; attempt++) {
			try {
				HttpResponse<String> response = http.send(request,
					HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
				if (response.statusCode() == 200) {
					Object parsed = Json.parse(response.body());
					if (parsed instanceof List) {
						return (List<?>) parsed;
					}
					throw new IOException("Unexpected JSON from the API");
				}
				last = new IOException("HTTP " + response.statusCode());
			} catch (IOException | RuntimeException e) {
				last = e;
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
				throw new ApiFailure("Interrupted", e);
			}
			System.err.println("  request failed (" + last.getMessage() + "), attempt " + attempt);
			try {
				Thread.sleep(5000L * attempt);
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
				throw new ApiFailure("Interrupted", e);
			}
		}
		throw new ApiFailure("Could not read " + API + " (" + last + ")", last);
	}

	private static String param(String name, String value) {
		return URLEncoder.encode(name, StandardCharsets.UTF_8) + "="
			+ URLEncoder.encode(value, StandardCharsets.UTF_8);
	}

	// ------------------------------------------------------------------ cleaning

	/** Same rules as the staging and "sel" steps of sql/crime_radar_all.sql. */
	private static Row clean(Object o) {
		if (!(o instanceof Map)) {
			return null;
		}
		Map<?, ?> m = (Map<?, ?>) o;
		String rpt = blank(text(m, "report_number"));
		String oid = blank(text(m, "offense_id"));
		LocalDateTime occ = time(text(m, "offense_date"));
		if (rpt == null || oid == null || occ == null) {
			return null;
		}
		Row r = new Row();
		r.reportNumber = rpt;
		r.sourceOffenseId = rpt + "-" + oid;
		r.occurred = occ;
		r.reported = time(text(m, "report_date_time"));
		r.category = left(orUnknown(text(m, "nibrs_offense_code_description")), 150);
		r.nibrsGroup = left(orUnknown(text(m, "nibrs_group_a_b")), 50);
		r.against = left(orUnknown(text(m, "nibrs_crime_against_category")), 100);
		r.precinct = left(orUnknown(text(m, "precinct")), 100);
		r.neighborhood = left(orUnknown(text(m, "neighborhood")), 150);
		String block = blank(text(m, "block_address"));
		r.block = block == null ? null : left(block, 255);
		r.lat = coordinate(text(m, "latitude"), 47, 48);
		r.lng = coordinate(text(m, "longitude"), -123, -122);
		String beat = blank(text(m, "beat"));
		r.beat = beat == null ? null : left(beat, 50);
		return r;
	}

	private static String text(Map<?, ?> m, String key) {
		Object v = m.get(key);
		return v == null ? null : v.toString();
	}

	/** TRIM, then '-' and empty become null. */
	private static String blank(String s) {
		if (s == null) {
			return null;
		}
		s = s.trim();
		return s.isEmpty() || s.equals("-") ? null : s;
	}

	private static String orUnknown(String s) {
		String v = blank(s);
		return v == null ? "UNKNOWN" : v;
	}

	private static String left(String s, int n) {
		return s.length() > n ? s.substring(0, n) : s;
	}

	private static LocalDateTime time(String s) {
		if (s == null || s.trim().isEmpty()) {
			return null;
		}
		try {
			return LocalDateTime.parse(s.trim()).withNano(0);
		} catch (RuntimeException e) {
			return null;
		}
	}

	private static BigDecimal coordinate(String s, int min, int max) {
		if (s == null || !NUMBER.matcher(s.trim()).matches()) {
			return null;
		}
		BigDecimal v = new BigDecimal(s.trim()).setScale(7, RoundingMode.HALF_UP);
		return v.compareTo(BigDecimal.valueOf(min)) >= 0 && v.compareTo(BigDecimal.valueOf(max)) <= 0
			? v : null;
	}

	// ------------------------------------------------------------------ database

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

	private static int sourceId(Connection c) throws SQLException {
		try (Statement s = c.createStatement();
				ResultSet rs = s.executeQuery(
					"SELECT SourceId FROM DataSources WHERE DatasetIdentifier='tazs-3rd5'")) {
			if (!rs.next()) {
				throw new SQLException("DataSources has no row for tazs-3rd5. "
					+ "Run sql/crime_radar_all.sql first.");
			}
			return rs.getInt(1);
		}
	}

	private static LocalDateTime maxTime(Connection c, String column) throws SQLException {
		try (Statement s = c.createStatement();
				ResultSet rs = s.executeQuery("SELECT MAX(" + column + ") FROM CrimeIncidents")) {
			rs.next();
			return rs.getObject(1, LocalDateTime.class);
		}
	}

	private static long countIncidents(Connection c) throws SQLException {
		try (Statement s = c.createStatement();
				ResultSet rs = s.executeQuery("SELECT COUNT(*) FROM CrimeIncidents")) {
			rs.next();
			return rs.getLong(1);
		}
	}

	private static String key(String... parts) {
		return String.join("\u0001", parts).toLowerCase();
	}

	private static void insertRows(Connection c, Path root, int sourceId, Iterable<Row> rows)
			throws Exception {
		boolean oldAuto = c.getAutoCommit();
		c.setAutoCommit(false);
		try {
			Map<String, Integer> precincts = loadMap(c, "SELECT PrecinctName,PrecinctId FROM PolicePrecincts");
			Map<String, Integer> nbs = loadMap(c, "SELECT NeighborhoodName,NeighborhoodId FROM Neighborhoods");
			Map<String, Integer> cats = loadMap(c,
				"SELECT CONCAT_WS(CHAR(1),CategoryName,COALESCE(NIBRSGroup,''),COALESCE(CrimeAgainstCategory,'')),"
					+ "CategoryId FROM CrimeCategories");
			GroupRules rules = new GroupRules(c, root);
			int newPrecincts = 0;
			int newNbs = 0;
			int newCats = 0;

			try (PreparedStatement insPrecinct = c.prepareStatement(
						"INSERT INTO PolicePrecincts(PrecinctName) VALUES(?)", Statement.RETURN_GENERATED_KEYS);
					PreparedStatement insNb = c.prepareStatement(
						"INSERT INTO Neighborhoods(NeighborhoodName,PrecinctId) VALUES(?,?)",
						Statement.RETURN_GENERATED_KEYS);
					PreparedStatement insCat = c.prepareStatement(
						"INSERT INTO CrimeCategories(CategoryName,NIBRSGroup,CrimeAgainstCategory) VALUES(?,?,?)",
						Statement.RETURN_GENERATED_KEYS);
					PreparedStatement insGroup = c.prepareStatement(
						"INSERT INTO CategoryGroups(CategoryId,GroupId) VALUES(?,?)");
					PreparedStatement ins = c.prepareStatement(
						"INSERT IGNORE INTO CrimeIncidents(SourceId,SourceOffenseId,ReportNumber,OccurredAt,"
							+ "ReportedAt,CategoryId,NeighborhoodId,PrecinctId,BlockAddress,Latitude,Longitude,Beat) "
							+ "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")) {
				int pending = 0;
				for (Row r : rows) {
					Integer precinctId = precincts.get(key(r.precinct));
					if (precinctId == null) {
						insPrecinct.setString(1, r.precinct);
						insPrecinct.executeUpdate();
						precinctId = generatedId(insPrecinct);
						precincts.put(key(r.precinct), precinctId);
						newPrecincts++;
					}
					Integer nbId = nbs.get(key(r.neighborhood));
					if (nbId == null) {
						insNb.setString(1, r.neighborhood);
						insNb.setInt(2, precinctId);
						insNb.executeUpdate();
						nbId = generatedId(insNb);
						nbs.put(key(r.neighborhood), nbId);
						newNbs++;
					}
					String ck = key(r.category, r.nibrsGroup, r.against);
					Integer catId = cats.get(ck);
					if (catId == null) {
						insCat.setString(1, r.category);
						insCat.setString(2, r.nibrsGroup);
						insCat.setString(3, r.against);
						insCat.executeUpdate();
						catId = generatedId(insCat);
						cats.put(ck, catId);
						newCats++;
						Integer groupId = rules.groupFor(r.category); // null = excluded
						if (groupId != null) {
							insGroup.setInt(1, catId);
							insGroup.setInt(2, groupId);
							insGroup.executeUpdate();
						}
					}
					ins.setInt(1, sourceId);
					ins.setString(2, r.sourceOffenseId);
					ins.setString(3, r.reportNumber);
					ins.setObject(4, r.occurred);
					if (r.reported == null) {
						ins.setNull(5, Types.TIMESTAMP);
					} else {
						ins.setObject(5, r.reported);
					}
					ins.setInt(6, catId);
					ins.setInt(7, nbId);
					ins.setInt(8, precinctId);
					ins.setString(9, r.block);
					ins.setBigDecimal(10, r.lat);
					ins.setBigDecimal(11, r.lng);
					ins.setString(12, r.beat);
					ins.addBatch();
					if (++pending % 2000 == 0) {
						ins.executeBatch();
					}
				}
				ins.executeBatch();
			}
			c.commit();
			if (newPrecincts + newNbs + newCats > 0) {
				System.out.println("Created lookups: " + newPrecincts + " precincts, " + newNbs
					+ " neighborhoods, " + newCats + " categories.");
			}
		} catch (Exception e) {
			c.rollback();
			throw e;
		} finally {
			c.setAutoCommit(oldAuto);
		}
	}

	private static int generatedId(PreparedStatement st) throws SQLException {
		try (ResultSet rs = st.getGeneratedKeys()) {
			rs.next();
			return rs.getInt(1);
		}
	}

	private static Map<String, Integer> loadMap(Connection c, String sql) throws SQLException {
		Map<String, Integer> map = new HashMap<String, Integer>();
		try (Statement s = c.createStatement(); ResultSet rs = s.executeQuery(sql)) {
			while (rs.next()) {
				// category keys use CHAR(1) as the separator; the others have one part
				map.put(rs.getString(1).toLowerCase(), rs.getInt(2));
			}
		}
		return map;
	}

	/** Deletes incidents older than the cutoff in chunks. Returns how many were removed. */
	private static long removeOld(Connection c, LocalDateTime cutoff) throws SQLException {
		long total = 0;
		try (PreparedStatement p = c.prepareStatement(
				"DELETE FROM CrimeIncidents WHERE OccurredAt < ? LIMIT 20000")) {
			p.setObject(1, cutoff);
			int n;
			do {
				n = p.executeUpdate();
				total += n;
			} while (n > 0);
		}
		return total;
	}

	/** Runs the REFRESH part of sql/app_tables.sql in one transaction. */
	private static void refreshSummary(Connection c, Path root) throws Exception {
		String script = new String(Files.readAllBytes(root.resolve("sql").resolve("app_tables.sql")),
			StandardCharsets.UTF_8);
		int a = script.indexOf("@@REFRESH-BEGIN");
		int b = script.indexOf("@@REFRESH-END");
		if (a < 0 || b < a) {
			throw new IllegalStateException("sql/app_tables.sql has no REFRESH section.");
		}
		a = script.indexOf('\n', a); // skip the rest of the marker comment line
		List<String> statements = SqlScript.split(script.substring(a, b));
		System.out.println("Rebuilding summary tables (" + statements.size() + " statements) ...");
		boolean oldAuto = c.getAutoCommit();
		c.setAutoCommit(false);
		try (Statement s = c.createStatement()) {
			for (String sql : statements) {
				s.execute(sql);
			}
			c.commit();
		} catch (SQLException e) {
			c.rollback();
			throw e;
		} finally {
			c.setAutoCommit(oldAuto);
		}
	}

	private static void printTotals(Connection c) throws SQLException {
		System.out.println("New totals:");
		try (Statement s = c.createStatement()) {
			try (ResultSet rs = s.executeQuery("SELECT COUNT(*) FROM CrimeIncidents")) {
				rs.next();
				System.out.println("  CrimeIncidents rows:   " + rs.getLong(1));
			}
			try (ResultSet rs = s.executeQuery(
					"SELECT MetaKey,MetaValue FROM AppMeta WHERE MetaKey IN "
						+ "('incidents','located','excluded','unknownTime','dataFrom','dataTo','builtAt') "
						+ "ORDER BY MetaKey")) {
				while (rs.next()) {
					System.out.println("  meta." + rs.getString(1) + " = " + rs.getString(2));
				}
			}
		}
	}

	// ------------------------------------------------------------------ crime groups

	/**
	 * Group for a new category, with the same rules as CategoryGroups:
	 * 1. a category with the same description already has a group (or none = excluded);
	 * 2. else the rule in pipeline/category_groups.csv ('exclude' = excluded);
	 * 3. else 'other'.
	 */
	private static final class GroupRules {
		private final Map<String, Integer> byName = new HashMap<String, Integer>();
		private final Set<String> excludedNames = new HashSet<String>();
		private final Map<String, Integer> groupIds = new HashMap<String, Integer>();
		private final Map<String, String> csv = new HashMap<String, String>();

		GroupRules(Connection c, Path root) throws SQLException, IOException {
			try (Statement s = c.createStatement()) {
				try (ResultSet rs = s.executeQuery("SELECT GroupKey,GroupId FROM CrimeGroups")) {
					while (rs.next()) {
						groupIds.put(rs.getString(1), rs.getInt(2));
					}
				}
				try (ResultSet rs = s.executeQuery("SELECT c.CategoryName,g.GroupId FROM CrimeCategories c "
						+ "LEFT JOIN CategoryGroups g ON g.CategoryId=c.CategoryId")) {
					while (rs.next()) {
						String name = rs.getString(1).toLowerCase();
						int g = rs.getInt(2);
						if (rs.wasNull()) {
							if (!byName.containsKey(name)) {
								excludedNames.add(name);
							}
						} else {
							byName.put(name, g);
							excludedNames.remove(name);
						}
					}
				}
			}
			Path file = root.resolve("pipeline").resolve("category_groups.csv");
			if (Files.exists(file)) {
				List<String> lines = Files.readAllLines(file, StandardCharsets.UTF_8);
				for (int i = 1; i < lines.size(); i++) {
					List<String> f = splitCsv(lines.get(i));
					if (f.size() >= 2) {
						csv.put(f.get(0).trim().toLowerCase(), f.get(1).trim());
					}
				}
			}
		}

		/** The GroupId, or null when the offense is excluded. */
		Integer groupFor(String description) {
			String name = description.toLowerCase();
			if (byName.containsKey(name)) {
				return byName.get(name);
			}
			if (excludedNames.contains(name)) {
				return null;
			}
			String rule = csv.get(name);
			if ("exclude".equals(rule)) {
				return null;
			}
			Integer id = rule == null ? null : groupIds.get(rule);
			return id != null ? id : groupIds.get("other");
		}

		private static List<String> splitCsv(String line) {
			List<String> out = new ArrayList<String>();
			StringBuilder cur = new StringBuilder();
			boolean quoted = false;
			for (int i = 0; i < line.length(); i++) {
				char ch = line.charAt(i);
				if (quoted) {
					if (ch == '"' && i + 1 < line.length() && line.charAt(i + 1) == '"') {
						cur.append('"');
						i++;
					} else if (ch == '"') {
						quoted = false;
					} else {
						cur.append(ch);
					}
				} else if (ch == '"') {
					quoted = true;
				} else if (ch == ',') {
					out.add(cur.toString());
					cur.setLength(0);
				} else {
					cur.append(ch);
				}
			}
			out.add(cur.toString());
			return out;
		}
	}
}
