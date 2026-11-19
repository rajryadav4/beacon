package crimeradar.service;

import crimeradar.model.RouteRequest;
import crimeradar.model.RoutingResponse;

@FunctionalInterface
public interface RoutingService {
    RoutingResponse generateRoutes(RouteRequest request) throws RoutingException;
}
