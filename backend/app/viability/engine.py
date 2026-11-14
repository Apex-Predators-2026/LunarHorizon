"""Main entry point: ``evaluate_scenario`` is the one function Members 3/4/5 call.

It is pure and deterministic: no network, no file I/O, no global state. Pipeline (Phases 1-6):

    env       = analyze_scenario(scenario, series)                   # Phase 2: windows, metrics, data quality
    checks    = build_constraint_assessment(scenario, env)           # Phase 3: PASS/FAIL/UNKNOWN + eligibility
    margins   = margins_from_assessment(checks)                      # Phase 4A
    risks     = assess_risks(scenario, checks, margins)              # Phase 4B
    level     = overall_risk(risks)                                  # Phase 4B
    score     = score_scenario(scenario, metrics, margins, elig,     # Phase 5A (reads, never changes, elig)
                               data_basis=env.data_quality.data_basis)
    text      = generate_explanations(elig, constraints, margins,   # Phase 6A: presentation only; reads
                                      risks, data_quality,           # every result above, changes none
                                      score=score, overall_risk=level)

Ranking several assessments is a separate, explicit step: ``rank_assessments`` (Phase 5B, ``ranking.py``).

``explanations`` is generated last from the finished verdicts, margins, risks, score and data quality. It
never feeds back into them, and it raises ``ValueError`` rather than explaining inputs that contradict each
other (which would be an engine bug). ``explain.explain_assessment_details`` returns the same items with
stable keys and technical evidence.

Preconditions: ``series.site.id == scenario.site.id`` (enforced by ``analyze_scenario``); mission periods not
covered by samples are UNKNOWN, not errors.
"""

from __future__ import annotations

from .analysis import analyze_scenario
from .constraints import build_constraint_assessment
from .conventions import ENGINE_VERSION
from .explain import STANDARD_LIMITATIONS, generate_explanations
from .inputs import ScientificTimeSeries
from .margins import margins_from_assessment
from .mission import MissionScenario
from .outputs import ViabilityAssessment
from .risk import assess_risks, overall_risk
from .scoring import score_scenario

__all__ = ["ENGINE_VERSION", "evaluate_scenario"]


def evaluate_scenario(scenario: MissionScenario, series: ScientificTimeSeries) -> ViabilityAssessment:
    """Full viability assessment of one scenario on one scientific time series (see the module docstring).

    Raises ``ValueError`` if the series is for a different site. Eligibility comes from the hard constraints
    only; margins, risks and the score are derived from the same Phase 2 environment and never feed back
    into it. Explanations (Phase 6A) are derived from all of the above and change none of it.
    """
    env = analyze_scenario(scenario, series)
    checks = build_constraint_assessment(scenario, env)
    margins = margins_from_assessment(checks)
    risks = assess_risks(scenario, checks, margins)
    score = score_scenario(scenario, env.metrics, margins, checks.eligibility, data_basis=env.data_quality.data_basis)
    level = overall_risk(risks)
    explanations = generate_explanations(
        checks.eligibility, checks.constraints, margins, risks, env.data_quality, score=score, overall_risk=level
    )
    return ViabilityAssessment(
        engine_version=ENGINE_VERSION,
        scenario_id=scenario.scenario_id,
        site=env.site,
        evaluated_start_utc=env.evaluated_start_utc,
        evaluated_end_utc=env.evaluated_end_utc,
        eligibility=checks.eligibility,
        constraints=checks.constraints,
        metrics=env.metrics,
        windows=env.windows,
        margins=margins,
        risks=risks,
        overall_risk=level,
        score=score,
        explanations=explanations,
        data_quality=env.data_quality,
        limitations=list(STANDARD_LIMITATIONS),
    )
