package crimeradar.model;

public class SafetyResources {
	protected int resourceId;
	// Nullable foreign key.
	protected Neighborhoods neighborhood;
	protected String resourceName;
	protected String resourceType;
	protected String contactInfo;
	protected String resourceURL;

	public SafetyResources(int resourceId, Neighborhoods neighborhood, String resourceName,
			String resourceType, String contactInfo, String resourceURL) {
		this.resourceId = resourceId;
		this.neighborhood = neighborhood;
		this.resourceName = resourceName;
		this.resourceType = resourceType;
		this.contactInfo = contactInfo;
		this.resourceURL = resourceURL;
	}

	public SafetyResources(int resourceId) {
		this.resourceId = resourceId;
	}

	public SafetyResources(Neighborhoods neighborhood, String resourceName, String resourceType,
			String contactInfo, String resourceURL) {
		this.neighborhood = neighborhood;
		this.resourceName = resourceName;
		this.resourceType = resourceType;
		this.contactInfo = contactInfo;
		this.resourceURL = resourceURL;
	}

	public int getResourceId() {
		return resourceId;
	}

	public void setResourceId(int resourceId) {
		this.resourceId = resourceId;
	}

	public Neighborhoods getNeighborhood() {
		return neighborhood;
	}

	public void setNeighborhood(Neighborhoods neighborhood) {
		this.neighborhood = neighborhood;
	}

	public String getResourceName() {
		return resourceName;
	}

	public void setResourceName(String resourceName) {
		this.resourceName = resourceName;
	}

	public String getResourceType() {
		return resourceType;
	}

	public void setResourceType(String resourceType) {
		this.resourceType = resourceType;
	}

	public String getContactInfo() {
		return contactInfo;
	}

	public void setContactInfo(String contactInfo) {
		this.contactInfo = contactInfo;
	}

	public String getResourceURL() {
		return resourceURL;
	}

	public void setResourceURL(String resourceURL) {
		this.resourceURL = resourceURL;
	}
}
