"""Operational margins (Phase 4A): signed headroom of each hard constraint against its threshold.

Margins are derived from the same evidence as the Phase 3 verdicts (``constraints.py``) and never
change them. Rules (normative):

* **Signed margin.** Minimum requirement (``AT_LEAST``): ``margin = observed - required``.
  Maximum limit (``AT_MOST``): ``margin = allowed - observed``. Positive = headroom, zero = exactly
  at the limit (still PASS: comparisons are inclusive), negative = confirmed violation.
  The margin keeps the constraint's unit: seconds, percentage points (``Unit.PERCENT``) or a
  fraction. Quantities of different kinds are never combined.
* **Bounds.** The measured quantity is known to lie in ``[L, U]`` (KNOWN ``v``: ``L = U = v``;
  BOUNDED: ``lower``/``upper``; UNAVAILABLE: the quantity's admissible range over the mission,
  exactly as Phase 3 uses it, i.e. percent ``[0, 100]``, fraction ``[0, 1]``, durations
  ``[0, mission duration]``). The margin interval is then
  ``[L - t, U - t]`` for a minimum and ``[t - U, t - L]`` for a maximum (correctly ordered).
  A KNOWN metric gives a KNOWN margin; anything else gives a BOUNDED margin, never a point value.
  An admissible-range margin is labelled as such in ``Metric.reason`` and ``MarginBasis``.
* **Representation tolerance.** A bound equal to the threshold within Phase 3's
  ``COMPARISON_REL_TOL`` (1e-12 relative; floating-point representation only) gives a margin of
  exactly ``0.0``. Hence, for every constraint: PASS iff ``lower margin >= 0``, FAIL iff
  ``upper margin < 0``, UNKNOWN iff the interval straddles zero (checked, ``ValueError`` otherwise).
* **No numeric margin.** Unconfigured constraints give a NOT_APPLICABLE margin with
  ``reference = None``. Configured requirements the engine cannot evaluate (Sun/Earth clearance,
  ``unknown_reason = unsupported``) give an UNAVAILABLE margin: no clearance margin is computed,
  and the time-mean clearance is never used as a stand-in.

Normalisation (``relative_margin``; not part of the shared ``OperationalMargin`` contract):
``relative = margin / threshold`` when ``threshold > 0``, else none. For a maximum limit this is
``1 - observed / limit`` (share of the limit left unused; at most 1); for a minimum it is
``observed / required - 1`` (excess as a share of the requirement; unbounded above). It is
dimensionless and comparable only within one constraint, not across constraints. Bounds are divided
by the same positive threshold, so their order and sign are preserved.

Classification (``classify_margin``) uses the *least favourable* bound, so uncertainty can never
make a margin look safer: NEGATIVE (upper < 0), UNCERTAIN (lower < 0 <= upper), AT_THRESHOLD
(lower == 0), NARROW (0 < lower < ``narrow_fraction`` x threshold, or a duration margin below the
time resolution of the data), COMFORTABLE (otherwise), plus UNSUPPORTED and NOT_APPLICABLE.
With a zero threshold the relative band is empty. A duration margin smaller than one sample
spacing cannot be resolved by the data: with sample-and-hold, interior durations err by less
than one spacing (docs section 5b). The time resolution therefore only ever moves a margin from
COMFORTABLE to NARROW, never the other way.

Margins are mission-scoped like the Phase 3 metrics: an outage spanning landing or mission end
is measured inside the mission window only (``MarginAssessment.clipped_at_mission_start/end``).
They describe illumination and line-of-sight headroom under the sampling policy. They say
nothing about battery state, power generation, radio links or landing safety.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from enum import StrEnum
from typing import Final, Self

from pydantic import Field, model_validator

from .constraints import COMPARISON_REL_TOL, CONSTRAINT_SPECS, ConstraintSpec, admissible_range
from .conventions import ContractModel, StrictBool
from .enums import Comparison, ConstraintId, ConstraintStatus, MetricStatus, Unit, UnknownReason
from .inputs import ScientificTimeSeries
from .mission import MissionScenario
from .outputs import ConstraintAssessment, ConstraintEvaluation, Metric, MetricsSummary, OperationalMargin

__all__ = [
    "NARROW_MARGIN_FRACTION",
    "MarginAssessment",
    "MarginBasis",
    "MarginClass",
    "assess_margin",
    "assess_margins",
    "classify_margin",
    "compute_margins",
    "margin_bounds",
    "margin_interval",
    "margins_from_assessment",
    "margins_from_constraints",
    "operational_margin",
    "relative_margin",
    "signed_margin",
]

# Default "narrow" band: a proven margin below 10 % of the threshold. A documented convention for
# Phase 4B/5, not a physical constant; callers may pass their own ``narrow_fraction``.
NARROW_MARGIN_FRACTION: Final = 0.10


class MarginClass(StrEnum):
    """Headroom category from the least favourable margin bound (see module docstring)."""

    COMFORTABLE = "comfortable"  # proven margin >= narrow band (and >= time resolution for durations)
    NARROW = "narrow"  # proven positive margin below the narrow band or the time resolution
    AT_THRESHOLD = "at_threshold"  # least favourable value exactly at the limit (still PASS)
    NEGATIVE = "negative"  # confirmed violation: even the most favourable value violates
    UNCERTAIN = "uncertain"  # bounds straddle zero: the data cannot decide
    UNSUPPORTED = "unsupported"  # configured, but no numeric margin is computable by this engine
    NOT_APPLICABLE = "not_applicable"  # constraint not configured


class MarginBasis(StrEnum):
    """What the margin bounds rest on."""

    MEASURED = "measured"  # KNOWN metric: exact under the sampling policy
    BOUNDED = "bounded"  # BOUNDED metric: data partly unknown
    ADMISSIBLE_RANGE = "admissible_range"  # metric unavailable: only the physically possible range
    NONE = "none"  # no numeric margin (unsupported or not applicable)


# Classes that agree with each Phase 3 verdict (enforced on MarginAssessment).
_CLASSES_FOR_STATUS: Final[dict[ConstraintStatus, frozenset[MarginClass]]] = {
    ConstraintStatus.PASS: frozenset({MarginClass.COMFORTABLE, MarginClass.NARROW, MarginClass.AT_THRESHOLD}),
    ConstraintStatus.FAIL: frozenset({MarginClass.NEGATIVE}),
    ConstraintStatus.UNKNOWN: frozenset({MarginClass.UNCERTAIN, MarginClass.UNSUPPORTED}),
    ConstraintStatus.NOT_APPLICABLE: frozenset({MarginClass.NOT_APPLICABLE}),
}


# --- pure margin arithmetic -------------------------------------------------------------------


def signed_margin(comparison: Comparison, threshold: float, observed: float) -> float:
    """``observed - threshold`` (minimum) or ``threshold - observed`` (maximum).

    Exactly ``0.0`` when ``observed`` equals ``threshold`` within ``COMPARISON_REL_TOL``, the same
    equality Phase 3 uses, so the margin's sign always agrees with the verdict.
    """
    if math.isclose(observed, threshold, rel_tol=COMPARISON_REL_TOL, abs_tol=0.0):
        return 0.0
    return observed - threshold if comparison is Comparison.AT_LEAST else threshold - observed


def margin_interval(comparison: Comparison, threshold: float, lower: float, upper: float) -> tuple[float, float]:
    """Margin bounds ``(least favourable, most favourable)`` from bounds ``lower <= observed <= upper``.

    Minimum: ``[lower - t, upper - t]``. Maximum: ``[t - upper, t - lower]``.
    """
    if lower > upper:
        raise ValueError(f"lower bound {lower} exceeds upper bound {upper}")
    a = signed_margin(comparison, threshold, lower)
    b = signed_margin(comparison, threshold, upper)
    return (a, b) if comparison is Comparison.AT_LEAST else (b, a)


def margin_bounds(margin: OperationalMargin) -> tuple[float, float] | None:
    """``(least favourable, most favourable)`` margin, or None when no numeric margin exists."""
    v = margin.value
    if v.status is MetricStatus.KNOWN:
        assert v.value is not None
        return v.value, v.value
    if v.status is MetricStatus.BOUNDED:
        assert v.lower is not None and v.upper is not None
        return v.lower, v.upper
    return None


# --- formatting (factual one-liners; explanation text is Phase 6) ------------------------------


def _fmt(value: float, unit: Unit, *, signed: bool = False, points: bool = False) -> str:
    sign = "+" if signed and value > 0 else ""
    if unit is Unit.SECONDS:
        return f"{sign}{value / 3600.0:.6g} h"
    if unit is Unit.PERCENT:
        return f"{sign}{value:.6g} {'pp' if points else '%'}"
    if unit is Unit.DEGREES:
        return f"{sign}{value:.6g} deg"
    return f"{sign}{value:.6g}"


def _formula(spec: ConstraintSpec, unit: Unit, threshold: float, observed: str, result: str) -> str:
    t = _fmt(threshold, unit)
    if spec.comparison is Comparison.AT_LEAST:
        return f"{spec.name}: margin = measured - required = {observed} - {t} = {result}"
    return f"{spec.name}: margin = limit - measured = {t} - {observed} = {result}"


def _span(lo: float, hi: float, unit: Unit, *, margin: bool) -> str:
    return f"[{_fmt(lo, unit, signed=margin, points=margin)}, {_fmt(hi, unit, signed=margin, points=margin)}]"


# --- building one margin ----------------------------------------------------------------------


def _bounds_and_basis(metric: Metric, duration_s: float) -> tuple[tuple[float, float], MarginBasis] | None:
    if metric.status is MetricStatus.KNOWN:
        assert metric.value is not None
        return (metric.value, metric.value), MarginBasis.MEASURED
    if metric.status is MetricStatus.BOUNDED:
        assert metric.lower is not None and metric.upper is not None
        return (metric.lower, metric.upper), MarginBasis.BOUNDED
    if metric.status is MetricStatus.UNAVAILABLE:
        rng = admissible_range(metric.unit, duration_s)
        return (rng, MarginBasis.ADMISSIBLE_RANGE) if rng is not None else None
    return None


def _build(
    spec: ConstraintSpec,
    threshold: float | None,
    metric: Metric,
    duration_s: float,
    *,
    unsupported: bool,
) -> tuple[OperationalMargin, MarginBasis]:
    unit = metric.unit
    cid = spec.constraint_id

    def margin(value: Metric, reference: float | None, description: str) -> OperationalMargin:
        return OperationalMargin(
            margin_id=cid.value, related_constraint=cid, reference=reference, value=value, description=description
        )

    if threshold is None:
        return margin(Metric.not_applicable(unit), None, f"{spec.name}: not configured; no margin."), MarginBasis.NONE
    if unsupported:
        why = spec.unsupported_reason or "the requirement is not evaluable by this engine version"
        return margin(
            Metric.unavailable(unit, f"unsupported: {why}"),
            threshold,
            f"{spec.name}: required {_fmt(threshold, unit)}, but no margin is computed (not evaluable by this "
            "engine version; the time-mean clearance is not a per-instant minimum).",
        ), MarginBasis.NONE
    found = _bounds_and_basis(metric, duration_s)
    if found is None:  # NOT_APPLICABLE metric for a threshold test: cannot occur for the specs
        return margin(
            Metric.unavailable(unit, "the measured quantity is not defined for this range"),
            threshold,
            f"{spec.name}: the measured quantity is not defined for this range; no margin.",
        ), MarginBasis.NONE

    (lower, upper), basis = found
    lo, hi = margin_interval(spec.comparison, threshold, lower, upper)
    value: Metric
    if basis is MarginBasis.MEASURED:
        value = Metric.known(lo, unit)
        text = _formula(spec, unit, threshold, _fmt(lower, unit), _fmt(lo, unit, signed=True, points=True)) + "."
    elif basis is MarginBasis.BOUNDED:
        value = Metric.bounded(lo, hi, unit, metric.reason)
        text = (
            _formula(spec, unit, threshold, _span(lower, upper, unit, margin=False), _span(lo, hi, unit, margin=True))
            + " (measured value bounded by unknown data)."
        )
    else:
        value = Metric.bounded(
            lo,
            hi,
            unit,
            f"measured value unavailable ({metric.reason}); margin bounds come from the quantity's admissible "
            "range over the mission, not from observations",
        )
        text = (
            _formula(spec, unit, threshold, _span(lower, upper, unit, margin=False), _span(lo, hi, unit, margin=True))
            + " (measured value unavailable: admissible range only, not observations)."
        )
    if spec.comparison is Comparison.AT_LEAST and unit is Unit.SECONDS and threshold > duration_s:
        text += " The requirement exceeds the mission duration."
    return margin(value, threshold, text), basis


def _check_duration(duration_s: float) -> None:
    if not (math.isfinite(duration_s) and duration_s > 0.0):
        raise ValueError(f"mission duration must be finite and positive, got {duration_s!r}")


def _spec_for(evaluation: ConstraintEvaluation) -> ConstraintSpec:
    spec = CONSTRAINT_SPECS[evaluation.constraint_id]
    if evaluation.comparison is not None and evaluation.comparison is not spec.comparison:
        raise ValueError(
            f"{evaluation.constraint_id.value}: comparison {evaluation.comparison.value!r} contradicts the "
            f"constraint definition ({spec.comparison.value!r})"
        )
    return spec


def _is_unsupported(spec: ConstraintSpec, evaluation: ConstraintEvaluation) -> bool:
    return spec.metric_field is None or evaluation.unknown_reason is UnknownReason.UNSUPPORTED


def _implied_status(margin: OperationalMargin) -> ConstraintStatus:
    if margin.value.status is MetricStatus.NOT_APPLICABLE:
        return ConstraintStatus.NOT_APPLICABLE
    bounds = margin_bounds(margin)
    if bounds is None:
        return ConstraintStatus.UNKNOWN
    lo, hi = bounds
    if lo >= 0.0:
        return ConstraintStatus.PASS
    if hi < 0.0:
        return ConstraintStatus.FAIL
    return ConstraintStatus.UNKNOWN


def _from_evaluation(evaluation: ConstraintEvaluation, duration_s: float) -> tuple[OperationalMargin, MarginBasis]:
    _check_duration(duration_s)
    spec = _spec_for(evaluation)
    result = _build(
        spec, evaluation.threshold, evaluation.measured, duration_s, unsupported=_is_unsupported(spec, evaluation)
    )
    implied = _implied_status(result[0])
    if implied is not evaluation.status:
        raise ValueError(
            f"{evaluation.constraint_id.value}: margin implies {implied.value!r} but the verdict is "
            f"{evaluation.status.value!r}; the evaluation is inconsistent or uses a different mission duration"
        )
    return result


# --- public entry points ----------------------------------------------------------------------


def operational_margin(evaluation: ConstraintEvaluation, duration_s: float) -> OperationalMargin:
    """Margin of one Phase 3 evaluation; ``duration_s`` = evaluated (mission) duration.

    Raises ``ValueError`` if the margin's sign contradicts ``evaluation.status``; margins never
    re-decide a verdict.
    """
    return _from_evaluation(evaluation, duration_s)[0]


def margins_from_constraints(constraints: Sequence[ConstraintEvaluation], duration_s: float) -> list[OperationalMargin]:
    """One margin per evaluation, in the given (Phase 3: ``ConstraintId``) order."""
    ids = [c.constraint_id for c in constraints]
    if len(ids) != len(set(ids)):
        raise ValueError("each constraint_id may appear at most once")
    return [operational_margin(c, duration_s) for c in constraints]


def margins_from_assessment(assessment: ConstraintAssessment) -> list[OperationalMargin]:
    """Margins of a Phase 3 ``ConstraintAssessment`` (recommended entry point)."""
    env = assessment.environment
    duration_s = (env.evaluated_end_utc - env.evaluated_start_utc).total_seconds()
    return margins_from_constraints(assessment.constraints, duration_s)


def compute_margins(
    scenario: MissionScenario, metrics: MetricsSummary, series: ScientificTimeSeries
) -> list[OperationalMargin]:
    """Phase 1 signature: margins from ``metrics`` = ``analyze_scenario(scenario, series).metrics``.

    Produces exactly the same margins as ``margins_from_assessment`` on the matching Phase 3
    assessment (tested). ``metrics`` must come from this scenario's analysis (mission window and
    ``solar_power_min_disk_fraction``); it carries no identity to check, so only the site is
    checked here (``ValueError``). Prefer ``margins_from_assessment``.
    """
    if series.site.id != scenario.site.id:
        raise ValueError(f"series is for site {series.site.id!r} but the scenario is for {scenario.site.id!r}")
    duration_s = scenario.duration_s
    _check_duration(duration_s)
    out: list[OperationalMargin] = []
    for cid in ConstraintId:
        spec = CONSTRAINT_SPECS[cid]
        threshold = spec.threshold(scenario)
        if spec.metric_field is None:
            metric = Metric.unavailable(spec.unit, spec.unsupported_reason or "not evaluable")
        else:
            metric = getattr(metrics, spec.metric_field)
            if metric.unit is not spec.unit:
                raise ValueError(f"metrics.{spec.metric_field} has unit {metric.unit.value!r}, expected {spec.unit}")
        out.append(_build(spec, threshold, metric, duration_s, unsupported=spec.metric_field is None)[0])
    return out


# --- normalisation and classification ---------------------------------------------------------


def relative_margin(margin: OperationalMargin) -> Metric | None:
    """``margin / reference`` (dimensionless) when ``reference > 0``; None otherwise.

    Reported with ``Unit.FRACTION`` (the contract's only dimensionless unit) but it is a ratio:
    negative for a violation, and above 1 possible for a minimum requirement. Comparable only
    within one constraint. Never computed for a zero (or negative) reference.
    """
    ref = margin.reference
    bounds = margin_bounds(margin)
    if ref is None or not ref > 0.0 or bounds is None:
        return None
    lo, hi = bounds
    if margin.value.status is MetricStatus.KNOWN:
        return Metric.known(lo / ref, Unit.FRACTION)
    return Metric.bounded(lo / ref, hi / ref, Unit.FRACTION, margin.value.reason)


def classify_margin(
    margin: OperationalMargin,
    *,
    narrow_fraction: float = NARROW_MARGIN_FRACTION,
    time_resolution_s: float | None = None,
) -> MarginClass:
    """Headroom category from the least favourable bound (see module docstring)."""
    if not (math.isfinite(narrow_fraction) and narrow_fraction >= 0.0):
        raise ValueError(f"narrow_fraction must be finite and non-negative, got {narrow_fraction!r}")
    if time_resolution_s is not None and not (math.isfinite(time_resolution_s) and time_resolution_s >= 0.0):
        raise ValueError(f"time_resolution_s must be finite and non-negative, got {time_resolution_s!r}")
    if margin.value.status is MetricStatus.NOT_APPLICABLE:
        return MarginClass.NOT_APPLICABLE
    bounds = margin_bounds(margin)
    if bounds is None:
        return MarginClass.UNSUPPORTED
    lo, hi = bounds
    if hi < 0.0:
        return MarginClass.NEGATIVE
    if lo < 0.0:
        return MarginClass.UNCERTAIN
    if lo == 0.0:
        return MarginClass.AT_THRESHOLD
    ref = margin.reference
    narrow = ref is not None and ref > 0.0 and lo < narrow_fraction * ref
    if time_resolution_s is not None and margin.value.unit is Unit.SECONDS and lo < time_resolution_s:
        narrow = True
    return MarginClass.NARROW if narrow else MarginClass.COMFORTABLE


class MarginAssessment(ContractModel):
    """Phase 4A result for one constraint: the contract margin plus its interpretation.

    Not part of ``ViabilityAssessment`` (the shared contract has only ``OperationalMargin``); it
    is the interface Phase 4B (risk) and Phase 5 (scoring) consume inside the engine.
    ``classification`` must agree with ``constraint_status`` (enforced): a PASS with a small
    margin is still PASS, a FAIL is always NEGATIVE.
    """

    margin: OperationalMargin
    constraint_status: ConstraintStatus  # Phase 3 verdict, echoed unchanged
    comparison: Comparison
    basis: MarginBasis
    classification: MarginClass
    relative: Metric | None  # margin / threshold; None if threshold <= 0 or no numeric margin
    narrow_fraction: float = Field(ge=0.0, strict=True)
    time_resolution_s: float | None = Field(ge=0.0, strict=True)  # applied to duration margins only
    # The decisive evidence window touches the mission edge with the state continuing beyond it:
    # the margin is mission-scoped (e.g. darkness already in progress at landing).
    clipped_at_mission_start: StrictBool = False
    clipped_at_mission_end: StrictBool = False

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if self.classification not in _CLASSES_FOR_STATUS[self.constraint_status]:
            raise ValueError(
                f"classification {self.classification.value!r} contradicts verdict {self.constraint_status.value!r}"
            )
        if self.margin.related_constraint is None:
            raise ValueError("a margin assessment requires margin.related_constraint")
        return self

    @property
    def constraint_id(self) -> ConstraintId:
        assert self.margin.related_constraint is not None
        return self.margin.related_constraint

    @property
    def worst_case(self) -> float | None:
        """Least favourable margin (the proven headroom when >= 0); None if no numeric margin."""
        bounds = margin_bounds(self.margin)
        return None if bounds is None else bounds[0]

    @property
    def best_case(self) -> float | None:
        """Most favourable margin; None if no numeric margin."""
        bounds = margin_bounds(self.margin)
        return None if bounds is None else bounds[1]


def assess_margin(
    evaluation: ConstraintEvaluation,
    duration_s: float,
    *,
    narrow_fraction: float = NARROW_MARGIN_FRACTION,
    time_resolution_s: float | None = None,
) -> MarginAssessment:
    """Margin, normalisation and classification of one Phase 3 evaluation."""
    margin, basis = _from_evaluation(evaluation, duration_s)
    windows = evaluation.evidence_windows
    return MarginAssessment(
        margin=margin,
        constraint_status=evaluation.status,
        comparison=CONSTRAINT_SPECS[evaluation.constraint_id].comparison,
        basis=basis,
        classification=classify_margin(margin, narrow_fraction=narrow_fraction, time_resolution_s=time_resolution_s),
        relative=relative_margin(margin),
        narrow_fraction=narrow_fraction,
        time_resolution_s=time_resolution_s,
        clipped_at_mission_start=any(w.clipped_at_start for w in windows),
        clipped_at_mission_end=any(w.clipped_at_end for w in windows),
    )


def assess_margins(
    assessment: ConstraintAssessment,
    *,
    narrow_fraction: float = NARROW_MARGIN_FRACTION,
    time_resolution_s: float | None = None,
) -> list[MarginAssessment]:
    """Phase 4A entry point for Phase 4B/5: one ``MarginAssessment`` per constraint, in order.

    ``time_resolution_s`` defaults to ``data_quality.largest_sample_gap_s`` (the coarsest sample
    spacing in the range; None with fewer than two samples). Pass ``0.0`` to disable it.
    """
    env = assessment.environment
    duration_s = (env.evaluated_end_utc - env.evaluated_start_utc).total_seconds()
    resolution = env.data_quality.largest_sample_gap_s if time_resolution_s is None else time_resolution_s
    return [
        assess_margin(c, duration_s, narrow_fraction=narrow_fraction, time_resolution_s=resolution)
        for c in assessment.constraints
    ]
