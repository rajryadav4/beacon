package crimeradar.servlet;

/** One row of the route comparison table on RecommendRoute.jsp (JavaBean getters for EL). */
public class RouteOptionView {
	private final String label;
	private final String tags;
	private final String durationText;
	private final String distanceText;
	private final String exposureText;
	private final String versusFastestText;
	private final String statusText;
	private final boolean recommended;
	private final boolean withinLimit;

	public RouteOptionView(String label, String tags, String durationText, String distanceText,
			String exposureText, String versusFastestText, String statusText, boolean recommended,
			boolean withinLimit) {
		this.label = label;
		this.tags = tags;
		this.durationText = durationText;
		this.distanceText = distanceText;
		this.exposureText = exposureText;
		this.versusFastestText = versusFastestText;
		this.statusText = statusText;
		this.recommended = recommended;
		this.withinLimit = withinLimit;
	}

	public String getLabel() {
		return label;
	}

	public String getTags() {
		return tags;
	}

	public String getDurationText() {
		return durationText;
	}

	public String getDistanceText() {
		return distanceText;
	}

	public String getExposureText() {
		return exposureText;
	}

	public String getVersusFastestText() {
		return versusFastestText;
	}

	public String getStatusText() {
		return statusText;
	}

	public boolean isRecommended() {
		return recommended;
	}

	public boolean isWithinLimit() {
		return withinLimit;
	}
}
