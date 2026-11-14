"""Viability output contract (viability engine -> Members 3, 4, 5, 6). Status: draft.

Design rules enforced here, not just documented:

* Eligibility (PASS/FAIL/UNKNOWN) is derived only from hard-constraint results:
  any FAIL -> FAIL, else any UNKNOWN -> UNKNOWN, else PASS.
* Desirability score and risk level are separate fields and cannot change eligibility.
  Only PASS scenarios are rank-eligible, and rankings list every PASS scenario before any
  UNKNOWN, and every UNKNOWN before any FAIL.
* Unavailable values are explicit (``Metric.status``), never zero. When data is partly
  unknown, a metric may be BOUNDED: the true value lies in [lower, upper].
* Phase 5 score contract (docs §5e): ``ScoreBreakdown.status`` separates an exact score
  (KNOWN), an uncertain one (BOUNDED: ``score`` null, interval in ``score_bounds``), and the two
  unscored cases (eligibility UNKNOWN; no scorable component). A lower bound is never written
  into ``score``, and UNKNOWN eligibility never carries a score. Rankings never mix data bases
  (real terrain-aware / real geometric-only / synthetic).
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from fractions import Fraction as Rational
from typing import Annotated, Final, Self

from pydantic import Field, StringConstraints, model_validator

from .conventions import (
    SCHEMA_VERSION,
    ContractModel,
    DurationS,
    Fraction,
    Identifier,
    NonEmptyStr,
    NonNegativeFloat,
    Percent,
    StrictBool,
    StrictFloat,
    UTCDatetime,
)
from .enums import (
    AngleType,
    CalculationBasis,
    ComparabilityPolicy,
    Comparison,
    Condition,
    ConditionState,
    ConstraintId,
    ConstraintStatus,
    DataBasis,
    Eligibility,
    ExplanationCategory,
    MetricStatus,
    RiskLevel,
    SamplingPolicy,
    ScoreComponent,
    ScoreComponentStatus,
    ScoreStatus,
    Severity,
    Unit,
    UnknownDataPolicy,
    UnknownReason,
    VisibilityCriterion,
    WindowKind,
)
from .inputs import Provenance
from .mission import LandingSite

# Durations derived from datetimes may differ from stored floats by float rounding.
_DURATION_TOLERANCE_S = 1e-3


def derive_eligibility(statuses: Iterable[ConstraintStatus]) -> Eligibility:
    """The single rule combining per-constraint results into overall eligibility.

    NOT_APPLICABLE results are ignored. With no applicable constraints the scenario is
    PASS (it has no hard requirements); data-quality concerns then surface via risks.
    """
    seen = set(statuses)
    if ConstraintStatus.FAIL in seen:
        return Eligibility.FAIL
    if ConstraintStatus.UNKNOWN in seen:
        return Eligibility.UNKNOWN
    return Eligibility.PASS


class Metric(ContractModel):
    """A measured quantity with an explicit availability state."""

    status: MetricStatus
    unit: Unit
    value: StrictFloat | None = None  # KNOWN only
    lower: StrictFloat | None = None  # BOUNDED only
    upper: StrictFloat | None = None  # BOUNDED only
    reason: str | None = None  # required when UNAVAILABLE

    @model_validator(mode="after")
    def _status_matches_fields(self) -> Self:
        s = self.status
        has_value = self.value is not None
        has_bounds = self.lower is not None or self.upper is not None
        if s is MetricStatus.KNOWN and (not has_value or has_bounds):
            raise ValueError("KNOWN metric requires value and no lower/upper")
        if s is MetricStatus.BOUNDED:
            if has_value or self.lower is None or self.upper is None:
                raise ValueError("BOUNDED metric requires lower and upper and no value")
            if self.lower > self.upper:
                raise ValueError("BOUNDED metric requires lower <= upper")
        if s in (MetricStatus.UNAVAILABLE, MetricStatus.NOT_APPLICABLE) and (has_value or has_bounds):
            raise ValueError(f"{s.value} metric must not carry numeric values")
        if s is MetricStatus.UNAVAILABLE and not self.reason:
            raise ValueError("UNAVAILABLE metric requires a reason")
        return self

    @classmethod
    def known(cls, value: float, unit: Unit) -> Metric:
        return cls(status=MetricStatus.KNOWN, unit=unit, value=value)

    @classmethod
    def bounded(cls, lower: float, upper: float, unit: Unit, reason: str | None = None) -> Metric:
        return cls(status=MetricStatus.BOUNDED, unit=unit, lower=lower, upper=upper, reason=reason)

    @classmethod
    def unavailable(cls, unit: Unit, reason: str) -> Metric:
        return cls(status=MetricStatus.UNAVAILABLE, unit=unit, reason=reason)

    @classmethod
    def not_applicable(cls, unit: Unit) -> Metric:
        return cls(status=MetricStatus.NOT_APPLICABLE, unit=unit)


class VisibilityWindow(ContractModel):
    """A maximal interval of one condition, clipped to the evaluated range."""

    kind: WindowKind
    start_utc: UTCDatetime
    end_utc: UTCDatetime
    duration_s: DurationS
    # True when the window is cut by the evaluated range; the condition may extend beyond it.
    clipped_at_start: StrictBool = False
    clipped_at_end: StrictBool = False

    @model_validator(mode="after")
    def _consistent_duration(self) -> Self:
        if self.end_utc <= self.start_utc:
            raise ValueError("window end_utc must be after start_utc")
        actual = (self.end_utc - self.start_utc).total_seconds()
        if abs(actual - self.duration_s) > _DURATION_TOLERANCE_S:
            raise ValueError(f"duration_s {self.duration_s} does not match end - start ({actual})")
        return self


class MetricsSummary(ContractModel):
    """Assessment-level metrics over the evaluated range (definitions: docs §5b).

    Durations are time-weighted under the stated ``SamplingPolicy``; percentages use the whole
    evaluated range as denominator, so unknown time widens the bounds instead of shrinking the
    denominator. "Power-lit" uses ``spacecraft.solar_power_min_disk_fraction`` when set, and
    otherwise equals direct sunlight (any part of the disk visible).
    """

    sunlight_duration: Metric  # direct sunlight: any part of the solar disk visible
    sunlight_percent: Metric
    full_sunlight_duration: Metric  # whole solar disk visible
    full_sunlight_percent: Metric
    partial_sunlight_duration: Metric  # part of the disk visible (0 < fraction < 1)
    partial_sunlight_percent: Metric
    power_lit_duration: Metric  # threshold-qualified illumination (see class docstring)
    power_lit_percent: Metric
    earth_visible_duration: Metric  # direct-to-Earth line-of-sight opportunity (geometric)
    earth_visible_percent: Metric
    simultaneous_duration: Metric  # power-lit AND Earth visible
    simultaneous_percent: Metric
    longest_simultaneous_window: Metric
    # "Darkness" means power-dark (below the threshold) when the threshold is set; otherwise
    # it equals longest_without_direct_sunlight.
    longest_continuous_darkness: Metric
    longest_without_direct_sunlight: Metric
    longest_communication_blackout: Metric
    mean_solar_disk_fraction: Metric  # time-average of visible_fraction (unit: fraction)
    initial_sunlight_duration: Metric  # continuous power-lit time from evaluated start
    initial_earth_visibility_duration: Metric  # continuous Earth visibility from evaluated start
    # Time from evaluated start to the first power-lit->dark (visible->blocked) transition.
    # NOT_APPLICABLE when no such transition occurs within the range.
    time_to_first_sunset: Metric
    time_to_first_earthset: Metric
    mean_sun_clearance: Metric  # time-mean (elevation - horizon) while in direct sunlight
    mean_earth_clearance: Metric  # time-mean (elevation - horizon) while the Earth is visible
    mean_solar_elevation: Metric  # time-mean Sun elevation above the local horizontal plane


class ConstraintEvaluation(ContractModel):
    """One hard requirement's verdict (Phase 3; docs section 5c).

    The first six fields are the Phase 1 contract. The remaining fields are additive and
    optional (defaults keep older constructors valid); ``constraints.evaluate_constraints``
    always fills them so Phase 4 (risk) and Phase 6 (explanations) can trace every verdict.
    """

    constraint_id: ConstraintId
    status: ConstraintStatus
    threshold: StrictFloat | None  # None only when NOT_APPLICABLE
    unit: Unit
    measured: Metric
    message: NonEmptyStr
    # --- Phase 3 evidence (additive) ---
    name: NonEmptyStr | None = None  # human-readable constraint name
    comparison: Comparison | None = None  # AT_LEAST (min) / AT_MOST (max); None = not a threshold test
    requirement_field: NonEmptyStr | None = None  # e.g. "spacecraft.max_continuous_darkness_s"
    metric_field: NonEmptyStr | None = None  # MetricsSummary field evaluated; None = no metric available
    condition: Condition | None = None  # Phase 2 condition the metric derives from (look up its windows)
    condition_unknown_duration_s: DurationS | None = None  # unknown time of that condition in range
    unknown_reason: UnknownReason | None = None  # set by Phase 3 exactly when status is UNKNOWN
    evidence_windows: list[VisibilityWindow] = Field(default_factory=list)  # e.g. longest outage

    @model_validator(mode="after")
    def _threshold_matches_status(self) -> Self:
        if (self.status is ConstraintStatus.NOT_APPLICABLE) != (self.threshold is None):
            raise ValueError("threshold must be None exactly when status is not_applicable")
        if self.measured.unit is not self.unit:
            raise ValueError("measured.unit must match constraint unit")
        if self.unknown_reason is not None and self.status is not ConstraintStatus.UNKNOWN:
            raise ValueError("unknown_reason is only allowed when status is unknown")
        return self


class OperationalMargin(ContractModel):
    """Signed headroom: positive = on the safe side of the reference, negative = violated."""

    margin_id: Identifier  # e.g. "darkness_duration", "min_earth_clearance"
    related_constraint: ConstraintId | None = None
    reference: StrictFloat | None  # the limit / threshold compared against
    value: Metric
    description: NonEmptyStr


class RiskIndicator(ContractModel):
    """Rule-triggered risk flag. ``rule`` states the explicit rule; no probabilities."""

    code: Identifier  # e.g. "low_darkness_margin", "geometric_only_data"
    level: RiskLevel
    rule: NonEmptyStr
    evidence: Metric | None = None
    message: NonEmptyStr


# --- Phase 5 score contract (C0; docs §5e) ------------------------------------------------------

# Scores are reported rounded to 6 decimals (exact: nearest; bounds: outward), so a reported score
# may differ from the exact weighted sum by up to 1e-6.
_SCORE_ROUNDING_TOL: Final = 1e-6
# Allowance for floating-point noise between a producer's and this validator's sums.
_FLOAT_NOISE_TOL: Final = 1e-9
_WEIGHT_TOL: Final = 1e-12

# "sha256:" + 64 lowercase hex digits; produced by ``MissionScenario.configuration_key``.
ConfigurationKey = Annotated[str, StringConstraints(pattern=r"^sha256:[0-9a-f]{64}$")]


def _interval(metric: Metric) -> tuple[float, float]:
    """``(lower, upper)`` of a KNOWN (``lower == upper``) or BOUNDED metric."""
    if metric.status is MetricStatus.KNOWN:
        assert metric.value is not None
        return metric.value, metric.value
    if metric.status is MetricStatus.BOUNDED:
        assert metric.lower is not None and metric.upper is not None
        return metric.lower, metric.upper
    raise ValueError(f"expected a known or bounded metric, got {metric.status.value!r}")


def _check_score_fields(status: ScoreStatus, score: float | None, bounds: Metric | None) -> None:
    """Shared by ScoreBreakdown and RankedScenario: ``score`` holds exact scores only."""
    if bounds is not None:
        if bounds.unit is not Unit.PERCENT:
            raise ValueError("score_bounds must use unit 'percent'")
        lo, hi = _interval(bounds)
        if lo < 0.0 or hi > 100.0:
            raise ValueError("score_bounds must lie within [0, 100]")
    if status is ScoreStatus.KNOWN:
        if score is None or bounds is None or bounds.status is not MetricStatus.KNOWN or bounds.value != score:
            raise ValueError("a known score needs score and a known score_bounds with the same value")
    elif status is ScoreStatus.BOUNDED:
        if score is not None:
            raise ValueError("a bounded score must leave score null: a lower bound is not an exact score")
        if bounds is None or bounds.status is not MetricStatus.BOUNDED:
            raise ValueError("a bounded score needs bounded score_bounds")
    elif score is not None or bounds is not None:
        raise ValueError(f"a {status.value!r} score must leave score and score_bounds null")


def _score_lower_bound(status: ScoreStatus | None, score: float | None, bounds: Metric | None) -> float | None:
    if status is ScoreStatus.KNOWN:
        return score
    if status is ScoreStatus.BOUNDED:
        assert bounds is not None and bounds.lower is not None
        return bounds.lower
    return None


class ScoreComponentResult(ContractModel):
    """One weighted component of the desirability score.

    The first five fields are the Phase 1 contract. Phase 5 (C0) adds ``status``,
    ``declared_weight`` and ``normalized``; with ``status`` unset the old meaning is unchanged.
    With ``status`` set: only an ACTIVE component has a weight above 0 and a normalized value;
    ``normalized`` is the component value in [0, 1] as a KNOWN or BOUNDED metric (BOUNDED only
    when lower < upper); ``normalized_value`` and ``contribution`` are filled only when it is
    KNOWN, so a bound is never shown as an exact value.
    """

    component: ScoreComponent
    weight: Fraction  # effective (normalised) weight; ACTIVE weights sum to 1, others are 0
    normalized_value: Fraction | None  # exact value only; None = not scored or only bounded
    contribution: NonNegativeFloat | None  # weight * normalized_value * 100 (exact values only)
    note: str | None = None
    # --- Phase 5 (C0, additive) ---
    status: ScoreComponentStatus | None = None  # None = legacy result without Phase 5 metadata
    declared_weight: NonNegativeFloat | None = None  # the preference weight as the user gave it
    normalized: Metric | None = None  # value in [0, 1] (unit fraction), KNOWN or BOUNDED

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if self.status is None:
            if self.declared_weight is not None or self.normalized is not None:
                raise ValueError("declared_weight and normalized require status")
            return self
        if self.declared_weight is None:
            raise ValueError("declared_weight is required when status is set")
        if self.status is ScoreComponentStatus.ACTIVE:
            if not (self.weight > 0.0 and self.declared_weight > 0.0):
                raise ValueError("an active component needs weight > 0 and declared_weight > 0")
        else:
            if self.status is ScoreComponentStatus.ZERO_WEIGHT and self.declared_weight != 0.0:
                raise ValueError("a zero_weight component must have declared_weight 0")
            if self.weight != 0.0 or self.normalized is not None:
                raise ValueError(f"a {self.status.value!r} component must have weight 0 and no normalized value")
        n = self.normalized
        if n is None:
            if self.normalized_value is not None or self.contribution is not None:
                raise ValueError("normalized_value and contribution require a normalized value")
            return self
        if n.unit is not Unit.FRACTION:
            raise ValueError("normalized must use unit 'fraction'")
        lo, hi = _interval(n)
        if lo < 0.0 or hi > 1.0:
            raise ValueError("normalized must lie within [0, 1]")
        if n.status is MetricStatus.KNOWN:
            if self.normalized_value != n.value:
                raise ValueError("normalized_value must equal normalized.value for a known component")
            expected = self.weight * lo * 100.0
            if self.contribution is None or abs(self.contribution - expected) > _FLOAT_NOISE_TOL:
                raise ValueError("contribution must equal weight * normalized_value * 100")
        else:
            if not lo < hi:
                raise ValueError("a bounded component needs lower < upper (equal bounds are known)")
            if self.normalized_value is not None or self.contribution is not None:
                raise ValueError("a bounded component must leave normalized_value and contribution null")
        return self


class ScoreBreakdown(ContractModel):
    """Desirability score of one scenario (docs §5e).

    Phase 1 fields keep their meaning. With Phase 5 metadata (``status`` set):

    * KNOWN: exact ``score``; ``score_bounds`` is the same value as a KNOWN metric.
    * BOUNDED: ``score`` is null; ``score_bounds`` holds [lower, upper], rounded outward.
    * ELIGIBILITY_UNKNOWN / NO_SCORABLE_COMPONENTS: ``score`` and ``score_bounds`` are null.
      Never shown as 0.
    * ``components`` lists every ``ScoreComponent`` once, in enum order; ACTIVE weights equal
      ``declared_weight / sum(declared_weight over ACTIVE)``, so they depend on configuration only.
    * ``configuration_key`` identifies the spacecraft, requirements and mission duration.
    """

    method_version: NonEmptyStr
    score: Percent | None  # exact 0..100 desirability; None = not scored or only bounded
    rank_eligible: StrictBool  # True iff eligibility is PASS
    components: list[ScoreComponentResult] = Field(default_factory=list)
    note: str | None = None
    # --- Phase 5 (C0, additive) ---
    status: ScoreStatus | None = None  # None = legacy breakdown without Phase 5 metadata
    score_bounds: Metric | None = None  # unit percent; KNOWN (= score) or BOUNDED
    configuration_key: ConfigurationKey | None = None  # MissionScenario.configuration_key()

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        status = self.status
        if status is None:
            if self.score_bounds is not None or self.configuration_key is not None:
                raise ValueError("score_bounds and configuration_key require status")
            return self
        if self.configuration_key is None:
            raise ValueError("configuration_key is required when status is set")
        _check_score_fields(status, self.score, self.score_bounds)
        if [c.component for c in self.components] != list(ScoreComponent):
            raise ValueError("components must list every score component once, in ScoreComponent order")
        if any(c.status is None for c in self.components):
            raise ValueError("every component needs a status when the score has one")
        active = [c for c in self.components if c.status is ScoreComponentStatus.ACTIVE]
        if active:
            declared = [c.declared_weight for c in active]
            assert all(d is not None for d in declared)
            top = max(d for d in declared if d is not None)
            total = math.fsum(d / top for d in declared if d is not None)
            for c in active:
                assert c.declared_weight is not None
                if abs(c.weight - (c.declared_weight / top) / total) > _WEIGHT_TOL:
                    raise ValueError("active weights must equal declared_weight / sum of active declared weights")
        if status is ScoreStatus.ELIGIBILITY_UNKNOWN and self.rank_eligible:
            raise ValueError("a score withheld for unknown eligibility cannot be rank-eligible")
        if status is ScoreStatus.NO_SCORABLE_COMPONENTS and active:
            raise ValueError("no_scorable_components requires that no component is active")
        if status in (ScoreStatus.ELIGIBILITY_UNKNOWN, ScoreStatus.NO_SCORABLE_COMPONENTS):
            if any(c.normalized is not None for c in self.components):
                raise ValueError(f"a {status.value!r} score must not carry normalized component values")
            return self
        if not active:
            raise ValueError(f"a {status.value!r} score needs at least one active component")
        values = [c.normalized for c in active]
        if any(v is None for v in values):
            raise ValueError("every active component of a scored result needs a normalized value")
        spans = [_interval(v) for v in values if v is not None]
        low = 100.0 * math.fsum(c.weight * s[0] for c, s in zip(active, spans, strict=True))
        high = 100.0 * math.fsum(c.weight * s[1] for c, s in zip(active, spans, strict=True))
        all_known = all(v is not None and v.status is MetricStatus.KNOWN for v in values)
        if status is ScoreStatus.KNOWN:
            assert self.score is not None
            if not all_known:
                raise ValueError("a known score needs every active component known")
            if abs(self.score - low) > _SCORE_ROUNDING_TOL + _FLOAT_NOISE_TOL:
                raise ValueError("score must equal 100 * sum(weight * normalized value), rounded to 6 decimals")
        else:
            assert self.score_bounds is not None
            if all_known:
                raise ValueError("a bounded score needs at least one bounded component")
            lower, upper = _interval(self.score_bounds)
            slack = _SCORE_ROUNDING_TOL + _FLOAT_NOISE_TOL
            if not (low - slack <= lower <= low + _FLOAT_NOISE_TOL):
                raise ValueError("score_bounds.lower must be the components' lower sum, rounded down")
            if not (min(high, 100.0) - _FLOAT_NOISE_TOL <= upper <= high + slack):
                raise ValueError("score_bounds.upper must be the components' upper sum, rounded up")
        return self

    @property
    def lower_bound(self) -> float | None:
        """Exact score (KNOWN) or guaranteed lower bound (BOUNDED); None when not scored.

        For ordering under the documented ranking policy (D8) only, never for display as a score.
        """
        return _score_lower_bound(self.status, self.score, self.score_bounds)

    def weights_signature(self) -> tuple[tuple[ScoreComponent, Rational], ...] | None:
        """Exact effective weights as rationals (``declared / sum over ACTIVE``); None if legacy.

        Rational arithmetic makes the comparison exact and scale-invariant (weights 1:1 and 2:2
        agree), with no floating-point tolerance. Components that are not ACTIVE weigh 0.
        """
        if self.status is None:
            return None
        weights = {
            c.component: Rational(c.declared_weight)
            for c in self.components
            if c.status is ScoreComponentStatus.ACTIVE and c.declared_weight is not None
        }
        total = sum(weights.values(), Rational(0))
        return tuple(
            (c.component, weights[c.component] / total if c.component in weights else Rational(0))
            for c in self.components
        )


class Explanation(ContractModel):
    category: ExplanationCategory
    severity: Severity
    message: NonEmptyStr
    related_constraint: ConstraintId | None = None


class DataQualitySummary(ContractModel):
    dataset_id: Identifier
    provenance: Provenance
    calculation_basis: CalculationBasis
    angle_type: AngleType
    sun_criterion: VisibilityCriterion
    earth_criterion: VisibilityCriterion
    sampling_policy: SamplingPolicy
    evaluated_duration_s: DurationS
    sample_count: int = Field(ge=0, strict=True)  # samples that represent part of the range
    # Largest spacing between consecutive samples spanning the range; None if < 2 samples.
    largest_sample_gap_s: DurationS | None
    uncovered_duration_s: DurationS  # range time no sample represents (gaps, outside coverage)
    coverage_gap_count: int = Field(ge=0, strict=True)  # maximal uncovered intervals in range
    sun_unknown_duration_s: DurationS  # uncovered time + samples with unknown Sun state
    earth_unknown_duration_s: DurationS
    sun_coverage_percent: Percent  # share of evaluated range with a known Sun state
    earth_coverage_percent: Percent
    assumptions: list[NonEmptyStr] = Field(default_factory=list)  # e.g. sampling rule used
    warnings: list[NonEmptyStr] = Field(default_factory=list)  # data issues found in range

    @property
    def data_basis(self) -> DataBasis:
        """SYNTHETIC if the provenance says so; else REAL_GEOMETRIC_ONLY or REAL_TERRAIN_AWARE."""
        if self.provenance.is_synthetic:
            return DataBasis.SYNTHETIC
        if self.calculation_basis is CalculationBasis.GEOMETRIC_ONLY:
            return DataBasis.REAL_GEOMETRIC_ONLY
        return DataBasis.REAL_TERRAIN_AWARE


class ConditionSummary(ContractModel):
    """Phase 2 time-series statistics of one ``Condition`` over the evaluated range.

    Durations are KNOWN when no part of the range has an unknown state for this condition,
    BOUNDED otherwise (unknown time counted as not met for ``lower`` and as met for ``upper``),
    and UNAVAILABLE when the condition is unknown over the whole range. Window counts include
    only confirmed windows; unknown periods may hide or merge further windows.
    """

    condition: Condition
    definition: NonEmptyStr  # the rule used, in words
    met_duration: Metric
    not_met_duration: Metric
    unknown_duration_s: DurationS
    met_percent: Metric
    initial_state: ConditionState  # state at the evaluated start (e.g. right after landing)
    initial_met_duration: Metric  # continuous met time from the evaluated start
    time_to_first_transition: Metric  # first change of state after the evaluated start
    time_to_first_loss: Metric  # first met -> not-met transition (sunset / Earthset)
    longest_met: Metric
    longest_met_window: VisibilityWindow | None  # longest confirmed met window
    longest_not_met: Metric  # longest outage
    longest_not_met_window: VisibilityWindow | None  # longest confirmed outage
    met_window_count: int = Field(ge=0, strict=True)
    not_met_window_count: int = Field(ge=0, strict=True)
    not_met_windows_per_day: NonNegativeFloat  # confirmed outages per 86 400 s of range


class EnvironmentAnalysis(ContractModel):
    """Phase 2 result: sunlight / Earth-visibility analysis of one site over one time range.

    It contains no pass/fail verdict, risk level or score (Phases 3-5).
    """

    schema_version: str = SCHEMA_VERSION
    engine_version: NonEmptyStr
    site: LandingSite
    evaluated_start_utc: UTCDatetime
    evaluated_end_utc: UTCDatetime
    solar_power_min_disk_fraction: Fraction | None
    metrics: MetricsSummary
    conditions: list[ConditionSummary]
    windows: list[VisibilityWindow]
    data_quality: DataQualitySummary

    @model_validator(mode="after")
    def _invariants(self) -> Self:
        if self.evaluated_end_utc <= self.evaluated_start_utc:
            raise ValueError("evaluated_end_utc must be after evaluated_start_utc")
        kinds = [c.condition for c in self.conditions]
        if len(kinds) != len(set(kinds)):
            raise ValueError("each condition may appear at most once")
        for w in self.windows:
            if w.start_utc < self.evaluated_start_utc or w.end_utc > self.evaluated_end_utc:
                raise ValueError("all windows must lie within the evaluated range")
        return self

    def condition(self, condition: Condition) -> ConditionSummary:
        for c in self.conditions:
            if c.condition is condition:
                return c
        raise KeyError(condition)

    def windows_of(self, kind: WindowKind) -> list[VisibilityWindow]:
        return [w for w in self.windows if w.kind is kind]


class ConstraintAssessment(ContractModel):
    """Phase 3 result: hard-constraint verdicts for one scenario plus the Phase 2 evidence.

    Contains no risk level, score or explanation text (Phases 4-6). ``constraints`` has one entry
    per ``ConstraintId`` (NOT_APPLICABLE when not configured), in ``ConstraintId`` order, and
    ``eligibility`` is derived from them by ``derive_eligibility`` (enforced).
    """

    schema_version: str = SCHEMA_VERSION
    engine_version: NonEmptyStr
    scenario_id: Identifier
    unknown_data_policy: UnknownDataPolicy  # echoed as requested; only report_unknown has an effect
    eligibility: Eligibility
    constraints: list[ConstraintEvaluation]
    environment: EnvironmentAnalysis  # metrics, condition statistics, windows, data quality

    @model_validator(mode="after")
    def _invariants(self) -> Self:
        ids = [c.constraint_id for c in self.constraints]
        if len(ids) != len(set(ids)):
            raise ValueError("each constraint_id may appear at most once")
        derived = derive_eligibility(c.status for c in self.constraints)
        if self.eligibility is not derived:
            raise ValueError(
                f"eligibility {self.eligibility.value!r} contradicts constraint results ({derived.value!r})"
            )
        return self

    def constraint(self, constraint_id: ConstraintId) -> ConstraintEvaluation:
        for c in self.constraints:
            if c.constraint_id is constraint_id:
                return c
        raise KeyError(constraint_id)

    def with_status(self, status: ConstraintStatus) -> list[ConstraintEvaluation]:
        return [c for c in self.constraints if c.status is status]


class ViabilityAssessment(ContractModel):
    """Complete, JSON-serializable result for one scenario."""

    schema_version: str = SCHEMA_VERSION
    engine_version: NonEmptyStr
    scenario_id: Identifier
    site: LandingSite
    evaluated_start_utc: UTCDatetime
    evaluated_end_utc: UTCDatetime
    eligibility: Eligibility
    constraints: list[ConstraintEvaluation]
    metrics: MetricsSummary
    windows: list[VisibilityWindow]
    margins: list[OperationalMargin]
    risks: list[RiskIndicator]
    overall_risk: RiskLevel
    score: ScoreBreakdown
    explanations: list[Explanation]
    data_quality: DataQualitySummary
    limitations: list[NonEmptyStr]

    @model_validator(mode="after")
    def _invariants(self) -> Self:
        if self.evaluated_end_utc <= self.evaluated_start_utc:
            raise ValueError("evaluated_end_utc must be after evaluated_start_utc")
        ids = [c.constraint_id for c in self.constraints]
        if len(ids) != len(set(ids)):
            raise ValueError("each constraint_id may appear at most once")
        derived = derive_eligibility(c.status for c in self.constraints)
        if self.eligibility is not derived:
            raise ValueError(
                f"eligibility {self.eligibility.value!r} contradicts constraint results ({derived.value!r})"
            )
        if self.score.rank_eligible != (self.eligibility is Eligibility.PASS):
            raise ValueError("score.rank_eligible must be True exactly when eligibility is PASS")
        # D4: UNKNOWN eligibility is never scored (score=None), whatever the producer.
        if self.eligibility is Eligibility.UNKNOWN:
            if self.score.score is not None or self.score.score_bounds is not None:
                raise ValueError("an assessment with unknown eligibility must not carry a score (score=None)")
            if self.score.status is not None and self.score.status is not ScoreStatus.ELIGIBILITY_UNKNOWN:
                raise ValueError("unknown eligibility requires score.status 'eligibility_unknown'")
        elif self.score.status is ScoreStatus.ELIGIBILITY_UNKNOWN:
            raise ValueError("score.status 'eligibility_unknown' requires eligibility UNKNOWN")
        for w in self.windows:
            if w.start_utc < self.evaluated_start_utc or w.end_utc > self.evaluated_end_utc:
                raise ValueError("all windows must lie within the evaluated range")
        return self

    @property
    def evaluated_duration_s(self) -> float:
        return (self.evaluated_end_utc - self.evaluated_start_utc).total_seconds()

    @property
    def data_basis(self) -> DataBasis:
        return self.data_quality.data_basis

    def comparability_key(self, policy: ComparabilityPolicy = ComparabilityPolicy.STRICT) -> tuple[object, ...]:
        """Assessments may share one ranking only if their keys are equal (D6, D7; docs §5e).

        Always: data basis, scoring ``method_version`` and exact effective weights. STRICT also
        adds ``configuration_key`` (spacecraft limits and type, panel threshold, every hard
        requirement, mission duration). Raises ``ValueError`` for a legacy score without Phase 5
        metadata, which cannot be ranked.
        """
        s = self.score
        if s.status is None or s.configuration_key is None:
            raise ValueError(f"{self.scenario_id}: score has no Phase 5 metadata (status, configuration_key)")
        key: tuple[object, ...] = (self.data_basis, s.method_version, s.weights_signature())
        if policy is ComparabilityPolicy.STRICT:
            key += (s.configuration_key,)
        return key


_TIER = {Eligibility.PASS: 0, Eligibility.UNKNOWN: 1, Eligibility.FAIL: 2}


class RankedScenario(ContractModel):
    """One ranking entry. Phase 5 (C0) adds ``score_status``, ``score_bounds`` and ``data_basis``
    (all set together); ``score`` then holds exact scores only, as in ``ScoreBreakdown``."""

    rank: int | None = Field(default=None, ge=1, strict=True)  # None unless PASS
    scenario_id: Identifier
    eligibility: Eligibility
    score: Percent | None
    overall_risk: RiskLevel
    # --- Phase 5 (C0, additive) ---
    score_status: ScoreStatus | None = None
    score_bounds: Metric | None = None
    data_basis: DataBasis | None = None

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if self.score_status is None:
            if self.score_bounds is not None or self.data_basis is not None:
                raise ValueError("score_bounds and data_basis require score_status")
            return self
        if self.data_basis is None:
            raise ValueError("data_basis is required when score_status is set")
        _check_score_fields(self.score_status, self.score, self.score_bounds)
        if (self.score_status is ScoreStatus.ELIGIBILITY_UNKNOWN) != (self.eligibility is Eligibility.UNKNOWN):
            raise ValueError("score_status 'eligibility_unknown' is used exactly when eligibility is UNKNOWN")
        return self

    @property
    def lower_bound(self) -> float | None:
        """Exact score or guaranteed lower bound, for ordering (D8); None when not scored."""
        return _score_lower_bound(self.score_status, self.score, self.score_bounds)


class RankingResult(ContractModel):
    """Ordered comparison output (Phase 5) for Members 4 and 5.

    Phase 5 (C0) adds ``data_basis`` and ``policy`` (set together). Then every entry carries Phase 5
    score metadata and that same data basis, so real and synthetic scenarios never share a ranking,
    and PASS entries follow the first two D8 keys: score lower bound descending (unscored last),
    then exact before bounded. The remaining D8 tie-breakers are not visible in the entries.
    """

    method_version: NonEmptyStr
    entries: list[RankedScenario]
    # --- Phase 5 (C0, additive) ---
    data_basis: DataBasis | None = None
    policy: ComparabilityPolicy | None = None

    @model_validator(mode="after")
    def _eligibility_dominates_score(self) -> Self:
        ids = [e.scenario_id for e in self.entries]
        if len(ids) != len(set(ids)):
            raise ValueError("scenario_id must be unique within a ranking")
        tiers = [_TIER[e.eligibility] for e in self.entries]
        if tiers != sorted(tiers):
            raise ValueError("entries must list all PASS, then UNKNOWN, then FAIL scenarios")
        expected_rank = 1
        for e in self.entries:
            if e.eligibility is Eligibility.PASS:
                if e.rank != expected_rank:
                    raise ValueError("PASS entries must have consecutive ranks starting at 1")
                expected_rank += 1
            elif e.rank is not None:
                raise ValueError("only PASS scenarios may be ranked")
        return self

    @model_validator(mode="after")
    def _phase5_consistent(self) -> Self:
        if (self.data_basis is None) != (self.policy is None):
            raise ValueError("data_basis and policy must be set together")
        if self.data_basis is None:
            if any(e.data_basis is not None for e in self.entries):
                raise ValueError("entries with a data_basis need a ranking with data_basis and policy")
            return self
        for e in self.entries:
            if e.score_status is None or e.data_basis is not self.data_basis:
                raise ValueError(
                    "every entry needs score metadata and the ranking's data_basis: "
                    "scenarios with different data bases are never ranked together"
                )
        keys = [
            (0, -lb, 0 if e.score_status is ScoreStatus.KNOWN else 1)
            if (lb := e.lower_bound) is not None
            else (1, 0.0, 0)
            for e in self.entries
            if e.eligibility is Eligibility.PASS
        ]
        if keys != sorted(keys):
            raise ValueError(
                "PASS entries must be ordered by score lower bound (descending, unscored last), "
                "exact scores before bounded ones at an equal bound"
            )
        return self
