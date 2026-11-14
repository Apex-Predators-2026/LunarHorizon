"""Small spherical-geometry helpers on the Moon."""
from __future__ import annotations

import math

MOON_RADIUS_KM = 1737.4


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two lunar points (haversine)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * MOON_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def destination(lat: float, lon: float, bearing_deg: float, dist_km: float) -> tuple[float, float]:
    """Point reached by travelling dist_km from (lat, lon) along bearing_deg (0 = north)."""
    d = dist_km / MOON_RADIUS_KM
    b = math.radians(bearing_deg)
    p1, l1 = math.radians(lat), math.radians(lon)
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), math.degrees(l2) % 360.0


def polar_xy_km(lat: float, lon: float) -> tuple[float, float]:
    """South-polar azimuthal-equidistant x/y in km (smooth everywhere near the pole)."""
    r = (90.0 + lat) * math.pi / 180.0 * MOON_RADIUS_KM
    a = math.radians(lon)
    return r * math.sin(a), r * math.cos(a)
