package crimeradar.model;

import java.math.BigDecimal;
import java.util.Date;

public class RiskScores {
	protected long riskScoreId;
	protected Neighborhoods neighborhood;
	protected Date riskDate;
	// 0 through 23.
	protected int hourOfDay;
	protected int incidentCount;
	protected BigDecimal riskScore;
	protected String modelVersion;

	public RiskScores(long riskScoreId, Neighborhoods neighborhood, Date riskDate, int hourOfDay,
			int incidentCount, BigDecimal riskScore, String modelVersion) {
		this.riskScoreId = riskScoreId;
		this.neighborhood = neighborhood;
		this.riskDate = riskDate;
		this.hourOfDay = hourOfDay;
		this.incidentCount = incidentCount;
		this.riskScore = riskScore;
		this.modelVersion = modelVersion;
	}

	public RiskScores(long riskScoreId) {
		this.riskScoreId = riskScoreId;
	}

	public RiskScores(Neighborhoods neighborhood, Date riskDate, int hourOfDay, int incidentCount,
			BigDecimal riskScore, String modelVersion) {
		this.neighborhood = neighborhood;
		this.riskDate = riskDate;
		this.hourOfDay = hourOfDay;
		this.incidentCount = incidentCount;
		this.riskScore = riskScore;
		this.modelVersion = modelVersion;
	}

	public long getRiskScoreId() {
		return riskScoreId;
	}

	public void setRiskScoreId(long riskScoreId) {
		this.riskScoreId = riskScoreId;
	}

	public Neighborhoods getNeighborhood() {
		return neighborhood;
	}

	public void setNeighborhood(Neighborhoods neighborhood) {
		this.neighborhood = neighborhood;
	}

	public Date getRiskDate() {
		return riskDate;
	}

	public void setRiskDate(Date riskDate) {
		this.riskDate = riskDate;
	}

	public int getHourOfDay() {
		return hourOfDay;
	}

	public void setHourOfDay(int hourOfDay) {
		this.hourOfDay = hourOfDay;
	}

	public int getIncidentCount() {
		return incidentCount;
	}

	public void setIncidentCount(int incidentCount) {
		this.incidentCount = incidentCount;
	}

	public BigDecimal getRiskScore() {
		return riskScore;
	}

	public void setRiskScore(BigDecimal riskScore) {
		this.riskScore = riskScore;
	}

	public String getModelVersion() {
		return modelVersion;
	}

	public void setModelVersion(String modelVersion) {
		this.modelVersion = modelVersion;
	}
}
