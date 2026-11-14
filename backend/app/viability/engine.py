"""Main entry point (Phases 3-6 - interface only; Phase 2 is in ``analysis.py``).

``evaluate_scenario`` is the one function Members 3/4/5 call. It is pure and deterministic:
no network, no file I/O, no global state. Planned pipeline:

    env       = analyze_scenario(scenario, series)                   # Phase 2 (done)
                # = windows + condition statistics + metrics + data quality
    checks    = evaluate_constraints(scenario, env.metrics, series)  # Phase 3
    margins   = compute_margins(scenario, env.metrics, series)       # Phase 4
    risks     = assess_risks(scenario, metrics, margins, quality)    # Phase 4
    score     = score_scenario(scenario, metrics, margins, elig)     # Phase 5
    text      = generate_explanations(...)                           # Phase 6

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
        "Phases 3-6: viability evaluation pipeline (Phase 2 analysis is available via analysis.analyze_scenario)"
    )
