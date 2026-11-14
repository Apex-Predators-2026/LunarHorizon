"""Warm the terrain cache so the demo doesn't wait on (or depend on) Moon Trek.

Run from backend/:  .venv\\Scripts\\python.exe scripts\\prefetch_tiles.py [--globe-zoom 3] [--polar-zoom 7] [--site-zoom 13]

  * the whole globe down to --globe-zoom
  * the south-polar face down to --polar-zoom (within 300 km of the pole)
  * the tiles around each curated site down to --site-zoom
Everything lands in data/cache/dem/ (git-ignored); later tile requests are then instant.
"""

import argparse
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engine.sites import SITES  # noqa: E402
from app.engine.tiles import max_zoom_for, tile_at, tile_centre_latlon, tile_heights  # noqa: E402

SOUTH_FACE = 5


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--globe-zoom", type=int, default=3)
    ap.add_argument("--polar-zoom", type=int, default=7)
    ap.add_argument("--site-zoom", type=int, default=13)
    args = ap.parse_args()

    tiles: set[tuple[int, int, int, int]] = set()
    for face in range(6):
        for z in range(args.globe_zoom + 1):
            tiles |= {(face, z, x, y) for x in range(2**z) for y in range(2**z)}
    for z in range(args.polar_zoom + 1):
        for x in range(2**z):
            for y in range(2**z):
                lat, _ = tile_centre_latlon(SOUTH_FACE, z, x, y)
                if lat <= -80:  # ~300 km from the pole
                    tiles.add((SOUTH_FACE, z, x, y))
    for site in SITES:
        for z in range(args.site_zoom + 1):
            face, x, y = tile_at(site["lat"], site["lon"], z)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    if 0 <= x + dx < 2**z and 0 <= y + dy < 2**z and z <= max_zoom_for(face, z, x + dx, y + dy):
                        tiles.add((face, z, x + dx, y + dy))

    todo = sorted(tiles, key=lambda t: t[1])  # coarse first
    print(f"{len(todo)} tiles to warm", flush=True)
    t0, done = time.time(), 0

    def work(t):
        tile_heights(*t)
        return t

    with ThreadPoolExecutor(max_workers=4) as pool:
        for _ in pool.map(work, todo):
            done += 1
            if done % 50 == 0 or done == len(todo):
                print(f"  {done}/{len(todo)}  {time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
