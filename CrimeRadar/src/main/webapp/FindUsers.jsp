<%@ page language="java" contentType="text/html; charset=UTF-8" pageEncoding="UTF-8"%>
<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core"%>
<%@ taglib prefix="fmt" uri="http://java.sun.com/jsp/jstl/fmt"%>
<c:set var="pageTitle" value="Users" />
<c:set var="activeNav" value="users" />
<%@ include file="/WEB-INF/jspf/header.jspf" %>

<div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
	<h1 class="h3 mb-0">App users</h1>
	<a class="btn btn-primary" href="usercreate">+ Create user</a>
</div>

<form class="row g-2 mb-3" action="findusers" method="get">
	<div class="col-sm-8 col-md-6">
		<input class="form-control" type="search" id="q" name="q" value="<c:out value='${q}'/>"
			placeholder="Search by display name or email" aria-label="Search users">
	</div>
	<div class="col-auto">
		<button class="btn btn-outline-secondary" type="submit">Search</button>
	</div>
</form>

<c:if test="${not empty appUsers}">
	<div class="card shadow-sm">
		<div class="table-responsive">
			<table class="table table-hover mb-0">
				<thead class="table-light">
					<tr>
						<th>User ID</th>
						<th>Display name</th>
						<th>Email</th>
						<th>Created</th>
						<th class="text-end">Actions</th>
					</tr>
				</thead>
				<tbody>
					<c:forEach items="${appUsers}" var="u">
						<tr>
							<td class="mono">${u.userId}</td>
							<td><c:out value="${u.displayName}" /></td>
							<td><c:out value="${u.email}" /></td>
							<td class="mono"><fmt:formatDate value="${u.createdAt}" pattern="yyyy-MM-dd HH:mm" /></td>
							<td class="text-end text-nowrap">
								<a class="btn btn-sm btn-outline-primary" href="userupdate?userid=${u.userId}">Update</a>
								<a class="btn btn-sm btn-outline-danger" href="userdelete?userid=${u.userId}">Delete</a>
							</td>
						</tr>
					</c:forEach>
				</tbody>
			</table>
		</div>
	</div>
</c:if>

<%@ include file="/WEB-INF/jspf/footer.jspf" %>
