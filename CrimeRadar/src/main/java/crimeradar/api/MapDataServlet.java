package crimeradar.api;

import crimeradar.service.MapDataCache;

import java.io.IOException;
import java.sql.SQLException;

import javax.servlet.annotation.WebServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

/**
 * GET api/meta, api/grid, api/neighborhoods. The JSON is built once and cached in memory
 * (MapDataCache). It is sent gzipped when the client asks for it, with an ETag so a
 * repeat visit can answer 304 Not Modified.
 */
@WebServlet(name = "MapDataServlet", urlPatterns = { "/api/meta", "/api/grid", "/api/neighborhoods" })
public class MapDataServlet extends ApiServlet {
	private static final long serialVersionUID = 1L;

	@Override
	protected void get(HttpServletRequest req, HttpServletResponse resp) throws Exception {
		String name = req.getServletPath().substring("/api/".length());
		MapDataCache.Entry entry;
		try {
			entry = MapDataCache.getInstance().get(name);
		} catch (SQLException e) {
			log("Map data is not ready", e);
			throw new ApiException(503,
				"Map data is not ready. Build the database summary tables first.");
		}
		if (entry == null) {
			throw new ApiException(404, "Not found.");
		}
		resp.setHeader("Cache-Control", "public, max-age=300");
		resp.setHeader("ETag", entry.etag);
		resp.setHeader("Vary", "Accept-Encoding");
		if (entry.etag.equals(req.getHeader("If-None-Match"))) {
			resp.setStatus(304);
			return;
		}
		boolean gzip = acceptsGzip(req.getHeader("Accept-Encoding"));
		byte[] body = gzip ? entry.gzip : entry.plain;
		resp.setStatus(200);
		resp.setContentType(JSON_TYPE);
		resp.setHeader("X-Content-Type-Options", "nosniff");
		if (gzip) {
			resp.setHeader("Content-Encoding", "gzip");
		}
		resp.setContentLength(body.length);
		if (!"HEAD".equals(req.getMethod())) {
			resp.getOutputStream().write(body);
		}
	}

	/** True when the Accept-Encoding header lists gzip (and not with q=0). */
	static boolean acceptsGzip(String header) throws IOException {
		if (header == null) {
			return false;
		}
		for (String part : header.split(",")) {
			String[] bits = part.trim().split(";");
			if (bits[0].trim().equalsIgnoreCase("gzip") || bits[0].trim().equals("*")) {
				for (int i = 1; i < bits.length; i++) {
					String p = bits[i].trim().replace(" ", "");
					if (p.equals("q=0") || p.equals("q=0.0") || p.equals("q=0.00")) {
						return false;
					}
				}
				return bits[0].trim().equalsIgnoreCase("gzip");
			}
		}
		return false;
	}
}
