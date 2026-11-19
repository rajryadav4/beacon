package crimeradar.tools;

import java.util.ArrayList;
import java.util.List;

/** Splits a .sql script into statements on ';' (no DELIMITER support, none is needed). */
final class SqlScript {

	private SqlScript() {
	}

	/**
	 * Skips "-- line" comments and block comments. Keeps ';' inside quotes.
	 * Returns the statements without the final ';' and without blank ones.
	 */
	static List<String> split(String script) {
		List<String> statements = new ArrayList<String>();
		StringBuilder cur = new StringBuilder();
		int n = script.length();
		char quote = 0;
		for (int i = 0; i < n; i++) {
			char c = script.charAt(i);
			if (quote != 0) {
				cur.append(c);
				if (c == '\\' && i + 1 < n) {
					cur.append(script.charAt(++i));
				} else if (c == quote) {
					if (i + 1 < n && script.charAt(i + 1) == quote) {
						cur.append(script.charAt(++i)); // doubled quote
					} else {
						quote = 0;
					}
				}
				continue;
			}
			if (c == '-' && i + 1 < n && script.charAt(i + 1) == '-'
					&& (i + 2 >= n || Character.isWhitespace(script.charAt(i + 2)))) {
				while (i < n && script.charAt(i) != '\n') {
					i++;
				}
				cur.append('\n');
				continue;
			}
			if (c == '/' && i + 1 < n && script.charAt(i + 1) == '*') {
				int end = script.indexOf("*/", i + 2);
				i = end < 0 ? n : end + 1;
				cur.append(' ');
				continue;
			}
			if (c == '\'' || c == '"' || c == '`') {
				quote = c;
				cur.append(c);
				continue;
			}
			if (c == ';') {
				add(statements, cur);
				cur.setLength(0);
				continue;
			}
			cur.append(c);
		}
		add(statements, cur);
		return statements;
	}

	private static void add(List<String> list, StringBuilder cur) {
		String s = cur.toString().trim();
		if (!s.isEmpty()) {
			list.add(s);
		}
	}
}
