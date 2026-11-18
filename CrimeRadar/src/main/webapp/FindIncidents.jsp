<%@ page language="java" contentType="text/html; charset=UTF-8" pageEncoding="UTF-8"%>
<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core"%>
<%@ taglib prefix="fmt" uri="http://java.sun.com/jsp/jstl/fmt"%>
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Crime Radar: Find Incidents</title>
</head>
<body>
	<h1>Crime Radar</h1>

	<form action="findincidents" method="get">
		<label for="neighborhoodid">Neighborhood</label>
		<select id="neighborhoodid" name="neighborhoodid">
			<c:forEach items="${neighborhoods}" var="n">
				<option value="${n.neighborhoodId}"
					<c:if test="${n.neighborhoodId == neighborhood.neighborhoodId}">selected</c:if>>
					<c:out value="${n.neighborhoodName}" />
				</option>
			</c:forEach>
		</select>
		<input type="submit" value="Search">
	</form>

	<p><span id="successMessage"><b><c:out value="${messages.success}" /></b></span></p>
	<p><span id="errorMessage" style="color: red"><c:out value="${messages.error}" /></span></p>

	<c:if test="${not empty crimeIncidents}">
		<table border="1">
			<tr>
				<th>Incident</th>
				<th>Occurred</th>
				<th>Category</th>
				<th>Crime Against</th>
				<th>Precinct</th>
				<th>Block</th>
				<th>Report #</th>
			</tr>
			<c:forEach items="${crimeIncidents}" var="i">
				<tr>
					<td>${i.incidentId}</td>
					<td><fmt:formatDate value="${i.occurredAt}" pattern="yyyy-MM-dd HH:mm" /></td>
					<td><c:out value="${i.crimeCategory.categoryName}" /></td>
					<td><c:out value="${i.crimeCategory.crimeAgainstCategory}" /></td>
					<td><c:out value="${i.policePrecinct.precinctName}" /></td>
					<td><c:out value="${i.blockAddress}" /></td>
					<td><c:out value="${i.reportNumber}" /></td>
				</tr>
			</c:forEach>
		</table>
	</c:if>
</body>
</html>
