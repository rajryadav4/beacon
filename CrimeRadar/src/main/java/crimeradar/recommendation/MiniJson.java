package crimeradar.recommendation;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A minimal JSON reader, so the project needs no extra jar just to read routing responses.
 * Objects become Map, arrays become List, numbers become Double, plus String, Boolean and null.
 */
final class MiniJson {

	private final String text;
	private int pos;

	private MiniJson(String text) {
		this.text = text;
	}

	static Object parse(String text) {
		if (text == null) {
			throw new IllegalArgumentException("No JSON to parse.");
		}
		MiniJson parser = new MiniJson(text);
		try {
			parser.skipWhitespace();
			Object value = parser.readValue();
			parser.skipWhitespace();
			if (parser.pos != text.length()) {
				throw parser.error("Unexpected text after JSON value");
			}
			return value;
		} catch (IndexOutOfBoundsException e) {
			throw new IllegalArgumentException("JSON ended unexpectedly.", e);
		}
	}

	/** The value as an object, or an empty map if it isn't one. */
	@SuppressWarnings("unchecked")
	static Map<String, Object> asObject(Object value) {
		return value instanceof Map ? (Map<String, Object>) value : Collections.emptyMap();
	}

	/** The value as an array, or an empty list if it isn't one. */
	@SuppressWarnings("unchecked")
	static List<Object> asArray(Object value) {
		return value instanceof List ? (List<Object>) value : Collections.emptyList();
	}

	/** The value as a number, or {@code fallback} if it isn't one. */
	static double asNumber(Object value, double fallback) {
		return value instanceof Double ? (Double) value : fallback;
	}

	private Object readValue() {
		char c = text.charAt(pos);
		switch (c) {
			case '{':
				return readObject();
			case '[':
				return readArray();
			case '"':
				return readString();
			case 't':
				return readLiteral("true", Boolean.TRUE);
			case 'f':
				return readLiteral("false", Boolean.FALSE);
			case 'n':
				return readLiteral("null", null);
			default:
				if (c == '-' || (c >= '0' && c <= '9')) {
					return readNumber();
				}
				throw error("Unexpected character '" + c + "'");
		}
	}

	private Map<String, Object> readObject() {
		Map<String, Object> map = new LinkedHashMap<>();
		pos++; // {
		skipWhitespace();
		if (text.charAt(pos) == '}') {
			pos++;
			return map;
		}
		while (true) {
			skipWhitespace();
			if (text.charAt(pos) != '"') {
				throw error("Expected a property name");
			}
			String key = readString();
			skipWhitespace();
			expect(':');
			skipWhitespace();
			map.put(key, readValue());
			skipWhitespace();
			if (text.charAt(pos) == ',') {
				pos++;
				continue;
			}
			expect('}');
			return map;
		}
	}

	private List<Object> readArray() {
		List<Object> list = new ArrayList<>();
		pos++; // [
		skipWhitespace();
		if (text.charAt(pos) == ']') {
			pos++;
			return list;
		}
		while (true) {
			skipWhitespace();
			list.add(readValue());
			skipWhitespace();
			if (text.charAt(pos) == ',') {
				pos++;
				continue;
			}
			expect(']');
			return list;
		}
	}

	private String readString() {
		expect('"');
		StringBuilder sb = new StringBuilder();
		while (true) {
			char c = text.charAt(pos++);
			if (c == '"') {
				return sb.toString();
			}
			if (c != '\\') {
				sb.append(c);
				continue;
			}
			char escaped = text.charAt(pos++);
			switch (escaped) {
				case '"':
				case '\\':
				case '/':
					sb.append(escaped);
					break;
				case 'b':
					sb.append('\b');
					break;
				case 'f':
					sb.append('\f');
					break;
				case 'n':
					sb.append('\n');
					break;
				case 'r':
					sb.append('\r');
					break;
				case 't':
					sb.append('\t');
					break;
				case 'u':
					sb.append((char) Integer.parseInt(text.substring(pos, pos + 4), 16));
					pos += 4;
					break;
				default:
					throw error("Bad escape '\\" + escaped + "'");
			}
		}
	}

	private Double readNumber() {
		int start = pos;
		while (pos < text.length() && "+-0123456789.eE".indexOf(text.charAt(pos)) >= 0) {
			pos++;
		}
		try {
			return Double.valueOf(text.substring(start, pos));
		} catch (NumberFormatException e) {
			throw error("Bad number");
		}
	}

	private Object readLiteral(String word, Object value) {
		if (!text.startsWith(word, pos)) {
			throw error("Expected " + word);
		}
		pos += word.length();
		return value;
	}

	private void expect(char c) {
		if (text.charAt(pos) != c) {
			throw error("Expected '" + c + "'");
		}
		pos++;
	}

	private void skipWhitespace() {
		while (pos < text.length() && Character.isWhitespace(text.charAt(pos))) {
			pos++;
		}
	}

	private IllegalArgumentException error(String message) {
		return new IllegalArgumentException(message + " at position " + pos + ".");
	}
}
