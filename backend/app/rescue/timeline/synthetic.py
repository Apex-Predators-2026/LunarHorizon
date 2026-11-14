"""SYNTHETIC placeholder timeline provider.

Used until Andrew's Horizons + LOLA data engine is ready, and as a fallback for points
that have no precomputed data. It is physically shaped but NOT accurate:

* Sun direction: the sub-solar point moves 360 deg per synodic month (29.53 d); its
  latitude swings +/-1.54 deg over the 346.6 d eclipse year. Phases are approximate.
* Earth direction: the sub-Earth point wanders with optical libration (+/-7.9 deg in
  longitude, +/-6.7 deg in latitude). Phases are approximate; parallax (~0.26 deg) is ignored.
* Terrain horizon: invented per site (smooth bumps around a base height). It rises as you
  move away from the catalog peaks and rises steeply inside crater PSRs.

Real numbers must come from JPL Horizons and LOLA/Moon Trek terrain. Never present
these results as real mission data.
"""
from __future__ import annotations

import hashlib
import math
from datetime import datetime

import numpy as np

from ..geo import distance_km, polar_xy_km
from ...models import Site
from ..catalog import PSRS, nearest_catalog_site
from .base import Timeline, solar_disk_fraction, time_grid

SYNODIC_DAYS = 29.530588853
ECLIPSE_YEAR_DAYS = 346.620075
ANOMALISTIC_DAYS = 27.554550
DRACONIC_DAYS = 27.212221
NEW_MOON_EPOCH = np.datetime64("2000-01-06T18:14:00", "s")
SUN_LAT_AMPLITUDE_DEG = 1.54
EARTH_LON_LIBRATION_DEG = 7.9
EARTH_LAT_LIBRATION_DEG = 6.7

HORIZON_RISE_PER_KM = 0.12  # synthetic: moving off a peak raises the horizon
HORIZON_RISE_CAP_DEG = 3.0
PSR_FLOOR_RISE_DEG = 8.0
N_HARMONICS = 6

SOURCE = "synthetic-placeholder"


def _days_since_epoch(times: np.ndarray) -> np.ndarray:
    return (times - NEW_MOON_EPOCH).astype("timedelta64[s]").astype(np.float64) / 86400.0


def subsolar_point(times: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    d = _days_since_epoch(times)
    lon = (180.0 - 360.0 * d / SYNODIC_DAYS) % 360.0
    lat = SUN_LAT_AMPLITUDE_DEG * np.sin(2 * np.pi * d / ECLIPSE_YEAR_DAYS)
    return lat, lon


def subearth_point(times: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    d = _days_since_epoch(times)
    lon = EARTH_LON_LIBRATION_DEG * np.sin(2 * np.pi * d / ANOMALISTIC_DAYS)
    lat = EARTH_LAT_LIBRATION_DEG * np.sin(2 * np.pi * d / DRACONIC_DAYS + 1.0)
    return lat, lon % 360.0


def horizontal(site_lat: float, site_lon: float, body_lat: np.ndarray, body_lon: np.ndarray):
    """Azimuth (0 = north, clockwise) and elevation of a distant body above a flat horizon."""
    phi = math.radians(max(-89.9999, min(89.9999, site_lat)))
    beta = np.radians(body_lat)
    dl = np.radians(body_lon - site_lon)
    sin_el = math.sin(phi) * np.sin(beta) + math.cos(phi) * np.cos(beta) * np.cos(dl)
    el = np.degrees(np.arcsin(np.clip(sin_el, -1, 1)))
    az = np.degrees(np.arctan2(np.cos(beta) * np.sin(dl),
                               math.cos(phi) * np.sin(beta) - math.sin(phi) * np.cos(beta) * np.cos(dl))) % 360.0
    return az, el


def _site_seed(site_id: str) -> np.ndarray:
    h = hashlib.sha256(site_id.encode()).digest()
    return np.frombuffer(h, dtype=np.uint8)[: N_HARMONICS * 2].astype(np.float64) / 255.0


def horizon_profile(lat: float, lon: float):
    """Return a function az_deg -> terrain horizon elevation (deg) for this point."""
    parent, d_parent = nearest_catalog_site(lat, lon)
    base = parent.horizon_base_deg + min(HORIZON_RISE_CAP_DEG, HORIZON_RISE_PER_KM * d_parent)
    for p in PSRS:
        d = distance_km(lat, lon, p.lat, p.lon)
        if d < p.radius_km:
            base += PSR_FLOOR_RISE_DEG * (1.0 - 0.5 * d / p.radius_km)
    seed = _site_seed(parent.id)
    x, y = polar_xy_km(lat, lon)
    px, py = polar_xy_km(parent.lat, parent.lon)
    dx, dy = x - px, y - py
    amps = np.array([parent.horizon_roughness_deg / (k + 1) for k in range(N_HARMONICS)])
    # Phases shift smoothly (0.15 rad per km) as you move away from the catalog site.
    ang = seed[N_HARMONICS:] * 6
    phases = 2 * np.pi * seed[:N_HARMONICS] + 0.15 * (dx * np.cos(ang) + dy * np.sin(ang))
    ks = np.arange(1, N_HARMONICS + 1)

    def profile(az_deg: np.ndarray) -> np.ndarray:
        a = np.radians(np.asarray(az_deg, dtype=float))[..., None]
        return base + np.sum(amps * np.sin(ks * a + phases), axis=-1)

    return profile


class SyntheticTimelineProvider:
    source = SOURCE

    def timeline(self, site: Site, start: datetime, end: datetime, step_hours: float = 1.0) -> Timeline:
        times = time_grid(start, end, step_hours)
        s_lat, s_lon = subsolar_point(times)
        e_lat, e_lon = subearth_point(times)
        sun_az, sun_el = horizontal(site.lat, site.lon, s_lat, s_lon)
        earth_az, earth_el = horizontal(site.lat, site.lon, e_lat, e_lon)
        prof = horizon_profile(site.lat, site.lon)
        sun_h = prof(sun_az)
        earth_h = prof(earth_az)
        return Timeline(
            site=site, times=times, step_hours=step_hours,
            sun_az=sun_az, sun_el=sun_el, sun_horizon=sun_h,
            sun_visible_fraction=solar_disk_fraction(sun_el, sun_h),
            earth_az=earth_az, earth_el=earth_el, earth_horizon=earth_h,
            earth_visible=earth_el > earth_h, source=SOURCE,
        )
