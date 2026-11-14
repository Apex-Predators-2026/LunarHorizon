"""PLACEHOLDER viability evaluator (Brandon owns the real one).

Rescue only depends on the function signature:

    evaluate_timeline(scenario: Scenario, timeline: Timeline) -> ViabilityResult

where `timeline` covers exactly the mission (landing_utc .. landing_utc + duration).
When Brandon's evaluator is ready, point `app/rescue/viability/__init__.py` at it and
rescue, sensitivity and compromise all pick it up automatically.
"""
from __future__ import annotations

import numpy as np

from ...models import MissionRequirements, Scenario, ViabilityMetrics, ViabilityResult, Violation
from ..timeline import Timeline

SOURCE = "placeholder-v1"

# Score weights (sum to 1).
W_SUN, W_DARK, W_EARTH, W_COMMS, W_INITIAL = 0.25, 0.25, 0.2, 0.2, 0.1


def longest_run_hours(mask: np.ndarray, step_hours: float) -> float:
    """Length (hours) of the longest run of True values."""
    if mask.size == 0 or not mask.any():
        return 0.0
    m = np.concatenate(([False], mask, [False])).astype(np.int8)
    d = np.diff(m)
    starts, ends = np.flatnonzero(d == 1), np.flatnonzero(d == -1)
    return float((ends - starts).max()) * step_hours


def leading_run_hours(mask: np.ndarray, step_hours: float) -> float:
    """Hours the mask stays True from the first sample."""
    if mask.size == 0 or not mask[0]:
        return 0.0
    off = np.flatnonzero(~mask)
    return float(off[0] if off.size else mask.size) * step_hours


def first_false_hours(mask: np.ndarray, step_hours: float) -> float | None:
    """Hours until the first transition from True to False, or None if it never happens."""
    if mask.size < 2:
        return None
    falls = np.flatnonzero(mask[:-1] & ~mask[1:])
    return None if falls.size == 0 else float(falls[0] + 1) * step_hours


def compute_metrics(tl: Timeline, req: MissionRequirements) -> ViabilityMetrics:
    step = tl.step_hours
    lit = tl.sun_visible_fraction >= req.panel_threshold
    earth = tl.earth_visible.astype(bool)
    sun_up = tl.sun_visible_fraction > 0
    sun_clear = (tl.sun_el - tl.sun_horizon)[sun_up]
    earth_clear = (tl.earth_el - tl.earth_horizon)[earth]
    return ViabilityMetrics(
        sunlight_fraction=float(tl.sun_visible_fraction.mean()),
        equivalent_sun_hours=float(tl.sun_visible_fraction.sum() * step),
        longest_dark_gap_hours=longest_run_hours(~lit, step),
        earth_visibility_fraction=float(earth.mean()),
        longest_comms_gap_hours=longest_run_hours(~earth, step),
        initial_sun_hours=leading_run_hours(lit, step),
        initial_comms_hours=leading_run_hours(earth, step),
        hours_to_first_sunset=first_false_hours(lit, step),
        hours_to_first_earthset=first_false_hours(earth, step),
        mean_sun_clearance_deg=float(sun_clear.mean()) if sun_clear.size else None,
        mean_earth_clearance_deg=float(earth_clear.mean()) if earth_clear.size else None,
        mean_solar_elevation_deg=float(tl.sun_el.mean()),
    )


# (requirement field, metric field, kind, unit, human label)
#   kind "min": metric must be >= requirement; "max": metric must be <= requirement
CHECKS: list[tuple[str, str, str, str, str]] = [
    ("min_sunlight_fraction", "sunlight_fraction", "min", "fraction", "average sunlight"),
    ("battery_hours", "longest_dark_gap_hours", "max", "h", "longest power gap (battery limit)"),
    ("min_earth_visibility_fraction", "earth_visibility_fraction", "min", "fraction", "Earth visibility"),
    ("max_comms_gap_hours", "longest_comms_gap_hours", "max", "h", "longest comms blackout"),
    ("min_initial_sun_hours", "initial_sun_hours", "min", "h", "sunlight right after landing"),
    ("min_initial_comms_hours", "initial_comms_hours", "min", "h", "Earth contact right after landing"),
]
CHECK_BY_CONSTRAINT = {c[0]: c for c in CHECKS}


def _fmt(v: float, unit: str) -> str:
    return f"{v * 100:.0f}%" if unit == "fraction" else f"{v:.0f} h"


def find_violations(m: ViabilityMetrics, req: MissionRequirements) -> list[Violation]:
    out = []
    for field, metric, kind, unit, label in CHECKS:
        required = float(getattr(req, field))
        actual = float(getattr(m, metric))
        short = required - actual if kind == "min" else actual - required
        if short > 1e-9:
            word = "below" if kind == "min" else "above"
            out.append(Violation(
                constraint=field, required=required, actual=actual, unit=unit, shortfall=short,
                relative_shortfall=short / required if required else float("inf"),
                message=f"{label.capitalize()} is {_fmt(actual, unit)}, {word} the {_fmt(required, unit)} requirement.",
            ))
    return out


def score(m: ViabilityMetrics, req: MissionRequirements) -> float:
    """0-100. Each component is 0.5 when a metric exactly meets its requirement, rising
    smoothly toward 1 as it gets better (2x better = 0.75) and falling toward 0 as it gets worse."""
    def more(v, r):
        return 1.0 if r <= 0 else float(1.0 - np.exp(-np.log(2) * v / r))

    def less(v, r):
        return float(np.exp(-np.log(2) * v / r))

    initial = 0.5 * more(m.initial_sun_hours, req.min_initial_sun_hours) + \
        0.5 * more(m.initial_comms_hours, req.min_initial_comms_hours)
    s = (W_SUN * more(m.sunlight_fraction, req.min_sunlight_fraction)
         + W_DARK * less(m.longest_dark_gap_hours, req.battery_hours)
         + W_EARTH * more(m.earth_visibility_fraction, req.min_earth_visibility_fraction)
         + W_COMMS * less(m.longest_comms_gap_hours, req.max_comms_gap_hours)
         + W_INITIAL * initial)
    return round(100.0 * s, 2)


def evaluate_timeline(scenario: Scenario, timeline: Timeline) -> ViabilityResult:
    req = scenario.requirements
    metrics = compute_metrics(timeline, req)
    violations = find_violations(metrics, req)
    return ViabilityResult(
        scenario=scenario, passes=not violations, score=score(metrics, req), metrics=metrics,
        violations=violations, source=SOURCE, data_source=timeline.source,
    )
