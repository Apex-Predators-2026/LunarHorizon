"""Rule-based operational risk assessment (Phase 4 - interface only).

Every indicator is produced by an explicit, documented rule (e.g. "darkness margin below
10 % of the battery limit -> HIGH"). No probabilities are reported. Risk level is
independent of eligibility and score.
"""

from __future__ import annotations

from .enums import RiskLevel
from .mission import MissionScenario
from .outputs import DataQualitySummary, MetricsSummary, OperationalMargin, RiskIndicator


def assess_risks(
    scenario: MissionScenario,
    metrics: MetricsSummary,
    margins: list[OperationalMargin],
    data_quality: DataQualitySummary,
) -> list[RiskIndicator]:
    raise NotImplementedError("Phase 4: risk assessment")


def overall_risk(risks: list[RiskIndicator]) -> RiskLevel:
    raise NotImplementedError("Phase 4: risk aggregation")
