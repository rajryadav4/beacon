<%@ page language="java" contentType="text/html; charset=UTF-8" pageEncoding="UTF-8"%>
<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core"%>
<%@ taglib prefix="fmt" uri="http://java.sun.com/jsp/jstl/fmt"%>
<c:set var="pageTitle" value="Create user" />
<c:set var="activeNav" value="users" />
<%@ include file="/WEB-INF/jspf/header.jspf" %>

<nav aria-label="breadcrumb"><ol class="breadcrumb">
	<li class="breadcrumb-item"><a href="findusers">Users</a></li>
	<li class="breadcrumb-item active" aria-current="page">Create</li>
</ol></nav>

<div class="row g-4">
	<div class="col-lg-6">
		<div class="card shadow-sm">
			<div class="card-body">
				<h1 class="h4 card-title mb-3">Create a user</h1>
				<form action="usercreate" method="post">
					<div class="mb-3">
						<label class="form-label" for="displayname">Display name</label>
						<input class="form-control" id="displayname" name="displayname" maxlength="100" required
							value="<c:out value='${empty appUser ? displayname : ""}'/>">
					</div>
					<div class="mb-3">
						<label class="form-label" for="email">Email</label>
						<input class="form-control" type="email" id="email" name="email" maxlength="255" required
							value="<c:out value='${empty appUser ? email : ""}'/>">
					</div>
					<div class="mb-3">
						<label class="form-label" for="password">Password</label>
						<input class="form-control" type="password" id="password" name="password" minlength="6" required>
						<div class="form-text">Stored as a SHA-256 hash, never in plain text.</div>
					</div>
					<button class="btn btn-primary" type="submit">Create user</button>
				</form>
			</div>
		</div>
	</div>

	<c:if test="${not empty appUser}">
		<div class="col-lg-6">
			<div class="card border-success shadow-sm">
				<div class="card-header bg-success-subtle">Row inserted into <code>AppUsers</code></div>
				<div class="card-body">
					<dl class="row mb-3">
						<dt class="col-4">User ID</dt><dd class="col-8 mono">${appUser.userId}</dd>
						<dt class="col-4">Display name</dt><dd class="col-8"><c:out value="${appUser.displayName}" /></dd>
						<dt class="col-4">Email</dt><dd class="col-8"><c:out value="${appUser.email}" /></dd>
						<dt class="col-4">Created</dt><dd class="col-8 mono"><fmt:formatDate value="${appUser.createdAt}" pattern="yyyy-MM-dd HH:mm:ss" /></dd>
						<dt class="col-4">Password hash</dt><dd class="col-8 mono small text-break"><c:out value="${appUser.passwordHash}" /></dd>
					</dl>
					<a class="btn btn-sm btn-outline-secondary" href="<c:url value='findusers'><c:param name='q' value='${appUser.email}'/></c:url>">See it in the user list</a>
					<a class="btn btn-sm btn-outline-primary" href="userupdate?userid=${appUser.userId}">Update</a>
					<a class="btn btn-sm btn-outline-danger" href="userdelete?userid=${appUser.userId}">Delete</a>
				</div>
			</div>
		</div>
	</c:if>
</div>

<%@ include file="/WEB-INF/jspf/footer.jspf" %>
