"""Combine ephemeris with the terrain horizon into sunlight / Earth-visibility timelines."""

from dataclasses import dataclass

import numpy as np

from .ephemeris import Ephemeris
from .horizon import HorizonMask

# Earth counts as visible for radio when its centre clears the terrain by this much.
EARTH_MIN_MARGIN_DEG = 0.0


def disk_fraction_visible(center_minus_horizon_deg, radius_deg) -> np.ndarray:
    """Fraction of a disk above a straight horizon line (0..1).

    u = how far the disk centre is above the line, in disk radii. The hidden part
    is a circular segment: area fraction (acos(u) - u*sqrt(1-u^2)) / pi.
    """
    u = np.clip(np.asarray(center_minus_horizon_deg) / radius_deg, -1, 1)
    return 1 - (np.arccos(u) - u * np.sqrt(1 - u * u)) / np.pi


@dataclass
class Timeline:
    times: np.ndarray  # datetime64[s]
    sun_az: np.ndarray
    sun_el: np.ndarray
    sun_horizon: np.ndarray  # NaN = unknown (terrain data missing in that direction)
    sun_fraction: np.ndarray  # 0..1 of the solar disk above terrain; NaN = unknown
    sun_radius: np.ndarray  # apparent solar radius used for the disk (deg)
    earth_az: np.ndarray
    earth_el: np.ndarray
    earth_horizon: np.ndarray  # NaN = unknown
    earth_margin: np.ndarray  # earth_el - earth_horizon; NaN = unknown
    earth_visible: np.ndarray  # bool (False where unknown; check earth_known)

    @property
    def sun_known(self) -> np.ndarray:
        return ~np.isnan(self.sun_fraction)

    @property
    def earth_known(self) -> np.ndarray:
        return ~np.isnan(self.earth_margin)

    @property
    def sunlit(self) -> np.ndarray:
        """Any part of the solar disk above the terrain (False where unknown; check sun_known)."""
        return self.sun_fraction > 0


def build_timeline(sun: Ephemeris, earth: Ephemeris, mask: HorizonMask) -> Timeline:
    if not np.array_equal(sun.times, earth.times):
        earth = earth.at(sun.times)
    sun_h = mask.at(sun.azimuth_deg)
    earth_h = mask.at(earth.azimuth_deg)
    radius = np.where(np.isnan(sun.angular_radius_deg), 0.2666, sun.angular_radius_deg)
    margin = earth.elevation_deg - earth_h
    with np.errstate(invalid="ignore"):  # NaN comparisons (unknown terrain) are expected
        return Timeline(
            times=sun.times,
            sun_az=sun.azimuth_deg,
            sun_el=sun.elevation_deg,
            sun_horizon=sun_h,
            sun_fraction=disk_fraction_visible(sun.elevation_deg - sun_h, radius),
            sun_radius=radius,
            earth_az=earth.azimuth_deg,
            earth_el=earth.elevation_deg,
            earth_horizon=earth_h,
            earth_margin=margin,
            earth_visible=margin > EARTH_MIN_MARGIN_DEG,
        )


def intervals(times: np.ndarray, on: np.ndarray) -> list[tuple[np.datetime64, np.datetime64]]:
    """Contiguous [start, end) runs where `on` is True. `end` is the first sample that is off
    (or the last sample if the run reaches the end of the data)."""
    on = np.asarray(on, dtype=bool)
    if not on.any():
        return []
    edges = np.diff(np.concatenate([[False], on, [False]]).astype(np.int8))
    starts = np.flatnonzero(edges == 1)
    ends = np.flatnonzero(edges == -1)
    return [(times[s], times[min(e, len(times) - 1)]) for s, e in zip(starts, ends)]


def next_edge(on: np.ndarray, i: int, to_state: bool) -> int | None:
    """Index of the first sample after i where `on` switches to `to_state` (e.g. to_state=False
    gives the next sunset even if it is currently dark). None if it never happens in the data."""
    on = np.asarray(on, dtype=bool)
    j = np.flatnonzero((on[i + 1 :] == to_state) & (on[i:-1] != to_state))
    return i + 1 + int(j[0]) if len(j) else None


def next_transition_off(times: np.ndarray, on: np.ndarray, t: np.datetime64):
    """First time at/after t when `on` switches from True to False (e.g. next sunset/Earthset).
    Returns None if it is already off at t, or never switches off within the data."""
    i = int(np.searchsorted(times, t))
    if i >= len(times) or not on[i]:
        return None
    off = np.flatnonzero(~np.asarray(on[i:], dtype=bool))
    return times[i + off[0]] if len(off) else None
