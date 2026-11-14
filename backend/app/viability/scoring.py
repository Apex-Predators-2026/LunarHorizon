"""Desirability scoring and ranking (Phase 5 - interface only).

Score: weighted, normalised components (see RankingPreferences), 0..100, explainable via
ScoreBreakdown.components. Ranking: PASS scenarios ranked by score; UNKNOWN and FAIL
scenarios are listed after them, unranked (enforced by RankingResult).
"""

from __future__ import annotations

from .enums import Eligibility
from .mission import MissionScenario
from .outputs import MetricsSummary, OperationalMargin, RankingResult, ScoreBreakdown, ViabilityAssessment


def score_scenario(
    scenario: MissionScenario,
    metrics: MetricsSummary,
    margins: list[OperationalMargin],
    eligibility: Eligibility,
) -> ScoreBreakdown:
    raise NotImplementedError("Phase 5: scoring")


def rank_assessments(assessments: list[ViabilityAssessment]) -> RankingResult:
    raise NotImplementedError("Phase 5: ranking")
