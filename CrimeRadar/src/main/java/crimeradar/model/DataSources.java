package crimeradar.model;

import java.util.Date;

/**
 * Plain old java objects (POJOs) in this package mirror the CrimeRadar tables, one class per
 * table. Foreign keys are held as references to the parent object, not as raw ids.
 */
public class DataSources {
	protected int sourceId;
	protected String sourceName;
	protected String datasetIdentifier;
	protected String sourceURL;
	protected Date lastImportedAt;

	public DataSources(int sourceId, String sourceName, String datasetIdentifier,
			String sourceURL, Date lastImportedAt) {
		this.sourceId = sourceId;
		this.sourceName = sourceName;
		this.datasetIdentifier = datasetIdentifier;
		this.sourceURL = sourceURL;
		this.lastImportedAt = lastImportedAt;
	}

	public DataSources(int sourceId) {
		this.sourceId = sourceId;
	}

	public DataSources(String sourceName, String datasetIdentifier, String sourceURL,
			Date lastImportedAt) {
		this.sourceName = sourceName;
		this.datasetIdentifier = datasetIdentifier;
		this.sourceURL = sourceURL;
		this.lastImportedAt = lastImportedAt;
	}

	public int getSourceId() {
		return sourceId;
	}

	public void setSourceId(int sourceId) {
		this.sourceId = sourceId;
	}

	public String getSourceName() {
		return sourceName;
	}

	public void setSourceName(String sourceName) {
		this.sourceName = sourceName;
	}

	public String getDatasetIdentifier() {
		return datasetIdentifier;
	}

	public void setDatasetIdentifier(String datasetIdentifier) {
		this.datasetIdentifier = datasetIdentifier;
	}

	public String getSourceURL() {
		return sourceURL;
	}

	public void setSourceURL(String sourceURL) {
		this.sourceURL = sourceURL;
	}

	public Date getLastImportedAt() {
		return lastImportedAt;
	}

	public void setLastImportedAt(Date lastImportedAt) {
		this.lastImportedAt = lastImportedAt;
	}
}
