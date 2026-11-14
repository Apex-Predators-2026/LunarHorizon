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
    monkeypatch.setattr(tr, "tile_heights", lambda f, z, x, y, pad=0: np.arange(65 * 65, dtype=np.float32).reshape(65, 65))
    monkeypatch.setattr(tr, "max_zoom_for", lambda f, z, x, y: 3)
    r = client.get("/api/terrain/tile/5/3/1/2")
    assert r.status_code == 200 and r.headers["content-type"] == "application/octet-stream"
    h = np.frombuffer(r.content, "<f4")
    assert h.size == 65 * 65 and h[0] == 0 and h[-1] == 65 * 65 - 1
    assert r.headers["x-tile-leaf"] == "1" and r.headers["x-tile-max"] == "4224.0"


def test_padded_tile_adds_the_neighbours_ring(monkeypatch):
    # 67 x 67 values; the min/max headers describe the tile itself, not the ring.
    def heights(f, z, x, y, pad=0):
        h = np.full((65 + 2 * pad,) * 2, 100.0, dtype=np.float32)
        h[0, 0] = -999.0 if pad else 100.0  # only in the ring
        return h

    monkeypatch.setattr(tr, "tile_heights", heights)
    monkeypatch.setattr(tr, "max_zoom_for", lambda f, z, x, y: 13)
    r = client.get("/api/terrain/tile/5/4/3/2?pad=1")
    assert r.status_code == 200 and np.frombuffer(r.content, "<f4").size == 67 * 67
    assert r.headers["x-tile-min"] == "100.0" and r.headers["x-tile-leaf"] == "0"
    assert client.get("/api/terrain/tile/5/4/3/2?pad=2").status_code == 422  # only 0 or 1


def test_bad_tiles_404():
    assert client.get("/api/terrain/tile/6/0/0/0").status_code == 404  # no face 6
    assert client.get("/api/terrain/tile/5/2/4/0").status_code == 404  # x out of range at level 2
    assert client.get("/api/terrain/tile/5/14/0/0").status_code == 404  # deeper than the data


def test_source_outage_is_502(monkeypatch):
    def down(*_, **__):
        raise OSError("connection refused")

    monkeypatch.setattr(tr, "tile_heights", down)
    assert client.get("/api/terrain/tile/5/0/0/0").status_code == 502


def test_psr_passthrough(monkeypatch):
    monkeypatch.setattr(tr.psr, "load", lambda: {"psrs": [{"id": "x", "lat": -89, "lon": 10, "area_km2": 12, "note": None}], "ice": [[-88, 5]]})
    d = client.get("/api/psr").json()
    assert d["psrs"][0]["id"] == "x" and d["ice"] == [[-88, 5]]
