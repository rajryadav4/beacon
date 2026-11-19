package crimeradar.util;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Tiny JSON writer and parser (the project has no JSON library).
 *
 * write() accepts Map, List, Object[], int[], double[], String, Number, Boolean and null.
 * parse() returns LinkedHashMap, ArrayList, String, BigDecimal, Boolean or null.
 */
public final class Json {

	private Json() {
	}

	// ---------------------------------------------------------------- writer

	public static String write(Object value) {
		StringBuilder sb = new StringBuilder(256);
		write(sb, value);
		return sb.toString();
	}

	public static void write(StringBuilder sb, Object value) {
		if (value == null) {
			sb.append("null");
		} else if (value instanceof String) {
			quote(sb, (String) value);
		} else if (value instanceof Boolean) {
			sb.append(((Boolean) value).booleanValue() ? "true" : "false");
		} else if (value instanceof Double || value instanceof Float) {
			number(sb, ((Number) value).doubleValue());
		} else if (value instanceof BigDecimal) {
			sb.append(((BigDecimal) value).toPlainString());
		} else if (value instanceof Number) {
			sb.append(value.toString());
		} else if (value instanceof Map) {
			sb.append('{');
			boolean first = true;
			for (Map.Entry<?, ?> e : ((Map<?, ?>) value).entrySet()) {
				if (!first) {
					sb.append(',');
				}
				first = false;
				quote(sb, String.valueOf(e.getKey()));
				sb.append(':');
				write(sb, e.getValue());
			}
			sb.append('}');
		} else if (value instanceof Iterable) {
			sb.append('[');
			boolean first = true;
			for (Object o : (Iterable<?>) value) {
				if (!first) {
					sb.append(',');
				}
				first = false;
				write(sb, o);
			}
			sb.append(']');
		} else if (value instanceof int[]) {
			int[] a = (int[]) value;
			sb.append('[');
			for (int i = 0; i < a.length; i++) {
				if (i > 0) {
					sb.append(',');
				}
				sb.append(a[i]);
			}
			sb.append(']');
		} else if (value instanceof double[]) {
			double[] a = (double[]) value;
			sb.append('[');
			for (int i = 0; i < a.length; i++) {
				if (i > 0) {
					sb.append(',');
				}
				number(sb, a[i]);
			}
			sb.append(']');
		} else if (value instanceof Object[]) {
			sb.append('[');
			Object[] a = (Object[]) value;
			for (int i = 0; i < a.length; i++) {
				if (i > 0) {
					sb.append(',');
				}
				write(sb, a[i]);
			}
			sb.append(']');
		} else {
			quote(sb, value.toString());
		}
	}

	/** Writes a double without exponent; NaN and infinity become null. */
	public static void number(StringBuilder sb, double d) {
		if (Double.isNaN(d) || Double.isInfinite(d)) {
			sb.append("null");
			return;
		}
		if (d == Math.rint(d) && Math.abs(d) < 1e15) {
			sb.append((long) d);
			return;
		}
		sb.append(BigDecimal.valueOf(d).stripTrailingZeros().toPlainString());
	}

	/** Writes a double rounded to the given number of decimals. */
	public static void number(StringBuilder sb, double d, int decimals) {
		if (Double.isNaN(d) || Double.isInfinite(d)) {
			sb.append("null");
			return;
		}
		BigDecimal bd = BigDecimal.valueOf(d).setScale(decimals, RoundingMode.HALF_UP);
		if (bd.signum() == 0) {
			sb.append('0');
		} else {
			sb.append(bd.stripTrailingZeros().toPlainString());
		}
	}

	public static void quote(StringBuilder sb, String s) {
		sb.append('"');
		for (int i = 0; i < s.length(); i++) {
			char c = s.charAt(i);
			switch (c) {
			case '"':
				sb.append("\\\"");
				break;
			case '\\':
				sb.append("\\\\");
				break;
			case '\n':
				sb.append("\\n");
				break;
			case '\r':
				sb.append("\\r");
				break;
			case '\t':
				sb.append("\\t");
				break;
			default:
				if (c < 0x20 || c == 0x2028 || c == 0x2029) {
					sb.append(String.format("\\u%04x", (int) c));
				} else {
					sb.append(c);
				}
			}
		}
		sb.append('"');
	}

