package crimeradar.recommendation;

/**
 * Incident counts for one grid cell, crime group and time block, as returned by CrimeStatsDao.
 *
 * @param row          grid row, see {@link CrimeGrid#row(double)}
 * @param col          grid column, see {@link CrimeGrid#col(double)}
 * @param group        who the crimes were against
 * @param timeBlock    0..5 for a 4-hour block, or -1 when the time is unknown (stamped 00:00:00)
 * @param recentCount  incidents in the recent window (used for the risk level)
 * @param shapeCount   incidents in the longer window (used for the time-of-day pattern)
 */
public record CellCount(int row, int col, CrimeGroup group, int timeBlock, long recentCount,
		long shapeCount) {

	public static final int UNKNOWN_TIME = -1;
}
