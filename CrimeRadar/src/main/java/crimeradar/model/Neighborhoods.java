package crimeradar.model;

public class Neighborhoods {
	protected int neighborhoodId;
	protected String neighborhoodName;
	// Nullable foreign key to PolicePrecincts.
	protected PolicePrecincts policePrecinct;

	public Neighborhoods(int neighborhoodId, String neighborhoodName,
			PolicePrecincts policePrecinct) {
		this.neighborhoodId = neighborhoodId;
		this.neighborhoodName = neighborhoodName;
		this.policePrecinct = policePrecinct;
	}

	public Neighborhoods(int neighborhoodId) {
		this.neighborhoodId = neighborhoodId;
	}

	public Neighborhoods(String neighborhoodName, PolicePrecincts policePrecinct) {
		this.neighborhoodName = neighborhoodName;
		this.policePrecinct = policePrecinct;
	}

	public int getNeighborhoodId() {
		return neighborhoodId;
	}

	public void setNeighborhoodId(int neighborhoodId) {
		this.neighborhoodId = neighborhoodId;
	}

	public String getNeighborhoodName() {
		return neighborhoodName;
	}

	public void setNeighborhoodName(String neighborhoodName) {
		this.neighborhoodName = neighborhoodName;
	}

	public PolicePrecincts getPolicePrecinct() {
		return policePrecinct;
	}

	public void setPolicePrecinct(PolicePrecincts policePrecinct) {
		this.policePrecinct = policePrecinct;
	}
}
