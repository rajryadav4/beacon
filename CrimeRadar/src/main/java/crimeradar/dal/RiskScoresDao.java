package crimeradar.dal;

import crimeradar.model.Neighborhoods;
import crimeradar.model.RiskScores;

import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;

public class RiskScoresDao {
	protected ConnectionManager connectionManager;

	private static RiskScoresDao instance = null;

	protected RiskScoresDao() {
		connectionManager = new ConnectionManager();
	}

	public static RiskScoresDao getInstance() {
		if (instance == null) {
			instance = new RiskScoresDao();
		}
		return instance;
	}

	private static final String SELECT_COLUMNS =
		"SELECT RiskScoreId,NeighborhoodId,RiskDate,HourOfDay,IncidentCount,RiskScore,"
			+ "ModelVersion FROM RiskScores ";

	public RiskScores create(RiskScores riskScore) throws SQLException {
		String insertRiskScore =
			"INSERT INTO RiskScores(NeighborhoodId,RiskDate,HourOfDay,IncidentCount,RiskScore,"
				+ "ModelVersion) VALUES(?,?,?,?,?,?);";
		Connection connection = null;
		PreparedStatement insertStmt = null;
		try {
			connection = connectionManager.getConnection();
			insertStmt = connection.prepareStatement(insertRiskScore,
				Statement.RETURN_GENERATED_KEYS);
			insertStmt.setInt(1, riskScore.getNeighborhood().getNeighborhoodId());
			insertStmt.setDate(2, DaoUtils.toSqlDate(riskScore.getRiskDate()));
			insertStmt.setInt(3, riskScore.getHourOfDay());
			insertStmt.setInt(4, riskScore.getIncidentCount());
			insertStmt.setBigDecimal(5, riskScore.getRiskScore());
			insertStmt.setString(6, riskScore.getModelVersion());
			insertStmt.executeUpdate();
			riskScore.setRiskScoreId(DaoUtils.getGeneratedKey(insertStmt));
			return riskScore;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, insertStmt, null);
		}
	}

	public RiskScores getRiskScoreById(long riskScoreId) throws SQLException {
		Connection connection = null;
		PreparedStatement selectStmt = null;
		ResultSet results = null;
		try {
			connection = connectionManager.getConnection();
			selectStmt = connection.prepareStatement(SELECT_COLUMNS + "WHERE RiskScoreId=?;");
			selectStmt.setLong(1, riskScoreId);
			results = selectStmt.executeQuery();
			NeighborhoodsDao neighborhoodsDao = NeighborhoodsDao.getInstance();
			if (results.next()) {
				Neighborhoods neighborhood =
					neighborhoodsDao.getNeighborhoodById(results.getInt("NeighborhoodId"));
				return fromResultSet(results, neighborhood);
			}
			return null;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, selectStmt, results);
		}
	}

	/** The neighborhood's hourly scores (all model versions) for one day, ordered by hour. */
	public List<RiskScores> getRiskScoresForNeighborhoodOnDate(Neighborhoods neighborhood,
			Date riskDate) throws SQLException {
		List<RiskScores> riskScores = new ArrayList<RiskScores>();
		Connection connection = null;
		PreparedStatement selectStmt = null;
		ResultSet results = null;
		try {
			connection = connectionManager.getConnection();
			selectStmt = connection.prepareStatement(SELECT_COLUMNS
				+ "WHERE NeighborhoodId=? AND RiskDate=? ORDER BY HourOfDay,ModelVersion;");
			selectStmt.setInt(1, neighborhood.getNeighborhoodId());
			selectStmt.setDate(2, DaoUtils.toSqlDate(riskDate));
			results = selectStmt.executeQuery();
			while (results.next()) {
				riskScores.add(fromResultSet(results, neighborhood));
			}
			return riskScores;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, selectStmt, results);
		}
	}

	public RiskScores updateRiskScore(RiskScores riskScore, BigDecimal newRiskScore)
			throws SQLException {
		String updateRiskScore = "UPDATE RiskScores SET RiskScore=? WHERE RiskScoreId=?;";
		Connection connection = null;
		PreparedStatement updateStmt = null;
		try {
			connection = connectionManager.getConnection();
			updateStmt = connection.prepareStatement(updateRiskScore);
			updateStmt.setBigDecimal(1, newRiskScore);
			updateStmt.setLong(2, riskScore.getRiskScoreId());
			updateStmt.executeUpdate();
			riskScore.setRiskScore(newRiskScore);
			return riskScore;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, updateStmt, null);
		}
	}

	public RiskScores delete(RiskScores riskScore) throws SQLException {
		String deleteRiskScore = "DELETE FROM RiskScores WHERE RiskScoreId=?;";
		Connection connection = null;
		PreparedStatement deleteStmt = null;
		try {
			connection = connectionManager.getConnection();
			deleteStmt = connection.prepareStatement(deleteRiskScore);
			deleteStmt.setLong(1, riskScore.getRiskScoreId());
			deleteStmt.executeUpdate();
			return null;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, deleteStmt, null);
		}
	}

	private static RiskScores fromResultSet(ResultSet results, Neighborhoods neighborhood)
			throws SQLException {
		return new RiskScores(
			results.getLong("RiskScoreId"),
			neighborhood,
			results.getDate("RiskDate"),
			results.getInt("HourOfDay"),
			results.getInt("IncidentCount"),
			results.getBigDecimal("RiskScore"),
			results.getString("ModelVersion"));
	}
}
