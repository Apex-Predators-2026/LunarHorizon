"""Engine checks against cases with known answers (no network)."""

import numpy as np
import pytest
from rasterio.warp import transform

from app.engine.ephemeris import _parse
from app.engine.geo import (
    MOON_GEOG_WKT,
    MOON_RADIUS_M,
    MOON_SPOLE_WKT,
    latlon_to_xy,
    local_north_east,
    xy_to_latlon,
)
from app.engine.horizon import compute_horizon
from app.engine.terrain import Terrain, Tier, TierSpec
from app.engine.visibility import disk_fraction_visible, intervals, next_transition_off


# ---------- projection ----------

@pytest.mark.parametrize("lat,lon", [(-89.67, 129.78), (-85.99, 357.07), (-89.53432, 209.94767)])
def test_projection_matches_proj(lat, lon):
    xs, ys = transform(MOON_GEOG_WKT, MOON_SPOLE_WKT, [lon], [lat])
    x, y = latlon_to_xy(lat, lon)
    assert x == pytest.approx(xs[0], abs=0.01)
    assert y == pytest.approx(ys[0], abs=0.01)
    lat2, lon2 = xy_to_latlon(x, y)
    assert lat2 == pytest.approx(lat, abs=1e-9)
    assert lon2 == pytest.approx(lon, abs=1e-9)


def test_north_and_east_directions():
    lat, lon = -88.0, 40.0
    x, y = latlon_to_xy(lat, lon)
    north, east = local_north_east(lon)
    lat_n, _ = xy_to_latlon(x + 100 * north[0], y + 100 * north[1])
    _, lon_e = xy_to_latlon(x + 100 * east[0], y + 100 * east[1])
    assert lat_n > lat  # north = away from the south pole
    assert lon_e > lon  # east = increasing longitude


# ---------- horizon ----------

def _tiers(z_fn):
    """Synthetic 2-tier terrain centred on (0, 50 km); z_fn(x, y) gives heights."""
    out = []
    for spec in (TierSpec("near", "-", 5, 5_000), TierSpec("far", "-", 100, 150_000)):
        n = int(2 * spec.half_width_m / spec.res_m)
        x0, y0 = -spec.half_width_m, 50_000 + spec.half_width_m
        c = x0 + (np.arange(n) + 0.5) * spec.res_m
        r = y0 - (np.arange(n) + 0.5) * spec.res_m
        X, Y = np.meshgrid(c, r)
        out.append(Tier(spec, z_fn(X, Y).astype(float), x0, y0, spec.res_m))
    return Terrain(out)


def test_flat_sphere_horizon_is_geometric_dip():
    terrain = _tiers(lambda x, y: np.zeros_like(x))
    mask = compute_horizon(terrain, 0.0, 50_000.0, observer_height_m=2.0, az_step_deg=10)
    expected = -np.degrees(np.arccos(MOON_RADIUS_M / (MOON_RADIUS_M + 2.0)))  # ~ -0.087 deg
    assert mask.elevation_deg == pytest.approx(expected, abs=0.005)


def test_ridge_blocks_only_its_direction():
    # 1000 m ridge 2 km from the site, on the side away from the pole (local north here).
    terrain = _tiers(lambda x, y: np.where((y > 52_000) & (y < 52_200), 1000.0, 0.0))
    mask = compute_horizon(terrain, 0.0, 50_000.0, observer_height_m=0.0, az_step_deg=1)
    assert mask.at(0) == pytest.approx(np.degrees(np.arctan(1000 / 2000)), abs=0.5)  # ~26.6 deg
    assert mask.at(180) < 0.1  # nothing to the south
    assert mask.distance_m[0] == pytest.approx(2000, abs=50)


def test_latlon_horizon_on_a_bare_sphere_is_the_geometric_dip():
    from app.engine.horizon import compute_horizon_latlon

    flat = lambda lat, lon, spacing: np.zeros(np.shape(lat))  # noqa: E731
    for lat, lon in ((0.67, 23.47), (-89.5, 210.0), (45.0, 300.0)):
        m = compute_horizon_latlon(lat, lon, observer_height_m=2.0, az_step_deg=30, sampler=flat)
        expected = -np.degrees(np.arccos(MOON_RADIUS_M / (MOON_RADIUS_M + 2.0)))
        assert m.elevation_deg == pytest.approx(expected, abs=0.005)


def test_latlon_horizon_sees_a_ridge_in_the_right_direction():
    from app.engine.geo import destination
    from app.engine.horizon import compute_horizon_latlon

    # A thin (~30 m) 1000 m wall 2 km due east of an equatorial site (east = increasing longitude).
    lat0, lon0 = 0.0, 20.0
    wall_lat, wall_lon = destination(lat0, lon0, 90.0, 2000.0)

    def ridge(lat, lon, spacing):
        lat, lon = np.asarray(lat), np.asarray(lon)
        near = (np.abs(lon - wall_lon) < 0.0005) & (np.abs(lat - lat0) < 1.0)
        return np.where(near, 1000.0, 0.0)

    m = compute_horizon_latlon(lat0, lon0, observer_height_m=0.0, az_step_deg=1, sampler=ridge)
    assert m.at(90) == pytest.approx(np.degrees(np.arctan(1000 / 2000)), abs=0.5)  # ~26.6 deg east
    assert m.at(270) < 0.1  # nothing to the west
    assert m.distance_m[90] == pytest.approx(2000, abs=30)


