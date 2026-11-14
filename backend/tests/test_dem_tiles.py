"""Elevation registry + cube-sphere tiles, without network (fake Moon Trek blocks)."""

import numpy as np
import pytest
from rasterio.warp import transform

from app.engine import dem
from app.engine.geo import (
    MOON_GEOG_WKT,
    MOON_NPOLE_WKT,
    destination,
    latlon_to_vec,
    latlon_to_xy_np,
    xy_to_latlon_np,
)
from app.engine.tiles import (
    FACES,
    N,
    max_zoom_for,
    tile_at,
    tile_latlon,
    uv_to_vec,
    vec_to_latlon,
    vertex_spacing_m,
)


# ---------------------------------------------------------------- projections

@pytest.mark.parametrize("lat,lon", [(88.0, 20.0), (80.5, 250.0), (89.9, 359.0)])
def test_north_polar_projection_matches_proj(lat, lon):
    xs, ys = transform(MOON_GEOG_WKT, MOON_NPOLE_WKT, [lon], [lat])
    x, y = latlon_to_xy_np(lat, lon)
    assert x == pytest.approx(xs[0], abs=0.01) and y == pytest.approx(ys[0], abs=0.01)
    lat2, lon2 = xy_to_latlon_np(x, y)
    assert lat2 == pytest.approx(lat, abs=1e-9) and lon2 == pytest.approx(lon, abs=1e-9)


def test_destination_great_circle():
    lat, lon = destination(0.0, 0.0, 90.0, np.pi / 2 * 1_737_400.0)  # a quarter turn east along the equator
    assert lat == pytest.approx(0, abs=1e-9) and lon == pytest.approx(90, abs=1e-9)
    lat, _ = destination(-89.0, 10.0, 180.0, 1_737_400.0 * np.radians(1.0))  # 1 deg south from 89S
    assert lat == pytest.approx(-90, abs=1e-6)


# ---------------------------------------------------------------- fake Moon Trek

class FakeStore(dem._BlockStore):
    """Blocks whose heights are a known linear function of map coordinates."""

    def __init__(self, fn):
        super().__init__()
        self.fn = fn
        self.downloads = 0

    def get(self, src, level, bx, by):
        key = (src.name, level, bx, by)
        if key not in self.mem:
            x0, y0, x1, y1, px = self._bbox(src, level, bx, by)
            bp = dem.block_px(src, level)
            cols = x0 + (np.arange(bp) + 0.5) * px
            rows = y1 - (np.arange(bp) + 0.5) * px
            X, Y = np.meshgrid(cols, rows)
            self.mem[key] = self.fn(src, X, Y).astype(np.float32)
            self.downloads += 1
        return self.mem[key]


def test_bilinear_sampling_reproduces_a_linear_field_across_blocks():
    store = FakeStore(lambda src, X, Y: 0.01 * X - 0.02 * Y)
    src = dem.SOURCES["sp30"]
    x = np.linspace(-40_000, 40_000, 50)  # spans several 30 m blocks (30.7 km each)
    y = np.linspace(30_000, -25_000, 50)
    z = dem.sample_source(src, 0, x, y, store)
    assert np.allclose(z, 0.01 * x - 0.02 * y, atol=1e-2)


def test_source_choice_by_latitude_and_spacing():
    seen = []

    def tag(src, X, Y):
        seen.append(src.name)
        return np.full(X.shape, {"sp5": 5.0, "sp20": 20.0, "sp30": 30.0, "sp100": 100.0, "global": 1.0}.get(src.name, -1.0))

    store = FakeStore(tag)
    # Near the south pole with fine spacing -> 5 m product; coarse spacing -> 100 m product.
    assert dem.sample_latlon(np.array([-89.5]), np.array([0.0]), 5, store)[0] == 5.0
    assert dem.sample_latlon(np.array([-89.5]), np.array([0.0]), 500, store)[0] == 100.0
    # Mid-latitudes always use the global product.
    assert dem.sample_latlon(np.array([10.0]), np.array([20.0]), 5, store)[0] == 1.0
    # At 70S the 5/20 m products don't reach; 30 m does.
    assert dem.sample_latlon(np.array([-80.0]), np.array([45.0]), 10, store)[0] == 30.0


