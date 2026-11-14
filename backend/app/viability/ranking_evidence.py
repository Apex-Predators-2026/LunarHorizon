"""Pairwise ranking evidence: why one scenario ranks above another, and how decisive that is (Part 2A).

This module only *reads* finished ``ViabilityAssessment`` objects (and optionally the ``RankingResult``
built from them). It never computes a desirability score, never changes eligibility, weights or the
ranking policy, and never fills a missing measurement. Everything it reports comes from:

* the ranking's own sort key (``ranking.ranking_order_key``) and criterion names
  (``ranking.ORDER_KEY_CRITERIA``), so the "deciding criterion" is by construction the one that
  decided the actual order;
* the ranking's own comparability rule (``ranking.comparability_issues``);
* the authoritative ``ScoreBreakdown``: ``score``, ``score_bounds``, and per component ``weight``,
  ``normalized`` and ``contribution``;
* constraints, risk indicators, data quality and provenance, quoted as they are.

Score difference. For score intervals A = [aL, aU] and B = [bL, bU] (an exact score is the interval
[s, s]), the difference A - B lies in [aL - bU, aU - bL]. It is computed exactly on the stored decimal
values (rational arithmetic; scores live on the scorer's 6-decimal grid) and rounded OUTWARD to 6
decimals (lower bound down, upper bound up; a float that would land inside the exact interval is moved
one ulp outward), so the reported interval always contains the exact one. Interpretation:

* lower bound > 0: A's score is strictly higher everywhere within the recorded bounds;
* upper bound < 0: B's score is strictly higher;
* otherwise the interval contains 0 and the represented uncertainty does NOT establish which score is
  higher. Overlap is not evidence that the two scenarios are equally good.

No difference is reported when a score is missing (``score = None`` is never 0) or when the two
assessments are not comparable (different data basis, scoring method, weights, or under STRICT
different requirements or duration): such scores do not measure the same thing.

Component contributions are ``100 * weight * normalized value`` as defined by
``ScoreComponentResult`` (the exact ``contribution`` field when the component is known; the same
definition at both interval ends when it is only bounded). They are listed per component, never summed
into a new score.

The desirability score is a relative index under the stated weights. It is not a probability of mission
success, and ranking order is not proof of physical superiority; the explanation says so.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from enum import StrEnum
from fractions import Fraction as Rational
from typing import Annotated, Final, Self

from pydantic import Field, StringConstraints, model_validator

from .conventions import ContractModel, Identifier, NonEmptyStr, Percent, StrictBool, StrictFloat
from .enums import (
    ComparabilityPolicy,
    ConstraintId,
    ConstraintStatus,
    DataBasis,
    Eligibility,
    MetricStatus,
    RiskLevel,
    ScoreComponent,
    ScoreComponentStatus,
    ScoreStatus,
)
from .outputs import Metric, RankingResult, ScoreComponentResult, ViabilityAssessment
from .ranking import (
    ORDER_KEY_CRITERIA,
    RankingCriterion,
    comparability_issues,
    rank_assessments,
    ranking_order_key,
)

__all__ = [
    "EVIDENCE_METHOD_VERSION",
    "SYNTHETIC_PREFIX",
    "Advantage",
    "ComponentEvidence",
    "DifferenceStatus",
    "PairwiseEvidence",
    "PointsInterval",
    "RankingCriterion",
    "ScenarioEvidence",
    "ScoreDifference",
    "compare_scenarios",
    "explain_adjacent",
    "score_difference",
    "score_text",
]

# Bump when the evidence fields, criterion naming or the wording rules change.
EVIDENCE_METHOD_VERSION: Final = "ranking-evidence-v1"
SYNTHETIC_PREFIX: Final = "[SYNTHETIC DATA] "  # same label as scoring / risk / explain

_DECIMALS: Final = 6  # the score grid used by scoring.py
_GRID: Final = 10**_DECIMALS

_LABEL: Final[dict[ScoreComponent, str]] = {
    ScoreComponent.SUNLIGHT: "sunlight (mean visible solar-disk fraction)",
    ScoreComponent.EARTH_VISIBILITY: "Earth visibility",
    ScoreComponent.SIMULTANEOUS: "simultaneous sunlight and Earth visibility",
    ScoreComponent.DARKNESS_MARGIN: "darkness headroom",
    ScoreComponent.BLACKOUT_MARGIN: "communication-blackout headroom",
    ScoreComponent.CLEARANCE_MARGIN: "clearance margin",
}
# "X benefits from <phrase>" / "Y has <phrase>"
_ADVANTAGE_PHRASE: Final[dict[ScoreComponent, str]] = {
    ScoreComponent.SUNLIGHT: "more sunlight (a higher mean visible solar-disk fraction)",
    ScoreComponent.EARTH_VISIBILITY: "stronger Earth visibility",
    ScoreComponent.SIMULTANEOUS: "more simultaneous sunlight and Earth visibility",
    ScoreComponent.DARKNESS_MARGIN: "greater darkness headroom",
    ScoreComponent.BLACKOUT_MARGIN: "greater communication-blackout headroom",
    ScoreComponent.CLEARANCE_MARGIN: "a larger clearance margin",
}
_DISCLAIMER: Final = (
    "The score is a relative desirability index under the stated weights, not a probability of mission "
    "success, and the ranking order is not proof of physical superiority."
)

# Evidence sentences can exceed NonEmptyStr's 500-character cap (they quote scores and constraint ids).
Text = Annotated[str, StringConstraints(min_length=1)]


# --- result models -----------------------------------------------------------------------------------


class PointsInterval(ContractModel):
    """Closed interval in score points, rounded outward to 6 decimals (it contains the exact interval).

    Used for score differences (may be negative) and for component contributions.
    """

    lower: StrictFloat
    upper: StrictFloat

    @model_validator(mode="after")
    def _ordered(self) -> Self:
        if not self.lower <= self.upper:
            raise ValueError("lower must not exceed upper")
        return self

    @property
    def contains_zero(self) -> bool:
        return self.lower <= 0.0 <= self.upper


class DifferenceStatus(StrEnum):
    """What the recorded bounds establish about selected-minus-competitor score."""

    SELECTED_HIGHER = "selected_higher"  # lower bound of the difference > 0
    COMPETITOR_HIGHER = "competitor_higher"  # upper bound of the difference < 0
    NOT_ESTABLISHED = "not_established"  # the difference interval contains 0
    UNAVAILABLE = "unavailable"  # at least one score is missing (never read as 0)
    NOT_COMPARABLE = "not_comparable"  # scores do not measure the same thing; no difference computed


class ScoreDifference(ContractModel):
    """Conservative interval of ``selected score - competitor score`` and its interpretation."""

    status: DifferenceStatus
    interval: PointsInterval | None  # set exactly for SELECTED_HIGHER / COMPETITOR_HIGHER / NOT_ESTABLISHED
    both_exact: StrictBool  # both scores KNOWN (the interval is then a single number up to rounding)
    statement: Text

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        numeric = self.status in (
            DifferenceStatus.SELECTED_HIGHER,
            DifferenceStatus.COMPETITOR_HIGHER,
            DifferenceStatus.NOT_ESTABLISHED,
        )
        if numeric != (self.interval is not None):
            raise ValueError(f"status {self.status.value!r} and interval presence disagree")
        if self.interval is not None:
            expected = _classify(self.interval)
            if self.status is not expected:
                raise ValueError(f"status {self.status.value!r} contradicts the interval ({expected.value!r})")
        elif self.both_exact:
            raise ValueError("both_exact requires a computed difference")
        return self


class Advantage(StrEnum):
    """Which side a single score component favours within the recorded bounds."""

    SELECTED = "selected"
    COMPETITOR = "competitor"
    EQUAL = "equal"  # both exact and identical contributions (says nothing beyond this component)
    NOT_ESTABLISHED = "not_established"  # contribution intervals overlap
    INACTIVE = "inactive"  # not part of the score under this configuration (weight 0)
    UNAVAILABLE = "unavailable"  # not evaluated (e.g. eligibility UNKNOWN) on at least one side


class ComponentEvidence(ContractModel):
    """One score component of both scenarios, quoted from their ``ScoreBreakdown``."""

    component: ScoreComponent
    label: NonEmptyStr
    weight: StrictFloat  # effective weight (identical on both sides: comparable scores share weights)
    selected_status: ScoreComponentStatus | None
    competitor_status: ScoreComponentStatus | None
    selected_value: Metric | None  # normalized value in [0, 1], KNOWN or BOUNDED
    competitor_value: Metric | None
    selected_contribution: PointsInterval | None  # score points (100 * weight * value)
    competitor_contribution: PointsInterval | None
    contribution_difference: PointsInterval | None  # selected minus competitor, outward-rounded
    advantage: Advantage


class ScenarioEvidence(ContractModel):
    """The facts about one scenario that the comparison relies on (all quoted, none computed)."""

    scenario_id: Identifier
    rank: int | None = Field(ge=1, strict=True)  # from the supplied RankingResult; None if not PASS or none given
    eligibility: Eligibility
    excluded_from_viable_ranking: StrictBool  # True unless eligibility is PASS
    exclusion_reason: str | None
    failed_constraints: list[ConstraintId]
    unknown_constraints: list[ConstraintId]
    score_status: ScoreStatus | None
    score: Percent | None  # exact score only (KNOWN); never a bound
    score_bounds: Metric | None
    score_text: Text
    overall_risk: RiskLevel
    risk_drivers: list[str]  # indicator codes at the overall level (empty when the overall level is LOW)
    min_coverage_percent: Percent  # min(sun, earth coverage), the ranking's coverage key
    data_basis: DataBasis
    is_synthetic: StrictBool
    dataset_id: NonEmptyStr
    engine_version: NonEmptyStr
    scoring_method_version: NonEmptyStr
    configuration_key: str | None


class PairwiseEvidence(ContractModel):
    """Why ``selected`` ranks above or below ``competitor`` (or why they cannot be ranked together)."""

    method_version: NonEmptyStr = EVIDENCE_METHOD_VERSION
    policy: ComparabilityPolicy
    selected: ScenarioEvidence
    competitor: ScenarioEvidence
    comparable: StrictBool
    comparability_issues: list[str]
    higher_id: Identifier | None  # placed first by the ranking policy; None when not comparable
    selected_ranks_higher: StrictBool | None
    deciding_criterion: RankingCriterion | None  # None when not comparable
    deciding_detail: Text
    score_difference: ScoreDifference
    components: list[ComponentEvidence]  # empty when not comparable or not both scored
    limitations: list[Text]
    explanation: Text

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if self.comparable == bool(self.comparability_issues):
            raise ValueError("comparable must be True exactly when there are no comparability issues")
        present = {v is not None for v in (self.higher_id, self.selected_ranks_higher, self.deciding_criterion)}
        if present != {self.comparable}:
            raise ValueError("an order is stated exactly when the scenarios are comparable")
        if self.comparable:
            expected = self.selected.scenario_id if self.selected_ranks_higher else self.competitor.scenario_id
            if self.higher_id != expected:
                raise ValueError("higher_id must name the scenario that ranks higher")
        elif self.score_difference.status is not DifferenceStatus.NOT_COMPARABLE or self.components:
            raise ValueError("incomparable scenarios get no score difference and no component comparison")
        return self


# --- numerics ----------------------------------------------------------------------------------------


def _down(x: Rational) -> float:
    """Largest float on (or within one ulp below) the 6-decimal grid that is <= x."""
    f = float(Rational(math.floor(x * _GRID), _GRID))
    while Rational(f) > x:
        f = math.nextafter(f, -math.inf)
    return f + 0.0  # no -0.0


def _up(x: Rational) -> float:
    """Smallest float on (or within one ulp above) the 6-decimal grid that is >= x."""
    f = float(Rational(math.ceil(x * _GRID), _GRID))
    while Rational(f) < x:
        f = math.nextafter(f, math.inf)
    return f + 0.0


def _outward(lo: Rational, hi: Rational) -> PointsInterval:
    return PointsInterval(lower=_down(lo), upper=_up(hi))


def _classify(interval: PointsInterval) -> DifferenceStatus:
    if interval.lower > 0.0:
        return DifferenceStatus.SELECTED_HIGHER
    if interval.upper < 0.0:
        return DifferenceStatus.COMPETITOR_HIGHER
    return DifferenceStatus.NOT_ESTABLISHED


def _exact(x: float) -> Rational:
    """The stored decimal value of ``x`` (its shortest round-trip representation), as an exact rational.

    Scores and bounds are written on the scorer's 6-decimal grid, so ``79.044225`` means exactly
    79.044225, not the nearest binary float; arithmetic on these values is then exact.
    """
    return Rational(repr(x))


def _metric_span(metric: Metric) -> tuple[Rational, Rational] | None:
    if metric.status is MetricStatus.KNOWN and metric.value is not None:
        v = _exact(metric.value)
        return v, v
    if metric.status is MetricStatus.BOUNDED and metric.lower is not None and metric.upper is not None:
        return _exact(metric.lower), _exact(metric.upper)
    return None


def _score_span(a: ViabilityAssessment) -> tuple[Rational, Rational] | None:
    """Exact rational [lower, upper] of a KNOWN or BOUNDED score; None when there is no number."""
    s = a.score
    if s.status not in (ScoreStatus.KNOWN, ScoreStatus.BOUNDED) or s.score_bounds is None:
        return None
    return _metric_span(s.score_bounds)


def _fmt(x: float) -> str:
    text = f"{x:.6f}".rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


def _signed(x: float) -> str:
    return ("+" if x > 0.0 else "") + _fmt(x)


# --- per-scenario facts ------------------------------------------------------------------------------


def score_text(a: ViabilityAssessment) -> str:
    """Display text for a score that never turns a bound into an exact number or a missing score into 0."""
    s = a.score
    if s.status is ScoreStatus.KNOWN and s.score is not None:
        return f"exact score {_fmt(s.score)}"
    if s.status is ScoreStatus.BOUNDED and s.score_bounds is not None:
        span = _metric_span(s.score_bounds)
        assert span is not None
        return f"score between {_fmt(float(span[0]))} and {_fmt(float(span[1]))} (bounded; no exact value)"
    if s.status is ScoreStatus.ELIGIBILITY_UNKNOWN:
        return "not scored: eligibility is UNKNOWN"
    if s.status is ScoreStatus.NO_SCORABLE_COMPONENTS:
        return "not scored: no score component is active under this configuration"
    if s.score is not None:  # legacy breakdown without Phase 5 metadata
        return f"legacy score {_fmt(s.score)} (no Phase 5 metadata; not rankable)"
    return "not scored"


def _ids(a: ViabilityAssessment, status: ConstraintStatus) -> list[ConstraintId]:
    return sorted((c.constraint_id for c in a.constraints if c.status is status), key=lambda c: c.value)


def _id_list(ids: Sequence[ConstraintId]) -> str:
    return ", ".join(c.value for c in ids) or "none"


def _exclusion_reason(a: ViabilityAssessment) -> str | None:
    if a.eligibility is Eligibility.FAIL:
        return f"fails hard constraint(s): {_id_list(_ids(a, ConstraintStatus.FAIL))}"
    if a.eligibility is Eligibility.UNKNOWN:
        return f"eligibility UNKNOWN; undetermined constraint(s): {_id_list(_ids(a, ConstraintStatus.UNKNOWN))}"
    return None


def _scenario(a: ViabilityAssessment, rank: int | None) -> ScenarioEvidence:
    q = a.data_quality
    drivers = [] if a.overall_risk is RiskLevel.LOW else sorted({r.code for r in a.risks if r.level is a.overall_risk})
    s = a.score
    return ScenarioEvidence(
        scenario_id=a.scenario_id,
        rank=rank,
        eligibility=a.eligibility,
        excluded_from_viable_ranking=a.eligibility is not Eligibility.PASS,
        exclusion_reason=_exclusion_reason(a),
        failed_constraints=_ids(a, ConstraintStatus.FAIL),
        unknown_constraints=_ids(a, ConstraintStatus.UNKNOWN),
        score_status=s.status,
        score=s.score if s.status is ScoreStatus.KNOWN else None,
        score_bounds=s.score_bounds,
        score_text=score_text(a),
        overall_risk=a.overall_risk,
        risk_drivers=drivers,
        min_coverage_percent=min(q.sun_coverage_percent, q.earth_coverage_percent),
        data_basis=a.data_basis,
        is_synthetic=q.provenance.is_synthetic,
        dataset_id=q.dataset_id,
        engine_version=a.engine_version,
        scoring_method_version=s.method_version,
        configuration_key=s.configuration_key,
    )


# --- score difference and components -----------------------------------------------------------------


def score_difference(
    selected: ViabilityAssessment,
    competitor: ViabilityAssessment,
    policy: ComparabilityPolicy | str = ComparabilityPolicy.STRICT,
) -> ScoreDifference:
    """Conservative interval of ``selected - competitor`` score (see the module docstring)."""
    issues = comparability_issues(selected, competitor, policy)
    if issues:
        return ScoreDifference(
            status=DifferenceStatus.NOT_COMPARABLE,
            interval=None,
            both_exact=False,
            statement=(
                f"No score difference is computed: the scores are not comparable (differing: {'; '.join(issues)})."
            ),
        )
    a_span, b_span = _score_span(selected), _score_span(competitor)
    if a_span is None or b_span is None:
        missing = [x for x, span in ((selected, a_span), (competitor, b_span)) if span is None]
        reasons = "; ".join(f"{x.scenario_id}: {score_text(x)}" for x in missing)
        return ScoreDifference(
            status=DifferenceStatus.UNAVAILABLE,
            interval=None,
            both_exact=False,
            statement=f"No score difference can be stated because a score is missing ({reasons}); "
            "a missing score is never treated as 0.",
        )
    interval = _outward(a_span[0] - b_span[1], a_span[1] - b_span[0])
    both_exact = selected.score.status is ScoreStatus.KNOWN and competitor.score.status is ScoreStatus.KNOWN
    status = _classify(interval)
    sid, cid = selected.scenario_id, competitor.scenario_id
    rng = f"[{_signed(interval.lower)}, {_signed(interval.upper)}] points"
    if status is DifferenceStatus.NOT_ESTABLISHED:
        if both_exact and interval.lower == interval.upper == 0.0:
            statement = (
                f"The exact scores of {sid} and {cid} are identical. Equal scores do not mean the sites are "
                "physically equivalent: the score covers only its weighted components."
            )
        else:
            statement = (
                f"The score difference {sid} minus {cid} lies in {rng}, which includes 0: the recorded "
                "uncertainty does not establish which score is higher."
            )
    else:
        hi_id, lo_id = (sid, cid) if status is DifferenceStatus.SELECTED_HIGHER else (cid, sid)
        if both_exact:
            statement = f"{hi_id}'s exact score is higher than {lo_id}'s (difference {sid} minus {cid}: {rng})."
        else:
            statement = (
                f"{hi_id}'s score is higher than {lo_id}'s everywhere within the recorded bounds "
                f"(difference {sid} minus {cid}: {rng})."
            )
    return ScoreDifference(status=status, interval=interval, both_exact=both_exact, statement=statement)


def _contribution_span(c: ScoreComponentResult) -> tuple[Rational, Rational] | None:
    """Exact [lower, upper] contribution in score points, from the component record only."""
    if c.normalized is None:
        return None
    if c.normalized.status is MetricStatus.KNOWN and c.contribution is not None:
        v = _exact(c.contribution)  # the authoritative exact contribution
        return v, v
    span = _metric_span(c.normalized)
    if span is None:
        return None
    w = _exact(c.weight) * 100
    return w * span[0], w * span[1]


def _components(selected: ViabilityAssessment, competitor: ViabilityAssessment) -> list[ComponentEvidence]:
    a_by = {c.component: c for c in selected.score.components}
    b_by = {c.component: c for c in competitor.score.components}
    out: list[ComponentEvidence] = []
    for comp in ScoreComponent:
        ca, cb = a_by.get(comp), b_by.get(comp)
        if ca is None or cb is None:
            continue
        active = ca.status is ScoreComponentStatus.ACTIVE and cb.status is ScoreComponentStatus.ACTIVE
        a_span = _contribution_span(ca) if active else None
        b_span = _contribution_span(cb) if active else None
        diff: PointsInterval | None = None
        if not active:
            adv = Advantage.INACTIVE
        elif a_span is None or b_span is None:
            adv = Advantage.UNAVAILABLE
        else:
            exact_lo, exact_hi = a_span[0] - b_span[1], a_span[1] - b_span[0]
            diff = _outward(exact_lo, exact_hi)
            both_known = a_span[0] == a_span[1] and b_span[0] == b_span[1]
            if both_known and exact_lo == 0:
                adv = Advantage.EQUAL
            elif diff.lower > 0.0:
                adv = Advantage.SELECTED
            elif diff.upper < 0.0:
                adv = Advantage.COMPETITOR
            else:
                adv = Advantage.NOT_ESTABLISHED
        out.append(
            ComponentEvidence(
                component=comp,
                label=_LABEL[comp],
                weight=ca.weight,
                selected_status=ca.status,
                competitor_status=cb.status,
                selected_value=ca.normalized if active else None,
                competitor_value=cb.normalized if active else None,
                selected_contribution=None if a_span is None else _outward(*a_span),
                competitor_contribution=None if b_span is None else _outward(*b_span),
                contribution_difference=diff,
                advantage=adv,
            )
        )
    return out


# --- deciding criterion ------------------------------------------------------------------------------


def _deciding(higher: ViabilityAssessment, lower: ViabilityAssessment) -> RankingCriterion:
    kh, kl = ranking_order_key(higher), ranking_order_key(lower)
    if higher.eligibility is not lower.eligibility:
        return RankingCriterion.ELIGIBILITY
    names = ORDER_KEY_CRITERIA[higher.eligibility]
    assert len(names) == len(kh) == len(kl), "ORDER_KEY_CRITERIA out of step with ranking_order_key"
    for name, x, y in zip(names, kh, kl, strict=True):
        if x != y:
            return name
    raise AssertionError("distinct scenario ids always give distinct ranking keys")


def _risk_text(a: ViabilityAssessment) -> str:
    codes = sorted({r.code for r in a.risks if r.level is a.overall_risk})
    if a.overall_risk is RiskLevel.LOW or not codes:
        return a.overall_risk.value
    return f"{a.overall_risk.value} ({', '.join(codes)})"


def _coverage(a: ViabilityAssessment) -> float:
    q = a.data_quality
    return min(q.sun_coverage_percent, q.earth_coverage_percent)


def _detail(criterion: RankingCriterion, h: ViabilityAssessment, lo: ViabilityAssessment) -> str:
    hid, lid = h.scenario_id, lo.scenario_id
    if criterion is RankingCriterion.ELIGIBILITY:
        return (
            f"{hid} is {h.eligibility.value.upper()} and {lid} is {lo.eligibility.value.upper()}; eligibility tiers "
            "come first (PASS, then UNKNOWN, then FAIL) and a score never overrides them."
        )
    if criterion is RankingCriterion.FAIL_CONSTRAINT_COUNT:
        return (
            f"Both FAIL; {hid} fails {len(_ids(h, ConstraintStatus.FAIL))} hard constraint(s) "
            f"({_id_list(_ids(h, ConstraintStatus.FAIL))}), {lid} fails {len(_ids(lo, ConstraintStatus.FAIL))} "
            f"({_id_list(_ids(lo, ConstraintStatus.FAIL))})."
        )
    if criterion is RankingCriterion.UNKNOWN_CONSTRAINT_COUNT:
        return (
            f"{hid} has {len(_ids(h, ConstraintStatus.UNKNOWN))} undetermined constraint(s), "
            f"{lid} has {len(_ids(lo, ConstraintStatus.UNKNOWN))}."
        )
    if criterion is RankingCriterion.SCORED_BEFORE_UNSCORED:
        return f"{hid} has a score ({score_text(h)}); {lid} has none ({score_text(lo)}). Scored scenarios come first."
    if criterion is RankingCriterion.SCORE_LOWER_BOUND:
        lh, ll = h.score.lower_bound, lo.score.lower_bound
        assert lh is not None and ll is not None
        return (
            f"Conservative score lower bound: {hid} {_fmt(lh)} vs {lid} {_fmt(ll)} "
            f"({hid}: {score_text(h)}; {lid}: {score_text(lo)})."
        )
    if criterion is RankingCriterion.EXACT_BEFORE_BOUNDED:
        lb = h.score.lower_bound
        assert lb is not None
        return (
            f"Equal score lower bound {_fmt(lb)}; {hid} has an exact score while {lid} has a {score_text(lo)}, "
            "and at an equal lower bound the policy places an exact score first."
        )
    if criterion is RankingCriterion.OVERALL_RISK:
        return (
            f"Score evidence ties; overall risk {hid} {_risk_text(h)} vs {lid} {_risk_text(lo)} "
            "(risk is a tie-breaker only and never changes a score)."
        )
    if criterion is RankingCriterion.MIN_COVERAGE:
        return (
            f"Score evidence and risk tie; data coverage min(sun, earth) {hid} {_fmt(_coverage(h))}% vs "
            f"{lid} {_fmt(_coverage(lo))}%."
        )
    return (
        f"Every substantive criterion ties; the order falls to the stable scenario_id tie-break "
        f"({hid!r} < {lid!r}), which expresses no preference."
    )


# --- explanation text --------------------------------------------------------------------------------


def _join(parts: Sequence[str]) -> str:
    return parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]


def _drivers(components: Sequence[ComponentEvidence], selected_is_higher: bool, hid: str, lid: str) -> str | None:
    """Sentence naming the components whose advantage is established, largest established gap first."""
    favour_h: list[tuple[float, int, str]] = []
    favour_l: list[tuple[float, int, str]] = []
    order = {c: i for i, c in enumerate(ScoreComponent)}
    for c in components:
        if c.contribution_difference is None or c.advantage not in (Advantage.SELECTED, Advantage.COMPETITOR):
            continue
        selected_wins = c.advantage is Advantage.SELECTED
        gap = c.contribution_difference.lower if selected_wins else -c.contribution_difference.upper
        entry = (-gap, order[c.component], _ADVANTAGE_PHRASE[c.component])
        (favour_h if selected_wins == selected_is_higher else favour_l).append(entry)
    if not favour_h and not favour_l:
        return None
    parts = []
    if favour_h:
        parts.append(f"{hid} benefits from {_join([p for *_, p in sorted(favour_h)])}")
    if favour_l:
        parts.append(f"{lid} has {_join([p for *_, p in sorted(favour_l)])}")
    return ("; ".join(parts) if not (favour_h and favour_l) else f"{parts[0]}, while {parts[1]}") + "."


def _lead(
    criterion: RankingCriterion,
    h: ViabilityAssessment,
    lo: ViabilityAssessment,
    diff: ScoreDifference,
    selected_is_higher: bool,
) -> str:
    hid, lid = h.scenario_id, lo.scenario_id
    if criterion is RankingCriterion.ELIGIBILITY:
        if h.eligibility is Eligibility.PASS:
            if lo.eligibility is Eligibility.FAIL:
                why = (
                    f"fails {_id_list(_ids(lo, ConstraintStatus.FAIL))}. Its score is descriptive only and does "
                    "not compete"
                )
            else:
                why = (
                    f"has UNKNOWN eligibility (undetermined: {_id_list(_ids(lo, ConstraintStatus.UNKNOWN))}) and is "
                    "not scored until the missing data is available"
                )
            return (
                f"{hid} ranks above {lid} because eligibility comes first: {hid} passes every hard constraint, "
                f"while {lid} {why}."
            )
        return (
            f"Neither {hid} nor {lid} is a viable candidate. {hid} ({h.eligibility.value.upper()}) is listed before "
            f"{lid} ({lo.eligibility.value.upper()}) because undetermined eligibility is listed before a confirmed "
            "failure; neither receives a rank."
        )
    if h.eligibility is not Eligibility.PASS:
        return (
            f"Neither {hid} nor {lid} is a viable candidate (both {h.eligibility.value.upper()}); among non-viable "
            f"scenarios {hid} is listed first: {_detail(criterion, h, lo)} Neither receives a rank."
        )
    established_for_h = diff.status is (
        DifferenceStatus.SELECTED_HIGHER if selected_is_higher else DifferenceStatus.COMPETITOR_HIGHER
    )
    if criterion is RankingCriterion.SCORED_BEFORE_UNSCORED:
        return (
            f"{hid} ranks above {lid} because {lid} has no score ({score_text(lo)}); that is a missing value, "
            "not evidence that it is less desirable."
        )
    if criterion is RankingCriterion.SCORE_LOWER_BOUND:
        if established_for_h:
            return (
                f"{hid} ranks above {lid}: its desirability score is higher everywhere within the recorded bounds "
                f"({score_text(h)} vs {score_text(lo)})."
            )
        return (
            f"{hid} ranks above {lid} under the conservative scoring policy (higher guaranteed lower bound), but "
            f"their score ranges overlap ({score_text(h)} vs {score_text(lo)}). The recorded evidence does not "
            f"prove {hid} has a higher desirability score."
        )
    if criterion is RankingCriterion.EXACT_BEFORE_BOUNDED:
        return (
            f"{hid} ranks above {lid} only because, at the same score lower bound, the policy places an exact score "
            f"before a bounded one ({score_text(h)} vs {score_text(lo)}). The recorded evidence does not prove "
            f"{hid} has a higher desirability score."
        )
    if criterion is RankingCriterion.SCENARIO_ID:
        return (
            f"{hid} and {lid} tie on every substantive criterion; {hid} is listed first only by the stable "
            "scenario_id tie-break. Neither is preferred by the evidence."
        )
    return f"{hid} ranks above {lid} on a tie-break, not on score: {_detail(criterion, h, lo)}"


def _limitations(
    a: ViabilityAssessment, b: ViabilityAssessment, policy: ComparabilityPolicy, comparable: bool
) -> list[str]:
    out = [_DISCLAIMER]
    pair = (a, b)
    if any(x.data_basis is DataBasis.SYNTHETIC for x in pair):
        out.append(
            SYNTHETIC_PREFIX + "At least one scenario uses synthetic geometry; it is not scientifically validated "
            "and never shares a leaderboard with real data."
        )
    if any(x.data_basis is DataBasis.REAL_GEOMETRIC_ONLY for x in pair):
        out.append("At least one scenario ignores terrain horizons (geometric-only data).")
    if any(x.score.status is ScoreStatus.BOUNDED for x in pair):
        out.append(
            "At least one score is only bounded; the ranking orders it by its guaranteed lower bound, a "
            "conservative ordering policy, not an estimate."
        )
    if any(x.score.status in (ScoreStatus.ELIGIBILITY_UNKNOWN, ScoreStatus.NO_SCORABLE_COMPONENTS) for x in pair):
        out.append("At least one scenario has no score; a missing score is never treated as 0.")
    if any(x.eligibility is Eligibility.FAIL for x in pair):
        out.append("Scores of FAIL scenarios are descriptive only and never compete with viable scenarios.")
    if (
        comparable
        and policy is ComparabilityPolicy.SAME_METHOD_AND_WEIGHTS
        and (a.score.configuration_key != b.score.configuration_key or a.evaluated_duration_s != b.evaluated_duration_s)
    ):
        out.append(
            "Compared under the explicit SAME_METHOD_AND_WEIGHTS opt-in: hard requirements or mission duration "
            "differ, so the scores do not express the same requirement set."
        )
    if any(
        c.status is ScoreComponentStatus.UNSUPPORTED and (c.declared_weight or 0.0) > 0.0
        for x in pair
        for c in x.score.components
    ):
        out.append("A clearance-margin weight was given, but clearance scoring is unsupported and not in the score.")
    return out


# --- public API --------------------------------------------------------------------------------------


def _ranks(ranking: RankingResult | None, pair: Sequence[ViabilityAssessment]) -> dict[str, int | None]:
    if ranking is None:
        return {a.scenario_id: None for a in pair}
    entries = {e.scenario_id: e for e in ranking.entries}
    out: dict[str, int | None] = {}
    for a in pair:
        e = entries.get(a.scenario_id)
        if e is None:
            raise ValueError(f"scenario {a.scenario_id!r} is not in the supplied ranking")
        if e.eligibility is not a.eligibility or e.score_status is not a.score.status or e.score != a.score.score:
            raise ValueError(f"ranking entry {a.scenario_id!r} does not match the supplied assessment")
        out[a.scenario_id] = e.rank
    return out


def compare_scenarios(
    selected: ViabilityAssessment,
    competitor: ViabilityAssessment,
    *,
    policy: ComparabilityPolicy | str | None = None,
    ranking: RankingResult | None = None,
) -> PairwiseEvidence:
    """Evidence for the order of ``selected`` and ``competitor`` under the existing ranking policy.

    ``policy`` defaults to the supplied ranking's policy, else STRICT. When ``ranking`` is given, both
    scenarios must be in it, its entries must match the assessments, and its order must agree with the
    ranking key; ranks are then reported. Raises ``ValueError`` for equal scenario ids or a mismatch.
    Pure: inputs are not modified, and swapping the arguments mirrors the result.
    """
    if selected.scenario_id == competitor.scenario_id:
        raise ValueError(f"cannot compare scenario {selected.scenario_id!r} with itself")
    if policy is None:
        pol = ranking.policy if ranking is not None and ranking.policy is not None else ComparabilityPolicy.STRICT
    else:
        pol = policy if isinstance(policy, ComparabilityPolicy) else ComparabilityPolicy(policy)
        if ranking is not None and ranking.policy is not None and ranking.policy is not pol:
            raise ValueError(f"policy {pol.value!r} differs from the ranking's policy {ranking.policy.value!r}")
    ranks = _ranks(ranking, (selected, competitor))
    sel_ev = _scenario(selected, ranks[selected.scenario_id])
    comp_ev = _scenario(competitor, ranks[competitor.scenario_id])
    issues = comparability_issues(selected, competitor, pol)
    diff = score_difference(selected, competitor, pol)
    limitations = _limitations(selected, competitor, pol, not issues)
    prefix = SYNTHETIC_PREFIX if sel_ev.is_synthetic or comp_ev.is_synthetic else ""
    sid, cid = selected.scenario_id, competitor.scenario_id

    if issues:
        text = (
            f"{prefix}{sid} and {cid} must not share one leaderboard: they differ in {'; '.join(issues)}. Their "
            f"scores do not measure the same thing, so no order or score difference is stated; show them in "
            f"separate groups. {sid}: {selected.eligibility.value.upper()}, {score_text(selected)}. "
            f"{cid}: {competitor.eligibility.value.upper()}, {score_text(competitor)}."
        )
        return PairwiseEvidence(
            policy=pol,
            selected=sel_ev,
            competitor=comp_ev,
            comparable=False,
            comparability_issues=issues,
            higher_id=None,
            selected_ranks_higher=None,
            deciding_criterion=None,
            deciding_detail="Not comparable under the ranking policy; no order is defined between them.",
            score_difference=diff,
            components=[],
            limitations=limitations,
            explanation=text,
        )

    selected_first = ranking_order_key(selected) < ranking_order_key(competitor)
    if ranking is not None:
        pos = {e.scenario_id: i for i, e in enumerate(ranking.entries)}
        if (pos[sid] < pos[cid]) != selected_first:
            raise ValueError("the supplied ranking orders these scenarios differently from the ranking policy")
    h, lo = (selected, competitor) if selected_first else (competitor, selected)
    criterion = _deciding(h, lo)
    both_scored = _score_span(selected) is not None and _score_span(competitor) is not None
    components = _components(selected, competitor) if both_scored else []
    sentences = [_lead(criterion, h, lo, diff, selected_first)]
    if components and h.eligibility is Eligibility.PASS and lo.eligibility is Eligibility.PASS:
        drivers = _drivers(components, selected_first, h.scenario_id, lo.scenario_id)
        sentences.append(
            drivers
            if drivers is not None
            else "No single score component clearly favours either scenario within the recorded bounds."
        )
    sentences.append(_DISCLAIMER)
    return PairwiseEvidence(
        policy=pol,
        selected=sel_ev,
        competitor=comp_ev,
        comparable=True,
        comparability_issues=[],
        higher_id=h.scenario_id,
        selected_ranks_higher=selected_first,
        deciding_criterion=criterion,
        deciding_detail=_detail(criterion, h, lo),
        score_difference=diff,
        components=components,
        limitations=limitations,
        explanation=prefix + " ".join(sentences),
    )


def explain_adjacent(
    assessments: Iterable[ViabilityAssessment],
    ranking: RankingResult | None = None,
    *,
    policy: ComparabilityPolicy | str | None = None,
) -> list[PairwiseEvidence]:
    """Evidence for each consecutive pair of one comparable ranking (entry i vs entry i + 1).

    Without ``ranking``, ranks the assessments with ``rank_assessments`` (which raises
    ``RankingComparabilityError`` for incomparable inputs; split them with ``partition_comparable``).
    The result follows the ranking order, so it does not depend on the input order.
    """
    items = list(assessments)
    if ranking is None:
        pol = ComparabilityPolicy.STRICT if policy is None else policy
        ranking = rank_assessments(items, pol)
    by_id = {a.scenario_id: a for a in items}
    missing = [e.scenario_id for e in ranking.entries if e.scenario_id not in by_id]
    if missing:
        raise ValueError(f"ranking entries without an assessment: {missing}")
    ordered = [by_id[e.scenario_id] for e in ranking.entries]
    return [
        compare_scenarios(ordered[i], ordered[i + 1], policy=policy, ranking=ranking) for i in range(len(ordered) - 1)
    ]
