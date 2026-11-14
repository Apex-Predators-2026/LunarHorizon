"""Viability entry point used by rescue.

When Brandon's evaluator is ready, import his `evaluate_timeline` here instead of the
placeholder one. It must keep the signature
    evaluate_timeline(scenario: Scenario, timeline: Timeline) -> ViabilityResult
and fill `violations[].constraint` with MissionRequirements field names.

Keep importing CHECKS / CHECK_BY_CONSTRAINT from the placeholder: rescue uses that table
(requirement -> metric, min/max, label) to word and round its loosening suggestions.
"""
from .placeholder import CHECK_BY_CONSTRAINT, CHECKS, evaluate_timeline

__all__ = ["evaluate_timeline", "CHECKS", "CHECK_BY_CONSTRAINT"]
