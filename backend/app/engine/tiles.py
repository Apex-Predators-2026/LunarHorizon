"""Cube-sphere terrain tiles for the whole Moon.

The sphere is split into 6 cube faces, each a quadtree. Poles sit at the centres of faces 4
(north) and 5 (south), so there is no singularity at the pole, the area we care most about.
Faces use the equal-angle mapping (tan), which keeps tiles roughly the same size.

Moon-fixed frame (same as Horizons/LOLA ME): x -> (lat 0, lon 0), y -> (lat 0, lon 90E), z -> north.

The frontend (src/viz/globe/cubeSphere.ts) must use exactly the same FACES table and vertex order:
heights[j * N + i], i along the face's `right` axis (u), j along its `up` axis (v), both increasing.
"""

import numpy as np

from .dem import finest_native_m, sample_latlon
from .geo import MOON_RADIUS_M, latlon_to_vec

N = 65  # vertices per tile side

# (centre, right, up) for each face, as unit vectors in the Moon-fixed frame.
FACES = (
    ((1, 0, 0), (0, 1, 0), (0, 0, 1)),  # 0: +X  (centred on lat 0, lon 0)
    ((0, 1, 0), (-1, 0, 0), (0, 0, 1)),  # 1: +Y  (lon 90E)
    ((-1, 0, 0), (0, -1, 0), (0, 0, 1)),  # 2: -X  (lon 180)
    ((0, -1, 0), (1, 0, 0), (0, 0, 1)),  # 3: -Y  (lon 90W)
    ((0, 0, 1), (0, 1, 0), (-1, 0, 0)),  # 4: +Z  (north pole)
    ((0, 0, -1), (0, 1, 0), (1, 0, 0)),  # 5: -Z  (south pole)
)
FACE_EDGE_M = np.pi / 2 * MOON_RADIUS_M  # arc length of a face edge
MAX_ZOOM = 13  # ~5 m vertex spacing, matches the 5 m polar DEMs


def tile_uv(z: int, x: int, y: int, n: int = N, pad: int = 0):
    """Face coordinates u, v of the tile's vertex grid, shape (n + 2 pad)^2, indexed [j, i].
    `pad` adds that many rings of vertices outside the tile (the neighbours' first rows), so a
    client can compute normals at the tile's edges that match the neighbouring tile exactly."""
    size = 2.0 / 2**z
    k = np.arange(-pad, n + pad) / (n - 1)
    u = -1 + size * (x + k)
    v = -1 + size * (y + k)
    return np.meshgrid(u, v)  # U[j, i] = u_i, V[j, i] = v_j


def uv_to_vec(face: int, u, v):
    """Unit vectors for face coordinates (equal-angle cube mapping)."""
    c, r, up = (np.array(a, dtype=float) for a in FACES[face])
    tu = np.tan(np.asarray(u) * np.pi / 4)[..., None]
    tv = np.tan(np.asarray(v) * np.pi / 4)[..., None]
    p = c + tu * r + tv * up
    return p / np.linalg.norm(p, axis=-1, keepdims=True)


def vec_to_latlon(p):
    p = np.asarray(p, dtype=float)
    lat = np.degrees(np.arcsin(np.clip(p[..., 2], -1, 1)))
    lon = np.degrees(np.arctan2(p[..., 1], p[..., 0])) % 360
    return lat, lon


def tile_latlon(face: int, z: int, x: int, y: int, n: int = N, pad: int = 0):
    U, V = tile_uv(z, x, y, n, pad)
    return vec_to_latlon(uv_to_vec(face, U, V))


def vertex_spacing_m(z: int, n: int = N) -> float:
    """Approximate distance between neighbouring vertices of a level-z tile."""
    return FACE_EDGE_M / 2**z / (n - 1)


def tile_centre_latlon(face: int, z: int, x: int, y: int):
    size = 2.0 / 2**z
    lat, lon = vec_to_latlon(uv_to_vec(face, -1 + size * (x + 0.5), -1 + size * (y + 0.5)))
    return float(lat), float(lon)


def tile_at(lat: float, lon: float, z: int) -> tuple[int, int, int]:
    """(face, x, y) of the level-z tile containing a point (inverse of the cube mapping)."""
    p = latlon_to_vec(lat, lon)
    face = int(np.argmax([np.dot(c, p) for c, _, _ in FACES]))
    c, r, up = (np.array(a, dtype=float) for a in FACES[face])
    q = p / np.dot(p, c)  # project onto the cube face plane
    u = np.arctan(np.dot(q, r)) * 4 / np.pi
    v = np.arctan(np.dot(q, up)) * 4 / np.pi
    n = 2**z
    return face, min(n - 1, int((u + 1) / 2 * n)), min(n - 1, int((v + 1) / 2 * n))


def max_zoom_for(face: int, z: int, x: int, y: int) -> int:
    """Deepest useful level at this tile: vertex spacing no finer than the best data there."""
    lat, lon = tile_centre_latlon(face, z, x, y)
    native = finest_native_m(lat, lon)
    zmax = int(np.floor(np.log2(FACE_EDGE_M / (N - 1) / native)))
    return max(0, min(MAX_ZOOM, zmax))


def validate_tile(face: int, z: int, x: int, y: int) -> None:
    if not (0 <= face < 6 and 0 <= z <= MAX_ZOOM and 0 <= x < 2**z and 0 <= y < 2**z):
        raise ValueError(f"No such tile: face {face}, level {z}, x {x}, y {y}")


def tile_heights(face: int, z: int, x: int, y: int, n: int = N, pad: int = 0, coarser_if_offline: bool = True) -> np.ndarray:
    """Heights (m, relative to the 1737.4 km sphere) of the tile's vertices, float32, row-major
    [j, i]: n x n, or (n + 2 pad)^2 with `pad` rings of the neighbours' vertices around it (the
    inner n x n are identical either way). Missing data (should be rare) is filled with the
    tile's mean, or 0."""
    validate_tile(face, z, x, y)
    lat, lon = tile_latlon(face, z, x, y, n, pad)
    m = n + 2 * pad
    # Offline (a demo away from the warmed areas): coarser cached data rather than no tile.
    # (prefetch_tiles.py --check turns this off: it must see what is really missing.)
    h = sample_latlon(lat.ravel(), lon.ravel(), vertex_spacing_m(z, n), coarser_if_offline=coarser_if_offline).reshape(m, m)
    if np.isnan(h).any():
        h = np.where(np.isnan(h), np.nanmean(h) if not np.isnan(h).all() else 0.0, h)
    return h.astype(np.float32)
