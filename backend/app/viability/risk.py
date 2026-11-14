"""Rule-based operational risk assessment (Phase 4B).

Risk indicators flag environmental and operational *vulnerabilities* of one scenario using
quantities the engine has already established: Phase 2 metrics, windows and data quality,
Phase 3 constraint verdicts, and Phase 4 operational margins. Every indicator names the
explicit rule that produced it (``RiskIndicator.rule``). Normative properties:

* **Not probabilities.** Levels are deterministic screening categories. They are not calibrated
  probabilities of mission failure, and LOW never means "safe to land" (``STANDARD_LIMITATIONS``).
* **Separate from eligibility.** Nothing here reads or writes eligibility: a PASS scenario can
  carry HIGH risk (little headroom), a FAIL scenario still gets its full indicator set, and an
  UNKNOWN verdict is never turned into FAIL or PASS. ``unknown_data_policy`` is not consulted.
* **Unknown is never LOW.** A level is assigned from the proven bounds of the evidence: KNOWN
  value -> its band; BOUNDED ``[lower, upper]`` -> the band only when both bounds fall in the
  same band, otherwise UNKNOWN; no evidence -> UNKNOWN. A level can be decided despite missing
  data when the bounds are decisive (the same principle as the Phase 3 verdict rule).
* **No invented physics.** No battery state, energy balance, thermal limit, radio link budget or
  landing-failure model is used. Earth visibility is geometric line of sight only.

Indicator families (``code`` grammar: ``family`` or ``family.<constraint_id>``), emitted in this
order:

======================================  ==========================================================
``synthetic_data``                      dataset is synthetic (provenance flag) -> UNKNOWN
``geometric_only_data``                 terrain not modelled -> UNKNOWN
``sun_data_coverage``                   unknown Sun / power state time in the mission
``earth_data_coverage``                 unknown Earth state time in the mission
``landing_in_darkness``                 power-dark at mission start (landing)
``landing_without_earth_visibility``    Earth obstructed at mission start (landing)
``darkness_exposure``                   longest power-dark period vs the spacecraft limit
``communication_exposure``              longest Earth line-of-sight blackout vs the limit
``margin_headroom.<constraint_id>``     headroom of a configured minimum requirement (margins)
``unsupported_requirement.<id>``        configured requirement the engine cannot evaluate
======================================  ==========================================================

Classification rules (``RiskPolicy`` holds the two adjustable numbers, defaults in brackets):

* Headroom fraction ``h = margin / reference`` (Phase 4 sign convention: positive = headroom,
  0 = exactly at the requirement, negative = violated). For an outage limit this equals
  ``1 - longest_outage / limit``, i.e. one minus the share of the allowable outage consumed.
  Band: ``h <= high_headroom_fraction`` [0.10] -> HIGH (includes 0 and every violation);
  ``h <= moderate_headroom_fraction`` [0.25] -> MODERATE; otherwise LOW. Both thresholds are
  inclusive and are **product-defined screening heuristics** (the 10 % figure is the example in
  the Phase 1 interface of this module), not NASA-validated values; changing them changes risk
  levels only, never eligibility.
* Exposure rules take the longest outage from the Phase 3 evaluation (``measured``; UNAVAILABLE
  -> the admissible range ``[0, mission duration]``, as in Phase 3) and its ``threshold``.
* Margin rules consume ``OperationalMargin`` objects (they never recompute margins). A configured
  minimum requirement without a supplied margin is UNKNOWN, or HIGH when Phase 3 already proved a
  violation (FAIL). A reference of 0 makes ``h`` undefined; the Phase 3 verdict then decides
  (PASS -> LOW, FAIL -> HIGH, UNKNOWN -> UNKNOWN).
* Landing rules use the Phase 2 state at the evaluated start. Met -> LOW; unknown -> UNKNOWN;
  not met -> MODERATE, raised to HIGH when the outage that is in progress at landing consumes
  the HIGH band of the corresponding limit or lasts the entire mission. The outage's proven
  bounds are ``[confirmed run from landing, + any directly following unknown time]``.
* Coverage rules: no unknown time -> LOW; unknown for the entire mission -> UNKNOWN (nothing is
  assessed); otherwise MODERATE (a confirmed data-quality concern: short events and outages can
  hide in unknown time). Product-defined screening heuristic.
* Data-basis and unsupported-requirement rules are always UNKNOWN: the real-site condition they
  concern is not assessed.

``overall_risk``: any HIGH -> HIGH; otherwise any UNKNOWN -> UNKNOWN; otherwise any MODERATE ->
MODERATE; otherwise LOW. An empty list is UNKNOWN (nothing assessed is not low risk).

When the dataset is synthetic every message is prefixed ``[SYNTHETIC DATA]`` so no indicator can
be read as evidence about a real site.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Final

from .constraints import admissible_range, meets
from .enums import (
    CalculationBasis,
    Comparison,
    Condition,
    ConditionState,
    ConstraintId,
    ConstraintStatus,
    MetricStatus,
    RiskLevel,
    Unit,
    UnknownReason,
    WindowKind,
)
from .mission import MissionScenario
from .outputs import (
    ConstraintAssessment,
    ConstraintEvaluation,
    EnvironmentAnalysis,
    Metric,
    OperationalMargin,
    RiskIndicator,
    VisibilityWindow,
)
from .windows import WINDOW_KINDS

__all__ = [
    "DEFAULT_RISK_POLICY",
    "OUTAGE_RISK_CODES",
    "SYNTHETIC_PREFIX",
    "RiskPolicy",
    "assess_risks",
    "classify_bounds",
    "headroom_band",
    "overall_risk",
]

# Tolerance (seconds) for "the outage lasts the whole mission" and "unknown for the whole range";
# the same as the duration tolerance of the output contract.
_DURATION_TOL_S: Final = 1e-3
# Relative tolerance for margin/verdict and reference/threshold consistency checks. Generous
# compared with Phase 3's 1e-12 so independent float paths cannot trip it; only a real
# contradiction (wrong scenario, wrong sign convention) does.
_CONSISTENCY_REL_TOL: Final = 1e-9

SYNTHETIC_PREFIX: Final = "[SYNTHETIC DATA] "

# Outage constraints and the code of the indicator that classifies their headroom.
OUTAGE_RISK_CODES: Final[dict[ConstraintId, str]] = {
    ConstraintId.MAX_CONTINUOUS_DARKNESS: "darkness_exposure",
    ConstraintId.MAX_COMMUNICATION_BLACKOUT: "communication_exposure",
}

_SCREENING_NOTE: Final = "Product-defined screening heuristic, not a probability; LOW does not mean safe."


@dataclass(frozen=True, slots=True)
class RiskPolicy:
    """Adjustable screening thresholds on the headroom fraction (see module docstring).

    Product-defined heuristics, not NASA-validated limits. They affect risk levels only.
    """

    high_headroom_fraction: float = 0.10
    moderate_headroom_fraction: float = 0.25

    def __post_init__(self) -> None:
        hi, mod = self.high_headroom_fraction, self.moderate_headroom_fraction
        if not (math.isfinite(hi) and math.isfinite(mod)):
            raise ValueError("risk policy thresholds must be finite")
        if not 0.0 <= hi <= mod <= 1.0:
            raise ValueError("risk policy requires 0 <= high_headroom_fraction <= moderate_headroom_fraction <= 1")


DEFAULT_RISK_POLICY: Final = RiskPolicy()


# --- pure classification rules ----------------------------------------------------------------


def headroom_band(fraction: float, policy: RiskPolicy = DEFAULT_RISK_POLICY) -> RiskLevel:
    """Band of one headroom fraction (inclusive thresholds; negative = violated -> HIGH)."""
    if meets(fraction, policy.high_headroom_fraction, Comparison.AT_MOST):
        return RiskLevel.HIGH
    if meets(fraction, policy.moderate_headroom_fraction, Comparison.AT_MOST):
        return RiskLevel.MODERATE
    return RiskLevel.LOW


def classify_bounds(lower_level: RiskLevel, upper_level: RiskLevel) -> RiskLevel:
    """Level from the levels of the two proven bounds: decided only when they agree."""
    return lower_level if lower_level is upper_level else RiskLevel.UNKNOWN


def _headroom_level(lo: float, hi: float, policy: RiskPolicy) -> RiskLevel:
    return classify_bounds(headroom_band(lo, policy), headroom_band(hi, policy))


def overall_risk(risks: Sequence[RiskIndicator]) -> RiskLevel:
    """HIGH > UNKNOWN > MODERATE > LOW; empty -> UNKNOWN (see module docstring)."""
    levels = {r.level for r in risks}
    for level in (RiskLevel.HIGH, RiskLevel.UNKNOWN, RiskLevel.MODERATE):
        if level in levels:
            return level
    return RiskLevel.LOW if levels else RiskLevel.UNKNOWN


# --- formatting -------------------------------------------------------------------------------


def _h(seconds: float) -> str:
    return f"{seconds / 3600.0:.6g} h"


def _pct(fraction: float) -> str:
    return f"{fraction * 100.0:.4g} %"


def _value(value: float, unit: Unit) -> str:
    if unit is Unit.SECONDS:
        return _h(value)
    if unit is Unit.PERCENT:
        return f"{value:.6g} %"
    if unit is Unit.DEGREES:
        return f"{value:.6g} deg"
    return f"{value:.6g}"


def _range(lo: str, hi: str) -> str:
    return lo if lo == hi else f"between {lo} and {hi}"


def _headroom_rule(subject: str, policy: RiskPolicy) -> str:
    return (
        f"{subject}: HIGH if headroom <= {_pct(policy.high_headroom_fraction)} of the reference (incl. 0 and "
        f"violations), MODERATE if <= {_pct(policy.moderate_headroom_fraction)}, else LOW; bounded evidence gets "
        f"a level only when both bounds agree, otherwise UNKNOWN. {_SCREENING_NOTE}"
    )


# --- input checks -----------------------------------------------------------------------------


def _check_matches(scenario: MissionScenario, assessment: ConstraintAssessment) -> None:
    env = assessment.environment
    if assessment.scenario_id != scenario.scenario_id:
        raise ValueError(
            f"assessment is for scenario {assessment.scenario_id!r} but the scenario is {scenario.scenario_id!r}"
        )
    if env.site.id != scenario.site.id:
        raise ValueError(f"assessment is for site {env.site.id!r} but the scenario is for {scenario.site.id!r}")
    if (env.evaluated_start_utc, env.evaluated_end_utc) != (scenario.mission_start_utc, scenario.mission_end_utc):
        raise ValueError("assessment range does not equal the scenario's mission window")
    if env.solar_power_min_disk_fraction != scenario.spacecraft.solar_power_min_disk_fraction:
        raise ValueError("assessment was computed with a different solar_power_min_disk_fraction")


def _close(a: float, b: float) -> bool:
    return math.isclose(a, b, rel_tol=_CONSISTENCY_REL_TOL, abs_tol=_CONSISTENCY_REL_TOL)


def _metric_bounds(metric: Metric) -> tuple[float, float] | None:
    """Proven bounds of a KNOWN / BOUNDED metric; None otherwise (never fabricated)."""
    if metric.status is MetricStatus.KNOWN:
        assert metric.value is not None
        return metric.value, metric.value
    if metric.status is MetricStatus.BOUNDED:
        assert metric.lower is not None and metric.upper is not None
        return metric.lower, metric.upper
    return None


def _index_margins(
    margins: Iterable[OperationalMargin], assessment: ConstraintAssessment
) -> dict[ConstraintId, OperationalMargin]:
    """Margins by related constraint, validated against the Phase 3 verdicts.

    Margins without a related constraint, or for a constraint that is not configured, are not
    classified (no documented reference). Raises ``ValueError`` on duplicates or contradictions,
    which indicate margins computed for another scenario or with another sign convention.
    """
    out: dict[ConstraintId, OperationalMargin] = {}
    for m in margins:
        cid = m.related_constraint
        if cid is None:
            continue
        if cid in out:
            raise ValueError(f"more than one operational margin relates to constraint {cid.value!r}")
        out[cid] = m
        ev = assessment.constraint(cid)
        if ev.status is ConstraintStatus.NOT_APPLICABLE:
            continue
        if m.value.unit is not ev.unit:
            raise ValueError(f"margin {m.margin_id!r} unit {m.value.unit.value!r} != constraint unit {ev.unit.value!r}")
        if ev.unknown_reason is UnknownReason.UNSUPPORTED:
            continue
        assert ev.threshold is not None
        if m.reference is None or not _close(m.reference, ev.threshold):
            raise ValueError(
                f"margin {m.margin_id!r} reference {m.reference!r} != constraint threshold {ev.threshold!r}"
            )
        bounds = _metric_bounds(m.value)
        if bounds is None:
            continue
        tol = _CONSISTENCY_REL_TOL * max(1.0, abs(ev.threshold))
        if ev.status is ConstraintStatus.PASS and bounds[1] < -tol:
            raise ValueError(f"margin {m.margin_id!r} is confirmed negative but constraint {cid.value!r} passes")
        if ev.status is ConstraintStatus.FAIL and bounds[0] > tol:
            raise ValueError(f"margin {m.margin_id!r} is confirmed positive but constraint {cid.value!r} fails")
    return out


# --- window helpers ---------------------------------------------------------------------------


def _partition(env: EnvironmentAnalysis, condition: Condition) -> list[VisibilityWindow]:
    """Met / not-met / unknown windows of ``condition``; they partition the evaluated range."""
    kinds = {k for k in WINDOW_KINDS[condition] if k is not None}
    return sorted((w for w in env.windows if w.kind in kinds), key=lambda w: w.start_utc)


def _outage_from_start(env: EnvironmentAnalysis, condition: Condition) -> tuple[float, float, VisibilityWindow]:
    """Bounds on the outage in progress at the evaluated start (state there must be NOT_MET).

    Lower bound: the confirmed not-met window starting at the evaluated start. Upper bound: that
    window plus every directly following unknown or not-met window (unknown may continue it).
    """
    _, not_met, unknown = WINDOW_KINDS[condition]
    windows = _partition(env, condition)
    first = windows[0]
    if first.kind is not not_met or first.start_utc != env.evaluated_start_utc:
        raise ValueError(f"no confirmed {condition.value} outage at the evaluated start")
    upper = first.duration_s
    end: datetime = first.end_utc
    for w in windows[1:]:
        if w.start_utc != end or w.kind not in (not_met, unknown):
            break
        upper += w.duration_s
        end = w.end_utc
    return first.duration_s, upper, first


def _outage_at_end(env: EnvironmentAnalysis, condition: Condition) -> VisibilityWindow | None:
    _, not_met, _ = WINDOW_KINDS[condition]
    for w in env.windows:
        if w.kind is not_met and w.end_utc == env.evaluated_end_utc:
            return w
    return None


def _edges_uncovered(env: EnvironmentAnalysis) -> list[str]:
    edges = []
    for w in env.windows_of(WindowKind.UNKNOWN_DATA):
        if w.start_utc == env.evaluated_start_utc:
            edges.append("mission start")
        if w.end_utc == env.evaluated_end_utc:
            edges.append("mission end")
    return edges


# --- indicator rules --------------------------------------------------------------------------


def _data_basis_indicators(env: EnvironmentAnalysis) -> list[RiskIndicator]:
    dq = env.data_quality
    out: list[RiskIndicator] = []
    if dq.provenance.is_synthetic:
        out.append(
            RiskIndicator(
                code="synthetic_data",
                level=RiskLevel.UNKNOWN,
                rule="UNKNOWN whenever provenance.is_synthetic is true: synthetic geometry is not evidence about a "
                "real site, so the real-site risk is not assessed.",
                message=f"Dataset {dq.dataset_id!r} is synthetic (not NASA-derived). All indicators describe the "
                "synthetic geometry only and are not validated mission evidence.",
            )
        )
    if dq.calculation_basis is CalculationBasis.GEOMETRIC_ONLY:
        out.append(
            RiskIndicator(
                code="geometric_only_data",
                level=RiskLevel.UNKNOWN,
                rule="UNKNOWN whenever calculation_basis is geometric_only: terrain shadowing and Earth "
                "obstruction are not modelled, so their effect is not assessed.",
                message="Horizon taken as the local horizontal plane (0 deg); terrain obstruction of the Sun and "
                "Earth at the site is not assessed.",
            )
        )
    return out


def _coverage_indicator(env: EnvironmentAnalysis, body: str, unknown_s: float) -> RiskIndicator:
    dq = env.data_quality
    duration = dq.evaluated_duration_s
    code = f"{body}_data_coverage"
    rule = (
        f"{body.capitalize()} state unknown time in the mission: 0 -> LOW; the entire mission -> UNKNOWN (not "
        f"assessed); otherwise MODERATE (outages and short events can hide in unknown time). {_SCREENING_NOTE}"
    )
    evidence = Metric.known(unknown_s, Unit.SECONDS)
    if unknown_s <= 0.0:
        return RiskIndicator(
            code=code,
            level=RiskLevel.LOW,
            rule=rule,
            evidence=evidence,
            message=f"{body.capitalize()} state is known for the whole mission ({_h(duration)}).",
        )
    whole = unknown_s >= duration - _DURATION_TOL_S
    parts = [f"{body.capitalize()} state unknown for {_h(unknown_s)} of {_h(duration)} ({_pct(unknown_s / duration)})"]
    if dq.sample_count == 0:
        parts.append("no sample represents any part of the mission (outside the dataset)")
    else:
        if dq.uncovered_duration_s > 0.0:
            uncovered = f"{_h(dq.uncovered_duration_s)} in {dq.coverage_gap_count} interval(s) has no sample"
            edges = _edges_uncovered(env)
            if edges:
                uncovered += f", including at {' and '.join(edges)} (outside dataset coverage or a gap)"
            parts.append(uncovered)
        state_unknown = unknown_s - dq.uncovered_duration_s
        if state_unknown > _DURATION_TOL_S:
            parts.append(
                f"{_h(state_unknown)} is sampled with an unknown state (missing ephemeris, terrain or fraction)"
            )
    parts.append(
        "not assessed, not counted as darkness or blackout" if whole else "treated as unknown, not as an outage"
    )
    return RiskIndicator(
        code=code,
        level=RiskLevel.UNKNOWN if whole else RiskLevel.MODERATE,
        rule=rule,
        evidence=evidence,
        message="; ".join(parts) + ".",
    )


@dataclass(frozen=True, slots=True)
class _OutageSpec:
    constraint_id: ConstraintId
    condition: Condition
    outage: str  # noun for a not-met period
    article: str  # "a" / "an" before ``outage``
    met_state: str  # adjective for the met state
    landing_code: str
    not_modelled: str  # what the landing rule deliberately does not infer


_POWER: Final = _OutageSpec(
    ConstraintId.MAX_CONTINUOUS_DARKNESS,
    Condition.POWER_ELIGIBLE,
    "power-dark period",
    "a",
    "power-lit",
    "landing_in_darkness",
    "stored energy and power-system state at landing are not modelled",
)
_EARTH: Final = _OutageSpec(
    ConstraintId.MAX_COMMUNICATION_BLACKOUT,
    Condition.EARTH_VISIBLE,
    "Earth line-of-sight blackout (geometry, not a radio link)",
    "an",
    "in Earth line of sight",
    "landing_without_earth_visibility",
    "radio-link availability (relay, antenna, ground station) is not modelled",
)


def _landing_indicator(spec: _OutageSpec, assessment: ConstraintAssessment, policy: RiskPolicy) -> RiskIndicator:
    env = assessment.environment
    summary = env.condition(spec.condition)
    limit = assessment.constraint(spec.constraint_id).threshold
    duration = (env.evaluated_end_utc - env.evaluated_start_utc).total_seconds()
    limit_text = f"the {_h(limit)} limit" if limit is not None else "no configured limit"
    rule = (
        f"State at mission start (landing): {spec.met_state} -> LOW; unknown -> UNKNOWN; otherwise MODERATE, "
        f"HIGH if the {spec.outage} in progress at landing lasts the whole mission or leaves <= "
        f"{_pct(policy.high_headroom_fraction)} headroom to {limit_text}; levels from proven bounds. "
        f"{_SCREENING_NOTE}"
    )
    state = summary.initial_state
    if state is ConditionState.MET:
        return RiskIndicator(
            code=spec.landing_code,
            level=RiskLevel.LOW,
            rule=rule,
            evidence=summary.initial_met_duration,
            message=f"Mission starts {spec.met_state}.",
        )
    if state is ConditionState.UNKNOWN:
        return RiskIndicator(
            code=spec.landing_code,
            level=RiskLevel.UNKNOWN,
            rule=rule,
            evidence=summary.initial_met_duration,
            message="State at mission start (landing) is unknown; not assessed and not assumed to be an outage.",
        )

    lo, hi, first = _outage_from_start(env, spec.condition)

    def level_of(x: float) -> RiskLevel:
        if x >= duration - _DURATION_TOL_S:
            return RiskLevel.HIGH
        if limit is not None and headroom_band(1.0 - x / limit, policy) is RiskLevel.HIGH:
            return RiskLevel.HIGH
        return RiskLevel.MODERATE

    level = classify_bounds(level_of(lo), level_of(hi))
    began = "already in progress at landing" if first.clipped_at_start else "beginning exactly at landing"
    lasts = f"it lasts {_range(_h(lo), _h(hi))} from landing"
    if lo >= duration - _DURATION_TOL_S:
        lasts += " (the whole mission)"
    parts = [f"Mission starts in {spec.article} {spec.outage} {began}", lasts]
    if lo < duration - _DURATION_TOL_S and hi > lo:
        parts.append("unknown data directly follows, so it may last longer")
    if limit is not None:
        parts.append(f"limit {_h(limit)}")
    parts.append(spec.not_modelled)
    evidence = Metric.known(lo, Unit.SECONDS) if lo == hi else Metric.bounded(lo, hi, Unit.SECONDS)
    return RiskIndicator(
        code=spec.landing_code, level=level, rule=rule, evidence=evidence, message="; ".join(parts) + "."
    )


def _exposure_indicator(
    spec: _OutageSpec, assessment: ConstraintAssessment, policy: RiskPolicy
) -> RiskIndicator | None:
    ev = assessment.constraint(spec.constraint_id)
    if ev.status is ConstraintStatus.NOT_APPLICABLE:
        return None
    assert ev.threshold is not None
    env = assessment.environment
    limit = ev.threshold
    duration = (env.evaluated_end_utc - env.evaluated_start_utc).total_seconds()
    code = OUTAGE_RISK_CODES[spec.constraint_id]
    rule = _headroom_rule(
        f"Longest {spec.outage} vs {ev.requirement_field or 'the limit'} (headroom = 1 - longest/limit)", policy
    )
    bounds = _metric_bounds(ev.measured)
    if bounds is None and ev.measured.status is MetricStatus.UNAVAILABLE:
        bounds = admissible_range(Unit.SECONDS, duration)
    verdict = f"constraint verdict {ev.status.value} (unchanged)"
    if bounds is None:
        return RiskIndicator(
            code=code,
            level=RiskLevel.UNKNOWN,
            rule=rule,
            evidence=ev.measured,
            message=f"Longest {spec.outage} is not defined for this mission; {verdict}.",
        )
    lo, hi = bounds
    level = _headroom_level(1.0 - hi / limit, 1.0 - lo / limit, policy)
    if ev.measured.status is MetricStatus.KNOWN:
        observed = f"is {_h(lo)} ({_pct(lo / limit)} of the {_h(limit)} limit)"
    else:
        what = "is unavailable; admissible range" if ev.measured.status is MetricStatus.UNAVAILABLE else "is"
        observed = (
            f"{what} between {_h(lo)} and {_h(hi)} ({_pct(lo / limit)}-{_pct(hi / limit)} of the {_h(limit)} limit)"
        )
    parts = [f"Longest {spec.outage} {observed}"]
    window = ev.evidence_windows[0] if ev.evidence_windows else None
    if window is not None and window.clipped_at_start:
        parts.append("it is already in progress at landing")
    if window is not None and window.clipped_at_end:
        parts.append("it continues to mission end")
    at_end = _outage_at_end(env, spec.condition)
    if at_end is not None and (window is None or at_end != window):
        parts.append(f"a {_h(at_end.duration_s)} outage is in progress at mission end")
    unknown_s = ev.condition_unknown_duration_s or 0.0
    if unknown_s > 0.0:
        parts.append(f"{_h(unknown_s)} of unknown state in the mission")
    parts.append(verdict)
    return RiskIndicator(code=code, level=level, rule=rule, evidence=ev.measured, message="; ".join(parts) + ".")


def _margin_indicator(ev: ConstraintEvaluation, margin: OperationalMargin | None, policy: RiskPolicy) -> RiskIndicator:
    assert ev.threshold is not None
    code = f"margin_headroom.{ev.constraint_id.value}"
    name = ev.name or ev.constraint_id.value
    rule = _headroom_rule(
        f"Operational margin of {ev.requirement_field or ev.constraint_id.value} (headroom = margin / required "
        "value; no margin supplied -> UNKNOWN, or HIGH if the constraint fails)",
        policy,
    )
    verdict = f"constraint verdict {ev.status.value} (unchanged)"
    if margin is None:
        if ev.status is ConstraintStatus.FAIL:
            return RiskIndicator(
                code=code,
                level=RiskLevel.HIGH,
                rule=rule,
                evidence=ev.measured,
                message=f"{name}: requirement violated; no operational margin supplied; {verdict}.",
            )
        return RiskIndicator(
            code=code,
            level=RiskLevel.UNKNOWN,
            rule=rule,
            evidence=ev.measured,
            message=f"{name}: no operational margin supplied, so headroom is not assessed; {verdict}.",
        )
    required = _value(ev.threshold, ev.unit)
    bounds = _metric_bounds(margin.value)
    if ev.threshold == 0.0:
        level = {
            ConstraintStatus.PASS: RiskLevel.LOW,
            ConstraintStatus.FAIL: RiskLevel.HIGH,
        }.get(ev.status, RiskLevel.UNKNOWN)
        message = f"{name}: required value is 0, so relative headroom is undefined; level follows the {verdict}."
        return RiskIndicator(code=code, level=level, rule=rule, evidence=margin.value, message=message)
    if bounds is None:
        return RiskIndicator(
            code=code,
            level=RiskLevel.UNKNOWN,
            rule=rule,
            evidence=margin.value,
            message=f"{name}: margin is {margin.value.status.value}; headroom not assessed; {verdict}.",
        )
    lo, hi = bounds
    ref = ev.threshold
    level = _headroom_level(lo / ref, hi / ref, policy)
    margin_text = _range(_value(lo, ev.unit), _value(hi, ev.unit))
    frac_text = _range(_pct(lo / ref), _pct(hi / ref))
    message = f"{name}: margin {margin_text} against required {required} (headroom {frac_text}); {verdict}."
    return RiskIndicator(code=code, level=level, rule=rule, evidence=margin.value, message=message)


def _unsupported_indicator(ev: ConstraintEvaluation) -> RiskIndicator:
    assert ev.threshold is not None
    field = ev.requirement_field or ev.constraint_id.value
    return RiskIndicator(
        code=f"unsupported_requirement.{ev.constraint_id.value}",
        level=RiskLevel.UNKNOWN,
        rule="UNKNOWN whenever a configured requirement cannot be evaluated by this engine version "
        "(Phase 3 unknown_reason = unsupported): no interpretation or safety judgement is made.",
        evidence=ev.measured,
        message=f"{field} = {_value(ev.threshold, ev.unit)} is configured but not evaluated by this engine version; "
        "its risk is not assessed and the constraint stays UNKNOWN.",
    )


# --- entry point ------------------------------------------------------------------------------


def assess_risks(
    scenario: MissionScenario,
    assessment: ConstraintAssessment,
    margins: Sequence[OperationalMargin] = (),
    *,
    policy: RiskPolicy = DEFAULT_RISK_POLICY,
) -> list[RiskIndicator]:
    """Deterministic risk indicators for one scenario (rules: module docstring).

    ``assessment`` is the Phase 3 result for ``scenario`` (``constraints.assess_constraints`` /
    ``build_constraint_assessment``); its Phase 2 environment supplies metrics, windows and data
    quality, so no geometry is recomputed. ``margins`` are Phase 4 ``OperationalMargin`` objects
    for the same scenario (at most one per related constraint). The assessment is not modified
    and eligibility is not consulted. (The Phase 1 stub took ``(scenario, metrics, margins,
    data_quality)``; landing-state, window-clipping and verdict evidence need the assessment.)

    Raises ``ValueError`` if the assessment or margins belong to another scenario.
    """
    _check_matches(scenario, assessment)
    by_constraint = _index_margins(margins, assessment)
    env = assessment.environment
    dq = env.data_quality

    risks = _data_basis_indicators(env)
    sun_unknown = max(dq.sun_unknown_duration_s, env.condition(Condition.POWER_ELIGIBLE).unknown_duration_s)
    risks.append(_coverage_indicator(env, "sun", sun_unknown))
    risks.append(_coverage_indicator(env, "earth", dq.earth_unknown_duration_s))
    risks.extend(_landing_indicator(spec, assessment, policy) for spec in (_POWER, _EARTH))
    for spec in (_POWER, _EARTH):
        exposure = _exposure_indicator(spec, assessment, policy)
        if exposure is not None:
            risks.append(exposure)
    for ev in assessment.constraints:
        if ev.status is ConstraintStatus.NOT_APPLICABLE or ev.constraint_id in OUTAGE_RISK_CODES:
            continue
        if ev.unknown_reason is UnknownReason.UNSUPPORTED:
            continue
        risks.append(_margin_indicator(ev, by_constraint.get(ev.constraint_id), policy))
    risks.extend(
        _unsupported_indicator(ev) for ev in assessment.constraints if ev.unknown_reason is UnknownReason.UNSUPPORTED
    )

    if dq.provenance.is_synthetic:
        # Rebuilt through validation so the 500-character message limit still holds.
        risks = [
            RiskIndicator.model_validate({**r.model_dump(), "message": SYNTHETIC_PREFIX + r.message}) for r in risks
        ]
    return risks
