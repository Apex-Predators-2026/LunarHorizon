"""Check one hour of a site's stored Sun/Earth positions against JPL Horizons (live) and an
independent local ephemeris (Skyfield + DE421), for the "Verify with JPL" button."""

import urllib.parse

import numpy as np

from .ephemeris import HORIZONS_API, fetch_ephemeris


def separation_deg(az1, el1, az2, el2) -> float:
    a1, e1, a2, e2 = (np.radians(v) for v in (az1, el1, az2, el2))
    c = np.sin(e1) * np.sin(e2) + np.cos(e1) * np.cos(e2) * np.cos(a1 - a2)
    return float(np.degrees(np.arccos(np.clip(c, -1, 1))))


def _skyfield(lat: float, lon: float, when: np.datetime64) -> dict:
    from .ephem_local import setup

    eph, pc, frame, ts = setup()
    s = str(np.datetime64(when, "m"))  # 'YYYY-MM-DDTHH:MM'
    t = ts.utc(int(s[:4]), int(s[5:7]), int(s[8:10]), int(s[11:13]), int(s[14:16]))
    place = eph["moon"] + pc.build_latlon_degrees(frame, lat, lon)
    out = {}
    for body, target in (("sun", eph["sun"]), ("earth", eph["earth"])):
        alt, az, _ = place.at(t).observe(target).apparent().altaz()
        out[body] = {"azimuth_deg": round(float(az.degrees) % 360, 5), "elevation_deg": round(float(alt.degrees), 5)}
    return out


def verify(lat: float, lon: float, when: np.datetime64, stored: dict) -> dict:
    """stored: {"sun": {"azimuth_deg", "elevation_deg"}, "earth": {...}} for the hour `when` (UTC)."""
    start = str(np.datetime64(when, "m")).replace("T", " ")
    stop = str(np.datetime64(when, "m") + np.timedelta64(1, "h")).replace("T", " ")
    horizons = {}
    for body in ("sun", "earth"):
        e = fetch_ephemeris(body, lat, lon, start, stop, "1h")
        horizons[body] = {"azimuth_deg": round(float(e.azimuth_deg[0]), 5), "elevation_deg": round(float(e.elevation_deg[0]), 5)}
    sky = _skyfield(lat, lon, when)

    bodies = {}
    for body in ("sun", "earth"):
        st, hz, sf = stored[body], horizons[body], sky[body]
        bodies[body] = {
            "stored": st,
            "horizons": hz,
            "skyfield": sf,
            "stored_vs_horizons_deg": round(separation_deg(st["azimuth_deg"], st["elevation_deg"], hz["azimuth_deg"], hz["elevation_deg"]), 5),
            "skyfield_vs_horizons_deg": round(separation_deg(sf["azimuth_deg"], sf["elevation_deg"], hz["azimuth_deg"], hz["elevation_deg"]), 5),
        }
    query = {
        "COMMAND": "'10'", "CENTER": "'coord@301'", "COORD_TYPE": "'GEODETIC'",
        "SITE_COORD": f"'{lon % 360},{lat},0'", "START_TIME": f"'{start}'", "STOP_TIME": f"'{stop}'",
        "STEP_SIZE": "'1h'", "QUANTITIES": "'4'", "ANG_FORMAT": "'DEG'", "MAKE_EPHEM": "'YES'", "EPHEM_TYPE": "'OBSERVER'",
    }
    return {
        "time_utc": str(np.datetime64(when, "m")) + "Z",
        "bodies": bodies,
        "horizons_example_query": HORIZONS_API + "?" + urllib.parse.urlencode(query),
        "note": "Stored values are rounded to 0.001 deg, so differences up to ~0.0007 deg are rounding. "
                "Skyfield uses JPL DE421, Horizons DE441.",
    }
