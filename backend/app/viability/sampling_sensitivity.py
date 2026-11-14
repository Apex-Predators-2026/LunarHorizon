"""Part 2B: sampling-policy sensitivity of one mission's viability verdict.

Question answered: *would the verdict change if the same scientific samples were interpreted with the other
supported sampling policy?* The canonical result is always the engine default (sample-and-hold, exactly what
``engine.evaluate_scenario`` returns); the nearest-sample result is computed next to it, never instead of it.

How both results are computed
-----------------------------
``evaluate_scenario_under_policy`` calls ``engine.evaluate_scenario(scenario, series, policy=policy)``, the
canonical entry point, whose ``policy`` keyword reaches ``analysis.analyze_scenario`` (its supported parameter)::

    env      = analyze_scenario(scenario, series, policy=policy)     # Phase 2 (the only policy-dependent step)
    checks   = build_constraint_assessment(scenario, env)            # Phase 3
    margins  = margins_from_assessment(checks)                       # Phase 4A
    risks    = assess_risks(scenario, checks, margins)               # Phase 4B
    score    = score_scenario(scenario, env.metrics, margins, ...)   # Phase 5A
    text     = generate_explanations(...)                            # Phase 6A

No constraint, margin, risk, scoring or explanation rule is re-implemented here. With the default policy the
result equals ``evaluate_scenario(scenario, series)`` exactly (tested); there is a single wiring, so the baseline
cannot drift from the canonical result. The scenario (site, landing time, duration, spacecraft, thresholds, preferences), the samples,
the risk policy and the score method are identical for both runs; only ``SamplingPolicy`` differs.

Interpretation (normative)
--------------------------
* Sensitivity is **not** statistical uncertainty, a probability or a confidence interval. Both policies read
  the same samples; they are not independent measurements and cannot validate each other.
* Agreement is **not** evidence that a site is safe: both policies miss events that start and end between
  two samples, and both share every modelling limitation of the engine.
* The report never changes the canonical verdict (no automatic PASS -> UNKNOWN downgrade).
* Coverage is separated from interpretation: a constraint that is UNKNOWN for lack of data under either
  policy makes the comparison INCONCLUSIVE when it decides eligibility (``CoverageAdequacy``), instead of
  being reported as a sampling-method difference.

Verdict rule (``SensitivityVerdict``), first match wins:

1. INCONCLUSIVE: eligibility is UNKNOWN under either policy because a constraint lacks data
   (``incomplete_data`` / ``no_data``). UNKNOWN is not a verdict, so a PASS/UNKNOWN pair is not a "change".
2. CHANGED: eligibility differs.
3. CONSTRAINTS_CHANGED: eligibility is equal, but at least one configured constraint's status differs.
4. UNCHANGED: eligibility and every configured constraint status are equal.

Pure and deterministic: inputs are never modified, and the report serializes identically for identical inputs.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Final, Self

from pydantic import Field, model_validator

from .conventions import ContractModel, Identifier, NonEmptyStr, StrictBool, StrictFloat, UTCDatetime
from .engine import evaluate_scenario
from .enums import (
    ConstraintId,
    ConstraintStatus,
    DataBasis,
    Eligibility,
    MetricStatus,
    RiskLevel,
    SamplingPolicy,
    ScoreStatus,
    Unit,
    UnknownReason,
)
from .inputs import Provenance, ScientificTimeSeries
from .mission import LandingSite, MissionScenario
from .outputs import Metric, MetricsSummary, ViabilityAssessment
from .windows import DEFAULT_SAMPLING_POLICY, PreparedSeries, prepare_series

__all__ = [
    "ALTERNATE_POLICY",
    "BASELINE_POLICY",
    "HELD_CONSTANT",
    "OPPORTUNITY_METRICS",
    "OUTAGE_METRICS",
    "SENSITIVITY_LIMITATIONS",
    "SENSITIVITY_METHOD_VERSION",
    "ConstraintComparison",
    "CoverageAdequacy",
    "CoverageComparison",
    "MetricComparison",
    "PolicyEvaluation",
    "PolicySeriesPair",
    "RiskChange",
    "RiskComparison",
    "SamplingSensitivityReport",
    "ScoreComparison",
    "SensitivityVerdict",
    "compare_policy_assessments",
    "evaluate_scenario_under_policy",
    "prepare_policy_series",
    "sampling_sensitivity_report",
]

SENSITIVITY_METHOD_VERSION: Final = "1.0.0-part2b"
BASELINE_POLICY: Final = DEFAULT_SAMPLING_POLICY  # canonical engine behaviour (sample-and-hold)
ALTERNATE_POLICY: Final = SamplingPolicy.NEAREST_SAMPLE

_POLICY_LABEL: Final = {
    SamplingPolicy.SAMPLE_HOLD: "sample-and-hold",
    SamplingPolicy.NEAREST_SAMPLE: "nearest-sample",
}

HELD_CONSTANT: Final[tuple[str, ...]] = (
    "Landing site (scenario.site).",
    "Landing timestamp (scenario.mission_start_utc).",
    "Mission duration (scenario.mission_end_utc).",
    "Spacecraft configuration, including the solar-power disk-fraction threshold and outage limits.",
    "Operational thresholds (every hard requirement).",
    "Scientific measurements: the same ScientificTimeSeries samples, dataset, provenance and coverage.",
    "Scoring preferences (weights) and the scoring method version.",
    "Risk thresholds (engine default risk policy) and constraint rules.",
)

SENSITIVITY_LIMITATIONS: Final[tuple[str, ...]] = (
    "Sampling sensitivity is not statistical uncertainty: it is not a probability, confidence level or error bar.",
    (
        "Both results interpret the same samples; the two sampling methods are not independent measurements and "
        "cannot validate each other."
    ),
    (
        "Agreement between the two sampling methods is not evidence that the landing site is safe or that the "
        "verdict is correct."
    ),
    "Both methods can miss Sun or Earth events that begin and end entirely between two samples.",
    "The canonical verdict is the sample-and-hold (engine default) result; this report never changes it.",
    (
        "This comparison has not been validated by NASA; it reflects the engine's illumination and line-of-sight "
        "model only."
    ),
)

# MetricsSummary fields grouped for the report (all fields are also compared in ``metrics``).
OUTAGE_METRICS: Final[tuple[str, ...]] = (
    "longest_continuous_darkness",  # longest power-dark period (threshold-qualified)
    "longest_without_direct_sunlight",
    "longest_communication_blackout",
)
OPPORTUNITY_METRICS: Final[tuple[str, ...]] = (
    "initial_sunlight_duration",  # continuous power-lit time from landing
    "initial_earth_visibility_duration",
    "time_to_first_sunset",
    "time_to_first_earthset",
)

_DATA_REASONS: Final = frozenset({UnknownReason.INCOMPLETE_DATA, UnknownReason.NO_DATA})


class SensitivityVerdict(StrEnum):
    """Outcome of comparing the two sampling policies (rule: module docstring)."""

    UNCHANGED = "unchanged"  # same eligibility and same status for every configured constraint
    CONSTRAINTS_CHANGED = "constraints_changed"  # same eligibility, some constraint status differs
    CHANGED = "changed"  # eligibility differs
    INCONCLUSIVE = "inconclusive"  # eligibility UNKNOWN for lack of data under at least one policy


class CoverageAdequacy(StrEnum):
    """Whether the data support a meaningful comparison (independent of how the policies differ)."""

    COMPLETE = "complete"  # no unknown Sun or Earth time under either policy
    DECISIVE = "decisive"  # some unknown time, but every evaluable configured constraint is decided under both
    INSUFFICIENT = "insufficient"  # a check lacks data under a policy, or Sun or Earth is unknown all mission


# --- report models ------------------------------------------------------------------------------------------


class MetricComparison(ContractModel):
    """One quantity under both policies. ``delta`` = alternate - baseline, only when both are KNOWN."""

    name: NonEmptyStr  # MetricsSummary field or margin id
    unit: Unit
    reference: StrictFloat | None = None  # threshold the quantity is compared with (margins / constraints)
    baseline: Metric
    alternate: Metric
    changed: StrictBool  # status, value or bounds differ
    status_changed: StrictBool
    became_known: StrictBool  # baseline not KNOWN, alternate KNOWN
    became_uncertain: StrictBool  # baseline KNOWN, alternate not KNOWN
    delta: StrictFloat | None

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if self.baseline.unit is not self.unit or self.alternate.unit is not self.unit:
            raise ValueError("both metrics must use the comparison's unit")
        if (self.delta is not None) != (
            self.baseline.status is MetricStatus.KNOWN and self.alternate.status is MetricStatus.KNOWN
        ):
            raise ValueError("delta is set exactly when both metrics are known")
        return self


class ConstraintComparison(ContractModel):
    """One configured hard constraint under both policies (threshold and rule are identical)."""

    constraint_id: ConstraintId
    name: NonEmptyStr | None
    threshold: StrictFloat
    baseline_status: ConstraintStatus
    alternate_status: ConstraintStatus
    baseline_unknown_reason: UnknownReason | None
    alternate_unknown_reason: UnknownReason | None
    measured: MetricComparison
    status_changed: StrictBool

    @property
    def data_limited(self) -> bool:
        """UNKNOWN for missing data (not for an unsupported requirement) under either policy."""
        return self.baseline_unknown_reason in _DATA_REASONS or self.alternate_unknown_reason in _DATA_REASONS


class ScoreComparison(ContractModel):
    baseline_status: ScoreStatus | None
    alternate_status: ScoreStatus | None
    baseline_score: StrictFloat | None  # exact scores only
    alternate_score: StrictFloat | None
    baseline_bounds: Metric | None
    alternate_bounds: Metric | None
    changed: StrictBool
    delta: StrictFloat | None  # alternate - baseline, both exact only


class RiskChange(ContractModel):
    """A risk indicator whose level differs, or which is raised under only one policy (level None)."""

    code: Identifier
    baseline_level: RiskLevel | None
    alternate_level: RiskLevel | None


class RiskComparison(ContractModel):
    baseline_overall: RiskLevel
    alternate_overall: RiskLevel
    overall_changed: StrictBool
    changed_indicators: list[RiskChange] = Field(default_factory=list)


class CoverageComparison(ContractModel):
    adequacy: CoverageAdequacy
    evaluated_duration_s: StrictFloat
    baseline_sun_coverage_percent: StrictFloat
    alternate_sun_coverage_percent: StrictFloat
    baseline_earth_coverage_percent: StrictFloat
    alternate_earth_coverage_percent: StrictFloat
    baseline_uncovered_duration_s: StrictFloat
    alternate_uncovered_duration_s: StrictFloat
    baseline_sample_count: int = Field(ge=0, strict=True)
    alternate_sample_count: int = Field(ge=0, strict=True)
    largest_sample_gap_s: StrictFloat | None  # spacing of the samples; identical under both policies
    data_limited_constraints: list[ConstraintId] = Field(default_factory=list)
    unsupported_constraints: list[ConstraintId] = Field(default_factory=list)
    notes: list[NonEmptyStr] = Field(default_factory=list)


class PolicyEvaluation(ContractModel):
    """The complete canonical pipeline result under one sampling policy."""

    policy: SamplingPolicy
    engine_default: StrictBool
    assumptions: list[NonEmptyStr]  # the sampling rule in words (from data_quality.assumptions)
    assessment: ViabilityAssessment

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if self.assessment.data_quality.sampling_policy is not self.policy:
            raise ValueError("assessment was produced with a different sampling policy")
        if self.engine_default != (self.policy is DEFAULT_SAMPLING_POLICY):
            raise ValueError("engine_default must be True exactly for the engine's default policy")
        return self


class SamplingSensitivityReport(ContractModel):
    """Sampling-policy sensitivity of one scenario's viability verdict (see the module docstring)."""

    method_version: NonEmptyStr
    engine_version: NonEmptyStr
    scenario_id: Identifier
    site: LandingSite
    evaluated_start_utc: UTCDatetime
    evaluated_end_utc: UTCDatetime
    dataset_id: Identifier
    provenance: Provenance
    data_basis: DataBasis
    held_constant: list[NonEmptyStr]
    baseline: PolicyEvaluation  # canonical (engine default) result
    alternate: PolicyEvaluation
    verdict: SensitivityVerdict
    summary: NonEmptyStr
    eligibility_changed: StrictBool
    constraints: list[ConstraintComparison]  # configured constraints only, in ConstraintId order
    changed_constraints: list[ConstraintId]
    outages: list[MetricComparison]  # OUTAGE_METRICS
    opportunities: list[MetricComparison]  # OPPORTUNITY_METRICS
    metrics: list[MetricComparison]  # every MetricsSummary field, in field order
    margins: list[MetricComparison]
    score: ScoreComparison
    risk: RiskComparison
    coverage: CoverageComparison
    statements: list[NonEmptyStr]
    limitations: list[NonEmptyStr]

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if self.baseline.policy is not BASELINE_POLICY or self.alternate.policy is not ALTERNATE_POLICY:
            raise ValueError("baseline must be the engine default policy and alternate the nearest-sample policy")
        eb, ea = self.baseline.assessment.eligibility, self.alternate.assessment.eligibility
        if self.eligibility_changed != (eb is not ea):
            raise ValueError("eligibility_changed contradicts the two assessments")
        if [c.constraint_id for c in self.constraints if c.status_changed] != self.changed_constraints:
            raise ValueError("changed_constraints must list exactly the constraints whose status changed")
        if self.verdict is not _verdict(eb, ea, self.constraints):
            raise ValueError("verdict contradicts the verdict rule")
        return self


