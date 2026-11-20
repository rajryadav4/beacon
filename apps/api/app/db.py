"""Connection pool. DATABASE_URL defaults to the docker-compose database."""

from __future__ import annotations

import os
from pathlib import Path

from psycopg_pool import ConnectionPool

DEFAULT_URL = "postgresql://crimeradar:crimeradar-dev@localhost:5433/crimeradar"


def database_url() -> str:
    if os.environ.get("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    env_file = Path(__file__).resolve().parents[3] / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            key, _, value = line.partition("=")
            if key.strip() == "DATABASE_URL" and value.strip():
                return value.strip()
    return DEFAULT_URL


pool = ConnectionPool(database_url(), min_size=1, max_size=8, open=False)
