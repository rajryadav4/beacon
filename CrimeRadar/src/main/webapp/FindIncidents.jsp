<%@ page language="java" contentType="text/html; charset=UTF-8" pageEncoding="UTF-8"%>
<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core"%>
<%@ taglib prefix="fmt" uri="http://java.sun.com/jsp/jstl/fmt"%>
<c:set var="pageTitle" value="Find incidents" />
<c:set var="activeNav" value="incidents" />
<%@ include file="/WEB-INF/jspf/header.jspf" %>

<h1 class="h3 mb-3">Recent incidents by neighborhood</h1>

<form class="row g-2 mb-3" action="findincidents" method="get">
	<div class="col-sm-8 col-md-5">
		<label class="visually-hidden" for="neighborhoodid">Neighborhood</label>
		<select class="form-select" id="neighborhoodid" name="neighborhoodid">
			<c:forEach items="${neighborhoods}" var="n">
				<option value="${n.neighborhoodId}"
					<c:if test="${n.neighborhoodId == neighborhood.neighborhoodId}">selected</c:if>>
					<c:out value="${n.neighborhoodName}" />
				</option>
			</c:forEach>
		</select>
	</div>
	<div class="col-auto">
		<button class="btn btn-primary" type="submit">Search</button>
	</div>
</form>

<c:if test="${not empty crimeIncidents}">
	<div class="card shadow-sm">
		<div class="table-responsive">
			<table class="table table-hover table-sm mb-0">
				<thead class="table-light">
					<tr>
						<th>Incident</th>
						<th>Occurred</th>
						<th>Category</th>
						<th>Crime against</th>
						<th>Precinct</th>
						<th>Block</th>
						<th>Report #</th>
					</tr>
				</thead>
				<tbody>
					<c:forEach items="${crimeIncidents}" var="i">
						<tr>
							<td class="mono">${i.incidentId}</td>
							<td class="mono text-nowrap"><fmt:formatDate value="${i.occurredAt}" pattern="yyyy-MM-dd HH:mm" /></td>
							<td><c:out value="${i.crimeCategory.categoryName}" /></td>
							<td><c:out value="${i.crimeCategory.crimeAgainstCategory}" /></td>
							<td><c:out value="${i.policePrecinct.precinctName}" /></td>
							<td><c:out value="${i.blockAddress}" /></td>
							<td class="mono"><c:out value="${i.reportNumber}" /></td>
						</tr>
					</c:forEach>
				</tbody>
			</table>
		</div>
	</div>
</c:if>

<%@ include file="/WEB-INF/jspf/footer.jspf" %>
