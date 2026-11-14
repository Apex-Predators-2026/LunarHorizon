"""Hard-constraint evaluation (Phase 3): PASS / FAIL / UNKNOWN / NOT_APPLICABLE per requirement.

Every verdict is derived from the Phase 2 ``EnvironmentAnalysis`` (no time-series logic is
repeated here). Rules (normative; docs/viability-engine.md section 5c):

* A requirement whose configured value is ``None`` is NOT_APPLICABLE.
* The measured metric gives bounds ``[L, U]``: KNOWN ``value`` -> ``L = U = value``; BOUNDED ->
  its ``lower``/``upper``; UNAVAILABLE -> the quantity's *admissible range* over the mission
  (percent ``[0, 100]``, fraction ``[0, 1]``, durations ``[0, mission duration]``), which is
  true by construction and so lets a trivially satisfied requirement still be proven.
* Minimum requirement (``AT_LEAST``, inclusive): PASS iff ``L >= t``; FAIL iff ``U < t``;
  otherwise UNKNOWN.  Maximum limit (``AT_MOST``, inclusive): PASS iff ``U <= t``; FAIL iff
  ``L > t``; otherwise UNKNOWN. Equality within a relative ``COMPARISON_REL_TOL`` (1e-12, i.e.
  floating-point representation only) counts as meeting the threshold.
* Verdicts are evidence-based only: an undecidable requirement is UNKNOWN, never FAIL.
  ``UnknownDataPolicy.WORST_CASE`` is deprecated and accepted for compatibility only; it does
  not change any verdict (a worst-case screen would equal ``eligibility != PASS``).
* Requirements the engine cannot evaluate from its inputs (``min_sun_clearance_deg``,
  ``min_earth_clearance_deg``) are UNKNOWN with ``unknown_reason = unsupported`` when configured:
  never silently passed, and never approximated by the *mean* clearance.

Overall eligibility is ``outputs.derive_eligibility``: any FAIL -> FAIL, else any UNKNOWN ->
UNKNOWN, else PASS (NOT_APPLICABLE ignored). All requirements in ``MissionRequirements`` and the
spacecraft limits are hard constraints; soft preferences never enter this module.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Final

from .analysis import analyze_scenario
from .conventions import ENGINE_VERSION
from .enums import (
    Comparison,
    Condition,
    ConstraintId,
    ConstraintStatus,
    MetricStatus,
    SamplingPolicy,
    Unit,
    UnknownDataPolicy,
    UnknownReason,
)
from .inputs import ScientificTimeSeries
from .mission import MissionScenario
from .outputs import (
    ConstraintAssessment,
    ConstraintEvaluation,
    EnvironmentAnalysis,
    Metric,
    VisibilityWindow,
    derive_eligibility,
)
from .windows import WINDOW_KINDS, PreparedSeries

__all__ = [
    "COMPARISON_REL_TOL",
    "CONSTRAINT_SPECS",
    "ConstraintSpec",
    "admissible_range",
    "assess_constraints",
    "build_constraint_assessment",
    "decide",
    "derive_eligibility",
    "evaluate_constraint",
    "evaluate_constraints",
    "meets",
]

# Equality tolerance for threshold comparisons: absorbs floating-point representation error
# only (e.g. rescue's 0.55 * 100 = 55.00000000000001 percent). It is ~4500x machine epsilon and
# far below any physical resolution (1 us of a 1 h step is 2.8e-10). Not a margin.
COMPARISON_REL_TOL: Final = 1e-12


@dataclass(frozen=True, slots=True)
class ConstraintSpec:
    """Static definition of one hard constraint: where its threshold and evidence come from."""

    constraint_id: ConstraintId
    name: str
    comparison: Comparison
    unit: Unit
    requirement_field: str  # "spacecraft.<attr>" or "requirements.<attr>"
    metric_field: str | None  # MetricsSummary attribute; None = not evaluable by this engine
    condition: Condition | None  # Phase 2 condition behind the metric (for unknown time / windows)
    quantity: str  # noun phrase used in messages
    unsupported_reason: str | None = None

    def threshold(self, scenario: MissionScenario) -> float | None:
        owner, attr = self.requirement_field.split(".", 1)
        source = scenario.spacecraft if owner == "spacecraft" else scenario.requirements
        value: float | None = getattr(source, attr)
        return value


_CLEARANCE_UNSUPPORTED: Final = (
    "not evaluated by this engine version: Phase 2 provides only the time-mean clearance, which "
    "cannot establish a per-instant minimum, and whether the value redefines visibility (a mask "
    "angle) or must hold whenever the body is visible is not yet agreed"
)

CONSTRAINT_SPECS: Final[dict[ConstraintId, ConstraintSpec]] = {
    s.constraint_id: s
    for s in (
        ConstraintSpec(
            ConstraintId.MAX_CONTINUOUS_DARKNESS,
            "Maximum continuous power-darkness",
            Comparison.AT_MOST,
            Unit.SECONDS,
            "spacecraft.max_continuous_darkness_s",
            "longest_continuous_darkness",
            Condition.POWER_ELIGIBLE,
            "longest continuous power-dark period",
        ),
        ConstraintSpec(
            ConstraintId.MAX_COMMUNICATION_BLACKOUT,
            "Maximum direct-to-Earth line-of-sight blackout",
            Comparison.AT_MOST,
            Unit.SECONDS,
            "spacecraft.max_communication_blackout_s",
            "longest_communication_blackout",
            Condition.EARTH_VISIBLE,
            "longest Earth line-of-sight blackout",
        ),
        ConstraintSpec(
            ConstraintId.MIN_SUNLIGHT_PERCENT,
            "Minimum direct-sunlight time",
            Comparison.AT_LEAST,
            Unit.PERCENT,
            "requirements.min_sunlight_percent",
            "sunlight_percent",
            Condition.DIRECT_SUNLIGHT,
            "share of mission time with direct sunlight (any part of the solar disk visible)",
        ),
        ConstraintSpec(
            ConstraintId.MIN_EARTH_VISIBILITY_PERCENT,
            "Minimum Earth line-of-sight time",
            Comparison.AT_LEAST,
            Unit.PERCENT,
            "requirements.min_earth_visibility_percent",
            "earth_visible_percent",
            Condition.EARTH_VISIBLE,
            "share of mission time with Earth line of sight",
        ),
        ConstraintSpec(
            ConstraintId.MIN_SIMULTANEOUS_PERCENT,
            "Minimum simultaneous power-lit and Earth line-of-sight time",
            Comparison.AT_LEAST,
            Unit.PERCENT,
            "requirements.min_simultaneous_percent",
            "simultaneous_percent",
            Condition.SIMULTANEOUS,
            "share of mission time that is power-lit with Earth line of sight",
        ),
        ConstraintSpec(
            ConstraintId.MIN_SUN_CLEARANCE,
            "Minimum Sun clearance above the horizon",
            Comparison.AT_LEAST,
            Unit.DEGREES,
            "requirements.min_sun_clearance_deg",
            None,
            Condition.DIRECT_SUNLIGHT,
            "Sun clearance above the horizon",
            _CLEARANCE_UNSUPPORTED,
        ),
        ConstraintSpec(
            ConstraintId.MIN_EARTH_CLEARANCE,
            "Minimum Earth clearance above the horizon",
            Comparison.AT_LEAST,
            Unit.DEGREES,
            "requirements.min_earth_clearance_deg",
            None,
            Condition.EARTH_VISIBLE,
            "Earth clearance above the horizon",
            _CLEARANCE_UNSUPPORTED,
        ),
        ConstraintSpec(
            ConstraintId.MIN_MEAN_SOLAR_DISK_FRACTION,
            "Minimum mean visible solar-disk fraction",
            Comparison.AT_LEAST,
            Unit.FRACTION,
            "requirements.min_mean_solar_disk_fraction",
            "mean_solar_disk_fraction",
            None,  # unknown where the Sun state or the fraction is missing; the metric states it
            "time-mean visible solar-disk fraction",
        ),
        ConstraintSpec(
            ConstraintId.MIN_INITIAL_SUNLIGHT,
            "Minimum continuous power-lit time after landing",
            Comparison.AT_LEAST,
            Unit.SECONDS,
            "requirements.min_initial_sunlight_s",
            "initial_sunlight_duration",
            Condition.POWER_ELIGIBLE,
            "continuous power-lit time from mission start",
        ),
        ConstraintSpec(
            ConstraintId.MIN_INITIAL_EARTH_VISIBILITY,
            "Minimum continuous Earth line of sight after landing",
            Comparison.AT_LEAST,
            Unit.SECONDS,
            "requirements.min_initial_earth_visibility_s",
            "initial_earth_visibility_duration",
            Condition.EARTH_VISIBLE,
            "continuous Earth line-of-sight time from mission start",
        ),
    )
}

_OUTAGE_CONSTRAINTS: Final = frozenset({ConstraintId.MAX_CONTINUOUS_DARKNESS, ConstraintId.MAX_COMMUNICATION_BLACKOUT})
_INITIAL_CONSTRAINTS: Final = frozenset({ConstraintId.MIN_INITIAL_SUNLIGHT, ConstraintId.MIN_INITIAL_EARTH_VISIBILITY})


# --- pure decision rules ----------------------------------------------------------------------


def meets(value: float, threshold: float, comparison: Comparison) -> bool:
    """Inclusive comparison; equality within ``COMPARISON_REL_TOL`` counts as meeting."""
    if math.isclose(value, threshold, rel_tol=COMPARISON_REL_TOL, abs_tol=0.0):
        return True
    return value >= threshold if comparison is Comparison.AT_LEAST else value <= threshold


def decide(comparison: Comparison, threshold: float, lower: float, upper: float) -> ConstraintStatus:
    """Three-valued verdict from proven bounds ``lower <= true value <= upper``.

    AT_LEAST: PASS iff lower >= t; FAIL iff upper < t. AT_MOST: PASS iff upper <= t; FAIL iff
    lower > t. Otherwise the threshold lies within the bounds and the verdict is UNKNOWN.
    """
    if lower > upper:
        raise ValueError(f"lower bound {lower} exceeds upper bound {upper}")
    favourable, unfavourable = (upper, lower) if comparison is Comparison.AT_LEAST else (lower, upper)
    if meets(unfavourable, threshold, comparison):
        return ConstraintStatus.PASS
    if not meets(favourable, threshold, comparison):
        return ConstraintStatus.FAIL
    return ConstraintStatus.UNKNOWN


def admissible_range(unit: Unit, duration_s: float) -> tuple[float, float] | None:
    """Values a quantity can take over a mission of ``duration_s``; None if not bounded a priori."""
    if unit is Unit.SECONDS:
        return 0.0, duration_s
    if unit is Unit.PERCENT:
        return 0.0, 100.0
    if unit is Unit.FRACTION:
        return 0.0, 1.0
    return None


def _bounds(metric: Metric, duration_s: float) -> tuple[float, float] | None:
    if metric.status is MetricStatus.KNOWN:
        assert metric.value is not None
        return metric.value, metric.value
    if metric.status is MetricStatus.BOUNDED:
        assert metric.lower is not None and metric.upper is not None
        return metric.lower, metric.upper
    if metric.status is MetricStatus.UNAVAILABLE:
        return admissible_range(metric.unit, duration_s)
    return None


# --- messages (factual one-liners; full explanations are Phase 6) -----------------------------


def _fmt(value: float, unit: Unit) -> str:
    if unit is Unit.SECONDS:
        return f"{value / 3600.0:.6g} h"
    if unit is Unit.PERCENT:
        return f"{value:.6g} %"
    if unit is Unit.DEGREES:
        return f"{value:.6g} deg"
    return f"{value:.6g}"


def _requirement(spec: ConstraintSpec, threshold: float) -> str:
    op = ">=" if spec.comparison is Comparison.AT_LEAST else "<="
    return f"{op} {_fmt(threshold, spec.unit)}"


def _observed(spec: ConstraintSpec, metric: Metric, bounds: tuple[float, float]) -> str:
    lo, hi = bounds
    if metric.status is MetricStatus.KNOWN:
        return f"{spec.quantity} is {_fmt(lo, spec.unit)}"
    if metric.status is MetricStatus.BOUNDED:
        why = f" ({metric.reason})" if metric.reason else ""
        return f"{spec.quantity} is between {_fmt(lo, spec.unit)} and {_fmt(hi, spec.unit)}{why}"
    return (
        f"{spec.quantity} is unavailable ({metric.reason}); its admissible range is "
        f"[{_fmt(lo, spec.unit)}, {_fmt(hi, spec.unit)}]"
    )


def _message(
    spec: ConstraintSpec,
    status: ConstraintStatus,
    metric: Metric,
    bounds: tuple[float, float],
    threshold: float,
    duration_s: float,
) -> str:
    head = f"{spec.name}: {_observed(spec, metric, bounds)}; required {_requirement(spec, threshold)}."
    exact = metric.status is MetricStatus.KNOWN
    if status is ConstraintStatus.PASS:
        tail = "Requirement met." if exact else "Even the least favourable possible value meets the requirement."
    elif status is ConstraintStatus.FAIL and spec.constraint_id in _INITIAL_CONSTRAINTS and threshold > duration_s:
        # Pending team decision (docs section 10): kept as FAIL, the same as rescue, but stated plainly.
        tail = (
            f"Requirement violated: it exceeds the mission duration ({_fmt(duration_s, spec.unit)}), and the "
            "metric is limited to the mission window."
        )
    elif status is ConstraintStatus.FAIL:
        tail = "Requirement violated." if exact else "Even the most favourable possible value violates the requirement."
    else:
        tail = "The threshold lies within the possible values, so the available data cannot decide (not a failure)."
    return f"{head} {tail}"


# --- evaluation -------------------------------------------------------------------------------


def _evidence(spec: ConstraintSpec, env: EnvironmentAnalysis) -> list[VisibilityWindow]:
    """Small, decision-relevant window set: the longest confirmed outage, or the state at start."""
    if spec.condition is None:
        return []
    if spec.constraint_id in _OUTAGE_CONSTRAINTS:
        w = env.condition(spec.condition).longest_not_met_window
        return [w] if w is not None else []
    if spec.constraint_id in _INITIAL_CONSTRAINTS:
        kinds = {k for k in WINDOW_KINDS[spec.condition] if k is not None}
        return [w for w in env.windows if w.kind in kinds and w.start_utc == env.evaluated_start_utc]
    return []


def evaluate_constraint(
    spec: ConstraintSpec, scenario: MissionScenario, env: EnvironmentAnalysis
) -> ConstraintEvaluation:
    """Verdict for one constraint (see module docstring). ``env`` must match ``scenario``."""
    threshold = spec.threshold(scenario)
    metric: Metric
    if spec.metric_field is None:
        assert spec.unsupported_reason is not None
        metric = Metric.unavailable(spec.unit, spec.unsupported_reason)
    else:
        metric = getattr(env.metrics, spec.metric_field)
    unknown_s = env.condition(spec.condition).unknown_duration_s if spec.condition is not None else None

    def result(
        status: ConstraintStatus,
        message: str,
        *,
        reason: UnknownReason | None = None,
    ) -> ConstraintEvaluation:
        applicable = status is not ConstraintStatus.NOT_APPLICABLE
        return ConstraintEvaluation(
            constraint_id=spec.constraint_id,
            status=status,
            threshold=threshold if applicable else None,
            unit=spec.unit,
            measured=metric,
            message=message,
            name=spec.name,
            comparison=spec.comparison,
            requirement_field=spec.requirement_field,
            metric_field=spec.metric_field,
            condition=spec.condition,
            condition_unknown_duration_s=unknown_s,
            unknown_reason=reason,
            evidence_windows=_evidence(spec, env) if applicable else [],
        )

    if threshold is None:
        return result(
            ConstraintStatus.NOT_APPLICABLE,
            f"{spec.name}: not configured ({spec.requirement_field} is null); not evaluated.",
        )
    if spec.metric_field is None:
        return result(
            ConstraintStatus.UNKNOWN,
            f"{spec.name}: required {_requirement(spec, threshold)} but {spec.unsupported_reason}. "
            "Reported as UNKNOWN, not as passed or failed.",
            reason=UnknownReason.UNSUPPORTED,
        )
    duration_s = (env.evaluated_end_utc - env.evaluated_start_utc).total_seconds()
    bounds = _bounds(metric, duration_s)
    if bounds is None:  # NOT_APPLICABLE metric for a threshold test: cannot occur for the specs above
        return result(
            ConstraintStatus.UNKNOWN,
            f"{spec.name}: {spec.quantity} is not defined for this range; cannot be evaluated.",
            reason=UnknownReason.NO_DATA,
        )
    status = decide(spec.comparison, threshold, *bounds)
    message = _message(spec, status, metric, bounds, threshold, duration_s)
    if status is not ConstraintStatus.UNKNOWN:
        return result(status, message)
    if scenario.requirements.unknown_data_policy is UnknownDataPolicy.WORST_CASE:
        message += " (unknown_data_policy 'worst_case' is deprecated and does not change verdicts.)"
    reason = UnknownReason.NO_DATA if metric.status is MetricStatus.UNAVAILABLE else UnknownReason.INCOMPLETE_DATA
    return result(status, message, reason=reason)


def _check_matches(scenario: MissionScenario, env: EnvironmentAnalysis) -> None:
    """Refuse an analysis computed for another site, window or power threshold."""
    if env.site.id != scenario.site.id:
        raise ValueError(f"analysis is for site {env.site.id!r} but the scenario is for {scenario.site.id!r}")
    if (env.evaluated_start_utc, env.evaluated_end_utc) != (scenario.mission_start_utc, scenario.mission_end_utc):
        raise ValueError("analysis range does not equal the scenario's mission window")
    if env.solar_power_min_disk_fraction != scenario.spacecraft.solar_power_min_disk_fraction:
        raise ValueError(
            "analysis was computed with solar_power_min_disk_fraction="
            f"{env.solar_power_min_disk_fraction!r}, but the scenario sets "
            f"{scenario.spacecraft.solar_power_min_disk_fraction!r}"
        )


def evaluate_constraints(scenario: MissionScenario, env: EnvironmentAnalysis) -> list[ConstraintEvaluation]:
    """One evaluation per ``ConstraintId``, in enum order, from a matching Phase 2 analysis.

    (The Phase 1 stub took ``(scenario, metrics, series)``; the analysis is needed instead for
    per-condition unknown time, evidence windows and the threshold/range identity check.)
    """
    _check_matches(scenario, env)
    return [evaluate_constraint(CONSTRAINT_SPECS[cid], scenario, env) for cid in ConstraintId]


def build_constraint_assessment(scenario: MissionScenario, env: EnvironmentAnalysis) -> ConstraintAssessment:
    constraints = evaluate_constraints(scenario, env)
    return ConstraintAssessment(
        engine_version=ENGINE_VERSION,
        scenario_id=scenario.scenario_id,
        unknown_data_policy=scenario.requirements.unknown_data_policy,
        eligibility=derive_eligibility(c.status for c in constraints),
        constraints=constraints,
        environment=env,
    )


def assess_constraints(
    scenario: MissionScenario,
    series: ScientificTimeSeries | PreparedSeries,
    *,
    policy: SamplingPolicy | None = None,
) -> ConstraintAssessment:
    """Phase 3 entry point: Phase 2 analysis of the mission window, then every constraint.

    Pass a ``PreparedSeries`` when evaluating many scenarios on one dataset. Raises
    ``ValueError`` if the series is for a different site.
    """
    return build_constraint_assessment(scenario, analyze_scenario(scenario, series, policy=policy))
