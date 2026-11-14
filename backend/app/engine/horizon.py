"""Terrain horizon mask: the highest elevation angle blocked by terrain in each direction.

For each azimuth, step outward from the observer across the terrain and take the
maximum elevation angle of the terrain, using exact spherical geometry (so the
Moon's curvature drops distant terrain below the observer's line of sight).

Approximation: rays are straight lines in the polar stereographic plane rather than
true great circles. Over a few hundred km near the pole the difference is small.
"""

from dataclasses import dataclass

import numpy as np

from .geo import MOON_RADIUS_M, local_north_east, scale_factor, xy_to_latlon
from .terrain import Terrain


@dataclass
class HorizonMask:
    azimuth_deg: np.ndarray  # evenly spaced from 0, clockwise from north
    elevation_deg: np.ndarray  # horizon elevation angle per azimuth
    distance_m: np.ndarray  # distance to the terrain point that sets the horizon
    ground_height_m: float  # terrain height at the site (relative to 1737.4 km sphere)
    observer_height_m: float  # height of the sensor above the ground

    def at(self, azimuth_deg) -> np.ndarray:
        """Horizon elevation at any azimuth (circular linear interpolation)."""
        az = np.concatenate([self.azimuth_deg, [self.azimuth_deg[0] + 360]])
        el = np.concatenate([self.elevation_deg, [self.elevation_deg[0]]])
        return np.interp(np.asarray(azimuth_deg) % 360, az, el)


def sample_distances(terrain: Terrain, start_m: float = 10.0) -> np.ndarray:
    """Distances along each ray, spaced at roughly each tier's resolution."""
    parts, d = [], start_m
    for tier in terrain.tiers:
        end = tier.spec.half_width_m
        if end > d:
            parts.append(np.arange(d, end, tier.res))
            d = end
    return np.concatenate(parts)


def compute_horizon(
    terrain: Terrain,
    x0: float,
    y0: float,
    observer_height_m: float = 2.0,
    az_step_deg: float = 0.5,
) -> HorizonMask:
    ground = float(terrain.sample(np.array([x0]), np.array([y0]))[0])
    if np.isnan(ground):
        raise ValueError("No terrain data at the site")
    lat0, lon0 = xy_to_latlon(x0, y0)
    k = float(scale_factor(lat0))  # projected metres per true metre at the site
    north, east = local_north_east(lon0)

    az = np.arange(0, 360, az_step_deg)
    d_true = sample_distances(terrain)  # true surface distance
    d_proj = d_true * k

    a = np.radians(az)[:, None]
    dirx = np.cos(a) * north[0] + np.sin(a) * east[0]
    diry = np.cos(a) * north[1] + np.sin(a) * east[1]
    px = x0 + dirx * d_proj[None, :]
    py = y0 + diry * d_proj[None, :]
    h = terrain.sample(px, py)  # (n_az, n_dist)

    # Exact elevation angle of a terrain point at central angle theta.
    r0 = MOON_RADIUS_M + ground + observer_height_m
    r1 = MOON_RADIUS_M + h
    theta = d_true[None, :] / MOON_RADIUS_M
    elev = np.degrees(np.arctan2(r1 * np.cos(theta) - r0, r1 * np.sin(theta)))
    elev = np.where(np.isnan(elev), -np.inf, elev)

    idx = np.argmax(elev, axis=1)
    best = elev[np.arange(len(az)), idx]
    if np.isinf(best).any():
        raise ValueError("Some azimuths had no terrain data")
    return HorizonMask(az, best, d_true[idx], ground, observer_height_m)
