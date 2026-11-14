"""Sun/Earth apparent azimuth & elevation from JPL Horizons, as seen from a lunar site.

Horizons elevations are relative to the flat (sphere) horizon; terrain is handled
separately in horizon.py. Azimuth is measured from local north towards east.
"""

import csv
import io
import urllib.parse
from dataclasses import dataclass
from datetime import datetime

import numpy as np

from .net import CACHE_DIR, fetch_cached

HORIZONS_API = "https://ssd.jpl.nasa.gov/api/horizons.api"
BODIES = {"sun": "10", "earth": "399"}
MOON_FRAME = "MEAN_ME"  # Horizons' name for the Moon's Mean-Earth/polar-axis frame


@dataclass
class Ephemeris:
    body: str
    times: np.ndarray  # datetime64[s], UTC
    azimuth_deg: np.ndarray
    elevation_deg: np.ndarray
    angular_radius_deg: np.ndarray  # half the apparent angular diameter

    def at(self, times: np.ndarray) -> "Ephemeris":
        """Linearly interpolate to other times (azimuth unwrapped across 0/360)."""
        t0 = self.times.astype("int64")
        t = np.asarray(times, dtype="datetime64[s]")
        ti = t.astype("int64")
        az = np.degrees(np.interp(ti, t0, np.unwrap(np.radians(self.azimuth_deg)))) % 360
        return Ephemeris(
            self.body,
            t,
            az,
            np.interp(ti, t0, self.elevation_deg),
            np.interp(ti, t0, self.angular_radius_deg),
        )


def _parse(text: str, body: str) -> Ephemeris:
    if "$$SOE" not in text:
        raise RuntimeError(f"Horizons returned no ephemeris for {body}:\n{text[:1500]}")
    head, rest = text.split("$$SOE", 1)
    # Site coordinates and the LOLA terrain are in the Mean-Earth/polar-axis (ME) frame. Horizons
    # says which frame it placed the site in; refuse anything else (PA vs ME is ~1 km at the pole,
    # enough to rotate azimuths by degrees near the pole).
    frame_line = next((ln for ln in head.splitlines() if ln.startswith("Center pole/equ")), None)
    if frame_line is not None and MOON_FRAME not in frame_line:
        raise RuntimeError(f"Horizons placed the site in an unexpected frame ({frame_line.strip()}); expected {MOON_FRAME}")
    header = [h.strip() for h in head.strip().splitlines()[-2].split(",")]
    lines = rest.split("$$EOE", 1)[0].strip().splitlines()

    az_i = next(i for i, h in enumerate(header) if h.startswith("Azi"))
    el_i = next(i for i, h in enumerate(header) if h.startswith("Elev"))
    diam_i = next((i for i, h in enumerate(header) if h.startswith("Ang-diam")), None)

    times, az, el, rad = [], [], [], []
    for rec in csv.reader(io.StringIO("\n".join(lines))):
        times.append(datetime.strptime(rec[0].strip(), "%Y-%b-%d %H:%M"))
        az.append(float(rec[az_i]))
        el.append(float(rec[el_i]))
        # Ang-diam is in arcseconds
        rad.append(float(rec[diam_i]) / 3600 / 2 if diam_i is not None else np.nan)

    return Ephemeris(
        body,
        np.array(times, dtype="datetime64[s]"),
        np.array(az),
        np.array(el),
        np.array(rad),
    )


def fetch_ephemeris(
    body: str, lat: float, lon: float, start: str, stop: str, step: str = "1h", alt_km: float = 0.0
) -> Ephemeris:
    """Fetch (and cache) the apparent az/el of 'sun' or 'earth' from a lunar site."""
    params = {
        "format": "text",
        "COMMAND": f"'{BODIES[body]}'",
        "OBJ_DATA": "'NO'",
        "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'OBSERVER'",
        "CENTER": "'coord@301'",  # 301 = Moon
        "COORD_TYPE": "'GEODETIC'",
        "SITE_COORD": f"'{lon % 360},{lat},{alt_km}'",  # E-lon deg, lat deg, alt km
        "START_TIME": f"'{start}'",
        "STOP_TIME": f"'{stop}'",
        "STEP_SIZE": f"'{step}'",
        "QUANTITIES": "'4,13'",  # 4 = apparent az/el, 13 = angular diameter
        "ANG_FORMAT": "'DEG'",
        "CSV_FORMAT": "'YES'",
    }
    url = HORIZONS_API + "?" + urllib.parse.urlencode(params)
    # Times may include "HH:MM"; ':' and ' ' aren't allowed / awkward in Windows file names.
    stamp = f"{start}_{stop}".replace(":", "").replace(" ", "T")
    name = f"horizons_{body}_{lat:.5f}_{lon:.5f}_{stamp}_{step}.txt"
    path = fetch_cached(url, CACHE_DIR / name)
    return _parse(path.read_text(), body)
