package crimeradar.service;

import crimeradar.dal.MapDataDao;
import crimeradar.dal.MapDataDao.ModelRun;
import crimeradar.dal.MapDataDao.NeighborhoodRow;
import crimeradar.util.Json;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.SQLException;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.zip.GZIPOutputStream;

/**
 * Builds api/meta, api/grid and api/neighborhoods once from the summary tables and keeps the
 * bytes in memory (plain and gzip). Every request after the first costs no database work,
 * except one cheap signature query at most every 30 seconds, which rebuilds the cache when
 * the tables or the model changed.
 */
public final class MapDataCache {

	private static final long CHECK_EVERY_MILLIS = 30000L;

	/** One cached response body. */
	public static final class Entry {
		public final byte[] plain;
		public final byte[] gzip;
		public final String etag;

		Entry(String json) {
			this.plain = json.getBytes(StandardCharsets.UTF_8);
			this.gzip = gzip(plain);
			this.etag = "\"" + sha1(plain) + "\"";
		}
	}

	private static final class Snapshot {
		final String signature;
		final Map<String, Entry> entries = new HashMap<String, Entry>();

		Snapshot(String signature) {
			this.signature = signature;
		}
	}

	private static final MapDataCache INSTANCE = new MapDataCache();

	public static MapDataCache getInstance() {
		return INSTANCE;
	}

	private volatile Snapshot snapshot;
	private volatile long checkedAt;

	private MapDataCache() {
	}

	/** name is "meta", "grid" or "neighborhoods". Throws SQLException if never built. */
	public Entry get(String name) throws SQLException {
		Snapshot s = snapshot;
		long now = System.currentTimeMillis();
		if (s == null || now - checkedAt > CHECK_EVERY_MILLIS) {
			s = refreshIfNeeded(now);
		}
		return s.entries.get(name);
	}

	/** Drops the cache so the next request rebuilds it. */
	public synchronized void invalidate() {
		snapshot = null;
	}

	private synchronized Snapshot refreshIfNeeded(long now) throws SQLException {
		Snapshot s = snapshot;
		if (s != null && now - checkedAt <= CHECK_EVERY_MILLIS) {
			return s; // another thread just did it
		}
		try {
			String signature = MapDataDao.getInstance().signature();
			if (s == null || !signature.equals(s.signature)) {
				s = build(signature);
				snapshot = s;
			}
			checkedAt = now;
			return s;
		} catch (SQLException e) {
			if (s != null) {
				checkedAt = now; // keep serving the old copy; try again later
				return s;
			}
			throw e;
		}
	}

	// ------------------------------------------------------------------ build

