"""Hard-constraint evaluation (Phase 3 - interface only).

Each configured requirement yields PASS / FAIL / UNKNOWN; unconfigured ones yield
NOT_APPLICABLE. A BOUNDED metric is decisive when the whole interval lies on one side of
the threshold; otherwise the result is UNKNOWN (REPORT_UNKNOWN policy) or evaluated with
the unfavourable bound (WORST_CASE policy). Unknown data never produces PASS on its own.
"""

from __future__ import annotations

from .inputs import ScientificTimeSeries
from .mission import MissionScenario
from .outputs import ConstraintEvaluation, MetricsSummary, derive_eligibility

__all__ = ["derive_eligibility", "evaluate_constraints"]


def evaluate_constraints(
    scenario: MissionScenario, metrics: MetricsSummary, series: ScientificTimeSeries
) -> list[ConstraintEvaluation]:
    raise NotImplementedError("Phase 3: constraint evaluation")