def test_level_choice():
    src = dem.SOURCES["sp5"]
    assert dem.level_for(src, 3) == 0
    assert dem.level_for(src, 5) == 0
    assert dem.level_for(src, 41) == 3  # 5 * 2^3 = 40 <= 41


def test_global_blocks_never_span_more_than_32_degrees():
    src = dem.SOURCES["global"]
    for level in range(0, 12):
        assert dem.block_px(src, level) * src.native * 2**level <= dem.MAX_SPAN_EQ_DEG + 1e-9
    store = FakeStore(lambda src, X, Y: np.sin(np.radians(Y)))  # coarse global sampling still works
    z = dem.sample_latlon(np.array([30.0, -45.0]), np.array([10.0, 200.0]), 40_000, store)
    assert z == pytest.approx(np.sin(np.radians([30.0, -45.0])), abs=0.02)


def test_global_wraps_at_180():
    store = FakeStore(lambda src, X, Y: np.cos(np.radians(X)))
    z = dem.sample_latlon(np.array([0.0, 0.0]), np.array([179.999, 180.001]), 200, store)
    assert np.all(np.isfinite(z)) and z == pytest.approx([-1, -1], abs=1e-3)


# ---------------------------------------------------------------- cube sphere

def test_faces_are_orthonormal_and_poles_are_face_centres():
    for c, r, u in FACES:
        m = np.array([c, r, u], dtype=float)
        assert np.allclose(m @ m.T, np.eye(3))
    lat, _ = vec_to_latlon(uv_to_vec(5, 0.0, 0.0))
    assert lat == pytest.approx(-90)
    lat, _ = vec_to_latlon(uv_to_vec(4, 0.0, 0.0))
    assert lat == pytest.approx(90)


def test_neighbouring_tiles_share_edges():
    # Right edge of tile (1,0) at level 1 == left edge of tile (1,1)... on the same face.
    lat_a, lon_a = tile_latlon(5, 1, 0, 0)
    lat_b, lon_b = tile_latlon(5, 1, 1, 0)
    va, vb = latlon_to_vec(lat_a[:, -1], lon_a[:, -1]), latlon_to_vec(lat_b[:, 0], lon_b[:, 0])
    assert np.allclose(va, vb, atol=1e-12)


def test_faces_tile_the_whole_sphere():
    rng = np.random.default_rng(0)
    p = rng.normal(size=(2000, 3))
    p /= np.linalg.norm(p, axis=1, keepdims=True)
    # Every direction belongs to the face whose centre has the largest dot product.
    face = np.argmax(np.array([c for c, _, _ in FACES], dtype=float) @ p.T, axis=0)
    assert set(face.tolist()) == set(range(6))


@pytest.mark.parametrize("lat,lon", [(-89.53432, 209.94767), (0.67, 23.47), (45.0, 300.0), (-90.0, 0.0), (10.0, 135.0)])
def test_tile_at_contains_the_point(lat, lon):
    for z in (0, 4, 10):
        face, x, y = tile_at(lat, lon, z)
        tlat, tlon = tile_latlon(face, z, x, y, n=3)
        corners = latlon_to_vec(tlat, tlon).reshape(-1, 3)
        p = latlon_to_vec(lat, lon)
        # The point is no further from the tile centre than the tile's own corners are.
        centre = corners[4]
        assert np.dot(p, centre) >= min(np.dot(c, centre) for c in corners) - 1e-12


def test_spacing_and_max_zoom():
    assert vertex_spacing_m(13) == pytest.approx(5.2, abs=0.1)
    assert max_zoom_for(5, 13, 4096, 4096) == 13  # south pole: 5 m data
    assert max_zoom_for(0, 0, 0, 0) == 8  # equator: global ~118 m product
    assert tile_latlon(5, 0, 0, 0)[0].shape == (N, N)
