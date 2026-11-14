"""Terrain tile / PSR endpoints, with the data layer stubbed (no network)."""

import numpy as np
from fastapi.testclient import TestClient

import app.terrain_router as tr
from app.main import app

client = TestClient(app)


def test_info_describes_the_shared_tiling():
    d = client.get("/api/terrain/info").json()
    assert d["tile_size"] == 65 and d["max_zoom"] == 13 and len(d["faces"]) == 6


def test_tile_is_binary_float32(monkeypatch):
    monkeypatch.setattr(tr, "tile_heights", lambda f, z, x, y: np.arange(65 * 65, dtype=np.float32).reshape(65, 65))
    monkeypatch.setattr(tr, "max_zoom_for", lambda f, z, x, y: 3)
    r = client.get("/api/terrain/tile/5/3/1/2")
    assert r.status_code == 200 and r.headers["content-type"] == "application/octet-stream"
    h = np.frombuffer(r.content, "<f4")
    assert h.size == 65 * 65 and h[0] == 0 and h[-1] == 65 * 65 - 1
    assert r.headers["x-tile-leaf"] == "1" and r.headers["x-tile-max"] == "4224.0"


def test_bad_tiles_404():
    assert client.get("/api/terrain/tile/6/0/0/0").status_code == 404  # no face 6
    assert client.get("/api/terrain/tile/5/2/4/0").status_code == 404  # x out of range at level 2
    assert client.get("/api/terrain/tile/5/14/0/0").status_code == 404  # deeper than the data


def test_source_outage_is_502(monkeypatch):
    def down(*_):
        raise OSError("connection refused")

    monkeypatch.setattr(tr, "tile_heights", down)
    assert client.get("/api/terrain/tile/5/0/0/0").status_code == 502


def test_psr_passthrough(monkeypatch):
    monkeypatch.setattr(tr.psr, "load", lambda: {"psrs": [{"id": "x", "lat": -89, "lon": 10, "area_km2": 12, "note": None}], "ice": [[-88, 5]]})
    d = client.get("/api/psr").json()
    assert d["psrs"][0]["id"] == "x" and d["ice"] == [[-88, 5]]
