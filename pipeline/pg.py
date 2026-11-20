"""Shared Postgres connection helper for the showcase pipeline scripts.

DATABASE_URL comes from the environment, then from a git-ignored .env file at
the repository root, then falls back to the docker-compose default.
"""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_URL = "postgresql://beacon:beacon-dev@localhost:5433/beacon"


def database_url() -> str:
    if os.environ.get("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            key, _, value = line.partition("=")
            if key.strip() == "DATABASE_URL" and value.strip():
                return value.strip()
    return DEFAULT_URL


def connect():
    import psycopg

    return psycopg.connect(database_url())
