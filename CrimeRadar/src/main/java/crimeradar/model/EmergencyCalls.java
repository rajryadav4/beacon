package crimeradar.model;

import java.math.BigDecimal;
import java.util.Date;

public class EmergencyCalls {
	protected long callId;
	protected DataSources dataSource;
	protected String sourceCallId;
	protected Date callTime;
	protected String callType;
	// Nullable foreign key.
	protected Neighborhoods neighborhood;
	protected BigDecimal latitude;
	protected BigDecimal longitude;

	public EmergencyCalls(long callId, DataSources dataSource, String sourceCallId, Date callTime,
			String callType, Neighborhoods neighborhood, BigDecimal latitude, BigDecimal longitude) {
		this.callId = callId;
		this.dataSource = dataSource;
		this.sourceCallId = sourceCallId;
		this.callTime = callTime;
		this.callType = callType;
		this.neighborhood = neighborhood;
		this.latitude = latitude;
		this.longitude = longitude;
	}

	public EmergencyCalls(long callId) {
		this.callId = callId;
	}

	public EmergencyCalls(DataSources dataSource, String sourceCallId, Date callTime,
			String callType, Neighborhoods neighborhood, BigDecimal latitude, BigDecimal longitude) {
		this.dataSource = dataSource;
		this.sourceCallId = sourceCallId;
		this.callTime = callTime;
		this.callType = callType;
		this.neighborhood = neighborhood;
		this.latitude = latitude;
		this.longitude = longitude;
	}

	public long getCallId() {
		return callId;
	}

	public void setCallId(long callId) {
		this.callId = callId;
	}

	public DataSources getDataSource() {
		return dataSource;
	}

	public void setDataSource(DataSources dataSource) {
		this.dataSource = dataSource;
	}

	public String getSourceCallId() {
		return sourceCallId;
	}

	public void setSourceCallId(String sourceCallId) {
		this.sourceCallId = sourceCallId;
	}

	public Date getCallTime() {
		return callTime;
	}

	public void setCallTime(Date callTime) {
		this.callTime = callTime;
	}

	public String getCallType() {
		return callType;
	}

	public void setCallType(String callType) {
		this.callType = callType;
	}

	public Neighborhoods getNeighborhood() {
		return neighborhood;
	}

	public void setNeighborhood(Neighborhoods neighborhood) {
		this.neighborhood = neighborhood;
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
}
