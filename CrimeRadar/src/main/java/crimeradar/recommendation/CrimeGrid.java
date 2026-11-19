package crimeradar.recommendation;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Reported-crime density on a grid of roughly 270 m x 270 m cells, for one travel mode.
 *
 * Why a grid: the Neighborhoods table has names but no boundaries, while every incident has a
 * latitude and longitude. A grid lets any route from the routing service be scored by the
 * cells it actually passes through, instead of by whole neighborhoods.
 *
 * Density for a cell and time block is:
 *
 * <pre>
 *   rate       = weighted incidents per day in the recent window, blended 50/50 with the
 *                average of the surrounding 3x3 cells (smooths out single-cell noise)
 *   multiplier = how much of the area's crime falls in this time block compared with an even
 *                spread, from the longer window (3x3 cells). Areas with few incidents lean on
 *                the citywide pattern: trust = incidents / (incidents + 20)
 *   density    = rate x multiplier
 * </pre>
 *
 * Incidents are weighted by who they were against, using the travel mode's weights.
 */
public final class CrimeGrid {

	/** Cell height in degrees of latitude (about 278 m). */
	public static final double CELL_LAT_DEGREES = 0.0025;
	/** Cell width in degrees of longitude (about 263 m at Seattle's latitude). */
	public static final double CELL_LNG_DEGREES = 0.0035;

	/** Incidents an area needs before its own time-of-day pattern counts as much as the city's. */
	private static final double PRIOR_STRENGTH = 20.0;
	/** Weight of a cell's own rate versus its 3x3 neighborhood average. */
	private static final double OWN_CELL_WEIGHT = 0.5;

	private final Map<Long, Double> ratePerDay;
	private final Map<Long, double[]> blockCounts;
	private final Map<Long, Long> knownTimeIncidents;
	private final double[] cityShare;
	private final Map<Long, double[]> densityCache = new HashMap<>();

	private CrimeGrid(Map<Long, Double> ratePerDay, Map<Long, double[]> blockCounts,
			Map<Long, Long> knownTimeIncidents, double[] cityShare) {
		this.ratePerDay = ratePerDay;
		this.blockCounts = blockCounts;
		this.knownTimeIncidents = knownTimeIncidents;
		this.cityShare = cityShare;
	}

	public static int row(double lat) {
		return (int) Math.floor(lat / CELL_LAT_DEGREES);
	}

	public static int col(double lng) {
		return (int) Math.floor(lng / CELL_LNG_DEGREES);
	}

	private static long key(int row, int col) {
		return ((long) row << 32) | (col & 0xFFFFFFFFL);
	}

	/** A grid with no crime data: every density is zero. */
	public static CrimeGrid empty() {
		return new CrimeGrid(new HashMap<>(), new HashMap<>(), new HashMap<>(), evenShare());
	}

	/**
	 * Builds the grid.
	 *
	 * @param counts      per-cell counts from CrimeStatsDao.getCellCounts
	 * @param cityCounts  citywide known-time counts as [CrimeGroup.ordinal()][block], from
	 *                    CrimeStatsDao.getCityBlockCounts
	 * @param mode        decides how much each crime group counts
	 * @param recentDays  length of the recent window in days
	 */
	public static CrimeGrid build(List<CellCount> counts, long[][] cityCounts, TravelMode mode,
			int recentDays) {
		if (recentDays <= 0) {
			throw new IllegalArgumentException("recentDays must be positive.");
		}
		Map<Long, Double> ratePerDay = new HashMap<>();
		Map<Long, double[]> blockCounts = new HashMap<>();
		Map<Long, Long> knownTimeIncidents = new HashMap<>();
		for (CellCount c : counts) {
			double weight = mode.weight(c.group());
			long k = key(c.row(), c.col());
			ratePerDay.merge(k, weight * c.recentCount() / recentDays, Double::sum);
			if (c.timeBlock() >= 0 && c.timeBlock() < TimeBlock.COUNT) {
				blockCounts.computeIfAbsent(k, x -> new double[TimeBlock.COUNT])[c.timeBlock()] +=
					weight * c.shapeCount();
				knownTimeIncidents.merge(k, c.shapeCount(), Long::sum);
			}
		}

		double[] cityShare = new double[TimeBlock.COUNT];
		double cityTotal = 0;
		for (CrimeGroup group : CrimeGroup.values()) {
			for (int b = 0; b < TimeBlock.COUNT; b++) {
				double weighted = mode.weight(group) * cityCounts[group.ordinal()][b];
				cityShare[b] += weighted;
				cityTotal += weighted;
			}
		}
		if (cityTotal <= 0) {
			cityShare = evenShare();
		} else {
			for (int b = 0; b < TimeBlock.COUNT; b++) {
				cityShare[b] /= cityTotal;
			}
		}
		return new CrimeGrid(ratePerDay, blockCounts, knownTimeIncidents, cityShare);
	}

	private static double[] evenShare() {
		double[] share = new double[TimeBlock.COUNT];
		java.util.Arrays.fill(share, 1.0 / TimeBlock.COUNT);
		return share;
	}

	public boolean isEmpty() {
		return ratePerDay.isEmpty();
	}

	/** Weighted reported incidents per day around this point during this time block. */
	public double density(GeoPoint point, TimeBlock block) {
		int r = row(point.lat());
		int c = col(point.lng());
		double[] densities = densityCache.computeIfAbsent(key(r, c), k -> computeDensities(r, c));
		return densities[block.ordinal()];
	}

	private double[] computeDensities(int r, int c) {
		double ownRate = ratePerDay.getOrDefault(key(r, c), 0.0);
		double neighborhoodRate = 0;
		double[] nearbyBlocks = new double[TimeBlock.COUNT];
		long nearbyIncidents = 0;
		for (int dr = -1; dr <= 1; dr++) {
			for (int dc = -1; dc <= 1; dc++) {
				long k = key(r + dr, c + dc);
				neighborhoodRate += ratePerDay.getOrDefault(k, 0.0);
				nearbyIncidents += knownTimeIncidents.getOrDefault(k, 0L);
				double[] blocks = blockCounts.get(k);
				if (blocks != null) {
					for (int b = 0; b < TimeBlock.COUNT; b++) {
						nearbyBlocks[b] += blocks[b];
					}
				}
			}
		}
		neighborhoodRate /= 9.0;
		double rate = OWN_CELL_WEIGHT * ownRate + (1 - OWN_CELL_WEIGHT) * neighborhoodRate;

		double nearbyTotal = 0;
		for (double v : nearbyBlocks) {
			nearbyTotal += v;
		}
		// Trust is based on how many incidents there really are, not on weighted totals,
		// so a mode's crime weights don't change how much the local pattern is trusted.
		double trust = nearbyIncidents / (nearbyIncidents + PRIOR_STRENGTH);
		double[] densities = new double[TimeBlock.COUNT];
		for (int b = 0; b < TimeBlock.COUNT; b++) {
			double localShare = nearbyTotal > 0 ? nearbyBlocks[b] / nearbyTotal : cityShare[b];
			double share = trust * localShare + (1 - trust) * cityShare[b];
			densities[b] = rate * share * TimeBlock.COUNT;
		}
		return densities;
	}
}
