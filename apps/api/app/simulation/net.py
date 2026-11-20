"""Outbound HTTP for the simulator (free public services only, no API keys).

Uses the standard library. TLS verification uses certifi's CA bundle when it is
installed (python.org builds of Python on macOS ship without one).
Requests carry only coordinates, never names, emails or other personal data.
"""

from __future__ import annotations

import json
import ssl
import urllib.request

USER_AGENT = "beacon-dev/0.1 (+https://github.com/rajryadav4/beacon)"


def _context() -> ssl.SSLContext:
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


_SSL = _context()


def fetch_bytes(url: str, timeout: float = 10, body: dict | None = None) -> bytes:
    headers = {"User-Agent": USER_AGENT, "Accept": "*/*"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout, context=_SSL) as resp:
        return resp.read()


def fetch_json(url: str, timeout: float = 10, body: dict | None = None) -> dict:
    return json.loads(fetch_bytes(url, timeout=timeout, body=body))
