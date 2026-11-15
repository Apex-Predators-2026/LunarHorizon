"""Timeline: Sun/Earth position + terrain horizon at a site, sampled at a fixed step.

This is the array form of the team's `TimelineStep` list (app/models.py,
docs/interfaces.md). Andrew's data engine produces those; rescue and viability only read
them, through a TimelineProvider.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Protocol

import numpy as np

from ...models import Site


def to_np_utc(t: datetime) -> np.datetime64:
    if t.tzinfo is not None:
        t = t.astimezone(timezone.utc).replace(tzinfo=None)
    return np.datetime64(t, "s")


@dataclass
class Timeline:
    site: Site
    times: np.ndarray  # datetime64[s], UTC, evenly spaced
    step_hours: float
    sun_az: np.ndarray
    sun_el: np.ndarray
    sun_horizon: np.ndarray
    sun_visible_fraction: np.ndarray  # 0-1, share of the solar disk above the terrain
    earth_az: np.ndarray
    earth_el: np.ndarray
    earth_horizon: np.ndarray
    earth_visible: np.ndarray  # bool
    source: str
    # Authoritative any-disk-visible flag from the site file (1.0 / 0.0 / NaN = unknown), when the source has one. A
    # sliver whose fraction was written as 0.0 can still be visible; None = no flag (state comes from the fraction).
    sun_visible: np.ndarray | None = None

    def __len__(self) -> int:
        return len(self.times)

    def index_of(self, t: datetime) -> int:
        """Index of the first sample at or after t."""
        return int(np.searchsorted(self.times, to_np_utc(t)))

    def slice(self, start: int, stop: int) -> "Timeline":
        s = slice(start, stop)
        return Timeline(
            site=self.site, times=self.times[s], step_hours=self.step_hours,
            sun_az=self.sun_az[s], sun_el=self.sun_el[s], sun_horizon=self.sun_horizon[s],
            sun_visible_fraction=self.sun_visible_fraction[s],
            earth_az=self.earth_az[s], earth_el=self.earth_el[s], earth_horizon=self.earth_horizon[s],
            earth_visible=self.earth_visible[s], source=self.source,
            sun_visible=None if self.sun_visible is None else self.sun_visible[s],
        )

    @property
    def earth_margin(self) -> np.ndarray:
        """Earth elevation minus terrain horizon (negative = blocked), like TimelineStep.earth.margin_deg."""
        return self.earth_el - self.earth_horizon

    def to_steps(self) -> list[dict]:
        """Convert to the team's TimelineStep JSON (app/models.py, docs/interfaces.md)."""
        margin = self.earth_margin
        return [
            {
                "time_utc": str(self.times[i]) + "Z",
                "sun": {"azimuth_deg": float(self.sun_az[i]), "elevation_deg": float(self.sun_el[i]),
                        "horizon_deg": float(self.sun_horizon[i]),
                        "visible_fraction": float(self.sun_visible_fraction[i])},
                "earth": {"azimuth_deg": float(self.earth_az[i]), "elevation_deg": float(self.earth_el[i]),
                          "horizon_deg": float(self.earth_horizon[i]), "visible": bool(self.earth_visible[i]),
                          "margin_deg": float(margin[i])},
            }
            for i in range(len(self))
        ]


class TimelineProvider(Protocol):
    def timeline(self, site: Site, start: datetime, end: datetime, step_hours: float = 1.0) -> Timeline:
        """Samples from start (inclusive) to end (inclusive) every step_hours."""
        ...


SUN_ANGULAR_RADIUS_DEG = 0.2666


def solar_disk_fraction(sun_el: np.ndarray, horizon: np.ndarray) -> np.ndarray:
    """Share of the solar disk above a flat terrain line at `horizon` (circular-segment area)."""
    d = np.clip((np.asarray(horizon) - np.asarray(sun_el)) / SUN_ANGULAR_RADIUS_DEG, -1.0, 1.0)
    return (np.arccos(d) - d * np.sqrt(1.0 - d * d)) / np.pi


def time_grid(start: datetime, end: datetime, step_hours: float) -> np.ndarray:
    s, e = to_np_utc(start), to_np_utc(end)
    step = np.timedelta64(int(round(step_hours * 3600)), "s")
    return np.arange(s, e + step, step)
