"""Multi-Scenario Comparison (Member 4).

Evaluates 1-6 landing scenarios side by side for the comparison dashboard. It does not
compute any Sun/Earth geometry or terrain itself, and it does not score viability:

* Timelines come from the data engine's records (app/store.py, the same data that
  /api/sites/{id}/timeline serves). Synthetic placeholder timelines are only used when
  the caller explicitly opts in with `allow_demo_data`, and are then labelled.
* Viability comes from the team's single viability entry point (app/rescue/viability),
  which is Brandon's evaluator once it replaces the placeholder.
* What this module adds is comparison statistics: sunlight / Earth-visibility windows,
  elevation statistics, an idealised panel incidence factor and events, all computed from
  those timelines.
"""
from .router import router

__all__ = ["router"]