# --- pipeline -------------------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PolicySeriesPair:
    """One scientific series prepared under both compared policies (prepare once, evaluate many missions)."""

    baseline: PreparedSeries
    alternate: PreparedSeries

    def __post_init__(self) -> None:
        if self.baseline.policy is not BASELINE_POLICY or self.alternate.policy is not ALTERNATE_POLICY:
            raise ValueError("PolicySeriesPair needs a sample-and-hold baseline and a nearest-sample alternate")
        if self.baseline.series is not self.alternate.series and self.baseline.series != self.alternate.series:
            raise ValueError("both prepared series must hold the same scientific measurements")

    @property
    def series(self) -> ScientificTimeSeries:
        return self.baseline.series


def prepare_policy_series(series: ScientificTimeSeries) -> PolicySeriesPair:
    return PolicySeriesPair(prepare_series(series, BASELINE_POLICY), prepare_series(series, ALTERNATE_POLICY))


def evaluate_scenario_under_policy(
    scenario: MissionScenario,
    series: ScientificTimeSeries | PreparedSeries,
    policy: SamplingPolicy,
) -> ViabilityAssessment:
    """``engine.evaluate_scenario(scenario, series, policy=policy)``: the canonical pipeline, nothing mirrored.

    A ``PreparedSeries`` must have been prepared with ``policy`` (``ValueError`` otherwise). With the default
    policy the result equals ``evaluate_scenario(scenario, series)`` exactly.
    """
    return evaluate_scenario(scenario, series, policy=policy)


