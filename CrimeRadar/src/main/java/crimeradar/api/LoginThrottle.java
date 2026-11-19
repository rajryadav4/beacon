package crimeradar.api;

import java.util.ArrayDeque;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Limits failed logins: 5 failures per email + IP within 10 minutes, then 429.
 * Kept in memory (it resets when Tomcat restarts), which is enough for this app.
 */
public final class LoginThrottle {
	public static final int MAX_FAILURES = 5;
	public static final long WINDOW_MILLIS = 10L * 60L * 1000L;
	private static final int MAX_KEYS = 20000;

	private static final Map<String, ArrayDeque<Long>> FAILURES =
		new ConcurrentHashMap<String, ArrayDeque<Long>>();

	private LoginThrottle() {
	}

	public static String key(String email, String ip) {
		return email.toLowerCase() + "|" + ip;
	}

	/**
	 * One atomic step per login attempt: drop old entries, refuse when there are already
	 * MAX_FAILURES attempts in the window, else count this attempt now.
	 * Returns 0 when the attempt may go on, or the seconds to wait. A successful login calls
	 * clear(), so only failed attempts stay counted.
	 */
	public static long tryAttempt(String key) {
		if (FAILURES.size() > MAX_KEYS) {
			sweep();
		}
		ArrayDeque<Long> q = FAILURES.computeIfAbsent(key, k -> new ArrayDeque<Long>());
		synchronized (q) {
			long now = System.currentTimeMillis();
			prune(q, now);
			if (q.size() >= MAX_FAILURES) {
				long oldest = q.peekFirst();
				return Math.max(1, (oldest + WINDOW_MILLIS - now + 999) / 1000);
			}
			q.addLast(now);
			return 0;
		}
	}

	public static void clear(String key) {
		FAILURES.remove(key);
	}

	private static void prune(ArrayDeque<Long> q, long now) {
		while (!q.isEmpty() && q.peekFirst() < now - WINDOW_MILLIS) {
			q.pollFirst();
		}
	}

	private static void sweep() {
		long now = System.currentTimeMillis();
		Iterator<Map.Entry<String, ArrayDeque<Long>>> it = FAILURES.entrySet().iterator();
		while (it.hasNext()) {
			ArrayDeque<Long> q = it.next().getValue();
			synchronized (q) {
				prune(q, now);
				if (q.isEmpty()) {
					it.remove();
				}
			}
		}
	}
}
