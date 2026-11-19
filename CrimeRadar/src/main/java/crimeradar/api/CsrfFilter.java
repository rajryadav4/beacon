package crimeradar.api;

import java.io.IOException;

import javax.servlet.Filter;
import javax.servlet.FilterChain;
import javax.servlet.ServletException;
import javax.servlet.ServletRequest;
import javax.servlet.ServletResponse;
import javax.servlet.annotation.WebFilter;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

/**
 * CSRF guard for the whole API. A browser cannot send a custom header from another site
 * without a CORS preflight, so requiring "X-CrimeRadar: 1" on every state-changing request
 * blocks cross-site form posts. Also sets UTF-8 for form bodies.
 */
@WebFilter(filterName = "CsrfFilter", urlPatterns = "/api/*")
public class CsrfFilter implements Filter {

	public static final String HEADER = "X-CrimeRadar";

	@Override
	public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain)
			throws IOException, ServletException {
		HttpServletRequest req = (HttpServletRequest) request;
		HttpServletResponse resp = (HttpServletResponse) response;
		req.setCharacterEncoding("UTF-8");
		String method = req.getMethod();
		boolean safe = "GET".equals(method) || "HEAD".equals(method) || "OPTIONS".equals(method);
		if (!safe && !"1".equals(req.getHeader(HEADER))) {
			ApiServlet.error(resp, 403, "Missing " + HEADER + " header.");
			return;
		}
		chain.doFilter(request, response);
	}
}