def sampling_sensitivity_report(
    scenario: MissionScenario,
    source: ScientificTimeSeries | PolicySeriesPair,
) -> SamplingSensitivityReport:
    """Evaluate ``scenario`` under both sampling policies and compare the results.

    ``source`` is the scientific series, or a ``PolicySeriesPair`` prepared from it (faster for many missions).
    Raises ``ValueError`` if the series is for another site.
    """
    pair = source if isinstance(source, PolicySeriesPair) else prepare_policy_series(source)
    baseline = evaluate_scenario_under_policy(scenario, pair.baseline, BASELINE_POLICY)
    alternate = evaluate_scenario_under_policy(scenario, pair.alternate, ALTERNATE_POLICY)
    return compare_policy_assessments(baseline, alternate)


# --- comparison -----------------------------------------------------------------------------------------------


def _interval(m: Metric) -> tuple[float | None, float | None]:
    if m.status is MetricStatus.KNOWN:
        return m.value, m.value
    return m.lower, m.upper


def _compare_metric(name: str, baseline: Metric, alternate: Metric, reference: float | None = None) -> MetricComparison:
    b_known, a_known = baseline.status is MetricStatus.KNOWN, alternate.status is MetricStatus.KNOWN
    delta: float | None = None
    if b_known and a_known:
        assert baseline.value is not None and alternate.value is not None
        delta = alternate.value - baseline.value
    return MetricComparison(
        name=name,
        unit=baseline.unit,
        reference=reference,
        baseline=baseline,
        alternate=alternate,
        changed=(baseline.status, _interval(baseline)) != (alternate.status, _interval(alternate)),
        status_changed=baseline.status is not alternate.status,
        became_known=a_known and not b_known,
        became_uncertain=b_known and not a_known,
        delta=delta,
    )


