<%@ page language="java" contentType="text/html; charset=UTF-8" pageEncoding="UTF-8"%>
<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core"%>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Crime Radar: Safer Route</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin="">
<style>
	:root { --red: #C8102E; --ink: #1d1d1d; --muted: #666; --line: #ddd; --tint: #fbf1f2; }
	* { box-sizing: border-box; }
	body { margin: 0; font-family: "Helvetica Neue", Arial, sans-serif; color: var(--ink); background: #fff; }
	header { background: var(--red); color: #fff; padding: 12px 20px; display: flex; justify-content: space-between; align-items: center; }
	header h1 { font-size: 20px; margin: 0; }
	header a { color: #fff; }
	main { display: grid; grid-template-columns: 340px 1fr; gap: 20px; padding: 20px; }
	@media (max-width: 860px) { main { grid-template-columns: 1fr; } }
	fieldset { border: 1px solid var(--line); border-radius: 8px; margin: 0 0 14px; padding: 10px 12px; }
	legend { font-weight: bold; padding: 0 4px; }
	label { display: block; font-size: 14px; margin: 6px 0 2px; }
	input[type=number], input[type=datetime-local], select { width: 100%; padding: 6px; font-size: 14px; }
	.modes label { display: inline-block; margin-right: 12px; }
	.hint { font-size: 13px; color: var(--muted); margin: 4px 0; }
	.coords { font-size: 13px; font-family: Menlo, monospace; }
	.row { display: flex; gap: 10px; }
	.row > div { flex: 1; }
	button { font-size: 15px; padding: 9px 14px; border-radius: 6px; border: 1px solid var(--red); cursor: pointer; }
	button.primary { background: var(--red); color: #fff; width: 100%; }
	button.link { background: none; border: none; color: var(--red); padding: 4px 0; font-size: 13px; }
	#map { height: 460px; border-radius: 8px; border: 1px solid var(--line); }
	.error { color: var(--red); font-weight: bold; }
	.why { background: var(--tint); border-left: 5px solid var(--red); padding: 10px 14px; margin: 14px 0; border-radius: 0 6px 6px 0; }
	table { border-collapse: collapse; width: 100%; font-size: 14px; }
	th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); }
	tr.recommended td { font-weight: bold; background: var(--tint); }
	tr.over td { color: var(--muted); }
	.swatch { display: inline-block; width: 22px; height: 4px; vertical-align: middle; margin-right: 6px; }
	.notes { font-size: 13px; color: var(--muted); padding-left: 18px; }
</style>
</head>
<body>
	<header>
		<h1>Crime Radar: Safer Route</h1>
		<a href="findincidents">Find incidents</a>
	</header>

	<main>
		<form id="tripForm" action="recommend" method="get">
			<fieldset>
				<legend>Trip</legend>
				<p class="hint">Click the map to set the start, then click again for the destination, or pick a place below.</p>
				<label for="startPreset">Start</label>
				<select id="startPreset" data-target="start"><option value="">Choose a place…</option></select>
				<div class="coords" id="startText">Not set</div>
				<label for="endPreset">Destination</label>
				<select id="endPreset" data-target="end"><option value="">Choose a place…</option></select>
				<div class="coords" id="endText">Not set</div>
				<button type="button" class="link" id="clearPoints">Clear points</button>
				<input type="hidden" name="startLat" id="startLat" value="<c:out value='${startLat}'/>">
				<input type="hidden" name="startLng" id="startLng" value="<c:out value='${startLng}'/>">
				<input type="hidden" name="endLat" id="endLat" value="<c:out value='${endLat}'/>">
				<input type="hidden" name="endLng" id="endLng" value="<c:out value='${endLng}'/>">
			</fieldset>

			<fieldset class="modes">
				<legend>Travel mode</legend>
				<c:forEach items="${modes}" var="m">
					<label><input type="radio" name="mode" value="${m.name()}"
						<c:if test="${m.name() == mode}">checked</c:if>> <c:out value="${m.label()}"/></label>
				</c:forEach>
			</fieldset>

			<fieldset>
				<legend>When and how much detour</legend>
				<label for="departure">Departure time</label>
				<input type="datetime-local" id="departure" name="departure" value="<c:out value='${departure}'/>">
				<div class="row">
					<div>
						<label for="maxDetour">Max detour (%)</label>
						<input type="number" id="maxDetour" name="maxDetour" min="0" max="100" step="1" value="<c:out value='${maxDetour}'/>">
					</div>
					<div>
						<label for="maxExtra">Max extra (min)</label>
						<input type="number" id="maxExtra" name="maxExtra" min="0" max="60" step="1" value="<c:out value='${maxExtra}'/>">
					</div>
				</div>
				<p class="hint">The smaller limit applies. A safer route is only suggested if it fits.</p>
			</fieldset>

			<button type="submit" class="primary">Recommend a route</button>
			<p class="error"><c:out value="${messages.error}"/></p>
		</form>

		<section>
			<div id="map"></div>

			<c:if test="${not empty options}">
				<div class="why"><strong>Why this route?</strong> <c:out value="${explanation}"/></div>
				<table>
					<tr>
						<th></th><th>Route</th><th>Time</th><th>Distance</th>
						<th>Crime exposure</th><th>vs. fastest</th><th>Status</th>
					</tr>
					<c:forEach items="${options}" var="o">
						<tr class="${o.recommended ? 'recommended' : (o.withinLimit ? '' : 'over')}">
							<td><span class="swatch" style="background:${o.recommended ? '#C8102E' : '#8a8a8a'}"></span></td>
							<td><c:out value="${o.label}"/>
								<c:if test="${not empty o.tags}"><br><small><c:out value="${o.tags}"/></small></c:if></td>
							<td><c:out value="${o.durationText}"/></td>
							<td><c:out value="${o.distanceText}"/></td>
							<td><c:out value="${o.exposureText}"/></td>
							<td><c:out value="${o.versusFastestText}"/></td>
							<td><c:out value="${o.statusText}"/></td>
						</tr>
					</c:forEach>
				</table>
				<p class="hint">Time limit for this trip: <c:out value="${maxAllowedText}"/>.
					Crime exposure is a relative score of reported incidents along a route (lower is better),
					not the chance that something happens to you.</p>
				<ul class="notes">
					<c:forEach items="${notes}" var="n"><li><c:out value="${n}"/></li></c:forEach>
				</ul>
			</c:if>
		</section>
	</main>

	<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin=""></script>
	<script>
	(function () {
		// Built by RecommendRoute.java from numbers and fixed labels only.
		var routes = <c:out value="${routesJson}" default="[]" escapeXml="false"/>;
		var modeDefaults = <c:out value="${modeDefaultsJson}" default="{}" escapeXml="false"/>;

		// Approximate locations of well-known Seattle places.
		var places = [
			["Capitol Hill Station", 47.6191, -122.3203],
			["Pike Place Market", 47.6097, -122.3422],
			["Westlake Center", 47.6114, -122.3370],
			["Northeastern Seattle (South Lake Union)", 47.6222, -122.3374],
			["Space Needle", 47.6205, -122.3493],
			["Pioneer Square", 47.6015, -122.3343],
			["Chinatown-International District", 47.5982, -122.3238],
			["University of Washington", 47.6560, -122.3095],
			["Ballard", 47.6680, -122.3850]
		];

		var map = L.map("map").setView([47.6150, -122.3350], 13);
		L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
			maxZoom: 19,
			attribution: "&copy; OpenStreetMap contributors"
		}).addTo(map);

		var fields = {
			start: [document.getElementById("startLat"), document.getElementById("startLng")],
			end: [document.getElementById("endLat"), document.getElementById("endLng")]
		};
		var markers = { start: null, end: null };
		var colors = { start: "#1b7f3b", end: "#1d1d1d" };

		function hasPoint(which) {
			return fields[which][0].value !== "" && fields[which][1].value !== "";
		}

		function setPoint(which, lat, lng) {
			fields[which][0].value = lat.toFixed(6);
			fields[which][1].value = lng.toFixed(6);
			document.getElementById(which + "Text").textContent = lat.toFixed(5) + ", " + lng.toFixed(5);
			if (markers[which]) { map.removeLayer(markers[which]); }
			markers[which] = L.circleMarker([lat, lng], {
				radius: 8, color: "#fff", weight: 2, fillColor: colors[which], fillOpacity: 1
			}).addTo(map).bindTooltip(which === "start" ? "Start" : "Destination");
		}

		function clearPoint(which) {
			fields[which][0].value = "";
			fields[which][1].value = "";
			document.getElementById(which + "Text").textContent = "Not set";
			if (markers[which]) { map.removeLayer(markers[which]); markers[which] = null; }
		}

		["start", "end"].forEach(function (which) {
			if (hasPoint(which)) {
				setPoint(which, parseFloat(fields[which][0].value), parseFloat(fields[which][1].value));
			}
			var select = document.getElementById(which + "Preset");
			places.forEach(function (p, i) {
				var option = document.createElement("option");
				option.value = i;
				option.textContent = p[0];
				select.appendChild(option);
			});
			select.addEventListener("change", function () {
				if (select.value === "") { return; }
				var p = places[parseInt(select.value, 10)];
				setPoint(which, p[1], p[2]);
			});
		});

		map.on("click", function (e) {
			if (!hasPoint("start")) {
				setPoint("start", e.latlng.lat, e.latlng.lng);
			} else if (!hasPoint("end")) {
				setPoint("end", e.latlng.lat, e.latlng.lng);
			} else {
				clearPoint("end");
				setPoint("start", e.latlng.lat, e.latlng.lng);
			}
		});

		document.getElementById("clearPoints").addEventListener("click", function () {
			clearPoint("start");
			clearPoint("end");
		});

		// Switching mode resets the detour limits to that mode's defaults.
		document.querySelectorAll("input[name=mode]").forEach(function (radio) {
			radio.addEventListener("change", function () {
				var d = modeDefaults[radio.value];
				if (d) {
					document.getElementById("maxDetour").value = d.detour;
					document.getElementById("maxExtra").value = d.extra;
				}
			});
		});

		document.getElementById("tripForm").addEventListener("submit", function (e) {
			if (!hasPoint("start") || !hasPoint("end")) {
				e.preventDefault();
				alert("Set both a start and a destination first.");
			}
		});

		// Draw alternatives first (grey, dashed), then the recommended route on top (red).
		var bounds = [];
		routes.filter(function (r) { return !r.recommended; }).forEach(function (r) {
			L.polyline(r.path, { color: "#8a8a8a", weight: 4, opacity: 0.8, dashArray: r.withinLimit ? null : "6 8" })
				.addTo(map).bindTooltip(r.label);
			bounds = bounds.concat(r.path);
		});
		routes.filter(function (r) { return r.recommended; }).forEach(function (r) {
			L.polyline(r.path, { color: "#C8102E", weight: 6, opacity: 0.95 })
				.addTo(map).bindTooltip(r.label + " (recommended)");
			bounds = bounds.concat(r.path);
		});
		if (bounds.length > 0) {
			map.fitBounds(bounds, { padding: [30, 30] });
		} else if (hasPoint("start") && hasPoint("end")) {
			map.fitBounds([markers.start.getLatLng(), markers.end.getLatLng()], { padding: [40, 40] });
		}
	})();
	</script>
</body>
</html>
