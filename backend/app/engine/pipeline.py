"""Full per-site pipeline: terrain -> horizon -> ephemeris -> timeline -> site record.

The returned dict is the format of data/sites/<id>.json (docs/interfaces.md).
"""

import time

import numpy as np

from .ephemeris import fetch_ephemeris
from .geo import latlon_to_xy
from .horizon import compute_horizon
from .terrain import TIERS, load_terrain
from .visibility import build_timeline

START, STOP, STEP = "2027-01-01", "2029-01-01", "1h"
OBSERVER_HEIGHT_M = 2.0


def _r(a, nd=3):
    return [round(float(v), nd) for v in a]


def analyze_site(site: dict, log=print) -> dict:
    """site needs id, name, lat, lon (source optional)."""
    np.seterr(invalid="ignore")
    t0 = time.time()
    x, y = (float(v) for v in latlon_to_xy(site["lat"], site["lon"]))
    log(f"== {site['name']}  ({site['lat']}, {site['lon']})  x={x:.0f} y={y:.0f}")

    log("  terrain (Moon Trek)...")
    terrain = load_terrain(x, y)
    log("  horizon mask...")
    mask = compute_horizon(terrain, x, y, observer_height_m=OBSERVER_HEIGHT_M)

    log("  ephemeris (Horizons)...")
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
    log(f"  ground height {mask.ground_height_m:.0f} m | {summary} | {time.time() - t0:.0f}s")

    return {
        "site": {
            "source": "",
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
            "azimuth_deg": _r(mask.azimuth_deg, 2),
            "elevation_deg": _r(mask.elevation_deg, 3),
            "distance_m": _r(mask.distance_m, 0),
        },
        "timeline": {
            "time_utc": [str(t) + "Z" for t in tl.times.astype("datetime64[m]")],
            "sun_azimuth_deg": _r(tl.sun_az),
            "sun_elevation_deg": _r(tl.sun_el),
            "sun_horizon_deg": _r(tl.sun_horizon),
            "sun_visible_fraction": _r(tl.sun_fraction),
            "earth_azimuth_deg": _r(tl.earth_az),
            "earth_elevation_deg": _r(tl.earth_el),
            "earth_horizon_deg": _r(tl.earth_horizon),
            "earth_margin_deg": _r(tl.earth_margin),
            "earth_visible": [bool(v) for v in tl.earth_visible],
        },
    }