def _check_held_constant(b: ViabilityAssessment, a: ViabilityAssessment) -> None:
    """Everything except the sampling interpretation must be identical (else the inputs are not comparable)."""
    for what, x, y in (
        ("scenario_id", b.scenario_id, a.scenario_id),
        ("site", b.site, a.site),
        ("evaluated range", (b.evaluated_start_utc, b.evaluated_end_utc), (a.evaluated_start_utc, a.evaluated_end_utc)),
        ("dataset_id", b.data_quality.dataset_id, a.data_quality.dataset_id),
        ("provenance", b.data_quality.provenance, a.data_quality.provenance),
        ("calculation basis", b.data_quality.calculation_basis, a.data_quality.calculation_basis),
        ("score method", b.score.method_version, a.score.method_version),
        ("configuration", b.score.configuration_key, a.score.configuration_key),
        ("score weights", b.score.weights_signature(), a.score.weights_signature()),
        (
            "constraint thresholds",
            [(c.constraint_id, c.status is ConstraintStatus.NOT_APPLICABLE, c.threshold) for c in b.constraints],
            [(c.constraint_id, c.status is ConstraintStatus.NOT_APPLICABLE, c.threshold) for c in a.constraints],
        ),
    ):
        if x != y:
            raise ValueError(f"assessments are not comparable: {what} differs (only the sampling policy may differ)")


