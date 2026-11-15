"""The hourly evaluation grid, shared by the Planner, Comparison, Mission Rescue and the Feasibility Atlas.

Policy for this release (review item #4: one documented policy, the same mission evaluated the same way on every
screen): the real data is hourly on whole UTC hours, so every mission is evaluated on that grid.

* The landing time is rounded to the nearest whole UTC hour (half an hour rounds up): 00:15 -> 00:00,
  00:30 -> 01:00.
* The mission length is rounded to whole hours (at least one hour): 1.01 days (24.24 h) -> 24 h.
* Every result reports the landing time and length that were evaluated. When they differ from what was asked,
  it says so in plain words (``time_note``).

Arbitrary sub-hour times would need interval semantics finer than the data. Rounding is honest because the
evaluated time is always shown.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

GRID_HOURS = 1.0
_ORIGIN = datetime(1970, 1, 1, tzinfo=timezone.utc)

POLICY = ("Missions are evaluated on the hourly data grid: the landing time is rounded to the nearest whole UTC "
          "hour and the length to whole hours.")


def _utc(t: datetime) -> datetime:
    return t.replace(tzinfo=timezone.utc) if t.tzinfo is None else t.astimezone(timezone.utc)


def snap_time(t: datetime, step_hours: float = GRID_HOURS) -> datetime:
    """Nearest whole grid step on the UTC clock; half a step rounds up."""
    t = _utc(t)
    step = timedelta(hours=step_hours)
    return _ORIGIN + ((t - _ORIGIN + step / 2) // step) * step


def snap_duration_days(days: float) -> float:
    """Mission length rounded to whole hours (at least one), in days."""
    return max(1, round(days * 24)) / 24


def _fmt(t: datetime) -> str:
    return _utc(t).strftime("%Y-%m-%d %H:%M UTC")


def time_note(requested_landing: datetime, requested_days: float,
              landing: datetime | None = None, days: float | None = None) -> str | None:
    """Plain-language note when the evaluated landing/length differ from the requested ones, else None."""
    landing = snap_time(requested_landing) if landing is None else landing
    days = snap_duration_days(requested_days) if days is None else days
    parts = []
    if _utc(requested_landing) != _utc(landing):
        parts.append(f"landing evaluated at {_fmt(landing)} (you entered {_fmt(requested_landing)})")
    if abs(requested_days - days) > 1e-9:
        parts.append(f"length evaluated as {round(days * 24):d} h (you entered {requested_days * 24:g} h)")
    if not parts:
        return None
    return "On the hourly data grid: " + "; ".join(parts) + "."
