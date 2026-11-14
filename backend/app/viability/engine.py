"""Main entry point (Phases 4-6 - interface only; Phase 2 is ``analysis.py``, Phase 3 ``constraints.py``).

``evaluate_scenario`` is the one function Members 3/4/5 call. It is pure and deterministic:
no network, no file I/O, no global state. Planned pipeline:

    env       = analyze_scenario(scenario, series)                   # Phase 2 (done)
                # = windows + condition statistics + metrics + data quality
    checks    = build_constraint_assessment(scenario, env)           # Phase 3 (done)
                # = per-constraint PASS/FAIL/UNKNOWN/NOT_APPLICABLE + eligibility
    margins   = compute_margins(scenario, env.metrics, series)       # Phase 4
    risks     = assess_risks(scenario, metrics, margins, quality)    # Phase 4
    score     = score_scenario(scenario, metrics, margins, elig)     # Phase 5
    text      = generate_explanations(...)                           # Phase 6

Until then ``constraints.assess_constraints(scenario, series)`` is the Phase 3 entry point.

Preconditions: ``series.site.id == scenario.site.id`` (already enforced by
``analyze_scenario``); mission periods not covered by samples are UNKNOWN, not errors.
"""

from __future__ import annotations

from .conventions import ENGINE_VERSION
from .inputs import ScientificTimeSeries
from .mission import MissionScenario
from .outputs import ViabilityAssessment

__all__ = ["ENGINE_VERSION", "evaluate_scenario"]


def evaluate_scenario(scenario: MissionScenario, series: ScientificTimeSeries) -> ViabilityAssessment:
    raise NotImplementedError(
        "Phases 3-6: viability evaluation pipeline (Phase 2 analysis is available via analysis.analyze_scenario, "
        "Phase 3 constraint verdicts via constraints.assess_constraints)"
    )