def _verdict(
    baseline: Eligibility, alternate: Eligibility, constraints: Sequence[ConstraintComparison]
) -> SensitivityVerdict:
    def data_unknown(eligibility: Eligibility, reasons: Sequence[UnknownReason | None]) -> bool:
        return eligibility is Eligibility.UNKNOWN and any(r in _DATA_REASONS for r in reasons)

    if data_unknown(baseline, [c.baseline_unknown_reason for c in constraints]) or data_unknown(
        alternate, [c.alternate_unknown_reason for c in constraints]
    ):
        return SensitivityVerdict.INCONCLUSIVE
    if baseline is not alternate:
        return SensitivityVerdict.CHANGED
    if any(c.status_changed for c in constraints):
        return SensitivityVerdict.CONSTRAINTS_CHANGED
    return SensitivityVerdict.UNCHANGED


def _compare_constraints(b: ViabilityAssessment, a: ViabilityAssessment) -> list[ConstraintComparison]:
    alt = {c.constraint_id: c for c in a.constraints}
    out: list[ConstraintComparison] = []
    for cb in b.constraints:
        if cb.status is ConstraintStatus.NOT_APPLICABLE:
            continue
        ca = alt[cb.constraint_id]
        assert cb.threshold is not None
        out.append(
            ConstraintComparison(
                constraint_id=cb.constraint_id,
                name=cb.name,
                threshold=cb.threshold,
                baseline_status=cb.status,
                alternate_status=ca.status,
                baseline_unknown_reason=cb.unknown_reason,
                alternate_unknown_reason=ca.unknown_reason,
                measured=_compare_metric(
                    cb.metric_field or cb.constraint_id.value, cb.measured, ca.measured, cb.threshold
                ),
                status_changed=cb.status is not ca.status,
            )
        )
    return out


def _compare_score(b: ViabilityAssessment, a: ViabilityAssessment) -> ScoreComparison:
    sb, sa = b.score, a.score
    delta = sa.score - sb.score if sb.score is not None and sa.score is not None else None
    bounds_b = None if sb.score_bounds is None else _interval(sb.score_bounds)
    bounds_a = None if sa.score_bounds is None else _interval(sa.score_bounds)
    return ScoreComparison(
        baseline_status=sb.status,
        alternate_status=sa.status,
        baseline_score=sb.score,
        alternate_score=sa.score,
        baseline_bounds=sb.score_bounds,
        alternate_bounds=sa.score_bounds,
        changed=(sb.status, sb.score, bounds_b) != (sa.status, sa.score, bounds_a),
        delta=delta,
    )


def _compare_risk(b: ViabilityAssessment, a: ViabilityAssessment) -> RiskComparison:
    lb = {r.code: r.level for r in b.risks}
    la = {r.code: r.level for r in a.risks}
    codes = [r.code for r in b.risks] + [r.code for r in a.risks if r.code not in lb]
    changes = [
        RiskChange(code=c, baseline_level=lb.get(c), alternate_level=la.get(c)) for c in codes if lb.get(c) != la.get(c)
    ]
    return RiskComparison(
        baseline_overall=b.overall_risk,
        alternate_overall=a.overall_risk,
        overall_changed=b.overall_risk is not a.overall_risk,
        changed_indicators=changes,
    )


