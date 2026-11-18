package crimeradar.model;

public class PolicePrecincts {
	protected int precinctId;
	protected String precinctName;

	public PolicePrecincts(int precinctId, String precinctName) {
		this.precinctId = precinctId;
		this.precinctName = precinctName;
	}

	public PolicePrecincts(int precinctId) {
		this.precinctId = precinctId;
	}

	public PolicePrecincts(String precinctName) {
		this.precinctName = precinctName;
	}

	public int getPrecinctId() {
		return precinctId;
	}

	public void setPrecinctId(int precinctId) {
		this.precinctId = precinctId;
	}

	public String getPrecinctName() {
		return precinctName;
	}

	public void setPrecinctName(String precinctName) {
		this.precinctName = precinctName;
	}
}
