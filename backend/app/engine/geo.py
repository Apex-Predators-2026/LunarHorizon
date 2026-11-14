"""Moon geometry and the south polar stereographic projection used by Moon Trek.

Projection (sphere, true scale at the pole, central meridian 0):
    rho = 2R tan(pi/4 + lat/2),  x = rho sin(lon),  y = rho cos(lon)
Verified against rasterio/PROJ in tests/test_geo.py.
"""

import numpy as np

MOON_RADIUS_M = 1_737_400.0

MOON_GEOG_WKT = (
    'GEOGCS["GCS_Moon",DATUM["D_Moon_2000",SPHEROID["Moon_2000_IAU_IAG",1737400.0,0.0]],'
    'PRIMEM["Reference_Meridian",0.0],UNIT["Degree",0.0174532925199433]]'
)
MOON_SPOLE_WKT = (
    'PROJCS["Moon2000_spole",' + MOON_GEOG_WKT + ',PROJECTION["Stereographic_South_Pole"],'
    'PARAMETER["false_easting",0.0],PARAMETER["false_northing",0.0],'
    'PARAMETER["central_meridian",0.0],PARAMETER["standard_parallel_1",-90.0],UNIT["Meter",1.0]]'
)


def latlon_to_xy(lat_deg, lon_deg):
    """Lat/lon (deg, east-positive) -> south polar stereographic x, y (m)."""
    lat = np.radians(lat_deg)
    lon = np.radians(lon_deg)
    rho = 2 * MOON_RADIUS_M * np.tan(np.pi / 4 + lat / 2)
    return rho * np.sin(lon), rho * np.cos(lon)


def xy_to_latlon(x, y):
    """South polar stereographic x, y (m) -> lat/lon (deg, lon in [0, 360))."""
    rho = np.hypot(x, y)
    lat = 2 * np.arctan(rho / (2 * MOON_RADIUS_M)) - np.pi / 2
    lon = np.arctan2(x, y)
    return np.degrees(lat), np.degrees(lon) % 360


def scale_factor(lat_deg):
    """Map scale factor k (projected distance / true distance) at a latitude."""
    return 2 / (1 + np.sin(-np.radians(lat_deg)))


def local_north_east(lon_deg):
    """Unit vectors (in the projection plane) pointing local north and local east.

    Near the south pole, north points away from the pole and east is the
    direction of increasing longitude.
    """
    lon = np.radians(lon_deg)
    north = np.array([np.sin(lon), np.cos(lon)])
    east = np.array([np.cos(lon), -np.sin(lon)])
    return north, east
