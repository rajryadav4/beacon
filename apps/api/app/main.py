"""Beacon API (FastAPI + PostgreSQL/PostGIS)."""

from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import privacy, web
from .db import pool
from .routers import alerts, map_data, safe_places


privacy.install()


@asynccontextmanager
async def lifespan(_: FastAPI):
    pool.open(wait=True, timeout=10)
    yield
    pool.close()


app = FastAPI(title="Beacon API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("CORS_ORIGINS", "http://localhost:5173").split(","),
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)
app.include_router(map_data.router, prefix="/api")
app.include_router(safe_places.router, prefix="/api")
app.include_router(alerts.router, prefix="/api")


@app.get("/api/health")
def health() -> dict:
    with pool.connection() as conn:
        conn.execute("SELECT 1")
    return {"status": "ok", "database": "ok"}


# The built web app, when apps/web/dist (or WEB_DIST) exists: the Docker image serves both.
web.install(app)
