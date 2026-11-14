"""Viability output contract (viability engine -> Members 3, 4, 5, 6). Status: draft.

Design rules enforced here, not just documented:

* Eligibility (PASS/FAIL/UNKNOWN) is derived only from hard-constraint results:
  any FAIL -> FAIL, else any UNKNOWN -> UNKNOWN, else PASS.
* Desirability score and risk level are separate fields and cannot change eligibility.
  Only PASS scenarios are rank-eligible, and rankings list every PASS scenario before any
  UNKNOWN, and every UNKNOWN before any FAIL.
* Unavailable values are explicit (``Metric.status``), never zero. When data is partly
  unknown, a metric may be BOUNDED: the true value lies in [lower, upper].
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Self

from pydantic import Field, model_validator

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
    Condition,
    ConditionState,
    ConstraintId,
    ConstraintStatus,
    Eligibility,
    ExplanationCategory,
    MetricStatus,
    RiskLevel,
    SamplingPolicy,
    ScoreComponent,
    Severity,
    Unit,
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
    constraint_id: ConstraintId
    status: ConstraintStatus
    threshold: StrictFloat | None  # None only when NOT_APPLICABLE
    unit: Unit
    measured: Metric
    message: NonEmptyStr

    @model_validator(mode="after")
    def _threshold_matches_status(self) -> Self:
        if (self.status is ConstraintStatus.NOT_APPLICABLE) != (self.threshold is None):
            raise ValueError("threshold must be None exactly when status is not_applicable")
        if self.measured.unit is not self.unit:
            raise ValueError("measured.unit must match constraint unit")
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


class ScoreComponentResult(ContractModel):
    component: ScoreComponent
    weight: Fraction  # normalised so weights sum to 1
    normalized_value: Fraction | None  # None = could not be scored
    contribution: NonNegativeFloat | None  # weight * normalized_value * 100
    note: str | None = None


class ScoreBreakdown(ContractModel):
    method_version: NonEmptyStr
    score: Percent | None  # 0..100 desirability; None = not scored
    rank_eligible: StrictBool  # True iff eligibility is PASS
    components: list[ScoreComponentResult] = Field(default_factory=list)
    note: str | None = None


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
        for w in self.windows:
            if w.start_utc < self.evaluated_start_utc or w.end_utc > self.evaluated_end_utc:
                raise ValueError("all windows must lie within the evaluated range")
        return self

    @property
    def evaluated_duration_s(self) -> float:
        return (self.evaluated_end_utc - self.evaluated_start_utc).total_seconds()


_TIER = {Eligibility.PASS: 0, Eligibility.UNKNOWN: 1, Eligibility.FAIL: 2}


class RankedScenario(ContractModel):
    rank: int | None = Field(default=None, ge=1, strict=True)  # None unless PASS
    scenario_id: Identifier
    eligibility: Eligibility
    score: Percent | None
    overall_risk: RiskLevel


class RankingResult(ContractModel):
    """Ordered comparison output (Phase 5) for Members 4 and 5."""

    method_version: NonEmptyStr
    entries: list[RankedScenario]

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
