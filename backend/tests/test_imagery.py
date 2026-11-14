"""LRO WAC imagery layer: PNG encoding, tile orientation, no-data handling, endpoint (no network)."""

import struct
import zlib

import numpy as np
from fastapi.testclient import TestClient

import app.engine.imagery as im
import app.terrain_router as tr
from app.engine.dem import DemSource, _BlockStore
from app.main import app

client = TestClient(app)


def _decode_png_gray(png: bytes) -> np.ndarray:
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    pos, idat, w, h = 8, b"", 0, 0
    while pos < len(png):
        n, kind = struct.unpack(">I4s", png[pos : pos + 8])
        data = png[pos + 8 : pos + 8 + n]
        assert zlib.crc32(kind + data) & 0xFFFFFFFF == struct.unpack(">I", png[pos + 8 + n : pos + 12 + n])[0]
        if kind == b"IHDR":
            w, h, depth, colour = struct.unpack(">IIBB", data[:10])
            assert (depth, colour) == (8, 0)  # 8-bit grayscale
        elif kind == b"IDAT":
            idat += data
        pos += 12 + n
    rows = zlib.decompress(idat)
    return np.array([list(rows[r * (w + 1) + 1 : (r + 1) * (w + 1)]) for r in range(h)], dtype=np.uint8)


def test_png_round_trips():
    img = (np.arange(12 * 7) % 256).astype(np.uint8).reshape(7, 12)
    assert np.array_equal(_decode_png_gray(im.png_gray(img)), img)


def test_tile_image_top_row_is_the_tiles_top_edge(monkeypatch):
    # Brightness = the sample's grid row j (v index), so the image's row order shows the orientation.
    def fake(lat, lon, spacing):
        n = int(np.sqrt(lat.size))
        return np.repeat(np.arange(n, dtype=float), n)  # grid row j (v index) -> brightness j

    monkeypatch.setattr(im, "sample_imagery", fake)
    img = im.imagery_tile(5, 3, 2, 5, px=16)
    assert img.shape == (16, 16)
    assert img[0, 0] == 15 and img[-1, 0] == 0  # row 0 = largest v (texture "top")


def test_zero_is_no_data_even_for_blocks_cached_before(tmp_path):
    src = DemSource("img", "Fake", "sp", 100, (0, 0, 1000, 1000), 100, "U8", True)
    path = tmp_path / "img" / "0" / "0_0.npy"
    path.parent.mkdir(parents=True)
    np.save(path, np.array([[0, 5], [9, 0]], dtype=np.float32))
    block = _BlockStore(tmp_path).get(src, 0, 0, 0)
    assert np.isnan(block[0, 0]) and np.isnan(block[1, 1]) and block[0, 1] == 5 and block[1, 0] == 9


def test_imagery_endpoint(monkeypatch):
    monkeypatch.setattr(tr, "imagery_tile", lambda f, z, x, y: np.full((4, 4), 77, dtype=np.uint8))
    tr._imagery_png.cache_clear()
    r = client.get("/api/imagery/tile/5/2/1/3")
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    assert (_decode_png_gray(r.content) == 77).all()
    assert client.get("/api/imagery/tile/5/8/0/0").status_code == 404  # deeper tiles use their ancestor
    assert client.get("/api/imagery/tile/6/0/0/0").status_code == 404


def test_imagery_outage_is_502(monkeypatch):
    def down(*_, **__):
        raise OSError("Moon Trek unreachable")

    monkeypatch.setattr(tr, "imagery_tile", down)
    tr._imagery_png.cache_clear()
    assert client.get("/api/imagery/tile/5/1/0/0").status_code == 502