def _compare_coverage(
    b: ViabilityAssessment, a: ViabilityAssessment, constraints: Sequence[ConstraintComparison]
) -> CoverageComparison:
    qb, qa = b.data_quality, a.data_quality
    data_limited = [c.constraint_id for c in constraints if c.data_limited]
    unsupported = [
        c.constraint_id
        for c in constraints
        if UnknownReason.UNSUPPORTED in (c.baseline_unknown_reason, c.alternate_unknown_reason)
    ]
    unknown_any = any(
        x > 0.0
        for x in (
            qb.sun_unknown_duration_s,
            qb.earth_unknown_duration_s,
            qa.sun_unknown_duration_s,
            qa.earth_unknown_duration_s,
        )
    )
    nothing_known = (
        min(qb.sun_coverage_percent, qb.earth_coverage_percent, qa.sun_coverage_percent, qa.earth_coverage_percent)
        == 0.0
    )
    if data_limited or nothing_known:
        adequacy = CoverageAdequacy.INSUFFICIENT
    elif unknown_any:
        adequacy = CoverageAdequacy.DECISIVE
    else:
        adequacy = CoverageAdequacy.COMPLETE
    notes: list[str] = []
    if qb.uncovered_duration_s != qa.uncovered_duration_s:
        notes.append(
            f"Time no sample represents differs between the policies ({_hours(qb.uncovered_duration_s)} under "
            f"{_POLICY_LABEL[BASELINE_POLICY]}, {_hours(qa.uncovered_duration_s)} under {_POLICY_LABEL[ALTERNATE_POLICY]}): "
            "the policies extend samples differently next to coverage bounds and gaps."
        )
    elif qb.uncovered_duration_s > 0.0:
        notes.append(
            f"{_hours(qb.uncovered_duration_s)} of the mission is covered by no sample under either policy "
            "(it may sit at different times under each policy)."
        )
    if data_limited:
        notes.append(
            "Undecidable for lack of data under at least one policy: "
            + ", ".join(c.value for c in data_limited)
            + ". This is a coverage limitation, not a sampling-method difference."
        )
    if unsupported:
        notes.append(
            "Configured but not evaluable by this engine version under either policy: "
            + ", ".join(c.value for c in unsupported)
            + "."
        )
    if nothing_known:
        notes.append("The Sun or Earth state is unknown for the entire mission under at least one policy.")
    return CoverageComparison(
        adequacy=adequacy,
        evaluated_duration_s=qb.evaluated_duration_s,
        baseline_sun_coverage_percent=qb.sun_coverage_percent,
        alternate_sun_coverage_percent=qa.sun_coverage_percent,
        baseline_earth_coverage_percent=qb.earth_coverage_percent,
        alternate_earth_coverage_percent=qa.earth_coverage_percent,
        baseline_uncovered_duration_s=qb.uncovered_duration_s,
        alternate_uncovered_duration_s=qa.uncovered_duration_s,
        baseline_sample_count=qb.sample_count,
        alternate_sample_count=qa.sample_count,
        largest_sample_gap_s=qb.largest_sample_gap_s,
        data_limited_constraints=data_limited,
        unsupported_constraints=unsupported,
        notes=notes,
    )


# --- wording --------------------------------------------------------------------------------------------------


def _num(x: float, digits: int) -> str:
    text = f"{x:.{digits}f}".rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


def _hours(seconds: float) -> str:
    return f"{_num(seconds / 3600.0, 3)} h"


def _value(x: float, unit: Unit) -> str:
    if unit is Unit.SECONDS:
        return _hours(x)
    if unit is Unit.PERCENT:
        return f"{_num(x, 3)} %"
    if unit is Unit.DEGREES:
        return f"{_num(x, 3)} deg"
    return _num(x, 4)


def _metric_text(m: Metric) -> str:
    if m.status is MetricStatus.KNOWN:
        assert m.value is not None
        return _value(m.value, m.unit)
    if m.status is MetricStatus.BOUNDED:
        assert m.lower is not None and m.upper is not None
        return f"between {_value(m.lower, m.unit)} and {_value(m.upper, m.unit)}"
    return "unavailable" if m.status is MetricStatus.UNAVAILABLE else "not applicable"


def _pair(c: MetricComparison) -> str:
    b, a = _POLICY_LABEL[BASELINE_POLICY], _POLICY_LABEL[ALTERNATE_POLICY]
    if not c.changed:
        return f"{_metric_text(c.baseline)} under both methods"
    text = f"{_metric_text(c.baseline)} ({b}) vs {_metric_text(c.alternate)} ({a})"
    if c.delta is not None:
        text += f", a difference of {'+' if c.delta > 0 else ''}{_value(c.delta, c.unit)}"
    return text


def _spacing(dq_gap: float | None) -> str:
    if dq_gap is None:
        return "sampled"
    if math.isclose(dq_gap, 3600.0):
        return "hourly"
    return f"sampled (spacing up to {_hours(dq_gap)})"


