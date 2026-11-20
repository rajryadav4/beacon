<%@ page language="java" contentType="text/html; charset=UTF-8" pageEncoding="UTF-8"%>
<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core"%>
<%@ taglib prefix="fmt" uri="http://java.sun.com/jsp/jstl/fmt"%>
<c:set var="pageTitle" value="Safe Routes" />
<c:set var="activeNav" value="routes" />
<%@ include file="/WEB-INF/jspf/header.jspf" %>

<div class="mb-3">
	<h1 class="h3 mb-1">Safe Routes: route risk score</h1>
	<p class="text-muted mb-0">
		Risk = &Sigma;<sub>segments</sub> (segment km &times; neighborhood incidents/day).
		Each segment is weighted by its neighborhood's crime rate over the last ${days} days of data
		(up to <fmt:formatDate value="${latestIncident}" pattern="yyyy-MM-dd" />). Lower is safer.
	</p>
</div>

<form class="card card-body shadow-sm mb-3" action="saferoutes" method="get">
	<div class="row g-2 align-items-end">
		<div class="col-md-4">
			<label class="form-label small" for="q">Route name contains</label>
			<input class="form-control" type="search" id="q" name="q" value="<c:out value='${q}'/>" placeholder="Any route">
		</div>
		<div class="col-6 col-md-2">
			<label class="form-label small" for="days">Crime window</label>
			<select class="form-select" id="days" name="days">
				<option value="30" ${days == 30 ? 'selected' : ''}>30 days</option>
				<option value="90" ${days == 90 ? 'selected' : ''}>90 days</option>
				<option value="365" ${days == 365 ? 'selected' : ''}>365 days</option>
			</select>
		</div>
		<div class="col-6 col-md-2">
			<label class="form-label small" for="rankby">Rank by</label>
			<select class="form-select" id="rankby" name="rankby">
				<option value="total" ${rankby == 'total' ? 'selected' : ''}>Total risk</option>
				<option value="perkm" ${rankby == 'perkm' ? 'selected' : ''}>Risk per km</option>
			</select>
		</div>
		<div class="col-6 col-md-2">
			<label class="form-label small" for="order">Order</label>
			<select class="form-select" id="order" name="order">
				<option value="safest" ${order == 'safest' ? 'selected' : ''}>Safest first</option>
				<option value="riskiest" ${order == 'riskiest' ? 'selected' : ''}>Riskiest first</option>
			</select>
		</div>
		<div class="col-3 col-md-1">
			<label class="form-label small" for="limit">Show</label>
			<select class="form-select" id="limit" name="limit">
				<option ${limit == 10 ? 'selected' : ''}>10</option>
				<option ${limit == 25 ? 'selected' : ''}>25</option>
				<option ${limit == 50 ? 'selected' : ''}>50</option>
				<option ${limit == 100 ? 'selected' : ''}>100</option>
			</select>
		</div>
		<div class="col-3 col-md-1 d-grid">
			<button class="btn btn-primary" type="submit">Rank</button>
		</div>
	</div>
</form>

<c:if test="${not empty routeRisks}">
	<div class="card shadow-sm">
		<div class="table-responsive">
			<table class="table table-hover mb-0">
				<thead class="table-light">
					<tr>
						<th>Rank</th>
						<th>Route</th>
						<th class="text-end">Segments</th>
						<th class="text-end">Length (km)</th>
						<th class="text-end">Risk score</th>
						<th class="text-end">Risk / km</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					<c:forEach items="${routeRisks}" var="rr">
						<tr>
							<td class="mono">${rr.rank}</td>
							<td>
								<c:out value="${empty rr.route.routeName ? 'Route' : rr.route.routeName}" />
								<span class="text-muted small">#${rr.route.routeId}</span>
							</td>
							<td class="text-end mono">${rr.segmentCount}</td>
							<td class="text-end mono"><fmt:formatNumber value="${rr.totalSegmentMeters / 1000}" minFractionDigits="2" maxFractionDigits="2" /></td>
							<td class="text-end mono fw-semibold"><fmt:formatNumber value="${rr.riskScore}" minFractionDigits="4" maxFractionDigits="4" /></td>
							<td class="text-end mono"><fmt:formatNumber value="${rr.riskPerKm}" minFractionDigits="4" maxFractionDigits="4" /></td>
							<td class="text-end"><a class="btn btn-sm btn-outline-secondary" href="routedetail?routeid=${rr.route.routeId}&days=${days}">Breakdown</a></td>
						</tr>
					</c:forEach>
				</tbody>
			</table>
		</div>
	</div>
</c:if>

<%@ include file="/WEB-INF/jspf/footer.jspf" %>
