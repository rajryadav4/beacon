"""Serving the built web app from the API origin (app/web.py). No database needed."""

from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app import web


@pytest.fixture
def client(tmp_path, monkeypatch):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>app</html>")
    (dist / "simulator.html").write_text("<html>simulator</html>")
    (dist / "favicon.svg").write_text("<svg/>")
    (dist / "assets" / "index-abc123.js").write_text("console.log(1)")
    (tmp_path / "secret.txt").write_text("outside dist")
    monkeypatch.setenv("WEB_DIST", str(dist))

    app = FastAPI()

    @app.get("/api/thing")
    def thing():
        return {"ok": True}

    @app.get("/api/missing")
    def missing():
        raise HTTPException(404, "no such thing")

    assert web.install(app)

    @app.get("/api/late")  # a router included after install() still wins
    def late():
        return {"late": True}

    return TestClient(app)


def test_index_and_deep_links(client):
    for path in ("/", "/map", "/alerts/123"):
        r = client.get(path)
        assert r.status_code == 200 and r.text == "<html>app</html>"
        assert r.headers["cache-control"] == "no-cache"


def test_extra_html_entry(client):
    assert client.get("/simulator").text == "<html>simulator</html>"
    assert client.get("/simulator.html").text == "<html>simulator</html>"


def test_assets(client):
    r = client.get("/assets/index-abc123.js")
    assert r.status_code == 200 and "immutable" in r.headers["cache-control"]
    assert client.get("/favicon.svg").text == "<svg/>"
    assert client.get("/assets/gone-999.js").status_code == 404


def test_api_wins(client):
    assert client.get("/api/thing").json() == {"ok": True}
    assert client.get("/api/late").json() == {"late": True}
    assert client.get("/api/missing").json() == {"detail": "no such thing"}
    r = client.get("/api/nope")
    assert r.status_code == 404 and r.json() == {"detail": "Not Found"}


def test_no_files_outside_dist(client):
    assert "outside dist" not in client.get("/../secret.txt").text
    assert "outside dist" not in client.get("/%2e%2e/secret.txt").text


def test_gzip(tmp_path, monkeypatch):
    monkeypatch.setenv("WEB_DIST", str(tmp_path / "nothing"))
    big = "x" * 5000
    app = FastAPI()

    @app.get("/api/big")
    def big_json():
        return {"big": big}

    web.install(app)
    r = TestClient(app).get("/api/big", headers={"Accept-Encoding": "gzip"})
    assert r.headers["content-encoding"] == "gzip" and r.json() == {"big": big}


def test_not_installed_without_dist(tmp_path, monkeypatch):
    monkeypatch.setenv("WEB_DIST", str(tmp_path / "nothing"))
    assert web.install(FastAPI()) is False
