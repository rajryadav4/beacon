package crimeradar.service;

import java.util.Arrays;
import java.util.Date;
import java.util.List;

/**
 * An immutable snapshot of the ML risk model: expected severity-weighted incidents per year
 * for each ~225 m grid cell and 6-hour time band (CellRiskScores of the active ModelRuns row).
 *
 * The grid is the one used everywhere else in the app (sql/app_tables.sql, pipeline, browser):
 * lat0 47.48, lng0 -122.46, dLat 0.002, dLng 0.003, 135 rows x 80 columns,
 * cellId = row * 100 + col. Bands: 0 night (0-6), 1 morning (6-12), 2 afternoon (12-18),
 * 3 evening (18-24), Seattle time. A cell on the grid with no CellRiskScores row has risk 0.
 */
public final class RiskGrid {
    public static final double LAT0 = 47.48;
    public static final double LNG0 = -122.46;
    public static final double D_LAT = 0.002;
    public static final double D_LNG = 0.003;
    public static final int ROWS = 135;
    public static final int COLS = 80;
    public static final int BANDS = 4;
    private static final int MAX_CELL_ID = (ROWS - 1) * 100 + (COLS - 1);

    private final String modelVersion;
    private final Date trainedAt;
    private final double[] risk;

    private RiskGrid(String modelVersion, Date trainedAt, double[] risk) {
        this.modelVersion = modelVersion;
        this.trainedAt = trainedAt == null ? null : new Date(trainedAt.getTime());
        this.risk = risk;
    }

    /**
     * @param rows {cellId, band, expectedRisk}, as returned by MapDataDao.loadRisk
     */
    public static RiskGrid of(String modelVersion, Date trainedAt, List<double[]> rows) {
        double[] risk = new double[(MAX_CELL_ID + 1) * BANDS];
        for (double[] row : rows) {
            int cellId = (int) row[0];
            int band = (int) row[1];
            double value = row[2];
            if (cellId < 0 || cellId > MAX_CELL_ID || cellId % 100 >= COLS || band < 0 || band >= BANDS
                    || !Double.isFinite(value) || value < 0) {
                throw new IllegalArgumentException("Invalid risk row for cell " + cellId + ", band " + band + ".");
            }
            risk[cellId * BANDS + band] = value;
        }
        return new RiskGrid(modelVersion, trainedAt, risk);
    }

    /** The cell containing the point, or -1 when the point is off the Seattle grid. */
    public static int cellId(double lat, double lng) {
        int row = (int) Math.floor((lat - LAT0) / D_LAT);
        int col = (int) Math.floor((lng - LNG0) / D_LNG);
        if (row < 0 || row >= ROWS || col < 0 || col >= COLS) {
            return -1;
        }
        return row * 100 + col;
    }

    /** Time band for an hour of the day (0-23). */
    public static int band(int hour) {
        return hour / 6;
    }

    public double risk(int cellId, int band) {
        return risk[cellId * BANDS + band];
    }

    public String modelVersion() {
        return modelVersion;
    }

    public Date trainedAt() {
        return trainedAt == null ? null : new Date(trainedAt.getTime());
    }

    @Override
    public String toString() {
        return "RiskGrid[" + modelVersion + ", nonzero=" + Arrays.stream(risk).filter(v -> v > 0).count() + "]";
    }
}
