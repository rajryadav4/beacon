package crimeradar.model;

public class EmergencyContacts {
	protected long contactId;
	protected AppUsers appUser;
	protected String contactName;
	protected String phoneNumber;
	protected String relationship;

	public EmergencyContacts(long contactId, AppUsers appUser, String contactName,
			String phoneNumber, String relationship) {
		this.contactId = contactId;
		this.appUser = appUser;
		this.contactName = contactName;
		this.phoneNumber = phoneNumber;
		this.relationship = relationship;
	}

	public EmergencyContacts(long contactId) {
		this.contactId = contactId;
	}

	public EmergencyContacts(AppUsers appUser, String contactName, String phoneNumber,
			String relationship) {
		this.appUser = appUser;
		this.contactName = contactName;
		this.phoneNumber = phoneNumber;
		this.relationship = relationship;
	}

	public long getContactId() {
		return contactId;
	}

	public void setContactId(long contactId) {
		this.contactId = contactId;
	}

	public AppUsers getAppUser() {
		return appUser;
	}

	public void setAppUser(AppUsers appUser) {
		this.appUser = appUser;
	}

	public String getContactName() {
		return contactName;
	}

	public void setContactName(String contactName) {
		this.contactName = contactName;
	}

	public String getPhoneNumber() {
		return phoneNumber;
	}

	public void setPhoneNumber(String phoneNumber) {
		this.phoneNumber = phoneNumber;
	}

	public String getRelationship() {
		return relationship;
	}

	public void setRelationship(String relationship) {
		this.relationship = relationship;
	}
}
