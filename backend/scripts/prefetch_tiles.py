"""Demo data pack: warm the caches so the demo doesn't wait on (or depend on) Moon Trek.

Run from backend/:
    .venv\\Scripts\\python.exe scripts\\prefetch_tiles.py [--no-imagery] [--globe-zoom 3] [--polar-zoom 7] [--site-zoom 13]

  * terrain: the whole globe down to --globe-zoom, the south-polar region (within ~300 km of the pole)
    down to --polar-zoom, the wider ring to --limb-lat (67 S) down to --limb-zoom and the whole
    south face down to --face-zoom (what the view shows towards the limb from high up), and the 3 x 3 tiles around each of the 24 curated sites down to --site-zoom.
    Tiles are warmed padded (pad=1), exactly as the 3D view requests them.
  * the PSR / surface-ice overlay (Moon Trek).
  * the LRO imagery the 3D view fades to when zoomed out (levels 0-3 everywhere, the polar region and the
    sites' surroundings to level 7, where imagery tiles stop); --no-imagery skips it.
  * the JPL/NAIF kernels for custom pins (local ephemeris, ~17 MB), so a pin dropped where the terrain is cached
    also works offline.
To check that a demo really needs nothing else, run the backend with LUNAR_OFFLINE=1 and go through it
(frontend/scripts/demo-tour.mjs --verify does that automatically; see docs/demo-setup.md).
Everything lands in data/cache/ (git-ignored; copy that folder to another machine to skip this).
Safe to re-run: cached data is reused, and tiles that failed (e.g. Moon Trek hiccups) are listed
so a second run can fill them in.
"""

import argparse
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engine import ephem_local, psr  # noqa: E402
from app.engine.imagery import IMAGERY_MAX_ZOOM, imagery_tile  # noqa: E402
from app.engine.net import CACHE_DIR  # noqa: E402
from app.engine.sites import ALL_SITES  # noqa: E402
from app.engine.tiles import max_zoom_for, tile_at, tile_centre_latlon, tile_heights  # noqa: E402

SOUTH_FACE = 5
Tile = tuple[int, int, int, int]


def globe(zmax: int) -> set[Tile]:
    return {(f, z, x, y) for f in range(6) for z in range(zmax + 1) for x in range(2**z) for y in range(2**z)}


def polar(zmax: int, lat_limit: float = -80.0) -> set[Tile]:
    """South-face tiles down to zmax whose centre is south of lat_limit (-80: ~300 km from the pole)."""
    out = set()
    for z in range(zmax + 1):
        for x in range(2**z):
            for y in range(2**z):
                if tile_centre_latlon(SOUTH_FACE, z, x, y)[0] <= lat_limit:
                    out.add((SOUTH_FACE, z, x, y))
    return out


def around_sites(zmax: int, respect_data: bool) -> set[Tile]:
    out = set()
    for site in ALL_SITES:
        for z in range(zmax + 1):
            face, x, y = tile_at(site["lat"], site["lon"], z)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    tx, ty = x + dx, y + dy
                    if 0 <= tx < 2**z and 0 <= ty < 2**z and (not respect_data or z <= max_zoom_for(face, z, tx, ty)):
                        out.add((face, z, tx, ty))
    return out


def warm(label: str, tiles: set[Tile], work) -> list[Tile]:
    """Run `work` on every tile (coarse first, 4 at a time); returns the tiles that failed."""
    todo = sorted(tiles, key=lambda t: t[1])
    print(f"{label}: {len(todo)} tiles", flush=True)
    t0, done, failed = time.time(), 0, []

    def run(t):
        try:
            work(t)
            return None
        except Exception as e:  # noqa: BLE001 - report and carry on; a re-run fills gaps
            return t, e

    with ThreadPoolExecutor(max_workers=4) as pool:
        for r in pool.map(run, todo):
            done += 1
            if r is not None:
                failed.append(r[0])
                if len(failed) <= 5:
                    print(f"  failed {r[0]}: {r[1]}", flush=True)
            if done % 100 == 0 or done == len(todo):
                print(f"  {done}/{len(todo)}  {time.time() - t0:.0f}s  ({len(failed)} failed)", flush=True)
    return failed


def folder_size(path: Path) -> float:
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file()) / 1e9 if path.exists() else 0.0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--globe-zoom", type=int, default=3)
    ap.add_argument("--polar-zoom", type=int, default=7)
    ap.add_argument("--site-zoom", type=int, default=13)
    # From high up near the pole the view reaches the limb, ~600 km away, drawn at about level 8: warm
    # that ring too (the demo tour's offline check found such tiles missing otherwise).
    ap.add_argument("--limb-zoom", type=int, default=8, help="zoom for the wider south-polar ring")
    ap.add_argument("--limb-lat", type=float, default=-67.0, help="the wider ring reaches this latitude")
    ap.add_argument("--face-zoom", type=int, default=6, help="the whole south face (to ~35 S) down to this zoom")
    ap.add_argument("--no-imagery", action="store_true", help="skip the LRO imagery (the zoomed-out look of the 3D view)")
    args = ap.parse_args()

    failed: list[Tile] = []
    terrain = (
        globe(args.globe_zoom)
        | polar(args.polar_zoom)
        | polar(args.limb_zoom, args.limb_lat)
        | polar(args.face_zoom, 0.0)  # the whole south face: the limb seen from far above the pole
        | around_sites(args.site_zoom, respect_data=True)
    )
    failed += warm("Terrain", terrain, lambda t: tile_heights(*t, pad=1))

    print("PSR / surface-ice overlay", flush=True)
    try:
        d = psr.load()
        print(f"  {len(d['psrs'])} PSRs, {len(d['ice'])} ice detections", flush=True)
    except OSError as e:
        print(f"  failed: {e}", flush=True)

    print("Ephemeris kernels for custom pins (JPL/NAIF)", flush=True)
    try:
        ephem_local.setup()
        print("  ready", flush=True)
    except OSError as e:
        print(f"  failed: {e}", flush=True)

    if not args.no_imagery:
        zmax = IMAGERY_MAX_ZOOM
        imagery = globe(min(3, zmax)) | polar(zmax) | around_sites(zmax, respect_data=False)
        failed += warm("Imagery", imagery, lambda t: imagery_tile(*t))

    print(
        f"\nCache: terrain {folder_size(CACHE_DIR / 'dem'):.2f} GB, imagery {folder_size(CACHE_DIR / 'imagery'):.2f} GB "
        f"(in {CACHE_DIR})",
        flush=True,
    )
    if failed:
        print(f"{len(failed)} tiles failed (usually Moon Trek being busy): run this again to fill them in.")
        sys.exit(1)
    print("All done: the demo can now run without Moon Trek for these areas.")


if __name__ == "__main__":
    main()