	private Snapshot build(String signature) throws SQLException {
		MapDataDao dao = MapDataDao.getInstance();
		Map<String, String> meta = dao.loadMeta();
		if (meta.isEmpty()) {
			throw new SQLException("Summary tables are empty. Run scripts/setup-db.ps1.");
		}

		// ---- neighborhoods (sorted by display name; the grid points into this list)
		List<NeighborhoodRow> nbs = dao.loadNeighborhoods();
		final Map<Integer, String> names = new HashMap<Integer, String>();
		for (NeighborhoodRow n : nbs) {
			names.put(n.id, displayName(n.name));
		}
		nbs.sort(new Comparator<NeighborhoodRow>() {
			@Override
			public int compare(NeighborhoodRow a, NeighborhoodRow b) {
				int c = names.get(a.id).toLowerCase().compareTo(names.get(b.id).toLowerCase());
				return c != 0 ? c : Integer.compare(a.id, b.id);
			}
		});
		Map<Integer, Integer> nbIndex = new HashMap<Integer, Integer>();
		for (int i = 0; i < nbs.size(); i++) {
			nbIndex.put(nbs.get(i).id, i);
		}
		Map<Integer, Integer> cellCounts = dao.loadCellCountsByNeighborhood();

		StringBuilder nbJson = new StringBuilder(64 * 1024);
		nbJson.append("{\"version\":1,\"neighborhoods\":[");
		for (int i = 0; i < nbs.size(); i++) {
			NeighborhoodRow n = nbs.get(i);
			if (i > 0) {
				nbJson.append(',');
			}
			int cells = cellCounts.containsKey(n.id) ? cellCounts.get(n.id) : 0;
			nbJson.append("{\"key\":");
			Json.quote(nbJson, n.name);
			nbJson.append(",\"name\":");
			Json.quote(nbJson, names.get(n.id));
			nbJson.append(",\"precinct\":");
			Json.quote(nbJson, n.precinct == null ? "" : n.precinct);
			nbJson.append(",\"lat\":");
			if (n.located > 0) {
				Json.number(nbJson, n.sumLat / n.located, 5);
			} else {
				nbJson.append("null");
			}
			nbJson.append(",\"lng\":");
			if (n.located > 0) {
				Json.number(nbJson, n.sumLng / n.located, 5);
			} else {
				nbJson.append("null");
			}
			nbJson.append(",\"cells\":").append(cells);
			nbJson.append(",\"areaKm2\":");
			Json.number(nbJson, cells * 0.0501, 2);
			nbJson.append(",\"counts\":");
			Json.write(nbJson, n.counts);
			nbJson.append(",\"unlocated\":").append(n.total - n.located);
			nbJson.append('}');
		}
		nbJson.append("]}");

		// ---- grid
		Map<Integer, Integer> cellNb = dao.loadCellNeighborhoods();
		ModelRun model = dao.loadActiveModel();
		TreeMap<Integer, int[]> counts = new TreeMap<Integer, int[]>();
		for (int[] r : dao.loadCellStats()) {
			int[] c = counts.get(r[0]);
			if (c == null) {
				c = new int[32];
				counts.put(r[0], c);
			}
			c[r[1] * 8 + r[2]] = r[3];
		}
		Map<Integer, double[]> risks = new HashMap<Integer, double[]>();
		if (model != null) {
			for (double[] r : dao.loadRisk(model.version)) {
				int cell = (int) r[0];
				double[] a = risks.get(cell);
				if (a == null) {
					a = new double[4];
					risks.put(cell, a);
				}
				a[(int) r[1]] = r[2];
				if (r[2] > 0 && !counts.containsKey(cell)) {
					counts.put(cell, new int[32]);
				}
			}
		}
		StringBuilder gridJson = new StringBuilder(4 * 1024 * 1024);
		gridJson.append("{\"version\":1,\"cells\":[");
		List<Double> allRisks = new ArrayList<Double>();
		boolean first = true;
		for (Map.Entry<Integer, int[]> e : counts.entrySet()) {
			int cell = e.getKey();
			int[] c = e.getValue();
			double[] risk = risks.get(cell);
			boolean any = false;
			for (int v : c) {
				if (v > 0) {
					any = true;
					break;
				}
			}
			if (!any && (risk == null || !hasPositive(risk))) {
				continue;
			}
			if (risk == null) {
				risk = new double[4];
			}
			Integer nbId = cellNb.get(cell);
			Integer idx = nbId == null ? null : nbIndex.get(nbId);
			if (!first) {
				gridJson.append(',');
			}
			first = false;
			gridJson.append('[').append(cell).append(',').append(idx == null ? -1 : idx).append(',');
			Json.write(gridJson, c);
			gridJson.append(",[");
			for (int b = 0; b < 4; b++) {
				if (b > 0) {
					gridJson.append(',');
				}
				Json.number(gridJson, risk[b], 2);
				allRisks.add(risk[b]);
			}
			gridJson.append("]]");
		}
		gridJson.append("]}");

		// ---- meta
		double[] q = quantiles(allRisks, 0.50, 0.75, 0.90, 0.97, 0.99);
		double[] fromModel = modelQuantiles(model);
		if (fromModel != null) {
			q = fromModel;
		}
		StringBuilder metaJson = new StringBuilder(4096);
		metaJson.append("{\"version\":1,\"generatedAt\":");
		Json.quote(metaJson, meta.getOrDefault("builtAt", ""));
		String[] src = dao.loadSource();
		metaJson.append(",\"source\":");
		Json.write(metaJson, map("name", src[0], "id", src[1], "url", src[2]));

		String from = meta.getOrDefault("dataFrom", "");
		String to = meta.getOrDefault("dataTo", "");
		double years = 0;
		try {
			years = ChronoUnit.DAYS.between(LocalDate.parse(from), LocalDate.parse(to)) / 365.25;
		} catch (RuntimeException ex) {
			// leave 0 when the dates are missing
		}
		metaJson.append(",\"dataRange\":{\"from\":");
		Json.quote(metaJson, from);
		metaJson.append(",\"to\":");
		Json.quote(metaJson, to);
		metaJson.append(",\"years\":");
		Json.number(metaJson, years, 2);
		metaJson.append("},\"totals\":");
		Json.write(metaJson, map("incidents", asLong(meta.get("incidents")),
			"located", asLong(meta.get("located")), "excluded", asLong(meta.get("excluded")),
			"unknownTime", asLong(meta.get("unknownTime"))));
		metaJson.append(",\"grid\":{\"lat0\":47.48,\"lng0\":-122.46,\"dLat\":0.002,"
			+ "\"dLng\":0.003,\"rows\":135,\"cols\":80}");

		List<Object> bands = new ArrayList<Object>();
		for (Object[] r : dao.loadBands()) {
			bands.add(map("id", r[0], "key", r[1], "label", r[2], "hours", r[3]));
		}
		List<Object> groups = new ArrayList<Object>();
		for (Object[] r : dao.loadGroups()) {
			groups.add(map("id", r[0], "key", r[1], "label", r[2],
				"severity", ((Number) r[3]).doubleValue()));
		}
		Map<String, Object> modes = new LinkedHashMap<String, Object>();
		for (Object[] r : dao.loadModes()) {
			modes.put((String) r[0], map("label", r[1],
				"vulnerability", ((Number) r[2]).doubleValue()));
		}
		metaJson.append(",\"bands\":");
		Json.write(metaJson, bands);
		metaJson.append(",\"groups\":");
		Json.write(metaJson, groups);
		metaJson.append(",\"modes\":");
		Json.write(metaJson, modes);

		metaJson.append(",\"risk\":{\"unit\":");
		Json.quote(metaJson, "expected severity-weighted incidents per year in the cell during the band");
		metaJson.append(",\"quantiles\":{");
		String[] qNames = { "q50", "q75", "q90", "q97", "q99" };
		for (int i = 0; i < qNames.length; i++) {
			if (i > 0) {
				metaJson.append(',');
			}
			metaJson.append('"').append(qNames[i]).append("\":");
			Json.number(metaJson, q[i], 3);
		}
		metaJson.append("},\"levels\":{\"elevated\":");
		Json.number(metaJson, q[2], 3); // ELEVATED >= q90
		metaJson.append(",\"high\":");
		Json.number(metaJson, q[3], 3); // HIGH >= q97
		metaJson.append("}},\"model\":");
		metaJson.append(modelJson(model));
		metaJson.append('}');

		Snapshot s = new Snapshot(signature);
		s.entries.put("meta", new Entry(metaJson.toString()));
		s.entries.put("grid", new Entry(gridJson.toString()));
		s.entries.put("neighborhoods", new Entry(nbJson.toString()));
		return s;
	}

