package crimeradar.model;

import java.math.BigDecimal;
import java.util.Date;

public class CrimeIncidents {
	protected long incidentId;
	protected DataSources dataSource;
	protected String sourceOffenseId;
	protected String reportNumber;
	protected Date occurredAt;
	protected Date reportedAt;
	protected CrimeCategories crimeCategory;
	// Nullable foreign keys.
	protected Neighborhoods neighborhood;
	protected PolicePrecincts policePrecinct;
	protected String blockAddress;
	protected BigDecimal latitude;
	protected BigDecimal longitude;
	protected String beat;

	public CrimeIncidents(long incidentId, DataSources dataSource, String sourceOffenseId,
			String reportNumber, Date occurredAt, Date reportedAt, CrimeCategories crimeCategory,
			Neighborhoods neighborhood, PolicePrecincts policePrecinct, String blockAddress,
			BigDecimal latitude, BigDecimal longitude, String beat) {
		this.incidentId = incidentId;
		this.dataSource = dataSource;
		this.sourceOffenseId = sourceOffenseId;
		this.reportNumber = reportNumber;
		this.occurredAt = occurredAt;
		this.reportedAt = reportedAt;
		this.crimeCategory = crimeCategory;
		this.neighborhood = neighborhood;
		this.policePrecinct = policePrecinct;
		this.blockAddress = blockAddress;
		this.latitude = latitude;
		this.longitude = longitude;
		this.beat = beat;
	}

	public CrimeIncidents(long incidentId) {
		this.incidentId = incidentId;
	}

	public CrimeIncidents(DataSources dataSource, String sourceOffenseId, String reportNumber,
			Date occurredAt, Date reportedAt, CrimeCategories crimeCategory,
			Neighborhoods neighborhood, PolicePrecincts policePrecinct, String blockAddress,
			BigDecimal latitude, BigDecimal longitude, String beat) {
		this.dataSource = dataSource;
		this.sourceOffenseId = sourceOffenseId;
		this.reportNumber = reportNumber;
		this.occurredAt = occurredAt;
		this.reportedAt = reportedAt;
		this.crimeCategory = crimeCategory;
		this.neighborhood = neighborhood;
		this.policePrecinct = policePrecinct;
		this.blockAddress = blockAddress;
		this.latitude = latitude;
		this.longitude = longitude;
		this.beat = beat;
	}

	public long getIncidentId() {
		return incidentId;
	}

	public void setIncidentId(long incidentId) {
		this.incidentId = incidentId;
	}

	public DataSources getDataSource() {
		return dataSource;
	}

	public void setDataSource(DataSources dataSource) {
		this.dataSource = dataSource;
	}

	public String getSourceOffenseId() {
		return sourceOffenseId;
	}

	public void setSourceOffenseId(String sourceOffenseId) {
		this.sourceOffenseId = sourceOffenseId;
	}

	public String getReportNumber() {
		return reportNumber;
	}

	public void setReportNumber(String reportNumber) {
		this.reportNumber = reportNumber;
	}

	public Date getOccurredAt() {
		return occurredAt;
	}

	public void setOccurredAt(Date occurredAt) {
		this.occurredAt = occurredAt;
	}

	public Date getReportedAt() {
		return reportedAt;
	}

	public void setReportedAt(Date reportedAt) {
		this.reportedAt = reportedAt;
	}

	public CrimeCategories getCrimeCategory() {
		return crimeCategory;
	}

	public void setCrimeCategory(CrimeCategories crimeCategory) {
		this.crimeCategory = crimeCategory;
	}

	public Neighborhoods getNeighborhood() {
		return neighborhood;
	}

	public void setNeighborhood(Neighborhoods neighborhood) {
		this.neighborhood = neighborhood;
	}

	public PolicePrecincts getPolicePrecinct() {
		return policePrecinct;
	}

	public void setPolicePrecinct(PolicePrecincts policePrecinct) {
		this.policePrecinct = policePrecinct;
	}

	public String getBlockAddress() {
		return blockAddress;
	}

	public void setBlockAddress(String blockAddress) {
		this.blockAddress = blockAddress;
	}

	public BigDecimal getLatitude() {
		return latitude;
	}

	public void setLatitude(BigDecimal latitude) {
		this.latitude = latitude;
	}

	public BigDecimal getLongitude() {
		return longitude;
	}

	public void setLongitude(BigDecimal longitude) {
		this.longitude = longitude;
	}

	public String getBeat() {
		return beat;
	}

	public void setBeat(String beat) {
		this.beat = beat;
	}
}
