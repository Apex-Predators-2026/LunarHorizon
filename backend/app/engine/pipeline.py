"""Full per-site pipeline: terrain -> horizon -> ephemeris -> timeline -> site record.

The returned dict is the format of data/sites/<id>.json (docs/interfaces.md).
"""

import time
from datetime import datetime, timezone

import numpy as np

from .ephemeris import MOON_FRAME, fetch_ephemeris
from .geo import latlon_to_xy
from .horizon import compute_horizon
from .terrain import TIERS, load_terrain
from .visibility import build_timeline

START, STOP, STEP = "2027-01-01", "2029-01-01", "1h"
OBSERVER_HEIGHT_M = 2.0
# Bump when the file format or the calculation changes, so readers can tell files apart.
#   1.0  first release
#   1.1  sun_visible + sun_angular_radius_deg columns, 6-decimal sun_visible_fraction, nulls for
#        unknown terrain, meta.generated_utc / generator_version / frame
GENERATOR_VERSION = "1.1"


def _r(a, nd=3):
    """Round to nd decimals; NaN (unknown) -> None, i.e. JSON null."""
    return [None if np.isnan(v) else round(float(v), nd) for v in np.asarray(a, dtype=float)]


def _b(flags, known):
    """Booleans with None (JSON null) where the value is unknown."""
    return [bool(f) if k else None for f, k in zip(flags, known)]


def _pct(flags, known):
    """Percentage of known samples where flags is True (None if nothing is known)."""
    n = int(np.count_nonzero(known))
    return round(100 * float(np.count_nonzero(flags & known)) / n, 1) if n else None


def analyze_site(site: dict, log=print) -> dict:
    """site needs id, name, lat, lon (source optional)."""
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

    sun_known, earth_known = tl.sun_known, tl.earth_known
    known_h = ~np.isnan(mask.elevation_deg)
    summary = {
        # Percentages are over hours where the answer is known; unknown_pct says how many were not.
        "sunlit_pct": _pct(tl.sunlit, sun_known),
        "mean_sun_fraction_pct": round(100 * float(np.nanmean(tl.sun_fraction)), 1) if sun_known.any() else None,
        "earth_visible_pct": _pct(tl.earth_visible, earth_known),
        "horizon_min_deg": round(float(np.nanmin(mask.elevation_deg)), 2) if known_h.any() else None,
        "horizon_max_deg": round(float(np.nanmax(mask.elevation_deg)), 2) if known_h.any() else None,
        "unknown_horizon_pct": round(100 * float(1 - known_h.mean()), 1),
        "unknown_hours_pct": round(100 * float(1 - (sun_known & earth_known).mean()), 1),
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
            "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "generator_version": GENERATOR_VERSION,
            "frame": f"Moon {MOON_FRAME} (Mean-Earth/polar axis): Horizons site and LOLA terrain",
            "start_utc": START,
            "stop_utc": STOP,
            "step": STEP,
            "ephemeris": "JPL Horizons API, apparent az/el (quantities 4,13), CENTER=coord@301",
            "terrain": [f"Moon Trek {t.service} ({t.res_m:g} m, +/-{t.half_width_m / 1000:g} km)" for t in TIERS],
        },
        "summary": summary,
        "horizon": {
            "azimuth_deg": _r(mask.azimuth_deg, 2),
            "elevation_deg": _r(mask.elevation_deg, 3),  # null = unknown (terrain data missing)
            "distance_m": _r(mask.distance_m, 0),
        },
        "timeline": {
            "time_utc": [str(t) + "Z" for t in tl.times.astype("datetime64[m]")],
            "sun_azimuth_deg": _r(tl.sun_az),
            "sun_elevation_deg": _r(tl.sun_el),
            "sun_angular_radius_deg": _r(tl.sun_radius, 5),
            "sun_horizon_deg": _r(tl.sun_horizon),
            "sun_visible_fraction": _r(tl.sun_fraction, 6),
            "sun_visible": _b(tl.sunlit, sun_known),  # authoritative "any of the disk above terrain"
            "earth_azimuth_deg": _r(tl.earth_az),
            "earth_elevation_deg": _r(tl.earth_el),
            "earth_horizon_deg": _r(tl.earth_horizon),
            "earth_margin_deg": _r(tl.earth_margin),
            "earth_visible": _b(tl.earth_visible, earth_known),
        },
    }
