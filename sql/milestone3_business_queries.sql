-- ============================================================
-- CS5200: DATABASE SYSTEMS | PROJECT: CRIME RADAR
-- MILESTONE 3: BUSINESS INSIGHTS
-- Run after sql/crime_radar_all.sql has built and loaded the database.
-- ============================================================

USE CrimeRadar;


-- Q1. Which Seattle neighborhoods have the highest number of reported crimes?
SELECT Neighborhoods.NeighborhoodName,
       COUNT(CrimeIncidents.IncidentId) AS TotalCrimes
FROM Neighborhoods
INNER JOIN CrimeIncidents
        ON Neighborhoods.NeighborhoodId = CrimeIncidents.NeighborhoodId
GROUP BY Neighborhoods.NeighborhoodId,
         Neighborhoods.NeighborhoodName
ORDER BY TotalCrimes DESC
LIMIT 10;


-- Q2. Which months experienced the highest number of reported crime incidents?
SELECT YEAR(CrimeIncidents.OccurredAt)  AS CrimeYear,
       MONTH(CrimeIncidents.OccurredAt) AS CrimeMonth,
       COUNT(*)                         AS TotalCrimes
FROM CrimeIncidents
WHERE CrimeIncidents.OccurredAt IS NOT NULL
GROUP BY YEAR(CrimeIncidents.OccurredAt),
         MONTH(CrimeIncidents.OccurredAt)
ORDER BY TotalCrimes DESC;


-- Q3. Which police precincts have the highest number of reported crimes?
SELECT PolicePrecincts.PrecinctName,
       COUNT(CrimeIncidents.IncidentId) AS TotalCrimes
FROM PolicePrecincts
LEFT OUTER JOIN CrimeIncidents
             ON PolicePrecincts.PrecinctId = CrimeIncidents.PrecinctId
GROUP BY PolicePrecincts.PrecinctId,
         PolicePrecincts.PrecinctName
ORDER BY TotalCrimes DESC;


-- Q4. What are the most common types of 911 emergency calls?
SELECT EmergencyCalls.CallType,
       COUNT(EmergencyCalls.CallId) AS TotalCalls
FROM EmergencyCalls
GROUP BY EmergencyCalls.CallType
ORDER BY TotalCalls DESC
LIMIT 10;


-- Q5. At what hours of the day are most crimes reported?
SELECT HOUR(OccurredAt) AS HourOfDay,
       COUNT(*)         AS TotalCrimes
FROM CrimeIncidents
WHERE OccurredAt IS NOT NULL
GROUP BY HOUR(OccurredAt)
ORDER BY TotalCrimes DESC;


-- Q6. How has reported crime changed year over year?
SELECT YEAR(OccurredAt) AS CrimeYear,
       COUNT(*)         AS TotalCrimes
FROM CrimeIncidents
WHERE OccurredAt IS NOT NULL
GROUP BY YEAR(OccurredAt)
ORDER BY CrimeYear;


-- Q7. Which police precincts take the longest for a crime to be reported?
--     Average hours between when a crime happened and when it was reported.
SELECT pp.PrecinctName,
       AVG(TIMESTAMPDIFF(HOUR, ci.OccurredAt, ci.ReportedAt)) AS AvgHoursToReport
FROM CrimeIncidents ci
JOIN PolicePrecincts pp
  ON ci.PrecinctId = pp.PrecinctId
WHERE ci.OccurredAt IS NOT NULL
  AND ci.ReportedAt IS NOT NULL
GROUP BY pp.PrecinctName
ORDER BY AvgHoursToReport DESC;


-- Q8. Which neighborhoods are most dangerous for people after dark,
--     and how much riskier is night (8 PM-4 AM) than day (8 AM-4 PM)?
SELECT n.NeighborhoodName,
       SUM(HOUR(ci.OccurredAt) >= 20 OR HOUR(ci.OccurredAt) < 4) AS NightCrimes,
       SUM(HOUR(ci.OccurredAt) BETWEEN 8 AND 15)                 AS DayCrimes,
       ROUND(SUM(HOUR(ci.OccurredAt) >= 20 OR HOUR(ci.OccurredAt) < 4)
             / NULLIF(SUM(HOUR(ci.OccurredAt) BETWEEN 8 AND 15), 0), 2) AS NightToDayRatio
