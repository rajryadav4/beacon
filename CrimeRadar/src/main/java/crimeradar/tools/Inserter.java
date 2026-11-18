package crimeradar.tools;

import crimeradar.dal.AppUsersDao;
import crimeradar.dal.CrimeCategoriesDao;
import crimeradar.dal.CrimeIncidentsDao;
import crimeradar.dal.DataSourcesDao;
import crimeradar.dal.EmergencyCallsDao;
import crimeradar.dal.EmergencyContactsDao;
import crimeradar.dal.NeighborhoodsDao;
import crimeradar.dal.PolicePrecinctsDao;
import crimeradar.dal.RiskScoresDao;
import crimeradar.dal.RouteRecommendationsDao;
import crimeradar.dal.RouteSegmentsDao;
import crimeradar.dal.RoutesDao;
import crimeradar.dal.SOSAlertsDao;
import crimeradar.dal.SafetyResourcesDao;
import crimeradar.model.AppUsers;
import crimeradar.model.CrimeCategories;
import crimeradar.model.CrimeIncidents;
import crimeradar.model.DataSources;
import crimeradar.model.EmergencyCalls;
import crimeradar.model.EmergencyContacts;
import crimeradar.model.Neighborhoods;
import crimeradar.model.PolicePrecincts;
import crimeradar.model.RiskScores;
import crimeradar.model.RouteRecommendations;
import crimeradar.model.RouteRecommendations.RecommendationType;
import crimeradar.model.RouteSegments;
import crimeradar.model.Routes;
import crimeradar.model.SOSAlerts;
import crimeradar.model.SOSAlerts.AlertStatus;
import crimeradar.model.SafetyResources;

import java.math.BigDecimal;
import java.sql.SQLException;
import java.util.Date;
import java.util.List;

/**
 * Exercises every DAO against the CrimeRadar database: reads the loaded SPD data, then creates,
 * reads, updates and deletes test rows in each table. Everything it creates is deleted at the
 * end, so it is safe to run repeatedly.
 *
 * Run as a Java Application (right click > Run As > Java Application) and watch the console.
 */
public class Inserter {