def _summary(
    verdict: SensitivityVerdict,
    eb: Eligibility,
    ea: Eligibility,
    constraints: Sequence[ConstraintComparison],
    spacing: str,
) -> str:
    b, a = _POLICY_LABEL[BASELINE_POLICY], _POLICY_LABEL[ALTERNATE_POLICY]
    if verdict is SensitivityVerdict.INCONCLUSIVE:
        where = (
            f"{eb.value.upper()} under both methods"
            if eb is ea
            else f"{eb.value.upper()} under {b} and {ea.value.upper()} under {a}"
        )
        return (
            f"Comparison is inconclusive because too much information is missing: eligibility is {where}, "
            "and the undecided checks lack data."
        )
    if verdict is SensitivityVerdict.CHANGED:
        return (
            f"Verdict changes depending on how the {spacing} measurements are interpreted: {eb.value.upper()} "
            f"under {b} (engine default) but {ea.value.upper()} under {a}."
        )
    if verdict is SensitivityVerdict.CONSTRAINTS_CHANGED:
        n = sum(c.status_changed for c in constraints)
        return (
            f"Verdict unchanged ({eb.value.upper()} under both tested sampling methods), but the status of {n} "
            f"constraint{'s' if n != 1 else ''} depends on how the {spacing} measurements are interpreted."
        )
    return (
        f"Verdict unchanged under the two tested sampling methods: {eb.value.upper()} under both, with the same "
        "status for every configured constraint."
    )


def _statements(
    *,
    verdict: SensitivityVerdict,
    constraints: Sequence[ConstraintComparison],
    outages: Sequence[MetricComparison],
    opportunities: Sequence[MetricComparison],
    metrics: Sequence[MetricComparison],
    score: ScoreComparison,
    risk: RiskComparison,
    coverage: CoverageComparison,
) -> list[str]:
    b, a = _POLICY_LABEL[BASELINE_POLICY], _POLICY_LABEL[ALTERNATE_POLICY]
    out: list[str] = []
    for c in constraints:
        if c.status_changed:
            out.append(
                f"{c.name or c.constraint_id.value}: {c.baseline_status.value.upper()} under {b}, "
                f"{c.alternate_status.value.upper()} under {a} (threshold {_value(c.threshold, c.measured.unit)}; "
                f"measured {_pair(c.measured)})."
            )
    labels = {
        "longest_continuous_darkness": "Longest power-dark period",
        "longest_without_direct_sunlight": "Longest period without direct sunlight",
        "longest_communication_blackout": "Longest communication blackout",
        "initial_sunlight_duration": "Initial power-lit period after landing",
        "initial_earth_visibility_duration": "Initial Earth visibility after landing",
        "time_to_first_sunset": "Time to first power-lit to dark transition",
        "time_to_first_earthset": "Time to first Earthset",
    }
    for m in (*outages, *opportunities):
        out.append(f"{labels[m.name]}: {_pair(m)}.")
    for m in metrics:
        if m.became_known:
            out.append(f"{m.name} is known under {a} but not under {b}.")
        elif m.became_uncertain:
            out.append(f"{m.name} is known under {b} but not under {a}.")
    if score.changed:
        sb = _score_text(score.baseline_status, score.baseline_score, score.baseline_bounds)
        sa = _score_text(score.alternate_status, score.alternate_score, score.alternate_bounds)
        out.append(f"Desirability score: {sb} ({b}) vs {sa} ({a}).")
    else:
        out.append(
            f"Desirability score: {_score_text(score.baseline_status, score.baseline_score, score.baseline_bounds)} "
            "under both methods."
        )
    if risk.overall_changed:
        out.append(
            f"Overall screening risk: {risk.baseline_overall.value} ({b}) vs {risk.alternate_overall.value} ({a})."
        )
    else:
        out.append(f"Overall screening risk: {risk.baseline_overall.value} under both methods.")
    if coverage.adequacy is CoverageAdequacy.COMPLETE:
        out.append("Coverage: every Sun and Earth state in the mission is known under both methods.")
    elif coverage.adequacy is CoverageAdequacy.DECISIVE:
        out.append("Coverage: some states are unknown, but every configured check is still decided under both methods.")
    else:
        out.append("Coverage is insufficient for a complete comparison under at least one method.")
    out.extend(coverage.notes)
    if verdict in (SensitivityVerdict.UNCHANGED, SensitivityVerdict.CONSTRAINTS_CHANGED):
        out.append(
            "Agreement between the two sampling methods is not evidence that the site is safe: both read the same "
            "samples and can miss events shorter than the sample spacing."
        )
    return out


