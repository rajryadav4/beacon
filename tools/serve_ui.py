"""Serve the CrimeRadar web UI without Tomcat (static files only).

The UI then runs in "offline data" mode: map data from assets/data/*.json and
the account in the browser. Start Tomcat (scripts/run-tomcat.ps1) for the full
app with the MySQL database.

Usage, from the repository root:

    python tools/serve_ui.py          # http://localhost:5500/
    python tools/serve_ui.py 8000
"""

import functools
import http.server
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "CrimeRadar" / "src" / "main" / "webapp"


class Handler(http.server.SimpleHTTPRequestHandler):
    # Explicit types: on Windows the registry can map .js to text/plain, which breaks ES modules.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json",
        ".svg": "image/svg+xml",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5500
    handler = functools.partial(Handler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"CrimeRadar UI (offline data mode): http://localhost:{port}/", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
