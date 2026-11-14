"""Mission metrics and data-quality summary (Phase 2 - interface only).

Durations, percentages and longest outages derived from windows. Where data is partly
unknown, metrics are BOUNDED (lower = unknown counted unfavourably for the quantity,
upper = favourably) rather than guessed.
"""

from __future__ import annotations

from datetime import datetime

from .inputs import ScientificTimeSeries
from .outputs import DataQualitySummary, MetricsSummary, VisibilityWindow


def compute_metrics(windows: list[VisibilityWindow], start_utc: datetime, end_utc: datetime) -> MetricsSummary:
    raise NotImplementedError("Phase 2: mission metrics")


def summarize_data_quality(series: ScientificTimeSeries, start_utc: datetime, end_utc: datetime) -> DataQualitySummary:
    raise NotImplementedError("Phase 2: data coverage summary")
