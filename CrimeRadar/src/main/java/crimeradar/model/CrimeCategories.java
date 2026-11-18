package crimeradar.model;

public class CrimeCategories {
	protected int categoryId;
	protected String categoryName;
	protected String nibrsGroup;
	protected String crimeAgainstCategory;

	public CrimeCategories(int categoryId, String categoryName, String nibrsGroup,
			String crimeAgainstCategory) {
		this.categoryId = categoryId;
		this.categoryName = categoryName;
		this.nibrsGroup = nibrsGroup;
		this.crimeAgainstCategory = crimeAgainstCategory;
	}

	public CrimeCategories(int categoryId) {
		this.categoryId = categoryId;
	}

	public CrimeCategories(String categoryName, String nibrsGroup, String crimeAgainstCategory) {
		this.categoryName = categoryName;
		this.nibrsGroup = nibrsGroup;
		this.crimeAgainstCategory = crimeAgainstCategory;
	}

	public int getCategoryId() {
		return categoryId;
	}

	public void setCategoryId(int categoryId) {
		this.categoryId = categoryId;
	}

	public String getCategoryName() {
		return categoryName;
	}

	public void setCategoryName(String categoryName) {
		this.categoryName = categoryName;
	}

	public String getNibrsGroup() {
		return nibrsGroup;
	}

	public void setNibrsGroup(String nibrsGroup) {
		this.nibrsGroup = nibrsGroup;
	}

	public String getCrimeAgainstCategory() {
		return crimeAgainstCategory;
	}

	public void setCrimeAgainstCategory(String crimeAgainstCategory) {
		this.crimeAgainstCategory = crimeAgainstCategory;
	}
}
