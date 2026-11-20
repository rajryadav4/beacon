package crimeradar.service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import crimeradar.model.Coordinate;
import crimeradar.model.DataQuality;
import crimeradar.model.RecommendationResult;
import crimeradar.model.RouteOption;

/**
 * Turns recommendation records into Maps for {@link crimeradar.util.Json#write(Object)}.
 * Keys and nesting match the record component names (the same shape Gson produced), with
 * nulls kept, so existing clients of /recommendroutes see no change.
 */
public final class RecommendationJson {

    private RecommendationJson() {
    }

    public static Map<String, Object> result(RecommendationResult r) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("recommendedRoute", route(r.recommendedRoute(), true));
        m.put("fastestRoute", route(r.fastestRoute(), true));
        m.put("lowestExposureRoute", route(r.lowestExposureRoute(), true));
        List<Object> alternatives = new ArrayList<>();
        for (RouteOption route : r.alternativeRoutes()) {
            alternatives.add(route(route, true));
        }
        m.put("alternativeRoutes", alternatives);
        m.put("explanation", r.explanation());
        RecommendationResult.ComparisonMetrics c = r.comparisonMetrics();
        Map<String, Object> metrics = new LinkedHashMap<>();
        if (c != null) {
            metrics.put("validRouteCount", c.validRouteCount());
            metrics.put("eligibleRouteCount", c.eligibleRouteCount());
            metrics.put("maximumAdditionalSeconds", c.maximumAdditionalSeconds());
            metrics.put("additionalSeconds", c.additionalSeconds());
            metrics.put("additionalTimeFraction", c.additionalTimeFraction());
            metrics.put("exposureImprovementFraction", c.exposureImprovementFraction());
        }
        m.put("comparisonMetrics", c == null ? null : metrics);
        m.put("warnings", r.warnings());
        return m;
    }

    /** A route; {@code withGeometry=false} leaves out the coordinate list. */
    public static Map<String, Object> route(RouteOption route, boolean withGeometry) {
        if (route == null) {
            return null;
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("routeId", route.routeId());
        m.put("travelMode", route.travelMode() == null ? null : route.travelMode().name());
        m.put("distanceMeters", route.distanceMeters());
        m.put("durationSeconds", route.durationSeconds());
        if (withGeometry) {
            List<Object> geometry = new ArrayList<>(route.geometry().size());
            for (Coordinate c : route.geometry()) {
                Map<String, Object> point = new LinkedHashMap<>();
                point.put("longitude", c.longitude());
                point.put("latitude", c.latitude());
                geometry.add(point);
            }
            m.put("geometry", geometry);
        }
        m.put("historicalExposureScore", route.historicalExposureScore());
        m.put("dataQuality", dataQuality(route.dataQuality()));
        return m;
    }

    public static Map<String, Object> dataQuality(DataQuality q) {
        if (q == null) {
            return null;
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("confidence", q.confidence());
        m.put("matchedGeometryFraction", q.matchedGeometryFraction());
        m.put("demonstrationData", q.demonstrationData());
        m.put("messages", q.messages());
        return m;
    }
}