	public static void main(String[] args) throws SQLException {
		// DAO instances.
		DataSourcesDao dataSourcesDao = DataSourcesDao.getInstance();
		PolicePrecinctsDao policePrecinctsDao = PolicePrecinctsDao.getInstance();
		CrimeCategoriesDao crimeCategoriesDao = CrimeCategoriesDao.getInstance();
		NeighborhoodsDao neighborhoodsDao = NeighborhoodsDao.getInstance();
		CrimeIncidentsDao crimeIncidentsDao = CrimeIncidentsDao.getInstance();
		EmergencyCallsDao emergencyCallsDao = EmergencyCallsDao.getInstance();
		SafetyResourcesDao safetyResourcesDao = SafetyResourcesDao.getInstance();
		RiskScoresDao riskScoresDao = RiskScoresDao.getInstance();
		AppUsersDao appUsersDao = AppUsersDao.getInstance();
		EmergencyContactsDao emergencyContactsDao = EmergencyContactsDao.getInstance();
		SOSAlertsDao sosAlertsDao = SOSAlertsDao.getInstance();
		RoutesDao routesDao = RoutesDao.getInstance();
		RouteSegmentsDao routeSegmentsDao = RouteSegmentsDao.getInstance();
		RouteRecommendationsDao routeRecommendationsDao = RouteRecommendationsDao.getInstance();

		// Unique suffix so repeated runs never collide on UNIQUE columns.
		String suffix = String.valueOf(System.currentTimeMillis());

		// READ: lookup tables loaded from the SPD data.
		section("Lookup tables");
		DataSources spd = dataSourcesDao.getDataSourceByDatasetIdentifier("tazs-3rd5");
		System.out.format("DataSource: id=%d name=%s url=%s%n",
			spd.getSourceId(), spd.getSourceName(), spd.getSourceURL());
		List<PolicePrecincts> precincts = policePrecinctsDao.getAllPolicePrecincts();
		System.out.format("PolicePrecincts: %d rows%n", precincts.size());
		for (PolicePrecincts p : precincts) {
			System.out.format("  %d %s%n", p.getPrecinctId(), p.getPrecinctName());
		}
		List<Neighborhoods> neighborhoods = neighborhoodsDao.getAllNeighborhoods();
		System.out.format("Neighborhoods: %d rows%n", neighborhoods.size());
		List<CrimeCategories> categories = crimeCategoriesDao.getAllCrimeCategories();
		System.out.format("CrimeCategories: %d rows%n", categories.size());
		System.out.format("CrimeCategories against PERSON: %d rows%n",
			crimeCategoriesDao.getCrimeCategoriesForCrimeAgainst("PERSON").size());

		// READ: crime incidents for one neighborhood.
		Neighborhoods neighborhood = neighborhoodsDao.getNeighborhoodByName(
			neighborhoods.get(0).getNeighborhoodName());
		section("Latest 5 CrimeIncidents in " + neighborhood.getNeighborhoodName());
		List<CrimeIncidents> incidents =
			crimeIncidentsDao.getCrimeIncidentsForNeighborhood(neighborhood, 5);
		for (CrimeIncidents i : incidents) {
			printIncident(i);
		}
		if (!incidents.isEmpty()) {
			CrimeIncidents first =
				crimeIncidentsDao.getCrimeIncidentById(incidents.get(0).getIncidentId());
			System.out.format("getCrimeIncidentById(%d) -> report %s%n",
				first.getIncidentId(), first.getReportNumber());
			Date to = first.getOccurredAt();
			Date from = new Date(to.getTime() - 30L * 24 * 60 * 60 * 1000);
			System.out.format("Incidents in the 30 days before that: %d (limit 1000)%n",
				crimeIncidentsDao.getCrimeIncidentsForNeighborhoodBetween(
					neighborhood, from, to, 1000).size());
		}
		System.out.format("Latest 3 incidents of category '%s': %d%n",
			categories.get(0).getCategoryName(),
			crimeIncidentsDao.getCrimeIncidentsForCategory(categories.get(0), 3).size());

		// CRUD: lookup tables, using a throwaway data source so the SPD rows are untouched.
		section("CRUD: DataSources, PolicePrecincts, Neighborhoods, CrimeCategories");
		DataSources testSource = dataSourcesDao.create(new DataSources(
			"Inserter test source", "TEST-" + suffix, "https://example.org", new Date()));
		System.out.format("Created DataSource %d%n", testSource.getSourceId());
		dataSourcesDao.updateLastImportedAt(testSource, new Date());
		System.out.format("Read back: %s%n",
			dataSourcesDao.getDataSourceById(testSource.getSourceId()).getDatasetIdentifier());

		PolicePrecincts testPrecinct =
			policePrecinctsDao.create(new PolicePrecincts("TEST PRECINCT " + suffix));
		Neighborhoods testNeighborhood = neighborhoodsDao.create(
			new Neighborhoods("TEST NEIGHBORHOOD " + suffix, null));
		neighborhoodsDao.updatePolicePrecinct(testNeighborhood, testPrecinct);
		System.out.format("Neighborhood %d now in precinct '%s'%n",
			testNeighborhood.getNeighborhoodId(),
			neighborhoodsDao.getNeighborhoodById(testNeighborhood.getNeighborhoodId())
				.getPolicePrecinct().getPrecinctName());
		System.out.format("Neighborhoods for test precinct: %d%n",
			neighborhoodsDao.getNeighborhoodsForPrecinct(testPrecinct).size());
		CrimeCategories testCategory = crimeCategoriesDao.create(
			new CrimeCategories("TEST CATEGORY " + suffix, "A", "PERSON"));
		System.out.format("Created CrimeCategory %d%n", testCategory.getCategoryId());

		// CRUD: CrimeIncidents and EmergencyCalls.
		section("CRUD: CrimeIncidents, EmergencyCalls");
		CrimeIncidents testIncident = crimeIncidentsDao.create(new CrimeIncidents(
			testSource, "TEST-" + suffix, "TEST-RPT", new Date(), new Date(), categories.get(0),
			testNeighborhood, testPrecinct, "100XX BLOCK OF TEST ST",
			new BigDecimal("47.6062000"), new BigDecimal("-122.3321000"), "T1"));
		System.out.format("Created CrimeIncident %d%n", testIncident.getIncidentId());
		crimeIncidentsDao.updateCrimeCategory(testIncident, testCategory);
		printIncident(crimeIncidentsDao.getCrimeIncidentById(testIncident.getIncidentId()));

		EmergencyCalls testCall = emergencyCallsDao.create(new EmergencyCalls(testSource,
			"TEST-" + suffix, new Date(), "Disturbance", testNeighborhood,
			new BigDecimal("47.6062000"), new BigDecimal("-122.3321000")));
		System.out.format("Created EmergencyCall %d, read back type '%s'%n",
			testCall.getCallId(),
			emergencyCallsDao.getEmergencyCallById(testCall.getCallId()).getCallType());
		System.out.format("EmergencyCalls for test neighborhood: %d%n",
			emergencyCallsDao.getEmergencyCallsForNeighborhood(testNeighborhood, 10).size());

		// CRUD: SafetyResources and RiskScores.
		section("CRUD: SafetyResources, RiskScores");
		SafetyResources testResource = safetyResourcesDao.create(new SafetyResources(
			testNeighborhood, "Test Clinic", "Clinic", "206-555-0000", "https://example.org"));
		safetyResourcesDao.updateContactInfo(testResource, "206-555-9999");
		System.out.format("SafetyResource %d contact now %s%n", testResource.getResourceId(),
			safetyResourcesDao.getSafetyResourceById(testResource.getResourceId())
				.getContactInfo());
		System.out.format("SafetyResources for test neighborhood: %d%n",
			safetyResourcesDao.getSafetyResourcesForNeighborhood(testNeighborhood).size());

		Date today = new Date();
		RiskScores testRisk = riskScoresDao.create(new RiskScores(
			testNeighborhood, today, 22, 3, new BigDecimal("41.5000"), "test"));
		riskScoresDao.updateRiskScore(testRisk, new BigDecimal("55.2500"));
		System.out.format("RiskScore %d now %s%n", testRisk.getRiskScoreId(),
			riskScoresDao.getRiskScoreById(testRisk.getRiskScoreId()).getRiskScore());
		System.out.format("RiskScores for test neighborhood today: %d%n",
			riskScoresDao.getRiskScoresForNeighborhoodOnDate(testNeighborhood, today).size());

		// CRUD: AppUsers and their EmergencyContacts and SOSAlerts.
		section("CRUD: AppUsers, EmergencyContacts, SOSAlerts");
		AppUsers testUser = appUsersDao.create(new AppUsers("Test User",
			"test" + suffix + "@example.com", AppUsersDao.hashPassword("secret")));
		appUsersDao.updateDisplayName(testUser, "Renamed Test User");
		AppUsers readUser = appUsersDao.getAppUserByEmail(testUser.getEmail());
		System.out.format("AppUser %d: %s <%s>%n",
			readUser.getUserId(), readUser.getDisplayName(), readUser.getEmail());
		System.out.format("Seed user1@example.com is %s%n",
			appUsersDao.getAppUserByEmail("user1@example.com") == null ? "missing" : "present");
		System.out.format("Users named 'User 1': %d%n",
			appUsersDao.getAppUsersByDisplayName("User 1").size());

		EmergencyContacts contact1 = emergencyContactsDao.create(
			new EmergencyContacts(testUser, "Alice", "206-555-1111", "Friend"));
		EmergencyContacts contact2 = emergencyContactsDao.create(
			new EmergencyContacts(testUser, "Bob", "206-555-2222", "Sibling"));
		emergencyContactsDao.updatePhoneNumber(contact2, "206-555-3333");
		System.out.format("Contact %d phone now %s%n", contact2.getContactId(),
			emergencyContactsDao.getEmergencyContactById(contact2.getContactId())
				.getPhoneNumber());
		emergencyContactsDao.delete(contact1);
		System.out.format("Contacts after deleting one: %d%n",
			emergencyContactsDao.getEmergencyContactsForUser(testUser).size());

		SOSAlerts alert = sosAlertsDao.create(new SOSAlerts(testUser, null,
			new BigDecimal("47.6100000"), new BigDecimal("-122.3400000"), null));
		System.out.format("SOSAlert %d created with status %s%n",
			alert.getAlertId(), alert.getAlertStatus());
		sosAlertsDao.updateAlertStatus(alert, AlertStatus.RESOLVED);
		System.out.format("SOSAlert %d status now %s%n", alert.getAlertId(),
			sosAlertsDao.getSOSAlertById(alert.getAlertId()).getAlertStatus());
		System.out.format("Alerts for user: %d%n",
			sosAlertsDao.getSOSAlertsForUser(testUser).size());

		// CRUD: Routes, RouteSegments, RouteRecommendations.
		section("CRUD: Routes, RouteSegments, RouteRecommendations");
		Routes route = routesDao.create(new Routes("Test Route",
			new BigDecimal("47.6000000"), new BigDecimal("-122.3300000"),
			new BigDecimal("47.6200000"), new BigDecimal("-122.3500000"), 2500));
		routesDao.updateRouteName(route, "Renamed Test Route");
		System.out.format("Route %d: %s%n", route.getRouteId(),
			routesDao.getRouteById(route.getRouteId()).getRouteName());
		RouteSegments segment1 = routeSegmentsDao.create(
			new RouteSegments(route, 1, testNeighborhood, 1200));
		routeSegmentsDao.create(new RouteSegments(route, 2, null, 1300));
		System.out.format("Segment %d is order %d%n", segment1.getSegmentId(),
			routeSegmentsDao.getRouteSegmentById(segment1.getSegmentId()).getSegmentOrder());
		System.out.format("Segments for route: %d%n",
			routeSegmentsDao.getRouteSegmentsForRoute(route).size());
		RouteRecommendations recommendation = routeRecommendationsDao.create(
			new RouteRecommendations(testUser, route, null, new BigDecimal("12.3400"),
				RecommendationType.SAFEST));
		System.out.format("Recommendation %d type %s%n", recommendation.getRecommendationId(),
			routeRecommendationsDao.getRouteRecommendationById(
				recommendation.getRecommendationId()).getRecommendationType());
		System.out.format("Recommendations for user: %d%n",
			routeRecommendationsDao.getRouteRecommendationsForUser(testUser).size());

		// DELETE: clean up everything created above, children before parents.
		section("Cleanup");
		appUsersDao.delete(testUser);
		System.out.format("Deleted user; getAppUserById -> %s%n",
			appUsersDao.getAppUserById(testUser.getUserId()));
		System.out.format("Recommendation kept with no user: %s%n",
			routeRecommendationsDao.getRouteRecommendationById(
				recommendation.getRecommendationId()).getAppUser());
		routesDao.delete(route);
		System.out.format("Deleted route; segments left: %d%n",
			routeSegmentsDao.getRouteSegmentsForRoute(route).size());
		riskScoresDao.delete(testRisk);
		safetyResourcesDao.delete(testResource);
		emergencyCallsDao.delete(testCall);
		crimeIncidentsDao.delete(testIncident);
		crimeCategoriesDao.delete(testCategory);
		neighborhoodsDao.delete(testNeighborhood);
		policePrecinctsDao.delete(testPrecinct);
		dataSourcesDao.delete(testSource);
		System.out.format("Test data source after delete: %s%n",
			dataSourcesDao.getDataSourceById(testSource.getSourceId()));
		System.out.println("Done.");
	}

	private static void section(String title) {
		System.out.println();
		System.out.println("== " + title + " ==");
	}

	private static void printIncident(CrimeIncidents i) {
		System.out.format("  #%d %s | %s | %s | %s%n",
			i.getIncidentId(),
			i.getOccurredAt(),
			i.getCrimeCategory().getCategoryName(),
			i.getNeighborhood() == null ? "-" : i.getNeighborhood().getNeighborhoodName(),
			i.getBlockAddress());
	}
}