def test_missing_terrain_makes_only_that_direction_unknown():
    # Hole with no data in any tier, 3 km to the east of the site (local east = +x here).
    def z(x, y):
        out = np.zeros_like(x)
        out[(x > 2_900) & (x < 3_100) & (np.abs(y - 50_000) < 100)] = np.nan
        return out

    mask = compute_horizon(_tiers(z), 0.0, 50_000.0, observer_height_m=2.0, az_step_deg=1)
    assert np.isnan(mask.at(90))  # looking through the hole: unknown, not a guess
    assert np.isnan(mask.distance_m[90])
    assert not np.isnan(mask.at(0)) and not np.isnan(mask.at(180)) and not np.isnan(mask.at(270))
    assert np.isnan(mask.elevation_deg).sum() <= 6  # only a few degrees around east


def test_timeline_marks_unknown_hours():
    from app.engine.ephemeris import Ephemeris
    from app.engine.horizon import HorizonMask
    from app.engine.visibility import build_timeline

    az = np.arange(0, 360, 90.0)
    mask = HorizonMask(az, np.array([1.0, np.nan, 1.0, 1.0]), np.array([1e3, np.nan, 1e3, 1e3]), 0.0, 2.0)
    t = np.array(["2027-01-01T00", "2027-01-01T01"], dtype="datetime64[s]")
    sun = Ephemeris("sun", t, np.array([0.0, 90.0]), np.array([2.0, 2.0]), np.array([0.27, 0.27]))
    earth = Ephemeris("earth", t, np.array([90.0, 180.0]), np.array([5.0, 5.0]), np.array([np.nan, np.nan]))
    tl = build_timeline(sun, earth, mask)
    assert tl.sun_known.tolist() == [True, False]  # Sun due east at hour 1 -> unknown
    assert tl.sunlit.tolist() == [True, False]
    assert tl.earth_known.tolist() == [False, True]


# ---------- visibility ----------

def test_disk_fraction():
    r = 0.27
    assert disk_fraction_visible(-r, r) == pytest.approx(0)
    assert disk_fraction_visible(0, r) == pytest.approx(0.5)
    assert disk_fraction_visible(r, r) == pytest.approx(1)
    assert disk_fraction_visible(-5, r) == pytest.approx(0)
    a, b = disk_fraction_visible([0.1, -0.1], r)
    assert a + b == pytest.approx(1)  # symmetric


def test_intervals_and_next_transition():
    t = np.arange(np.datetime64("2027-01-01T00:00"), np.datetime64("2027-01-01T08:00"), np.timedelta64(1, "h"))
    on = np.array([0, 1, 1, 0, 0, 1, 1, 1], dtype=bool)
    runs = intervals(t, on)
    assert [(str(a), str(b)) for a, b in runs] == [
        ("2027-01-01T01:00", "2027-01-01T03:00"),
        ("2027-01-01T05:00", "2027-01-01T07:00"),
    ]
    assert next_transition_off(t, on, t[1]) == t[3]
    assert next_transition_off(t, on, t[0]) is None  # already off
    assert next_transition_off(t, on, t[6]) is None  # never switches off in the data


# ---------- Horizons parsing ----------

SAMPLE = """\
*******************************************************************************
 Date__(UT)__HR:MN, , ,Azi_(a-app), Elev_(a-app),  Ang-diam,
*************************************************
$$SOE
 2027-Jan-01 00:00,*, , 133.339447,     0.787435,  1919.52,
 2027-Jan-01 01:00,*, , 359.900000,     0.788883,  1919.50,
 2027-Jan-01 02:00,*, ,   0.100000,     0.790350,  1919.48,
$$EOE
"""


def _with_frame(frame: str) -> str:
    # In real responses this line sits near the top of the header, well above the column names.
    return f"Center pole/equ : {frame} (high precision)        {{East-longitude positive}}\n" + SAMPLE


def test_frame_guard_accepts_mean_earth_and_rejects_others():
    assert len(_parse(_with_frame("MEAN_ME"), "sun").times) == 3
    with pytest.raises(RuntimeError, match="unexpected frame"):
        _parse(_with_frame("IAU_MOON"), "sun")


def test_parse_and_interpolate_across_north():
    eph = _parse(SAMPLE, "sun")
    assert len(eph.times) == 3
    assert eph.angular_radius_deg[0] == pytest.approx(1919.52 / 3600 / 2)
    mid = eph.at(np.array(["2027-01-01T01:30"], dtype="datetime64[s]"))
    assert mid.azimuth_deg[0] == pytest.approx(0.0, abs=1e-6)  # wraps 359.9 -> 0.1 correctly