	/** meta.model: version, algorithm, trainedOn, metrics, baseline (null when no model). */
	@SuppressWarnings("unchecked")
	private static String modelJson(ModelRun model) {
		if (model == null) {
			return "null";
		}
		Map<String, Object> out = new LinkedHashMap<String, Object>();
		out.put("version", model.version);
		out.put("algorithm", model.algorithm);
		Object metrics = null;
		Object baseline = null;
		String trainedOn = "";
		if (model.metricsJson != null) {
			try {
				Object parsed = Json.parse(model.metricsJson);
				if (parsed instanceof Map) {
					Map<String, Object> m = (Map<String, Object>) parsed;
					Object mm = m.get("metaModel"); // written by ml/train_risk_model.py
					Map<String, Object> src = mm instanceof Map ? (Map<String, Object>) mm : m;
					metrics = src.containsKey("metrics") ? src.get("metrics") : src;
					baseline = src.get("baseline");
					if (src.get("trainedOn") instanceof String) {
						trainedOn = (String) src.get("trainedOn");
					}
				}
			} catch (RuntimeException e) {
				// bad JSON in the table: serve the model without metrics
			}
		}
		out.put("trainedOn", trainedOn);
		out.put("metrics", metrics);
		out.put("baseline", baseline);
		return Json.write(out);
	}

	// ------------------------------------------------------------------ helpers

	/** q50, q75, q90, q97, q99 from metrics.json (written by the ML script), or null. */
	@SuppressWarnings("unchecked")
	private static double[] modelQuantiles(ModelRun model) {
		if (model == null || model.metricsJson == null) {
			return null;
		}
		try {
			Object parsed = Json.parse(model.metricsJson);
			if (!(parsed instanceof Map)) {
				return null;
			}
			Object qs = ((Map<String, Object>) parsed).get("quantiles");
			if (!(qs instanceof Map)) {
				return null;
			}
			String[] keys = { "q50", "q75", "q90", "q97", "q99" };
			double[] out = new double[keys.length];
			for (int i = 0; i < keys.length; i++) {
				Object v = ((Map<String, Object>) qs).get(keys[i]);
				if (!(v instanceof Number)) {
					return null;
				}
				out[i] = ((Number) v).doubleValue();
			}
			return out;
		} catch (RuntimeException e) {
			return null;
		}
	}


