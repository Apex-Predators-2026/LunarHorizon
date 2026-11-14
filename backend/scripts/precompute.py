"""Precompute horizon masks and 2-year hourly visibility timelines for the curated sites.

Run from backend/:  .venv\\Scripts\\python.exe scripts\\precompute.py [site-id ...]
Writes data/sites/<id>.json (format: docs/interfaces.md).
"""

import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engine.ephemeris import fetch_ephemeris  # noqa: E402
from app.engine.geo import latlon_to_xy  # noqa: E402
from app.engine.horizon import compute_horizon  # noqa: E402
from app.engine.net import DATA_DIR  # noqa: E402
from app.engine.sites import SITES  # noqa: E402
from app.engine.terrain import TIERS, load_terrain  # noqa: E402
from app.engine.visibility import build_timeline  # noqa: E402

START, STOP, STEP = "2027-01-01", "2029-01-01", "1h"
OBSERVER_HEIGHT_M = 2.0
OUT_DIR = DATA_DIR / "sites"


def r(a, nd=3):
    return [round(float(v), nd) for v in a]


def run(site: dict) -> dict:
    t0 = time.time()
    x, y = (float(v) for v in latlon_to_xy(site["lat"], site["lon"]))
    print(f"\n== {site['name']}  ({site['lat']}, {site['lon']})  x={x:.0f} y={y:.0f}")

    print("  terrain (Moon Trek)...", flush=True)
    terrain = load_terrain(x, y)
    print("  horizon mask...", flush=True)
    mask = compute_horizon(terrain, x, y, observer_height_m=OBSERVER_HEIGHT_M)

    print("  ephemeris (Horizons)...", flush=True)
    sun = fetch_ephemeris("sun", site["lat"], site["lon"], START, STOP, STEP)
    earth = fetch_ephemeris("earth", site["lat"], site["lon"], START, STOP, STEP)
    tl = build_timeline(sun, earth, mask)

    summary = {
        "sunlit_pct": round(100 * float(tl.sunlit.mean()), 1),
        "mean_sun_fraction_pct": round(100 * float(tl.sun_fraction.mean()), 1),
        "earth_visible_pct": round(100 * float(tl.earth_visible.mean()), 1),
        "horizon_min_deg": round(float(mask.elevation_deg.min()), 2),
        "horizon_max_deg": round(float(mask.elevation_deg.max()), 2),
    }
    print(f"  ground height {mask.ground_height_m:.0f} m | {summary} | {time.time() - t0:.0f}s")

    return {
        "site": {
            **site,
            "x_m": round(x, 1),
            "y_m": round(y, 1),
            "ground_height_m": round(mask.ground_height_m, 1),
            "observer_height_m": OBSERVER_HEIGHT_M,
        },
        "meta": {
            "start_utc": START,
            "stop_utc": STOP,
            "step": STEP,
            "ephemeris": "JPL Horizons API, apparent az/el (quantities 4,13), CENTER=coord@301",
            "terrain": [f"Moon Trek {t.service} ({t.res_m:g} m, +/-{t.half_width_m / 1000:g} km)" for t in TIERS],
        },
        "summary": summary,
        "horizon": {
            "azimuth_deg": r(mask.azimuth_deg, 2),
            "elevation_deg": r(mask.elevation_deg, 3),
            "distance_m": r(mask.distance_m, 0),
        },
        "timeline": {
            "time_utc": [str(t) + "Z" for t in tl.times.astype("datetime64[m]")],
            "sun_azimuth_deg": r(tl.sun_az),
            "sun_elevation_deg": r(tl.sun_el),
            "sun_horizon_deg": r(tl.sun_horizon),
            "sun_visible_fraction": r(tl.sun_fraction),
            "earth_azimuth_deg": r(tl.earth_az),
            "earth_elevation_deg": r(tl.earth_el),
            "earth_horizon_deg": r(tl.earth_horizon),
            "earth_margin_deg": r(tl.earth_margin),
            "earth_visible": [bool(v) for v in tl.earth_visible],
        },
    }


def main(ids: list[str]) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for site in SITES:
        if ids and site["id"] not in ids:
            continue
        result = run(site)
        path = OUT_DIR / f"{site['id']}.json"
        path.write_text(json.dumps(result, separators=(",", ":")))
        print(f"  wrote {path.relative_to(DATA_DIR.parent)} ({path.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    np.seterr(invalid="ignore")
    main(sys.argv[1:])
