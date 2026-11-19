package crimeradar.recommendation;

import java.time.LocalDate;
import java.time.LocalDateTime;

/**
 * Which incidents the scores are based on.
 *
 * The window is anchored to the newest incident in the database, not to today, so scores stay
 * meaningful even when the data sync hasn't run for a while. The newest {@link #LAG_DAYS} days
 * are skipped because SPD reports arrive 5 to 6.5 days late on average (Milestone 3, Q7), so
 * that week always looks safer than it really was.
 *
 * @param latestIncident newest OccurredAt in CrimeIncidents
 * @param end            exclusive end of both windows (latestIncident minus the lag)
 * @param recentStart    start of the recent window, which sets each cell's risk level
 * @param shapeStart     start of the longer window, which sets the time-of-day pattern
 */
public record DataWindow(LocalDateTime latestIncident, LocalDateTime end,
		LocalDateTime recentStart, LocalDateTime shapeStart) {

	public static final int LAG_DAYS = 7;
	public static final int RECENT_DAYS = 90;
	public static final int SHAPE_DAYS = 365;

	public static DataWindow fromLatestIncident(LocalDateTime latestIncident) {
		LocalDateTime end = latestIncident.minusDays(LAG_DAYS);
		return new DataWindow(latestIncident, end, end.minusDays(RECENT_DAYS),
			end.minusDays(SHAPE_DAYS));
	}

	public int recentDays() {
		return RECENT_DAYS;
	}

	/** True when the newest incident is more than {@code maxAgeDays} before {@code today}. */
	public boolean isStale(LocalDate today, int maxAgeDays) {
		return latestIncident.toLocalDate().isBefore(today.minusDays(maxAgeDays));
	}
}