def _score_text(status: ScoreStatus | None, score: float | None, bounds: Metric | None) -> str:
    if status is ScoreStatus.KNOWN and score is not None:
        return f"{_num(score, 3)}/100"
    if status is ScoreStatus.BOUNDED and bounds is not None and bounds.lower is not None and bounds.upper is not None:
        return f"between {_num(bounds.lower, 3)} and {_num(bounds.upper, 3)}/100"
    if status is ScoreStatus.ELIGIBILITY_UNKNOWN:
        return "not scored (eligibility unknown)"
    if status is ScoreStatus.NO_SCORABLE_COMPONENTS:
        return "not scored (no scorable component)"
    return "not scored"


# --- entry point for two finished assessments -----------------------------------------------------------------


def compare_policy_assessments(
    baseline: ViabilityAssessment, alternate: ViabilityAssessment
) -> SamplingSensitivityReport:
    """Report for two assessments of the same scenario and series under the two compared policies.

    ``baseline`` must use the engine default (sample-and-hold) and ``alternate`` nearest-sample; everything
    else (scenario, configuration, data) must be identical (``ValueError`` otherwise). Inputs are not modified.
    """
    if baseline.data_quality.sampling_policy is not BASELINE_POLICY:
        raise ValueError(f"baseline must use {BASELINE_POLICY.value!r}")
    if alternate.data_quality.sampling_policy is not ALTERNATE_POLICY:
        raise ValueError(f"alternate must use {ALTERNATE_POLICY.value!r}")
    _check_held_constant(baseline, alternate)

    constraints = _compare_constraints(baseline, alternate)
    names = list(MetricsSummary.model_fields)
    metrics = [_compare_metric(n, getattr(baseline.metrics, n), getattr(alternate.metrics, n)) for n in names]
    by_name = {m.name: m for m in metrics}
    outages = [by_name[n] for n in OUTAGE_METRICS]
    opportunities = [by_name[n] for n in OPPORTUNITY_METRICS]
    alt_margins = {m.margin_id: m for m in alternate.margins}
    margins = [
        _compare_metric(m.margin_id, m.value, alt_margins[m.margin_id].value, m.reference)
        for m in baseline.margins
        if m.value.status is not MetricStatus.NOT_APPLICABLE
    ]
    score = _compare_score(baseline, alternate)
    risk = _compare_risk(baseline, alternate)
    coverage = _compare_coverage(baseline, alternate, constraints)
    eb, ea = baseline.eligibility, alternate.eligibility
    verdict = _verdict(eb, ea, constraints)
    spacing = _spacing(baseline.data_quality.largest_sample_gap_s)
    dq = baseline.data_quality

    def evaluation(a: ViabilityAssessment) -> PolicyEvaluation:
        p = a.data_quality.sampling_policy
        return PolicyEvaluation(
            policy=p,
            engine_default=p is DEFAULT_SAMPLING_POLICY,
            assumptions=list(a.data_quality.assumptions),
            assessment=a,
        )

    return SamplingSensitivityReport(
        method_version=SENSITIVITY_METHOD_VERSION,
        engine_version=baseline.engine_version,
        scenario_id=baseline.scenario_id,
        site=baseline.site,
        evaluated_start_utc=baseline.evaluated_start_utc,
        evaluated_end_utc=baseline.evaluated_end_utc,
        dataset_id=dq.dataset_id,
        provenance=dq.provenance,
        data_basis=dq.data_basis,
        held_constant=list(HELD_CONSTANT),
        baseline=evaluation(baseline),
        alternate=evaluation(alternate),
        verdict=verdict,
        summary=_summary(verdict, eb, ea, constraints, spacing),
        eligibility_changed=eb is not ea,
        constraints=constraints,
        changed_constraints=[c.constraint_id for c in constraints if c.status_changed],
        outages=outages,
        opportunities=opportunities,
        metrics=metrics,
        margins=margins,
        score=score,
        risk=risk,
        coverage=coverage,
        statements=_statements(
            verdict=verdict,
            constraints=constraints,
            outages=outages,
            opportunities=opportunities,
            metrics=metrics,
            score=score,
            risk=risk,
            coverage=coverage,
        ),
        limitations=(
            ["[SYNTHETIC DATA] Not NASA-derived; not valid for mission decisions."]
            if dq.provenance.is_synthetic
            else []
        )
        + list(SENSITIVITY_LIMITATIONS),
    )
