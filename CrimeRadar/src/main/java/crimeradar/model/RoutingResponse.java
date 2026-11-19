package crimeradar.model;

import java.util.List;

public record RoutingResponse(List<RouteOption> routes, List<String> warnings) {
    public RoutingResponse { routes = List.copyOf(routes); warnings = List.copyOf(warnings); }
}
