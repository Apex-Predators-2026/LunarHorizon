"""Build the ready-made first view: the coarsest terrain tiles and LRO imagery of the whole Moon,
in two small files that ship with the frontend, so the globe appears as soon as the page loads,
without waiting for the backend or Moon Trek. Finer tiles still stream as usual.

Run from backend/ (after changing the terrain or imagery sources or the tiling):
    .venv\\Scripts\\python.exe scripts\\build_base_pack.py [--max-zoom 2] [--imagery-px 128] [--only terrain|imagery]

frontend/public/terrain/base.bin (little-endian), read by frontend/src/viz/globe/basePack.ts:
    header: b"LBP1", uint16 side (tile_size + 2 = padded side), uint16 tile count
    per tile: uint8 face, uint8 z, uint16 x, uint16 y, uint8 leaf, uint8 0,
              int16 heights[side * side] (metres, rounded; padded like /api/terrain/tile?pad=1)
Whole metres are plenty here: at these levels the vertices are 10-42 km apart.

frontend/public/imagery/base.bin (little-endian), read by frontend/src/viz/globe/imageryPack.ts:
    header: b"LIP1", uint16 tile count, uint16 0
    per tile: uint8 face, uint8 z, uint16 x, uint16 y, uint8 0, uint8 0, uint32 length, PNG bytes
              (8-bit grey, like /api/imagery/tile). 128 px is ~5 km/px at level 2, about what the
              whole-Moon view shows; deeper levels stream from the backend at full size.
"""

import argparse
import struct
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engine.imagery import imagery_tile, png_gray  # noqa: E402
from app.engine.tiles import N, max_zoom_for, tile_heights  # noqa: E402

PUBLIC = Path(__file__).resolve().parents[2] / "frontend" / "public"
OUT = PUBLIC / "terrain" / "base.bin"
IMAGERY_OUT = PUBLIC / "imagery" / "base.bin"
PAD = 1


def _tiles(max_zoom: int):
    return [(f, z, x, y) for f in range(6) for z in range(max_zoom + 1) for x in range(2**z) for y in range(2**z)]


def build(max_zoom: int) -> bytes:
    side = N + 2 * PAD
    tiles = _tiles(max_zoom)
    parts = [b"LBP1", struct.pack("<HH", side, len(tiles))]
    for f, z, x, y in tiles:
        h = tile_heights(f, z, x, y, pad=PAD)
        q = np.clip(np.round(h), -32768, 32767).astype("<i2")
        leaf = 1 if z >= max_zoom_for(f, z, x, y) else 0
        parts.append(struct.pack("<BBHHBB", f, z, x, y, leaf, 0))
        parts.append(q.tobytes())
    return b"".join(parts)


def build_imagery(max_zoom: int, px: int) -> bytes:
    tiles = _tiles(max_zoom)
    parts = [b"LIP1", struct.pack("<HH", len(tiles), 0)]
    for f, z, x, y in tiles:
        png = png_gray(imagery_tile(f, z, x, y, px=px))
        parts.append(struct.pack("<BBHHBBI", f, z, x, y, 0, 0, len(png)))
        parts.append(png)
    return b"".join(parts)


def _write(path: Path, data: bytes, what: str, t0: float):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    print(f"wrote {path} ({len(data) / 1e6:.2f} MB, {what}) in {time.time() - t0:.0f} s")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-zoom", type=int, default=2, help="coarsest levels to include (0..max)")
    ap.add_argument("--imagery-px", type=int, default=128, help="imagery texture size per tile")
    ap.add_argument("--only", choices=["terrain", "imagery"], help="build just one of the two packs")
    args = ap.parse_args()
    if args.only != "imagery":
        t0 = time.time()
        _write(OUT, build(args.max_zoom), f"terrain levels 0-{args.max_zoom}", t0)
    if args.only != "terrain":
        t0 = time.time()
        what = f"imagery levels 0-{args.max_zoom}, {args.imagery_px} px"
        _write(IMAGERY_OUT, build_imagery(args.max_zoom, args.imagery_px), what, t0)


if __name__ == "__main__":
    main()
