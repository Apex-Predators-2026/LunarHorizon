"""Full per-site pipeline: terrain -> horizon -> ephemeris -> timeline -> site record.

The returned dict is the format of data/sites/<id>.json (docs/interfaces.md).
"""

import time
from datetime import datetime, timezone

import numpy as np

from .dem import SOURCES
from .ephem_local import local_ephemeris
from .ephemeris import MOON_FRAME, fetch_ephemeris
from .geo import latlon_to_xy
from .horizon import RINGS, compute_horizon_latlon
from .visibility import build_timeline

START, STOP, STEP = "2027-01-01", "2029-01-01", "1h"
OBSERVER_HEIGHT_M = 2.0
# Bump when the file format or the calculation changes, so readers can tell files apart.
#   1.0  first release
#   1.1  sun_visible + sun_angular_radius_deg columns, 6-decimal sun_visible_fraction, nulls for
#        unknown terrain, meta.generated_utc / generator_version / frame
#   1.2  works anywhere on the Moon: great-circle horizon over the whole-Moon DEM registry,
#        site.kind / site.approximate, x_m / y_m null away from the south pole,
#        meta.ephemeris says which ephemeris was used (Horizons, or local Skyfield for custom sites)
GENERATOR_VERSION = "1.2"
# Decimal places written per column type; stored in meta so readers don't infer them from the version.
FRACTION_DECIMALS = 6  # sun_visible_fraction
ANGLE_DECIMALS = 3  # azimuth / elevation / horizon / margin columns
EPHEMERIS_TEXT = {
    "horizons": "JPL Horizons API (DE441), apparent az/el (quantities 4,13), CENTER=coord@301",
    "local": "Skyfield + JPL DE421 in MOON_ME_DE421 (validated against Horizons to 0.00001 deg)",
}


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


def analyze_site(site: dict, log=print, ephemeris: str = "horizons") -> dict:
    """site needs id, name, lat, lon (source, kind, approximate optional).
    ephemeris: "horizons" (curated sites) or "local" (custom sites: no network round trip)."""
    t0 = time.time()
    lat, lon = site["lat"], site["lon"]
    log(f"== {site['name']}  ({lat}, {lon})")

    log("  terrain + horizon (Moon Trek LOLA)...")
    mask = compute_horizon_latlon(lat, lon, observer_height_m=OBSERVER_HEIGHT_M)

    log(f"  ephemeris ({ephemeris})...")
    if ephemeris == "local":
        sun = local_ephemeris("sun", lat, lon, START, STOP)
        earth = local_ephemeris("earth", lat, lon, START, STOP)
    else:
        sun = fetch_ephemeris("sun", lat, lon, START, STOP, STEP)
        earth = fetch_ephemeris("earth", lat, lon, START, STOP, STEP)
    tl = build_timeline(sun, earth, mask)
    polar_xy = latlon_to_xy(lat, lon) if lat <= -60 else (None, None)

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
            "kind": "custom",
            "approximate": False,
            **site,
            # South-polar stereographic metres (Moon Trek's polar maps); null away from the south pole.
            "x_m": None if polar_xy[0] is None else round(float(polar_xy[0]), 1),
            "y_m": None if polar_xy[1] is None else round(float(polar_xy[1]), 1),
            "ground_height_m": round(mask.ground_height_m, 1),
            "observer_height_m": OBSERVER_HEIGHT_M,
        },
        "meta": {
            "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "generator_version": GENERATOR_VERSION,
            "fraction_decimals": FRACTION_DECIMALS,  # sun_visible_fraction precision (read this, not the version)
            "angle_decimals": ANGLE_DECIMALS,  # azimuth/elevation/horizon/margin precision
            "frame": f"Moon {MOON_FRAME} (Mean-Earth/polar axis): Horizons site and LOLA terrain",
            "start_utc": START,
            "stop_utc": STOP,
            "step": STEP,
            "ephemeris": EPHEMERIS_TEXT[ephemeris],
            "terrain": [f"Moon Trek {s.service} ({s.native_m:.0f} m)" for s in SOURCES.values()],
            "horizon_method": (
                "great circles every 0.5 deg of azimuth, sampled every "
                + ", ".join(f"{step:g} m to {end / 1000:g} km" for _, end, step in RINGS)
                + "; finest LOLA product available at each point"
            ),
        },
        "summary": summary,
        "horizon": {
            "azimuth_deg": _r(mask.azimuth_deg, 2),
            "elevation_deg": _r(mask.elevation_deg, ANGLE_DECIMALS),  # null = unknown (terrain data missing)
            "distance_m": _r(mask.distance_m, 0),
        },
        "timeline": {
            "time_utc": [str(t) + "Z" for t in tl.times.astype("datetime64[m]")],
            "sun_azimuth_deg": _r(tl.sun_az, ANGLE_DECIMALS),
            "sun_elevation_deg": _r(tl.sun_el, ANGLE_DECIMALS),
            "sun_angular_radius_deg": _r(tl.sun_radius, 5),
            "sun_horizon_deg": _r(tl.sun_horizon, ANGLE_DECIMALS),
            "sun_visible_fraction": _r(tl.sun_fraction, FRACTION_DECIMALS),
            "sun_visible": _b(tl.sunlit, sun_known),  # authoritative "any of the disk above terrain"
            "earth_azimuth_deg": _r(tl.earth_az, ANGLE_DECIMALS),
            "earth_elevation_deg": _r(tl.earth_el, ANGLE_DECIMALS),
            "earth_horizon_deg": _r(tl.earth_horizon, ANGLE_DECIMALS),
            "earth_margin_deg": _r(tl.earth_margin, ANGLE_DECIMALS),
            "earth_visible": _b(tl.earth_visible, earth_known),
        },
    }
