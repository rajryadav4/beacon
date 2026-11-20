"""Serve the built web app (apps/web/dist) from the API's own origin.

Used by the Docker image, so the browser calls relative /api/... with no CORS.
Nothing happens when the dist folder has no index.html (local development
runs the Vite dev server instead).

Static files are served from a 404 handler, not a catch-all route, so every
API route wins no matter when its router is included:

    /assets/index-abc.js -> dist/assets/index-abc.js (cached for a year: hashed names)
    /favicon.svg         -> dist/favicon.svg
    /simulator           -> dist/simulator.html (any extra HTML entry page)
    /any/deep/link       -> dist/index.html (the app routes on the client)
    /api/unknown         -> the API's JSON 404

WEB_DIST overrides the folder (default: apps/web/dist in the repository).
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exception_handlers import http_exception_handler
from fastapi.responses import FileResponse
from starlette.exceptions import HTTPException

DEFAULT_DIST = Path(__file__).resolve().parents[3] / "apps" / "web" / "dist"
HASHED = {"Cache-Control": "public, max-age=31536000, immutable"}
REVALIDATE = {"Cache-Control": "no-cache"}


def web_dist() -> Path:
    return Path(os.environ.get("WEB_DIST") or DEFAULT_DIST).resolve()


def resolve(dist: Path, url_path: str) -> Path | None:
    """The file for a URL path inside dist, or None (never a file outside dist)."""
    rel = url_path.strip("/")
    candidates = [rel, rel + ".html", rel + "/index.html"] if rel else ["index.html"]
    for candidate in candidates:
        path = (dist / candidate).resolve()
        if path.is_relative_to(dist) and path.is_file():
            return path
    return None


def install(app: FastAPI) -> bool:
    dist = web_dist()
    index = dist / "index.html"
    if not index.is_file():
        return False

    @app.exception_handler(HTTPException)
    async def serve_web(request: Request, exc: HTTPException):
        path = request.url.path
        if (exc.status_code != 404 or request.method not in ("GET", "HEAD")
                or path == "/api" or path.startswith("/api/")):
            return await http_exception_handler(request, exc)
        file = resolve(dist, path)
        if file is None:
            if Path(path).suffix:  # a missing asset, not a page
                return await http_exception_handler(request, exc)
            file = index
        headers = HASHED if file.parent.name == "assets" else REVALIDATE
        return FileResponse(file, headers=headers)

    return True
