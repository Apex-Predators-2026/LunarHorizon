"""Operational margins (Phase 4 - interface only).

Signed headroom against spacecraft limits (darkness, blackout, percentages) and angular
clearance of the Sun/Earth above the terrain horizon (or above the configured minimum
clearance) while they are counted as visible.
"""

from __future__ import annotations

from .inputs import ScientificTimeSeries
from .mission import MissionScenario
from .outputs import MetricsSummary, OperationalMargin


def compute_margins(
    scenario: MissionScenario, metrics: MetricsSummary, series: ScientificTimeSeries
) -> list[OperationalMargin]:
    raise NotImplementedError("Phase 4: operational margins")
