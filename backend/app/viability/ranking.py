"""Eligibility-aware ranking of existing assessments (Phase 5B; docs §5e, D4-D8).

Ranking only *consumes* ``ViabilityAssessment`` objects. It never recomputes a score, never touches a
hard-constraint verdict and never changes eligibility. A missing score is never read as 0, and a
bounded score is never turned into a point estimate (it is only *ordered* by its lower bound, D8).

Comparability (D6, D7). One call produces one common ranking, so every input must share

* the data basis (real terrain-aware / real geometric-only / synthetic; never mixed, under any policy),
* the scoring ``method_version`` and the exact effective weights,
* under ``STRICT`` (default) also the requirements fingerprint (``configuration_key``) and the
  evaluated duration. ``SAME_METHOD_AND_WEIGHTS`` (explicit opt-in) drops those last two.

``RankingResult`` has room for exactly one group, so incompatible inputs raise
:class:`RankingComparabilityError` instead of being mixed. :func:`partition_comparable` splits a
mixed collection into groups that can each be ranked.

Ordering (D8), all keys ascending, last key unique so the order is total and input-order independent.
Tiers are PASS, then UNKNOWN, then FAIL; only PASS entries get ranks.

* PASS: scored before unscored; score lower bound descending; ``known`` before ``bounded``; risk
  (low < moderate < high < unknown); min(sun, earth coverage) descending; ``scenario_id``.
* UNKNOWN: number of UNKNOWN constraints; min coverage descending; ``scenario_id``.
* FAIL: number of FAIL constraints; number of UNKNOWN constraints; scored before unscored; score lower
  bound descending; risk; ``scenario_id``.

Stored (rounded) values are compared exactly, never with a tolerance.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence

from .enums import (
    ComparabilityPolicy,
    ConstraintStatus,
    DataBasis,
    Eligibility,
    RiskLevel,
    ScoreStatus,
)
from .outputs import RankedScenario, RankingResult, ViabilityAssessment

__all__ = [
    "RANKING_METHOD_VERSION",
    "RankingComparabilityError",
    "partition_comparable",
    "rank_assessments",
    "ranking_explanations",
]

# method_version of an empty ranking (no scoring method exists to report).
RANKING_METHOD_VERSION = "ranking-phase5b-v1"

_RISK_ORDER: dict[RiskLevel, int] = {
    RiskLevel.LOW: 0,
    RiskLevel.MODERATE: 1,
    RiskLevel.HIGH: 2,
    RiskLevel.UNKNOWN: 3,
}
_TIER: dict[Eligibility, int] = {
    Eligibility.PASS: 0,
    Eligibility.UNKNOWN: 1,
    Eligibility.FAIL: 2,
}


class RankingComparabilityError(ValueError):
    """The assessments cannot share one ranking (duplicate ids, legacy score or incompatible basis)."""


# --- helpers -----------------------------------------------------------------------------------


def _lower_bound(a: ViabilityAssessment) -> float | None:
    """Exact score (known) or guaranteed lower bound (bounded); None when there is no number."""
    s = a.score
    if s.status is ScoreStatus.KNOWN:
        return s.score
    if s.status is ScoreStatus.BOUNDED:
        assert s.score_bounds is not None and s.score_bounds.lower is not None
        return s.score_bounds.lower
    return None


def _min_coverage(a: ViabilityAssessment) -> float:
    q = a.data_quality
    return min(q.sun_coverage_percent, q.earth_coverage_percent)


def _count(a: ViabilityAssessment, status: ConstraintStatus) -> int:
    return sum(1 for c in a.constraints if c.status is status)


def _scored_key(a: ViabilityAssessment) -> tuple[int, float]:
    lb = _lower_bound(a)
    return (1, 0.0) if lb is None else (0, -lb)


def _order_key(a: ViabilityAssessment) -> tuple[object, ...]:
    """Total order: tier first (eligibility before desirability), then the D8 keys of that tier."""
    tier = _TIER[a.eligibility]
    if a.eligibility is Eligibility.PASS:
        exact = 0 if a.score.status is ScoreStatus.KNOWN else 1
        return (
            tier,
            *_scored_key(a),
            exact,
            _RISK_ORDER[a.overall_risk],
            -_min_coverage(a),
            a.scenario_id,
        )
    if a.eligibility is Eligibility.UNKNOWN:
        return (
            tier,
            _count(a, ConstraintStatus.UNKNOWN),
            -_min_coverage(a),
            a.scenario_id,
        )
    return (
        tier,
        _count(a, ConstraintStatus.FAIL),
        _count(a, ConstraintStatus.UNKNOWN),
        *_scored_key(a),
        _RISK_ORDER[a.overall_risk],
        a.scenario_id,
    )


def _check_ids(items: Sequence[ViabilityAssessment]) -> None:
    seen: set[str] = set()
    dupes: set[str] = set()
    for a in items:
        (dupes if a.scenario_id in seen else seen).add(a.scenario_id)
    if dupes:
        raise RankingComparabilityError(f"duplicate scenario_id in ranking input: {sorted(dupes)}")


def _comparison_key(a: ViabilityAssessment, policy: ComparabilityPolicy) -> tuple[object, ...]:
    try:
        key = a.comparability_key(policy)
    except ValueError as exc:  # legacy score without Phase 5 metadata
        raise RankingComparabilityError(str(exc)) from exc
    if policy is ComparabilityPolicy.STRICT:
        key += (a.evaluated_duration_s,)
    return key


def _mismatches(ref: ViabilityAssessment, other: ViabilityAssessment, policy: ComparabilityPolicy) -> list[str]:
    rs, os_ = ref.score, other.score
    out: list[str] = []
    if ref.data_basis is not other.data_basis:
        out.append(f"data basis ({ref.data_basis.value} vs {other.data_basis.value})")
    if rs.method_version != os_.method_version:
        out.append(f"scoring method ({rs.method_version!r} vs {os_.method_version!r})")
    if rs.weights_signature() != os_.weights_signature():
        out.append("effective score weights")
    if policy is ComparabilityPolicy.STRICT:
        if rs.configuration_key != os_.configuration_key:
            out.append("requirements/configuration fingerprint")
        if ref.evaluated_duration_s != other.evaluated_duration_s:
            out.append(f"evaluated duration ({ref.evaluated_duration_s:g} s vs {other.evaluated_duration_s:g} s)")
    return out


def _coerce_policy(policy: ComparabilityPolicy | str) -> ComparabilityPolicy:
    return policy if isinstance(policy, ComparabilityPolicy) else ComparabilityPolicy(policy)


def _entry(a: ViabilityAssessment, rank: int | None) -> RankedScenario:
    s = a.score
    return RankedScenario(
        rank=rank,
        scenario_id=a.scenario_id,
        eligibility=a.eligibility,
        score=s.score,
        overall_risk=a.overall_risk,
        score_status=s.status,
        score_bounds=s.score_bounds,
        data_basis=a.data_basis,
    )


# --- public API --------------------------------------------------------------------------------


def partition_comparable(
    assessments: Iterable[ViabilityAssessment],
    policy: ComparabilityPolicy | str = ComparabilityPolicy.STRICT,
) -> list[list[ViabilityAssessment]]:
    """Split assessments into groups that may each share one ranking.

    Groups are ordered by their smallest ``scenario_id`` and members by ``scenario_id``, so the
    result does not depend on input order. Raises for duplicate ids or legacy scores.
    """
    pol = _coerce_policy(policy)
    items = sorted(assessments, key=lambda a: a.scenario_id)
    _check_ids(items)
    groups: dict[tuple[object, ...], list[ViabilityAssessment]] = {}
    for a in items:
        groups.setdefault(_comparison_key(a, pol), []).append(a)
    return list(groups.values())  # dicts keep first-insertion order == smallest id first


def rank_assessments(
    assessments: Iterable[ViabilityAssessment],
    policy: ComparabilityPolicy | str = ComparabilityPolicy.STRICT,
) -> RankingResult:
    """Rank existing assessments into one common, deterministic ``RankingResult``.

    Every input appears in the result: PASS entries first with ranks 1..n, then UNKNOWN, then FAIL
    entries, unranked. Raises :class:`RankingComparabilityError` for duplicate scenario ids, legacy
    scores without Phase 5 metadata, or inputs that are not comparable under ``policy`` (different
    data basis, method, weights, and under STRICT requirements or evaluated duration). An empty input
    gives an empty result without data basis or policy.
    """
    pol = _coerce_policy(policy)
    items = list(assessments)
    if not items:
        return RankingResult(method_version=RANKING_METHOD_VERSION, entries=[])
    _check_ids(items)

    # Reference = smallest scenario_id, so error messages do not depend on input order.
    ref = min(items, key=lambda a: a.scenario_id)
    ref_key = _comparison_key(ref, pol)
    bad = sorted(
        (a for a in items if _comparison_key(a, pol) != ref_key),
        key=lambda a: a.scenario_id,
    )
    if bad:
        details = "; ".join(f"{a.scenario_id}: {', '.join(_mismatches(ref, a, pol))}" for a in bad)
        raise RankingComparabilityError(
            f"assessments are not comparable under policy {pol.value!r} "
            f"(reference {ref.scenario_id!r}); differing: {details}. "
            "Use partition_comparable() and rank each group separately."
        )

    ordered = sorted(items, key=_order_key)
    entries: list[RankedScenario] = []
    next_rank = 1
    for a in ordered:
        if a.eligibility is Eligibility.PASS:
            entries.append(_entry(a, next_rank))
            next_rank += 1
        else:
            entries.append(_entry(a, None))
    basis: DataBasis = ref.data_basis
    return RankingResult(
        method_version=ref.score.method_version,
        entries=entries,
        data_basis=basis,
        policy=pol,
    )


def _score_text(a: ViabilityAssessment) -> str:
    s = a.score
    if s.status is ScoreStatus.KNOWN:
        return f"exact score {s.score}"
    if s.status is ScoreStatus.BOUNDED:
        assert s.score_bounds is not None
        return f"score only bounded [{s.score_bounds.lower}, {s.score_bounds.upper}], ordered by its lower bound"
    if s.status is ScoreStatus.NO_SCORABLE_COMPONENTS:
        return "no scorable components, ranked after scored scenarios"
    return "not scored"


def ranking_explanations(assessments: Iterable[ViabilityAssessment], result: RankingResult) -> dict[str, str]:
    """Plain-language reason for each entry's place (or absence of rank) in ``result``.

    Derived from the assessments and the result only; ``RankedScenario`` has no text field.
    Returned in the result's entry order. Assessments missing from ``result`` are ignored.
    """
    by_id = {a.scenario_id: a for a in assessments}
    out: dict[str, str] = {}
    for e in result.entries:
        a = by_id.get(e.scenario_id)
        if a is None:
            continue
        if a.eligibility is Eligibility.PASS:
            out[e.scenario_id] = (
                f"Rank {e.rank}: all hard constraints pass; {_score_text(a)}; overall risk "
                f"{a.overall_risk.value}. Ties are broken by risk, then coverage, then scenario id."
            )
            continue
        statuses = ConstraintStatus.UNKNOWN if a.eligibility is Eligibility.UNKNOWN else ConstraintStatus.FAIL
        ids = ", ".join(c.constraint_id.value for c in a.constraints if c.status is statuses) or "none"
        if a.eligibility is Eligibility.UNKNOWN:
            out[e.scenario_id] = (
                f"Not ranked: eligibility is UNKNOWN (undetermined constraints: {ids}); "
                "it is never scored or ranked until the missing data is available."
            )
        else:
            out[e.scenario_id] = (
                f"Not ranked: eligibility is FAIL (failed constraints: {ids}); {_score_text(a)} "
                "is descriptive only and never competes with viable scenarios."
            )
    return out
