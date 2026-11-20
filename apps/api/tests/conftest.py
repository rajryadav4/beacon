"""Shared test setup."""

from __future__ import annotations

import pytest

from app.db import pool


@pytest.fixture(scope="session", autouse=True)
def keep_pool_open():
    """Each test module starts the app with its own TestClient, and app shutdown
    closes the connection pool, which cannot be reopened. Keep it open until the
    whole session ends so every module can use it (opening an open pool is a no-op)."""
    close = pool.close
    pool.close = lambda *args, **kwargs: None
    yield
    pool.close = close
    pool.close()
