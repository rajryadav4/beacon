package crimeradar.dal;

import crimeradar.model.CrimeCategories;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;

public class CrimeCategoriesDao {
	protected ConnectionManager connectionManager;

	private static CrimeCategoriesDao instance = null;

	protected CrimeCategoriesDao() {
		connectionManager = new ConnectionManager();
	}

	public static CrimeCategoriesDao getInstance() {
		if (instance == null) {
			instance = new CrimeCategoriesDao();
		}
		return instance;
	}

	private static final String SELECT_COLUMNS =
		"SELECT CategoryId,CategoryName,NIBRSGroup,CrimeAgainstCategory FROM CrimeCategories ";

	public CrimeCategories create(CrimeCategories crimeCategory) throws SQLException {
		String insertCategory =
			"INSERT INTO CrimeCategories(CategoryName,NIBRSGroup,CrimeAgainstCategory) "
				+ "VALUES(?,?,?);";
		Connection connection = null;
		PreparedStatement insertStmt = null;
		try {
			connection = connectionManager.getConnection();
			insertStmt = connection.prepareStatement(insertCategory,
				Statement.RETURN_GENERATED_KEYS);
			insertStmt.setString(1, crimeCategory.getCategoryName());
			insertStmt.setString(2, crimeCategory.getNibrsGroup());
			insertStmt.setString(3, crimeCategory.getCrimeAgainstCategory());
			insertStmt.executeUpdate();
			crimeCategory.setCategoryId((int) DaoUtils.getGeneratedKey(insertStmt));
			return crimeCategory;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, insertStmt, null);
		}
	}

	public CrimeCategories getCrimeCategoryById(int categoryId) throws SQLException {
		List<CrimeCategories> categories =
			getList(SELECT_COLUMNS + "WHERE CategoryId=?;", categoryId);
		return categories.isEmpty() ? null : categories.get(0);
	}

	/** e.g. "PERSON", "PROPERTY" or "SOCIETY". */
	public List<CrimeCategories> getCrimeCategoriesForCrimeAgainst(String crimeAgainstCategory)
			throws SQLException {
		return getList(SELECT_COLUMNS + "WHERE CrimeAgainstCategory=? ORDER BY CategoryName;",
			crimeAgainstCategory);
	}

	public List<CrimeCategories> getAllCrimeCategories() throws SQLException {
		return getList(SELECT_COLUMNS + "ORDER BY CategoryName;", null);
	}

	/** Delete the CrimeCategories instance. Fails while CrimeIncidents rows reference it. */
	public CrimeCategories delete(CrimeCategories crimeCategory) throws SQLException {
		String deleteCategory = "DELETE FROM CrimeCategories WHERE CategoryId=?;";
		Connection connection = null;
		PreparedStatement deleteStmt = null;
		try {
			connection = connectionManager.getConnection();
			deleteStmt = connection.prepareStatement(deleteCategory);
			deleteStmt.setInt(1, crimeCategory.getCategoryId());
			deleteStmt.executeUpdate();
			return null;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, deleteStmt, null);
		}
	}

	/** Runs a query with at most one parameter (null for none). */
	private List<CrimeCategories> getList(String query, Object param) throws SQLException {
		List<CrimeCategories> categories = new ArrayList<CrimeCategories>();
		Connection connection = null;
		PreparedStatement selectStmt = null;
		ResultSet results = null;
		try {
			connection = connectionManager.getConnection();
			selectStmt = connection.prepareStatement(query);
			if (param != null) {
				selectStmt.setObject(1, param);
			}
			results = selectStmt.executeQuery();
			while (results.next()) {
				categories.add(new CrimeCategories(
					results.getInt("CategoryId"),
					results.getString("CategoryName"),
					results.getString("NIBRSGroup"),
					results.getString("CrimeAgainstCategory")));
			}
			return categories;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, selectStmt, results);
		}
	}
}
