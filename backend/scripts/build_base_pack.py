"""Build the ready-made first view: the coarsest terrain tiles of the whole Moon in one small file
that ships with the frontend (frontend/public/terrain/base.bin), so the globe appears as soon as
the page loads, without waiting for the backend or Moon Trek. Finer tiles still stream as usual.

Run from backend/ (after changing the terrain sources or the tiling):
    .venv\\Scripts\\python.exe scripts\\build_base_pack.py [--max-zoom 2]

Format (little-endian), read by frontend/src/viz/globe/basePack.ts:
    header: b"LBP1", uint16 side (tile_size + 2 = padded side), uint16 tile count
    per tile: uint8 face, uint8 z, uint16 x, uint16 y, uint8 leaf, uint8 0,
              int16 heights[side * side] (metres, rounded; padded like /api/terrain/tile?pad=1)
Whole metres are plenty here: at these levels the vertices are 10-42 km apart.
"""

import argparse
import struct
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engine.tiles import N, max_zoom_for, tile_heights  # noqa: E402

OUT = Path(__file__).resolve().parents[2] / "frontend" / "public" / "terrain" / "base.bin"
PAD = 1


def build(max_zoom: int) -> bytes:
    side = N + 2 * PAD
    tiles = [(f, z, x, y) for f in range(6) for z in range(max_zoom + 1) for x in range(2**z) for y in range(2**z)]
    parts = [b"LBP1", struct.pack("<HH", side, len(tiles))]
    for f, z, x, y in tiles:
        h = tile_heights(f, z, x, y, pad=PAD)
        q = np.clip(np.round(h), -32768, 32767).astype("<i2")
        leaf = 1 if z >= max_zoom_for(f, z, x, y) else 0
        parts.append(struct.pack("<BBHHBB", f, z, x, y, leaf, 0))
        parts.append(q.tobytes())
    return b"".join(parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-zoom", type=int, default=2, help="coarsest levels to include (0..max)")
    args = ap.parse_args()
    t0 = time.time()
    data = build(args.max_zoom)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(data)
    print(f"wrote {OUT} ({len(data) / 1e6:.2f} MB, levels 0-{args.max_zoom}) in {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
