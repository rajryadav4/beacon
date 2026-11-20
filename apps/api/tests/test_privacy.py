"""The caller's location never reaches the access log."""

import logging

from app.privacy import RedactLocation, redact


def test_redact_query():
    assert redact("/api/alerts/active?lat=47.61&lng=-122.33") == "/api/alerts/active?lat=redacted&lng=redacted"
    assert redact("/api/safe-places/nearest?hazard=flood&latitude=1&lon=2&limit=3") == \
        "/api/safe-places/nearest?hazard=flood&latitude=redacted&lon=redacted&limit=3"
    assert redact("/api/heatmap?band=night") == "/api/heatmap?band=night"


def test_filter_rewrites_uvicorn_access_args():
    record = logging.LogRecord("uvicorn.access", logging.INFO, "", 0, '%s - "%s %s HTTP/%s" %d',
                               ("127.0.0.1:5000", "GET", "/api/outlook?lat=47.6&lng=-122.3", "1.1", 200), None)
    assert RedactLocation().filter(record)
    assert "47.6" not in record.getMessage() and "lat=redacted" in record.getMessage()
