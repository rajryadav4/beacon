package crimeradar.servlet;

import crimeradar.service.MlRouteRiskScorer;

import javax.servlet.ServletContextEvent;
import javax.servlet.ServletContextListener;
import javax.servlet.annotation.WebListener;

/**
 * Registers the shared ML risk scorer (Person 1) as ServletContext attribute
 * {@value RecommendRoutes#RISK_SCORER_ATTRIBUTE}, where RecommendRoutes and the
 * /api/routes/recommend endpoint pick it up. The scorer reads MySQL lazily on its first use,
 * so the app starts even when the database is down.
 */
@WebListener
public class RouteServicesListener implements ServletContextListener {

    @Override
    public void contextInitialized(ServletContextEvent event) {
        if (event.getServletContext().getAttribute(RecommendRoutes.RISK_SCORER_ATTRIBUTE) == null) {
            event.getServletContext().setAttribute(RecommendRoutes.RISK_SCORER_ATTRIBUTE, new MlRouteRiskScorer());
        }
    }

    @Override
    public void contextDestroyed(ServletContextEvent event) {
        event.getServletContext().removeAttribute(RecommendRoutes.RISK_SCORER_ATTRIBUTE);
    }
}
