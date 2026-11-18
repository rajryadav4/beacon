package crimeradar.model;

import java.math.BigDecimal;
import java.util.Date;

public class RouteRecommendations {
	protected long recommendationId;
	// Nullable: a recommendation can be requested anonymously.
	protected AppUsers appUser;
	protected Routes route;
	protected Date requestedAt;
	protected BigDecimal estimatedRisk;
	protected RecommendationType recommendationType;

	// Names match the values of the RecommendationType ENUM column exactly.
	public enum RecommendationType {
		SAFEST, FASTEST, BALANCED
	}

	public RouteRecommendations(long recommendationId, AppUsers appUser, Routes route,
			Date requestedAt, BigDecimal estimatedRisk, RecommendationType recommendationType) {
		this.recommendationId = recommendationId;
		this.appUser = appUser;
		this.route = route;
		this.requestedAt = requestedAt;
		this.estimatedRisk = estimatedRisk;
		this.recommendationType = recommendationType;
	}

	public RouteRecommendations(long recommendationId) {
		this.recommendationId = recommendationId;
	}

	public RouteRecommendations(AppUsers appUser, Routes route, Date requestedAt,
			BigDecimal estimatedRisk, RecommendationType recommendationType) {
		this.appUser = appUser;
		this.route = route;
		this.requestedAt = requestedAt;
		this.estimatedRisk = estimatedRisk;
		this.recommendationType = recommendationType;
	}

	public long getRecommendationId() {
		return recommendationId;
	}

	public void setRecommendationId(long recommendationId) {
		this.recommendationId = recommendationId;
	}

	public AppUsers getAppUser() {
		return appUser;
	}

	public void setAppUser(AppUsers appUser) {
		this.appUser = appUser;
	}

	public Routes getRoute() {
		return route;
	}

	public void setRoute(Routes route) {
		this.route = route;
	}

	public Date getRequestedAt() {
		return requestedAt;
	}

	public void setRequestedAt(Date requestedAt) {
		this.requestedAt = requestedAt;
	}

	public BigDecimal getEstimatedRisk() {
		return estimatedRisk;
	}

	public void setEstimatedRisk(BigDecimal estimatedRisk) {
		this.estimatedRisk = estimatedRisk;
	}

	public RecommendationType getRecommendationType() {
		return recommendationType;
	}

	public void setRecommendationType(RecommendationType recommendationType) {
		this.recommendationType = recommendationType;
	}
}