	private static boolean hasPositive(double[] a) {
		for (double d : a) {
			if (d > 0) {
				return true;
			}
		}
		return false;
	}

	/** Linear-interpolation quantiles (same method as numpy's default). */
	static double[] quantiles(List<Double> values, double... qs) {
		double[] out = new double[qs.length];
		if (values.isEmpty()) {
			return out;
		}
		double[] a = new double[values.size()];
		for (int i = 0; i < a.length; i++) {
			a[i] = values.get(i);
		}
		Arrays.sort(a);
		for (int i = 0; i < qs.length; i++) {
			double pos = qs[i] * (a.length - 1);
			int lo = (int) Math.floor(pos);
			int hi = (int) Math.ceil(pos);
			out[i] = a[lo] + (a[hi] - a[lo]) * (pos - lo);
		}
		return out;
	}

	private static final Map<String, String> NAME_FIXES = new HashMap<String, String>();
	static {
		// Same fixes as pipeline/crime_data.py NAME_FIXES, so the API matches the static JSON.
		String[][] fixes = {
			{ "SLU/CASCADE", "South Lake Union / Cascade" }, { "LAKECITY", "Lake City" },
			{ "BITTERLAKE", "Bitter Lake" }, { "SANDPOINT", "Sand Point" },
			{ "DOWNTOWN COMMERCIAL", "Downtown" },
			{ "CHINATOWN/INTERNATIONAL DISTRICT", "Chinatown-International District" },
			{ "UNIVERSITY", "University District" }, { "SODO", "SODO" },
			{ "COMMERCIAL DUWAMISH", "Duwamish (Industrial)" },
			{ "COMMERCIAL HARBOR ISLAND", "Harbor Island" },
			{ "FAUNTLEROY SW", "Fauntleroy" }, { "NEW HOLLY", "NewHolly" },
			{ "EASTLAKE - EAST", "Eastlake East" }, { "EASTLAKE - WEST", "Eastlake West" },
			{ "MORGAN", "Morgan Junction" } };
		for (String[] f : fixes) {
			NAME_FIXES.put(f[0], f[1]);
		}
	}

	/** SPD key to display name: ROOSEVELT/RAVENNA becomes Roosevelt / Ravenna. */
	static String displayName(String key) {
		String fixed = NAME_FIXES.get(key);
		if (fixed != null) {
			return fixed;
		}
		String[] parts = key.split("/", -1);
		StringBuilder sb = new StringBuilder();
		for (int i = 0; i < parts.length; i++) {
			if (i > 0) {
				sb.append(" / ");
			}
			sb.append(titleCase(parts[i].trim()));
		}
		return sb.toString();
	}

	/** Same as Python's str.title(): CAPITOL HILL becomes Capitol Hill. */
	static String titleCase(String s) {
		StringBuilder sb = new StringBuilder(s.length());
		boolean prevLetter = false;
		for (int i = 0; i < s.length(); i++) {
			char c = s.charAt(i);
			if (Character.isLetter(c)) {
				sb.append(prevLetter ? Character.toLowerCase(c) : Character.toUpperCase(c));
				prevLetter = true;
			} else {
				sb.append(c);
				prevLetter = false;
			}
		}
		return sb.toString();
	}

	private static long asLong(String s) {
		try {
			return s == null ? 0 : Long.parseLong(s);
		} catch (NumberFormatException e) {
			return 0;
		}
	}

	private static Map<String, Object> map(Object... kv) {
		Map<String, Object> m = new LinkedHashMap<String, Object>();
		for (int i = 0; i < kv.length; i += 2) {
			m.put((String) kv[i], kv[i + 1]);
		}
		return m;
	}

	private static byte[] gzip(byte[] data) {
		try {
			ByteArrayOutputStream bos = new ByteArrayOutputStream(data.length / 4 + 64);
			GZIPOutputStream gz = new GZIPOutputStream(bos);
			gz.write(data);
			gz.close();
			return bos.toByteArray();
		} catch (IOException e) {
			throw new IllegalStateException(e);
		}
	}

	private static String sha1(byte[] data) {
		try {
			byte[] d = MessageDigest.getInstance("SHA-1").digest(data);
			StringBuilder sb = new StringBuilder();
			for (int i = 0; i < 10; i++) {
				sb.append(String.format("%02x", d[i]));
			}
			return sb.toString();
		} catch (NoSuchAlgorithmException e) {
			throw new IllegalStateException(e);
		}
	}
}
