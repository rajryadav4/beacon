package crimeradar.service;

import crimeradar.model.*;
import crimeradar.util.Json;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;
import java.io.InputStream;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

/**
 * Runs tests/route-rules-cases.json against the Java rules. The browser copy (recommend.js) runs
 * the same file with `node tools/check_route_rules.mjs`, so the two cannot drift apart unnoticed.
 */
class RouteRulesSharedCasesTest {

    @TestFactory
    List<DynamicTest> sharedCases() throws Exception {
        Map<String, Object> root = obj(Json.parse(load()));
        List<DynamicTest> tests = new ArrayList<>();
        for (Object item : (List<?>) root.get("cases")) {
            Map<String, Object> c = obj(item);
            tests.add(DynamicTest.dynamicTest((String) c.get("name"), () -> run(c)));
        }
        assertFalse(tests.isEmpty());
        return tests;
    }

    private static void run(Map<String, Object> c) {
        TravelMode mode = TravelMode.parse((String) c.get("mode"));
        var settings = RecommendationSettings.forPreference(
                RecommendationSettings.Preference.parse((String) c.get("preference")));
        List<RouteOption> routes = new ArrayList<>();
        int n = 0;
        for (Object item : (List<?>) c.get("routes")) {
            Map<String, Object> r = obj(item);
            Object exposure = r.get("exposure");
            double offset = ++n * 0.001; // distinct geometry per route (identical paths are merged)
            routes.add(new RouteOption((String) r.get("id"), mode, num(r.get("distance")), num(r.get("duration")),
                    List.of(new Coordinate(-122.33, 47.60), new Coordinate(-122.33 + offset, 47.61),
                            new Coordinate(-122.32, 47.62)),
                    exposure == null ? null : num(exposure), null));
        }
        var result = new RecommendationService(settings).recommend(routes, mode);
        Map<String, Object> expect = obj(c.get("expect"));
        assertEquals(expect.get("recommendedId"), result.recommendedRoute().routeId(), result.explanation());
        Object texts = expect.get("explanationContains");
        if (texts != null) {
            for (Object text : (List<?>) texts) {
                assertTrue(result.explanation().contains((String) text),
                        "explanation lacks \"" + text + "\": " + result.explanation());
            }
        }
    }

    private static String load() throws Exception {
        try (InputStream in = RouteRulesSharedCasesTest.class.getClassLoader()
                .getResourceAsStream("route-rules-cases.json")) {
            if (in != null) {
                return new String(in.readAllBytes(), StandardCharsets.UTF_8);
            }
        }
        for (String path : List.of("../tests/route-rules-cases.json", "tests/route-rules-cases.json")) {
            if (Files.exists(Path.of(path))) {
                return Files.readString(Path.of(path));
            }
        }
        throw new IllegalStateException("tests/route-rules-cases.json not found");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> obj(Object o) { return (Map<String, Object>) o; }

    private static double num(Object o) { return ((BigDecimal) o).doubleValue(); }
}
