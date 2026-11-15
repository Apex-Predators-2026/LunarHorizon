"""Sample selection for a mission interval that has already been placed on the hourly grid (app/timegrid.py).

The time *policy* (landing rounded to the nearest whole UTC hour, length to whole hours, the evaluated time reported
back) lives in ``app.timegrid`` and is applied by each consumer before calling these helpers. This module only says
which samples represent an interval ``[landing_utc, landing_utc + duration_days)``, exactly as the canonical engine's
adapters compute it (``timedelta(days=duration_days)``, microsecond precision):

* The data are instantaneous samples with the canonical sample-and-hold support (app/viability/windows.py): sample
  ``i`` represents ``[t_i, t_{i+1})``. A mission needs the sample *at or before* landing and every sample before the
  mission end; the engine clips the first and last supports to the mission bounds. Nothing is interpolated.
* ``covers``: real data cover the whole interval (first sample <= landing and mission end <= last sample; the last
  sample is an instant and never represents time after itself).
* Durations, percentages and means are weighted by represented time (clipped supports), never by sample count.

(Recovered from the unpublished mission-decision-report branch, a733b85; its exact-interval *policy* was not
integrated because main's hourly-grid policy, 3cc2355 / ada6c42, is the team's.)
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import numpy as np

def to_utc(t: datetime) -> datetime:
    """Timezone-aware UTC (naive input is taken as UTC, as in app.models.to_utc)."""
    return t.replace(tzinfo=UTC) if t.tzinfo is None else t.astimezone(UTC)


def mission_bounds(landing_utc: datetime, duration_days: float) -> tuple[datetime, datetime]:
    """[start, end) of a mission, exactly as the canonical adapters compute it."""
    start = to_utc(landing_utc)
    return start, start + timedelta(days=duration_days)


def np_us(t: datetime) -> np.datetime64:
    """A UTC datetime as numpy datetime64[us] (exact for datetime values)."""
    return np.datetime64(to_utc(t).replace(tzinfo=None), "us")


def covers(times: np.ndarray, start: datetime, end: datetime) -> bool:
    """True if samples ``times`` (sorted datetime64) cover [start, end): first <= start and end <= last."""
    return len(times) >= 1 and times[0] <= np_us(start) and np_us(end) <= times[-1]


def sample_range(times: np.ndarray, start: datetime, end: datetime) -> tuple[int, int]:
    """Index range [i, j) of the samples that represent [start, end) under sample-and-hold: from the sample at or
    before ``start`` to the last sample before ``end``. Requires ``covers(times, start, end)``."""
    s, e = np_us(start), np_us(end)
    i = int(np.searchsorted(times, s, side="right")) - 1
    j = int(np.searchsorted(times, e, side="left"))
    if i < 0 or j <= i:
        raise ValueError(f"samples do not cover {start.isoformat()} .. {end.isoformat()}")
    return i, j


def iso_z(t: datetime | np.datetime64) -> str:
    """UTC ISO 8601 with a Z suffix (microseconds only when non-zero)."""
    if isinstance(t, np.datetime64):
        t = datetime.fromisoformat(str(np.datetime64(t, "us"))).replace(tzinfo=UTC)
    return to_utc(t).isoformat().replace("+00:00", "Z")
