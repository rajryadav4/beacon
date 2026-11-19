package crimeradar.recommendation;

/** Who a crime is against, from CrimeCategories.CrimeAgainstCategory, folded into three groups. */
public enum CrimeGroup {
	PERSON, PROPERTY, OTHER;

	/** Maps the database value ("PERSON", "PROPERTY", "SOCIETY", ...) to a group. */
	public static CrimeGroup fromDatabase(String crimeAgainstCategory) {
		if (crimeAgainstCategory == null) {
			return OTHER;
		}
		switch (crimeAgainstCategory.trim().toUpperCase()) {
			case "PERSON":
				return PERSON;
			case "PROPERTY":
				return PROPERTY;
			default:
				return OTHER;
		}
	}
}
