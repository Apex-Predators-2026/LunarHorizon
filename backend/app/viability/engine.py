"""Main entry point (Phases 2-6 - interface only).

``evaluate_scenario`` is the one function Members 3/4/5 call. It is pure and deterministic:
no network, no file I/O, no global state. Planned pipeline:

    windows   = extract_windows(series, start, end)                  # Phase 2
    metrics   = compute_metrics(windows, start, end)                 # Phase 2
    quality   = summarize_data_quality(series, start, end)           # Phase 2
    checks    = evaluate_constraints(scenario, metrics, series)      # Phase 3
    margins   = compute_margins(scenario, metrics, series)           # Phase 4
    risks     = assess_risks(scenario, metrics, margins, quality)    # Phase 4
    score     = score_scenario(scenario, metrics, margins, elig)     # Phase 5
    text      = generate_explanations(...)                           # Phase 6

Preconditions to enforce in Phase 3: ``series.site.id == scenario.site.id``;
mission periods not covered by samples are UNKNOWN, not errors.
"""

from __future__ import annotations

from .inputs import ScientificTimeSeries
from .mission import MissionScenario
from .outputs import ViabilityAssessment

ENGINE_VERSION = "0.1.0-phase1"


def evaluate_scenario(scenario: MissionScenario, series: ScientificTimeSeries) -> ViabilityAssessment:
    raise NotImplementedError("Phases 2-6: viability evaluation pipeline")
