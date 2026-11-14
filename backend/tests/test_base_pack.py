"""The ready-made first view (scripts/build_base_pack.py): file layout, without network."""

import importlib.util
import struct
from pathlib import Path

import numpy as np

spec = importlib.util.spec_from_file_location("build_base_pack", Path(__file__).resolve().parents[1] / "scripts" / "build_base_pack.py")
bbp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bbp)


def test_layout_matches_the_frontend_reader(monkeypatch):
    side = bbp.N + 2

    def heights(f, z, x, y, pad=0):
        return np.full((side, side), 100.4 * (f + 1), dtype=np.float32) - 5000.0

    monkeypatch.setattr(bbp, "tile_heights", heights)
    monkeypatch.setattr(bbp, "max_zoom_for", lambda f, z, x, y: 13)
    data = bbp.build(1)
    assert data[:4] == b"LBP1"
    assert struct.unpack_from("<HH", data, 4) == (side, 6 * 5)
    face, z, x, y, leaf, _ = struct.unpack_from("<BBHHBB", data, 8)
    assert (face, z, x, y, leaf) == (0, 0, 0, 0, 0)
    first = np.frombuffer(data, "<i2", side * side, 16)
    assert (first == -4900).all()  # 100.4 - 5000 rounded to whole metres
    assert len(data) == 8 + 30 * (8 + 2 * side * side)


def test_imagery_layout_matches_the_frontend_reader(monkeypatch):
    calls = []

    def image(f, z, x, y, px):
        calls.append((f, z, x, y, px))
        return np.full((px, px), 10 * f + z, dtype=np.uint8)

    monkeypatch.setattr(bbp, "imagery_tile", image)
    data = bbp.build_imagery(1, 8)
    assert data[:4] == b"LIP1"
    assert struct.unpack_from("<HH", data, 4) == (6 * 5, 0)
    o, seen = 8, []
    for _ in range(30):
        face, z, x, y, _, _, n = struct.unpack_from("<BBHHBBI", data, o)
        assert data[o + 12 : o + 20] == b"\x89PNG\r\n\x1a\n"
        seen.append((face, z, x, y))
        o += 12 + n
    assert o == len(data)
    assert seen == [c[:4] for c in calls] and all(c[4] == 8 for c in calls)
