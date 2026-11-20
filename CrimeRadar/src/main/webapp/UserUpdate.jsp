<%@ page language="java" contentType="text/html; charset=UTF-8" pageEncoding="UTF-8"%>
<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core"%>
<%@ taglib prefix="fmt" uri="http://java.sun.com/jsp/jstl/fmt"%>
<c:set var="pageTitle" value="Update user" />
<c:set var="activeNav" value="users" />
<%@ include file="/WEB-INF/jspf/header.jspf" %>

<nav aria-label="breadcrumb"><ol class="breadcrumb">
	<li class="breadcrumb-item"><a href="findusers">Users</a></li>
	<li class="breadcrumb-item active" aria-current="page">Update</li>
</ol></nav>

<c:if test="${not empty appUser}">
	<div class="row g-4">
		<div class="col-lg-6">
			<div class="card shadow-sm">
				<div class="card-body">
					<h1 class="h4 card-title mb-3">Update user #${appUser.userId}</h1>
					<dl class="row mb-3">
						<dt class="col-4">Email</dt><dd class="col-8"><c:out value="${appUser.email}" /></dd>
						<dt class="col-4">Created</dt><dd class="col-8 mono"><fmt:formatDate value="${appUser.createdAt}" pattern="yyyy-MM-dd HH:mm" /></dd>
						<dt class="col-4">Display name</dt><dd class="col-8 fw-semibold"><c:out value="${appUser.displayName}" /></dd>
					</dl>
					<form action="userupdate" method="post">
						<input type="hidden" name="userid" value="${appUser.userId}">
						<div class="mb-3">
							<label class="form-label" for="displayname">New display name</label>
							<input class="form-control" id="displayname" name="displayname" maxlength="100" required
								value="<c:out value='${appUser.displayName}'/>">
						</div>
						<button class="btn btn-primary" type="submit">Save changes</button>
						<a class="btn btn-link" href="<c:url value='findusers'><c:param name='q' value='${appUser.email}'/></c:url>">Back to list</a>
					</form>
				</div>
			</div>
		</div>
	</div>
</c:if>

<%@ include file="/WEB-INF/jspf/footer.jspf" %>
