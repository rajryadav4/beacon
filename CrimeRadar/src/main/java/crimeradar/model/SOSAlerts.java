package crimeradar.model;

import java.math.BigDecimal;
import java.util.Date;

public class SOSAlerts {
	protected long alertId;
	protected AppUsers appUser;
	protected Date alertTime;
	protected BigDecimal latitude;
	protected BigDecimal longitude;
	protected AlertStatus alertStatus;

	// Names match the values of the AlertStatus ENUM column exactly.
	public enum AlertStatus {
		ACTIVE, RESOLVED, CANCELLED
	}

	public SOSAlerts(long alertId, AppUsers appUser, Date alertTime, BigDecimal latitude,
			BigDecimal longitude, AlertStatus alertStatus) {
		this.alertId = alertId;
		this.appUser = appUser;
		this.alertTime = alertTime;
		this.latitude = latitude;
		this.longitude = longitude;
		this.alertStatus = alertStatus;
	}

	public SOSAlerts(long alertId) {
		this.alertId = alertId;
	}

	public SOSAlerts(AppUsers appUser, Date alertTime, BigDecimal latitude, BigDecimal longitude,
			AlertStatus alertStatus) {
		this.appUser = appUser;
		this.alertTime = alertTime;
		this.latitude = latitude;
		this.longitude = longitude;
		this.alertStatus = alertStatus;
	}

	public long getAlertId() {
		return alertId;
	}

	public void setAlertId(long alertId) {
		this.alertId = alertId;
	}

	public AppUsers getAppUser() {
		return appUser;
	}

	public void setAppUser(AppUsers appUser) {
		this.appUser = appUser;
	}

	public Date getAlertTime() {
		return alertTime;
	}

	public void setAlertTime(Date alertTime) {
		this.alertTime = alertTime;
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

	public AlertStatus getAlertStatus() {
		return alertStatus;
	}

	public void setAlertStatus(AlertStatus alertStatus) {
		this.alertStatus = alertStatus;
	}
}
