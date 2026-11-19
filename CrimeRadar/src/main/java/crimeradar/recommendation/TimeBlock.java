package crimeradar.recommendation;

import java.time.LocalDateTime;

/**
 * The day split into six 4-hour blocks, the same blocks used in the Milestone 3 analysis.
 * Crime patterns are compared per block rather than per hour so each block has enough data.
 */
public enum TimeBlock {
	LATE_NIGHT("12–4 AM"),
	EARLY_MORNING("4–8 AM"),
	MORNING("8 AM–12 PM"),
	AFTERNOON("12–4 PM"),
	EVENING("4–8 PM"),
	NIGHT("8 PM–12 AM");

	public static final int COUNT = 6;

	private final String label;

	TimeBlock(String label) {
		this.label = label;
	}

	public String label() {
		return label;
	}

	public static TimeBlock of(LocalDateTime time) {
		return values()[time.getHour() / 4];
	}

	public static TimeBlock fromIndex(int index) {
		return values()[index];
	}
}
