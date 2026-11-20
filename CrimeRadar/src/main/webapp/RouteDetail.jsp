<%@ page language="java" contentType="text/html; charset=UTF-8" pageEncoding="UTF-8"%>
<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core"%>
<%@ taglib prefix="fmt" uri="http://java.sun.com/jsp/jstl/fmt"%>
<c:set var="pageTitle" value="Route breakdown" />
<c:set var="activeNav" value="routes" />
<%@ include file="/WEB-INF/jspf/header.jspf" %>

<nav aria-label="breadcrumb"><ol class="breadcrumb">
	<li class="breadcrumb-item"><a href="saferoutes?days=${days}">Safe Routes</a></li>
	<li class="breadcrumb-item active" aria-current="page">Breakdown</li>
</ol></nav>

<c:if test="${not empty route}">
	<h1 class="h3 mb-1"><c:out value="${empty route.routeName ? 'Route' : route.routeName}" /> <span class="text-muted fs-6">#${route.routeId}</span></h1>
	<p class="text-muted">
		From (${route.startLatitude}, ${route.startLongitude}) to (${route.endLatitude}, ${route.endLongitude}).
		Crime window: ${days} days ending <fmt:formatDate value="${latestIncident}" pattern="yyyy-MM-dd" />.
	</p>

	<div class="row g-3 mb-3">
		<div class="col-sm-4"><div class="card card-body shadow-sm">
			<div class="text-muted small">Risk score</div>
			<div class="fs-3 fw-semibold mono"><fmt:formatNumber value="${totalRisk}" minFractionDigits="4" maxFractionDigits="4" /></div>
		</div></div>
		<div class="col-sm-4"><div class="card card-body shadow-sm">
			<div class="text-muted small">Length</div>
			<div class="fs-3 fw-semibold mono"><fmt:formatNumber value="${totalMeters / 1000}" minFractionDigits="2" maxFractionDigits="2" /> km</div>
		</div></div>
		<div class="col-sm-4"><div class="card card-body shadow-sm">
			<div class="text-muted small">Segments</div>
			<div class="fs-3 fw-semibold mono">${segmentRisks.size()}</div>
		</div></div>
	</div>

	<div class="card shadow-sm">
		<div class="table-responsive">
			<table class="table mb-0">
				<thead class="table-light">
					<tr>
						<th>#</th>
						<th>Neighborhood</th>
						<th class="text-end">km</th>
						<th class="text-end">Incidents (${days}d)</th>
						<th class="text-end">Incidents / day</th>
						<th class="text-end">km &times; rate</th>
						<th style="width: 22%">Share of risk</th>
					</tr>
				</thead>
				<tbody>
					<c:forEach items="${segmentRisks}" var="s">
						<tr>
							<td class="mono">${s.segmentOrder}</td>
							<td><c:out value="${empty s.neighborhoodName ? '(none)' : s.neighborhoodName}" /></td>
							<td class="text-end mono"><fmt:formatNumber value="${s.distanceMeters / 1000}" minFractionDigits="2" maxFractionDigits="2" /></td>
							<td class="text-end mono">${s.incidentsInWindow}</td>
							<td class="text-end mono"><fmt:formatNumber value="${s.incidentsPerDay}" minFractionDigits="4" maxFractionDigits="4" /></td>
							<td class="text-end mono fw-semibold"><fmt:formatNumber value="${s.contribution}" minFractionDigits="4" maxFractionDigits="4" /></td>
							<td>
								<c:if test="${maxContribution > 0}">
									<div class="risk-bar" style="width: ${s.contribution * 100 / maxContribution}%"></div>
								</c:if>
							</td>
						</tr>
					</c:forEach>
				</tbody>
				<tfoot class="table-light">
					<tr>
						<th colspan="5" class="text-end">Route risk score (sum)</th>
						<th class="text-end mono"><fmt:formatNumber value="${totalRisk}" minFractionDigits="4" maxFractionDigits="4" /></th>
						<th></th>
					</tr>
				</tfoot>
			</table>
		</div>
	</div>
</c:if>

<%@ include file="/WEB-INF/jspf/footer.jspf" %>
