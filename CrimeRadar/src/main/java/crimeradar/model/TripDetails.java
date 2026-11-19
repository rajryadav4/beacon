package crimeradar.model;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.Date;

/**
 * One saved trip. It joins three tables: Routes (coordinates, distance),
 * RouteRecommendations (user, time, choice) and TripDetails (labels, mode, risk).
 */
public class TripDetails {
	public long recommendationId;
	public long userId;
	public String fromLabel;
	public BigDecimal fromLat;
	public BigDecimal fromLng;
	public String toLabel;
	public BigDecimal toLat;
	public BigDecimal toLng;
	public String modeKey;
	public LocalDateTime departAt;
	public int distanceMeters;
	public int durationSeconds;
	public BigDecimal riskScore;
	/** low, elevated or high. */
	public String riskLevel;
	/** SAFEST, FASTEST or BALANCED (RouteRecommendations.RecommendationType). */
	public String choice;
	public Date createdAt;
}
