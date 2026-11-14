"""Visibility-window analysis (Phase 2 - interface only).

Turns instantaneous samples into maximal intervals (sunlight, darkness, Earth-visible,
blackout, simultaneous, unknown-data), clipped to the evaluated range.

Phase 2 must decide and document the sample-integration rule (e.g. state transitions at
the linearly interpolated zero crossing of horizon clearance vs. at sample midpoints) and
must treat gaps longer than ``series.sampling.max_gap_s`` as UNKNOWN_DATA, never darkness.
"""

from __future__ import annotations

from datetime import datetime

from .inputs import ScientificTimeSeries
from .outputs import VisibilityWindow


def extract_windows(series: ScientificTimeSeries, start_utc: datetime, end_utc: datetime) -> list[VisibilityWindow]:
    raise NotImplementedError("Phase 2: visibility-window analysis")