FROM CrimeIncidents ci
JOIN Neighborhoods n    ON n.NeighborhoodId = ci.NeighborhoodId
JOIN CrimeCategories cc ON cc.CategoryId = ci.CategoryId
WHERE cc.CrimeAgainstCategory = 'PERSON'
GROUP BY n.NeighborhoodName
ORDER BY NightCrimes DESC
LIMIT 10;


-- Q9. Are weekends more dangerous than weekdays?
SELECT DAYNAME(ci.OccurredAt) AS DayOfWeek,
       CASE WHEN DAYOFWEEK(ci.OccurredAt) IN (1, 7)
            THEN 'Weekend' ELSE 'Weekday' END AS DayType,
       COUNT(*)                                            AS TotalCrimes,
       SUM(cc.CrimeAgainstCategory = 'PERSON')             AS CrimesAgainstPeople,
       ROUND(100 * SUM(cc.CrimeAgainstCategory = 'PERSON') / COUNT(*), 1) AS PctAgainstPeople
FROM CrimeIncidents ci
JOIN CrimeCategories cc ON cc.CategoryId = ci.CategoryId
WHERE ci.OccurredAt IS NOT NULL
GROUP BY DAYOFWEEK(ci.OccurredAt), DAYNAME(ci.OccurredAt), DayType
ORDER BY TotalCrimes DESC;


-- Q10. Which neighborhoods (with 500+ incidents) have the most reported crime,
--      and which precinct covers each?
SELECT n.NeighborhoodName,
       pp.PrecinctName,
       COUNT(ci.IncidentId) AS TotalCrimes
FROM Neighborhoods n
JOIN CrimeIncidents ci  ON ci.NeighborhoodId = n.NeighborhoodId
JOIN PolicePrecincts pp ON pp.PrecinctId = n.PrecinctId
WHERE n.NeighborhoodName NOT IN ('UNKNOWN', 'OOJ')
GROUP BY n.NeighborhoodId, n.NeighborhoodName, pp.PrecinctName
HAVING COUNT(ci.IncidentId) >= 500
ORDER BY TotalCrimes DESC
LIMIT 10;


-- Q11. Route risk = SUM over segments of (segment km x neighborhood incidents/day),
--      where a neighborhood's rate is its incidents per day over the last 90 days.
WITH NeighborhoodCrimeRate AS (
    SELECT n.NeighborhoodId,
           COUNT(ci.IncidentId) / 90 AS IncidentsPerDay
    FROM Neighborhoods n
    LEFT JOIN CrimeIncidents ci
           ON ci.NeighborhoodId = n.NeighborhoodId
          AND ci.OccurredAt >= NOW() - INTERVAL 90 DAY
    GROUP BY n.NeighborhoodId
)
SELECT r.RouteId,
       r.RouteName,
       COUNT(rs.SegmentId)                 AS SegmentCount,
       SUM(COALESCE(rs.DistanceMeters, 0)) AS TotalSegmentMeters,
       ROUND(SUM(COALESCE(rs.DistanceMeters, 0) / 1000.0
                 * COALESCE(ncr.IncidentsPerDay, 0)), 4) AS RiskScore,
       ROUND(SUM(COALESCE(rs.DistanceMeters, 0) / 1000.0
                 * COALESCE(ncr.IncidentsPerDay, 0))
             / NULLIF(SUM(COALESCE(rs.DistanceMeters, 0)) / 1000.0, 0), 4) AS RiskPerKm
FROM Routes r
JOIN RouteSegments rs
  ON rs.RouteId = r.RouteId
LEFT JOIN NeighborhoodCrimeRate ncr
       ON ncr.NeighborhoodId = rs.NeighborhoodId
GROUP BY r.RouteId, r.RouteName
ORDER BY RiskScore ASC;
