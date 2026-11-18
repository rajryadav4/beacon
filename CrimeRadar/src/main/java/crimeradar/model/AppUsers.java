package crimeradar.model;

import java.util.Date;

public class AppUsers {
	protected long userId;
	protected String displayName;
	protected String email;
	protected String passwordHash;
	protected Date createdAt;

	public AppUsers(long userId, String displayName, String email, String passwordHash,
			Date createdAt) {
		this.userId = userId;
		this.displayName = displayName;
		this.email = email;
		this.passwordHash = passwordHash;
		this.createdAt = createdAt;
	}

	public AppUsers(long userId) {
		this.userId = userId;
	}

	public AppUsers(String displayName, String email, String passwordHash) {
		this.displayName = displayName;
		this.email = email;
		this.passwordHash = passwordHash;
	}

	public long getUserId() {
		return userId;
	}

	public void setUserId(long userId) {
		this.userId = userId;
	}

	public String getDisplayName() {
		return displayName;
	}

	public void setDisplayName(String displayName) {
		this.displayName = displayName;
	}

	public String getEmail() {
		return email;
	}

	public void setEmail(String email) {
		this.email = email;
	}

	public String getPasswordHash() {
		return passwordHash;
	}

	public void setPasswordHash(String passwordHash) {
		this.passwordHash = passwordHash;
	}

	public Date getCreatedAt() {
		return createdAt;
	}

	public void setCreatedAt(Date createdAt) {
		this.createdAt = createdAt;
	}
}
