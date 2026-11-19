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

/** api/me/* needs a signed-in user: 401 otherwise. */
@WebFilter(filterName = "AuthFilter", urlPatterns = "/api/me/*")
public class AuthFilter implements Filter {

	@Override
	public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain)
			throws IOException, ServletException {
		HttpServletRequest req = (HttpServletRequest) request;
		HttpServletResponse resp = (HttpServletResponse) response;
		if (ApiServlet.currentUserId(req) == null) {
			resp.setHeader("Cache-Control", "no-store");
			ApiServlet.error(resp, 401, "Please sign in.");
			return;
		}
		chain.doFilter(request, response);
	}
}
