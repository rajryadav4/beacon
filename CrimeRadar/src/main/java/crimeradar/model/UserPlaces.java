package crimeradar.model;

import java.math.BigDecimal;
import java.util.Date;

/** One row of UserPlaces. Kind names match the Kind ENUM column exactly. */
public class UserPlaces {
	public enum Kind {
		HOME, WORK, SAVED
	}

	public long placeId;
	public long userId;
	public Kind kind;
	public String label;
	public String address;
	public BigDecimal latitude;
	public BigDecimal longitude;
	public Date createdAt;

	public UserPlaces() {
	}

	public UserPlaces(long userId, Kind kind, String label, String address, BigDecimal latitude,
			BigDecimal longitude) {
		this.userId = userId;
		this.kind = kind;
		this.label = label;
		this.address = address;
		this.latitude = latitude;
		this.longitude = longitude;
	}
}
