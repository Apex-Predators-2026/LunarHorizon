"""Bounds of Member 1's committed real site files, shared by the real-data tests (tests only).

Member 1 regenerates ``data/sites/*.json`` from time to time. On 2026-11-14 (commit 4ebc988) the files were
extended from 2027-01-01 .. 2029-01-01 to 2026-01-01 .. 2031-01-01 (generator 1.2, hourly). Every timeline
column over the old two years is byte-identical in the new files (checked for all 24 files; site and horizon
blocks unchanged), so the independent derivations and regression baselines of the Phase 2-6 and Part 2 tests
keep their meaning when they read that same window.

Two separate notions are used:

* the **regression window** ``REGRESSION_START .. REGRESSION_END``: the fixed two-year window the independent
  raw-column checks and pinned regression values refer to. ``raw_site`` slices a file's timeline to it, so
  raw index 0 is ``REGRESSION_START`` exactly as in the original files;
* the **dataset bounds** ``DATA_START .. DATA_END``: the first and last sample instants of the committed files,
  read from the files themselves. Coverage-boundary tests (missions straddling or after the end of the data)
  use these, so they follow any future regeneration instead of pinning a calendar date.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from functools import cache
from pathlib import Path
from typing import Any, Final

SITES_DIR: Final = Path(__file__).resolve().parents[3] / "data" / "sites"
REGRESSION_START: Final = datetime(2027, 1, 1, tzinfo=UTC)
REGRESSION_END: Final = datetime(2029, 1, 1, tzinfo=UTC)
H: Final = 3600.0
_REFERENCE_SITE: Final = "malapert-massif"


def parse_time(stamp: str) -> datetime:
    """Member 1's ``time_utc`` stamp (``2027-01-01T00:00Z``) as an aware UTC datetime."""
    return datetime.fromisoformat(stamp).astimezone(UTC)


@cache
def _load(site: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((SITES_DIR / f"{site}.json").read_text(encoding="utf-8"))
    return data


def timeline_bounds(site: str) -> tuple[datetime, datetime]:
    """First and last sample instants of one committed site file."""
    t = _load(site)["timeline"]["time_utc"]
    return parse_time(t[0]), parse_time(t[-1])


def window_timeline(timeline: dict[str, Any], start: datetime, end: datetime) -> dict[str, Any]:
    """Columns of ``timeline`` restricted to samples ``start <= t <= end`` (both whole-hour sample instants).

    Raises ``ValueError`` if either instant is not a sample of the file, so a misaligned window cannot pass silently.
    """
    first = parse_time(timeline["time_utc"][0])
    i0, i1 = int((start - first).total_seconds() // H), int((end - first).total_seconds() // H)
    stamps = timeline["time_utc"]
    if not (0 <= i0 <= i1 < len(stamps)) or parse_time(stamps[i0]) != start or parse_time(stamps[i1]) != end:
        raise ValueError(f"window {start.isoformat()} .. {end.isoformat()} is not a sample range of this file")
    return {k: v[i0 : i1 + 1] for k, v in timeline.items()}


def raw_site(site: str, *, start: datetime = REGRESSION_START, end: datetime = REGRESSION_END) -> dict[str, Any]:
    """The committed site file with its timeline restricted to ``start .. end`` (default: the regression window).

    ``site``, ``meta``, ``horizon`` and ``summary`` are returned unchanged; ``summary`` describes the WHOLE file.
    """
    data = _load(site)
    return {**data, "timeline": window_timeline(data["timeline"], start, end)}


def raw_timeline(site: str, *, start: datetime = REGRESSION_START, end: datetime = REGRESSION_END) -> dict[str, Any]:
    """Shorthand for ``raw_site(site, start=start, end=end)["timeline"]``."""
    return raw_site(site, start=start, end=end)["timeline"]


DATA_START, DATA_END = timeline_bounds(_REFERENCE_SITE)
DATA_HOURS: Final = int((DATA_END - DATA_START).total_seconds() // H)
AFTER_DATA: Final = DATA_END + timedelta(days=31)  # a landing well after the last sample (no data at all)
# A 14-day mission from STRADDLE_START covers the final 168 hours of data, then 168 h beyond it. END_SITE is lit and
# Earth-visible through the final covered hours of the committed files, so the covered week proves no failure and
# the mission is UNKNOWN (Malapert's final covered week is power-dark: a proven FAIL, correctly not UNKNOWN).
END_SITE: Final = "connecting-ridge"
STRADDLE_START: Final = DATA_END - timedelta(days=7)

__all__ = [
    "AFTER_DATA",
    "DATA_END",
    "DATA_HOURS",
    "DATA_START",
    "END_SITE",
    "REGRESSION_END",
    "REGRESSION_START",
    "SITES_DIR",
    "STRADDLE_START",
    "H",
    "parse_time",
    "raw_site",
    "raw_timeline",
    "timeline_bounds",
    "window_timeline",
]
