package crimeradar.model;

import java.math.BigDecimal;

/** One row of UserPreferences (1:1 with AppUsers). */
public class UserPreferences {
	public long userId;
	public String modeKey = "walk";
	public BigDecimal safetyWeight = new BigDecimal("0.70");
	public boolean alertsOn = true;

	public UserPreferences() {
	}

	public UserPreferences(long userId, String modeKey, BigDecimal safetyWeight,
			boolean alertsOn) {
		this.userId = userId;
		this.modeKey = modeKey;
		this.safetyWeight = safetyWeight;
		this.alertsOn = alertsOn;
	}
}
