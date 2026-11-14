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
