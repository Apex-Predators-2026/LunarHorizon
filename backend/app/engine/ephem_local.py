"""Local Sun/Earth ephemeris with Skyfield + JPL DE421 in the Moon's Mean-Earth frame.

Used for custom sites so they don't need two JPL Horizons round trips. Validated against our
Horizons data to <= 0.0007 deg at all curated sites (scripts/validate_engine.py,
docs/validation-engine.md). Curated sites keep using Horizons directly.
"""

from functools import lru_cache

import numpy as np

from .ephemeris import Ephemeris
from .net import CACHE_DIR, fetch_cached

NAIF = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels"
KERNELS = {  # NAIF moves superseded kernels to a_old_versions/; DE421 matches the moon_pa_de421 frame
    "moon_080317.tf": f"{NAIF}/fk/satellites/moon_080317.tf",
    "pck00008.tpc": f"{NAIF}/pck/a_old_versions/pck00008.tpc",
    "moon_pa_de421_1900-2050.bpc": f"{NAIF}/pck/moon_pa_de421_1900-2050.bpc",
    "de421.bsp": "https://ssd.jpl.nasa.gov/ftp/eph/planets/bsp/de421.bsp",
}
SUN_RADIUS_KM = 695_700.0
EARTH_RADIUS_KM = 6_378.137  # equatorial, as Horizons uses for Earth's angular diameter


class LocalEphemerisUnavailable(RuntimeError):
    """Skyfield is not installed in the backend's Python environment.

    It is a runtime requirement (backend/requirements.txt) for custom sites and "Verify with JPL". A venv set up
    without it used to surface as a bare ModuleNotFoundError, i.e. an unexplained HTTP 500 on POST /api/sites/custom.
    """


@lru_cache(maxsize=1)
def setup():
    """(ephemeris, planetary constants, MOON_ME_DE421 frame, timescale); downloads kernels once."""
    try:
        from skyfield.api import Loader
        from skyfield.planetarylib import PlanetaryConstants
    except ImportError as e:  # not cached by lru_cache: installing the package fixes it without a restart
        raise LocalEphemerisUnavailable(
            "The local ephemeris library (skyfield) is not installed on the backend. "
            "Run: pip install -r backend/requirements.txt, then restart the API."
        ) from e

    kdir = CACHE_DIR / "kernels"
    paths = {name: fetch_cached(url, kdir / name, timeout=900) for name, url in KERNELS.items()}
    load = Loader(str(kdir))
    eph = load(str(paths["de421.bsp"]))
    pc = PlanetaryConstants()
    pc.read_text(load(str(paths["moon_080317.tf"])))
    pc.read_text(load(str(paths["pck00008.tpc"])))
    pc.read_binary(load(str(paths["moon_pa_de421_1900-2050.bpc"])))
    frame = pc.build_frame_named("MOON_ME_DE421")
    return eph, pc, frame, load.timescale(builtin=True)


def local_ephemeris(body: str, lat: float, lon: float, start: str, stop: str, step_hours: int = 1) -> Ephemeris:
    """Apparent az/el of 'sun' or 'earth' from a lunar site, hourly from start to stop inclusive
    (same sampling as the Horizons files). start/stop: 'YYYY-MM-DD'."""
    eph, pc, frame, ts = setup()
    t0 = np.datetime64(start, "h")
    times = np.arange(t0, np.datetime64(stop, "h") + 1, np.timedelta64(step_hours, "h"))
    hours = (times - t0).astype(int)
    y, m, d = (int(v) for v in start.split("-"))
    t = ts.utc(y, m, d, hours)
    place = eph["moon"] + pc.build_latlon_degrees(frame, lat, lon)
    target = eph["sun"] if body == "sun" else eph["earth"]
    alt, az, distance = place.at(t).observe(target).apparent().altaz()
    radius_km = SUN_RADIUS_KM if body == "sun" else EARTH_RADIUS_KM
    ang_radius = np.degrees(np.arcsin(radius_km / distance.km))
    return Ephemeris(body, times.astype("datetime64[s]"), az.degrees % 360, alt.degrees, ang_radius)
