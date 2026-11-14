"""Viability entry point used by rescue (and by the comparison service, which imports the same name).

Rescue runs on the canonical viability engine (Member 2, app/viability) through its compatibility
layer, which keeps rescue's signature
    evaluate_timeline(scenario: Scenario, timeline: Timeline) -> ViabilityResult
Switched after the side-by-side test (tests/test_engine_side_by_side.py) showed identical verdicts,
metrics and violations on real data; only the score formula differs (docs/viability-engine.md §5g).

The placeholder evaluator stays in placeholder.py for reference and its own tests. Keep importing
CHECKS / CHECK_BY_CONSTRAINT from it: rescue uses that table (requirement -> metric, min/max, label)
to word and round its loosening suggestions.
"""
from app.viability.compat.rescue import evaluate_timeline

from .placeholder import CHECK_BY_CONSTRAINT, CHECKS

__all__ = ["evaluate_timeline", "CHECKS", "CHECK_BY_CONSTRAINT"]
