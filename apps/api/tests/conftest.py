"""Shared test setup."""

from __future__ import annotations

import os

import pytest

from app.db import pool

# Tests that need the full local data (SPD crime load, Seattle safe-places import).
# CI runs on the schema plus the committed ML risk output only and sets
# BEACON_TEST_DATA=schema, which skips these; new tests can use @pytest.mark.needs_data.
NEEDS_DATA = {
    "test_map_data.py": {"test_meta", "test_heatmap_all", "test_heatmap_filters_narrow_the_result"},
    "test_safe_places.py": {"test_safe_places_in_box", "test_safe_places_kind_filter",
                            "test_nearest_orders_by_rank_then_distance", "test_nearest_crime_goes_to_police",
                            "test_nearest_without_hazard_is_by_distance",
                            "test_nearest_falls_back_when_nothing_is_close"},
}


def pytest_configure(config):
    config.addinivalue_line("markers", "needs_data: needs the full local data load (skipped in CI)")


def pytest_collection_modifyitems(config, items):
    if os.environ.get("BEACON_TEST_DATA") != "schema":
        return
    skip = pytest.mark.skip(reason="needs the full data load (BEACON_TEST_DATA=schema)")
    for item in items:
        name = getattr(item, "originalname", item.name)
        if "needs_data" in item.keywords or name in NEEDS_DATA.get(item.path.name, ()):
            item.add_marker(skip)


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
