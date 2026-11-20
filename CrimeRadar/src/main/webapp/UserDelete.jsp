<%@ page language="java" contentType="text/html; charset=UTF-8" pageEncoding="UTF-8"%>
<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core"%>
<%@ taglib prefix="fmt" uri="http://java.sun.com/jsp/jstl/fmt"%>
<c:set var="pageTitle" value="Delete user" />
<c:set var="activeNav" value="users" />
<%@ include file="/WEB-INF/jspf/header.jspf" %>

<nav aria-label="breadcrumb"><ol class="breadcrumb">
	<li class="breadcrumb-item"><a href="findusers">Users</a></li>
	<li class="breadcrumb-item active" aria-current="page">Delete</li>
</ol></nav>

<c:choose>
	<c:when test="${deleted}">
		<p>The row is gone from <code>AppUsers</code>; looking it up by ID now returns nothing.</p>
		<a class="btn btn-outline-secondary" href="findusers">Back to users</a>
	</c:when>
	<c:when test="${not empty appUser}">
		<div class="row">
			<div class="col-lg-7">
				<div class="card border-danger shadow-sm">
					<div class="card-body">
						<h1 class="h4 card-title mb-3">Delete user #${appUser.userId}?</h1>
						<dl class="row mb-3">
							<dt class="col-4">Display name</dt><dd class="col-8"><c:out value="${appUser.displayName}" /></dd>
							<dt class="col-4">Email</dt><dd class="col-8"><c:out value="${appUser.email}" /></dd>
							<dt class="col-4">Created</dt><dd class="col-8 mono"><fmt:formatDate value="${appUser.createdAt}" pattern="yyyy-MM-dd HH:mm" /></dd>
						</dl>
						<div class="alert alert-warning small">
							This runs in one transaction: it deletes the user's
							<b>${contactCount}</b> emergency contact(s) and <b>${alertCount}</b> SOS alert(s),
							keeps their route recommendations without a user, then deletes the user.
						</div>
						<form action="userdelete" method="post">
							<input type="hidden" name="userid" value="${appUser.userId}">
							<button class="btn btn-danger" type="submit">Delete user</button>
							<a class="btn btn-link" href="findusers">Cancel</a>
						</form>
					</div>
				</div>
			</div>
		</div>
	</c:when>
</c:choose>

<%@ include file="/WEB-INF/jspf/footer.jspf" %>
