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
    elevation_deg: np.ndarray  # horizon elevation angle per azimuth (NaN = unknown, terrain data missing)
    distance_m: np.ndarray  # distance to the terrain point that sets the horizon (NaN = unknown)
    ground_height_m: float  # terrain height at the site (relative to 1737.4 km sphere)
    observer_height_m: float  # height of the sensor above the ground

    def at(self, azimuth_deg) -> np.ndarray:
        """Horizon elevation at any azimuth (circular linear interpolation; NaN if either
        neighbouring direction is unknown)."""
        az = np.concatenate([self.azimuth_deg, [self.azimuth_deg[0] + 360]])
        el = np.concatenate([self.elevation_deg, [self.elevation_deg[0]]])
        return np.interp(np.asarray(azimuth_deg) % 360, az, el)


def sample_distances(terrain: Terrain, start_m: float = 10.0) -> np.ndarray:
    """Distances along each ray, spaced at roughly each tier's resolution. Rays stop 2% short of
    the outermost crop's edge, so the edge itself is never mistaken for missing terrain."""
    parts, d = [], start_m
    for i, tier in enumerate(terrain.tiers):
        end = tier.spec.half_width_m * (0.98 if i == len(terrain.tiers) - 1 else 1)
        if end > d:
            parts.append(np.arange(d, end, tier.res))
            d = end
    return np.concatenate(parts)


# (start, end, step) of the distance rings for compute_horizon_latlon, in metres. The step also
# sets which DEM resolution is used (see dem.sample_latlon), like the old near/mid/far tiers.
RINGS = ((10.0, 5_000.0, 5.0), (5_000.0, 45_000.0, 30.0), (45_000.0, 294_000.0, 200.0))


def compute_horizon_latlon(
    lat: float,
    lon: float,
    observer_height_m: float = 2.0,
    az_step_deg: float = 0.5,
    rings=RINGS,
    sampler=None,
) -> HorizonMask:
    """Horizon anywhere on the Moon: walk true great circles from the site in each direction
    and take the highest elevation angle of the terrain, computed from 3D Moon-fixed vectors.

    Same geometry as the independent check in scripts/validate_engine.py (which matched the
    polar-map version to <= 0.005 deg), sampling the whole-Moon DEM registry (app/engine/dem.py).
    A direction is unknown (NaN) if any point along it has no terrain data.
    """
    from .dem import sample_latlon
    from .geo import destination, latlon_to_vec

    sampler = sampler or sample_latlon
    ground = float(sampler(np.array([lat]), np.array([lon]), rings[0][2])[0])
    if np.isnan(ground):
        raise ValueError("No terrain data at the site")
    up = latlon_to_vec(lat, lon)
    eye = (MOON_RADIUS_M + ground + observer_height_m) * up
    az = np.arange(0, 360, az_step_deg)

    best = np.full(az.size, -np.inf)
    dist = np.zeros(az.size)
    unknown = np.zeros(az.size, dtype=bool)
    for d0, d1, step in rings:
        d = np.arange(d0, d1, step)
        lat2, lon2 = destination(lat, lon, az[:, None], d[None, :])
        h = sampler(lat2.ravel(), lon2.ravel(), step).reshape(lat2.shape)
        v = (MOON_RADIUS_M + h)[..., None] * latlon_to_vec(lat2, lon2) - eye
        el = np.degrees(np.arcsin(np.clip((v @ up) / np.linalg.norm(v, axis=-1), -1, 1)))
        unknown |= np.isnan(el).any(axis=1)
        filled = np.where(np.isnan(el), -np.inf, el)
        i = np.argmax(filled, axis=1)
        e = filled[np.arange(az.size), i]
        better = e > best
        best[better] = e[better]
        dist[better] = d[i][better]
    best[unknown] = np.nan
    dist[unknown] = np.nan
    return HorizonMask(az, best, dist, ground, observer_height_m)


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

    # A direction is unknown if any point along it has no terrain in any tier: the missing point
    # could be the one that blocks the sky, so a max over the rest might be too low.
    unknown = np.isnan(elev).any(axis=1)
    filled = np.where(np.isnan(elev), -np.inf, elev)
    idx = np.argmax(filled, axis=1)
    best = filled[np.arange(len(az)), idx]
    best = np.where(unknown, np.nan, best)
    dist = np.where(unknown, np.nan, d_true[idx])
    return HorizonMask(az, best, dist, ground, observer_height_m)