	public static String quote(String s) {
		StringBuilder sb = new StringBuilder(s.length() + 2);
		quote(sb, s);
		return sb.toString();
	}

	// ---------------------------------------------------------------- parser

	public static Object parse(String text) {
		Parser p = new Parser(text);
		p.skipWs();
		Object v = p.value(0);
		p.skipWs();
		if (p.pos != text.length()) {
			throw new IllegalArgumentException("Extra text after JSON value at " + p.pos);
		}
		return v;
	}

	private static final class Parser {
		final String s;
		int pos = 0;

		Parser(String s) {
			this.s = s;
		}

		void skipWs() {
			while (pos < s.length() && Character.isWhitespace(s.charAt(pos))) {
				pos++;
			}
		}

		IllegalArgumentException err(String msg) {
			return new IllegalArgumentException(msg + " at " + pos);
		}

		Object value(int depth) {
			if (depth > 64) {
				throw err("JSON too deep");
			}
			if (pos >= s.length()) {
				throw err("Unexpected end");
			}
			char c = s.charAt(pos);
			if (c == '{') {
				pos++;
				Map<String, Object> m = new LinkedHashMap<String, Object>();
				skipWs();
				if (peek() == '}') {
					pos++;
					return m;
				}
				while (true) {
					skipWs();
					String k = string();
					skipWs();
					expect(':');
					skipWs();
					m.put(k, value(depth + 1));
					skipWs();
					char d = next();
					if (d == '}') {
						return m;
					}
					if (d != ',') {
						throw err("Expected , or }");
					}
				}
			}
			if (c == '[') {
				pos++;
				List<Object> l = new ArrayList<Object>();
				skipWs();
				if (peek() == ']') {
					pos++;
					return l;
				}
				while (true) {
					skipWs();
					l.add(value(depth + 1));
					skipWs();
					char d = next();
					if (d == ']') {
						return l;
					}
					if (d != ',') {
						throw err("Expected , or ]");
					}
				}
			}
			if (c == '"') {
				return string();
			}
			if (s.startsWith("true", pos)) {
				pos += 4;
				return Boolean.TRUE;
			}
			if (s.startsWith("false", pos)) {
				pos += 5;
				return Boolean.FALSE;
			}
			if (s.startsWith("null", pos)) {
				pos += 4;
				return null;
			}
			int start = pos;
			while (pos < s.length() && "+-0123456789.eE".indexOf(s.charAt(pos)) >= 0) {
				pos++;
			}
			if (start == pos) {
				throw err("Unexpected character");
			}
			try {
				return new BigDecimal(s.substring(start, pos));
			} catch (NumberFormatException e) {
				throw err("Bad number");
			}
		}

		char peek() {
			return pos < s.length() ? s.charAt(pos) : (char) 0;
		}

		char next() {
			if (pos >= s.length()) {
				throw err("Unexpected end");
			}
			return s.charAt(pos++);
		}

		void expect(char c) {
			if (next() != c) {
				pos--;
				throw err("Expected " + c);
			}
		}

		String string() {
			expect('"');
			StringBuilder sb = new StringBuilder();
			while (true) {
				char c = next();
				if (c == '"') {
					return sb.toString();
				}
				if (c == '\\') {
					char e = next();
					switch (e) {
					case 'n':
						sb.append('\n');
						break;
					case 'r':
						sb.append('\r');
						break;
					case 't':
						sb.append('\t');
						break;
					case 'b':
						sb.append('\b');
						break;
					case 'f':
						sb.append('\f');
						break;
					case 'u':
						if (pos + 4 > s.length()) {
							throw err("Bad unicode escape");
						}
						sb.append((char) Integer.parseInt(s.substring(pos, pos + 4), 16));
						pos += 4;
						break;
					default:
						sb.append(e);
					}
				} else {
					sb.append(c);
				}
			}
		}
	}
}
