package crimeradar.dal;

import crimeradar.model.Neighborhoods;
import crimeradar.model.RouteSegments;
import crimeradar.model.Routes;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.List;

public class RouteSegmentsDao {
	protected ConnectionManager connectionManager;

	private static RouteSegmentsDao instance = null;

	protected RouteSegmentsDao() {
		connectionManager = new ConnectionManager();
	}

	public static RouteSegmentsDao getInstance() {
		if (instance == null) {
			instance = new RouteSegmentsDao();
		}
		return instance;
	}

	private static final String SELECT_COLUMNS =
		"SELECT SegmentId,RouteId,SegmentOrder,NeighborhoodId,DistanceMeters FROM RouteSegments ";

	public RouteSegments create(RouteSegments segment) throws SQLException {
		String insertSegment =
			"INSERT INTO RouteSegments(RouteId,SegmentOrder,NeighborhoodId,DistanceMeters) "
				+ "VALUES(?,?,?,?);";
		Connection connection = null;
		PreparedStatement insertStmt = null;
		try {
			connection = connectionManager.getConnection();
			insertStmt = connection.prepareStatement(insertSegment,
				Statement.RETURN_GENERATED_KEYS);
			insertStmt.setLong(1, segment.getRoute().getRouteId());
			insertStmt.setInt(2, segment.getSegmentOrder());
			Neighborhoods neighborhood = segment.getNeighborhood();
			insertStmt.setObject(3, neighborhood == null ? null : neighborhood.getNeighborhoodId(),
				Types.INTEGER);
			insertStmt.setObject(4, segment.getDistanceMeters(), Types.INTEGER);
			insertStmt.executeUpdate();
			segment.setSegmentId(DaoUtils.getGeneratedKey(insertStmt));
			return segment;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, insertStmt, null);
		}
	}

	public RouteSegments getRouteSegmentById(long segmentId) throws SQLException {
		Connection connection = null;
		PreparedStatement selectStmt = null;
		ResultSet results = null;
		try {
			connection = connectionManager.getConnection();
			selectStmt = connection.prepareStatement(SELECT_COLUMNS + "WHERE SegmentId=?;");
			selectStmt.setLong(1, segmentId);
			results = selectStmt.executeQuery();
			RoutesDao routesDao = RoutesDao.getInstance();
			if (results.next()) {
				Routes route = routesDao.getRouteById(results.getLong("RouteId"));
				return fromResultSet(results, route);
			}
			return null;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, selectStmt, results);
		}
	}

	/** The route's segments in travel order. */
	public List<RouteSegments> getRouteSegmentsForRoute(Routes route) throws SQLException {
		List<RouteSegments> segments = new ArrayList<RouteSegments>();
		Connection connection = null;
		PreparedStatement selectStmt = null;
		ResultSet results = null;
		try {
			connection = connectionManager.getConnection();
			selectStmt = connection.prepareStatement(
				SELECT_COLUMNS + "WHERE RouteId=? ORDER BY SegmentOrder;");
			selectStmt.setLong(1, route.getRouteId());
			results = selectStmt.executeQuery();
			while (results.next()) {
				segments.add(fromResultSet(results, route));
			}
			return segments;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, selectStmt, results);
		}
	}

	public RouteSegments delete(RouteSegments segment) throws SQLException {
		String deleteSegment = "DELETE FROM RouteSegments WHERE SegmentId=?;";
		Connection connection = null;
		PreparedStatement deleteStmt = null;
		try {
			connection = connectionManager.getConnection();
			deleteStmt = connection.prepareStatement(deleteSegment);
			deleteStmt.setLong(1, segment.getSegmentId());
			deleteStmt.executeUpdate();
			return null;
		} catch (SQLException e) {
			e.printStackTrace();
			throw e;
		} finally {
			DaoUtils.close(connection, deleteStmt, null);
		}
	}

	private static RouteSegments fromResultSet(ResultSet results, Routes route)
			throws SQLException {
		Integer neighborhoodId = results.getObject("NeighborhoodId", Integer.class);
		Neighborhoods neighborhood = neighborhoodId == null ? null
			: NeighborhoodsDao.getInstance().getNeighborhoodById(neighborhoodId);
		return new RouteSegments(
			results.getLong("SegmentId"),
			route,
			results.getInt("SegmentOrder"),
			neighborhood,
			results.getObject("DistanceMeters", Integer.class));
	}
}
