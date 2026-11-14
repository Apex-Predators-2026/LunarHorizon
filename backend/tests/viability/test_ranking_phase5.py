"""Phase 5B: eligibility-aware ranking (docs §5e, D4-D8). All data is SYNTHETIC test data."""

from __future__ import annotations

import json
import random
from datetime import timedelta
from typing import Any

import pytest

from app.viability import (
    ComparabilityPolicy,
    DataBasis,
    ScoreComponent,
    ScoreComponentStatus,
    ScoreStatus,
)
from app.viability.enums import (
    CalculationBasis,
    ConstraintStatus,
    Eligibility,
    RiskLevel,
    Unit,
)
from app.viability.outputs import (
    Metric,
    RankingResult,
    ScoreBreakdown,
    ViabilityAssessment,
)
from app.viability.ranking import (
    RankingComparabilityError,
    partition_comparable,
    rank_assessments,
    ranking_explanations,
)

from .helpers import assessment_kwargs

SUN, EARTH, SIM, DARK, BLACK, CLEAR = list(ScoreComponent)
A, Z, U = (
    ScoreComponentStatus.ACTIVE,
    ScoreComponentStatus.ZERO_WEIGHT,
    ScoreComponentStatus.UNSUPPORTED,
)
KEY = "sha256:" + "a" * 64
OTHER_KEY = "sha256:" + "b" * 64
P, F, UNK = Eligibility.PASS, Eligibility.FAIL, Eligibility.UNKNOWN
CS = ConstraintStatus

_ELIG_STATUSES = {P: (CS.PASS,), F: (CS.FAIL,), UNK: (CS.UNKNOWN,)}


# --- builders ----------------------------------------------------------------------------------


def _frac(v: float) -> Metric:
    return Metric.known(v, Unit.FRACTION)


def _comp(
    c: ScoreComponent,
    status: ScoreComponentStatus,
    declared: float,
    weight: float,
    norm: Metric | None,
) -> Any:
    from app.viability.outputs import ScoreComponentResult

    exact = norm is not None and norm.status.value == "known"
    value = norm.value if exact and norm is not None else None
    return ScoreComponentResult(
        component=c,
        weight=weight,
        normalized_value=value,
        contribution=weight * value * 100.0 if value is not None else None,
        status=status,
        declared_weight=declared,
        normalized=norm,
    )


def _components(sun: Metric | None, two_active: bool, earth: Metric | None = None) -> list[Any]:
    """SUN active (weight 1), or SUN + EARTH active (0.5 each); everything else inactive."""
    if two_active:
        w = 0.5
        return [
            _comp(SUN, A, 1.0, w, sun),
            _comp(EARTH, A, 1.0, w, earth),
            *[_comp(c, Z, 0.0, 0.0, None) for c in (SIM, DARK, BLACK)],
            _comp(CLEAR, U, 0.0, 0.0, None),
        ]
    return [
        _comp(SUN, A, 1.0, 1.0, sun),
        *[_comp(c, Z, 0.0, 0.0, None) for c in (EARTH, SIM, DARK, BLACK)],
        _comp(CLEAR, U, 0.0, 0.0, None),
    ]


def known_score(
    score: float,
    *,
    method: str = "m1",
    key: str = KEY,
    rank_eligible: bool = True,
    two_active: bool = False,
) -> ScoreBreakdown:
    v = _frac(score / 100.0)
    return ScoreBreakdown(
        method_version=method,
        score=score,
        rank_eligible=rank_eligible,
        components=_components(v, two_active, v),
        status=ScoreStatus.KNOWN,
        score_bounds=Metric.known(score, Unit.PERCENT),
        configuration_key=key,
    )


def bounded_score(lo: float, hi: float, *, key: str = KEY, rank_eligible: bool = True) -> ScoreBreakdown:
    return ScoreBreakdown(
        method_version="m1",
        score=None,
        rank_eligible=rank_eligible,
        components=_components(Metric.bounded(lo / 100.0, hi / 100.0, Unit.FRACTION), False),
        status=ScoreStatus.BOUNDED,
        score_bounds=Metric.bounded(lo, hi, Unit.PERCENT),
        configuration_key=key,
    )


def no_components_score(*, key: str = KEY, rank_eligible: bool = True) -> ScoreBreakdown:
    comps = [_comp(c, U if c is CLEAR else Z, 1.0 if c is CLEAR else 0.0, 0.0, None) for c in ScoreComponent]
    return ScoreBreakdown(
        method_version="m1",
        score=None,
        rank_eligible=rank_eligible,
        components=comps,
        status=ScoreStatus.NO_SCORABLE_COMPONENTS,
        configuration_key=key,
    )


def unknown_score(*, key: str = KEY, no_active: bool = False) -> ScoreBreakdown:
    comps = (
        [_comp(c, U if c is CLEAR else Z, 1.0 if c is CLEAR else 0.0, 0.0, None) for c in ScoreComponent]
        if no_active
        else _components(None, False)
    )
    return ScoreBreakdown(
        method_version="m1",
        score=None,
        rank_eligible=False,
        components=comps,
        status=ScoreStatus.ELIGIBILITY_UNKNOWN,
        configuration_key=key,
    )


def make(
    sid: str,
    eligibility: Eligibility = P,
    score: ScoreBreakdown | float | None = None,
    *,
    risk: RiskLevel = RiskLevel.LOW,
    coverage: tuple[float, float] = (100.0, 100.0),
    basis: DataBasis = DataBasis.SYNTHETIC,
    hours: float = 24.0,
    statuses: tuple[ConstraintStatus, ...] | None = None,
) -> ViabilityAssessment:
    if eligibility is UNK and not isinstance(score, ScoreBreakdown):
        sb = unknown_score()
    elif isinstance(score, ScoreBreakdown):
        sb = score
    elif score is None:
        sb = unknown_score() if eligibility is UNK else known_score(50.0, rank_eligible=eligibility is P)
    else:
        sb = known_score(score, rank_eligible=eligibility is P)
    kw = assessment_kwargs(eligibility, statuses or _ELIG_STATUSES[eligibility])
    dq = kw["data_quality"]
    prov = dq.provenance.model_copy(update={"is_synthetic": basis is DataBasis.SYNTHETIC})
    calc = CalculationBasis.GEOMETRIC_ONLY if basis is DataBasis.REAL_GEOMETRIC_ONLY else dq.calculation_basis
    if basis is DataBasis.REAL_TERRAIN_AWARE and calc is CalculationBasis.GEOMETRIC_ONLY:
        calc = next(c for c in CalculationBasis if c is not CalculationBasis.GEOMETRIC_ONLY)
    kw["data_quality"] = dq.model_copy(
        update={
            "provenance": prov,
            "calculation_basis": calc,
            "sun_coverage_percent": coverage[0],
            "earth_coverage_percent": coverage[1],
        }
    )
    kw["scenario_id"] = sid
    kw["score"] = sb
    kw["overall_risk"] = risk
    kw["evaluated_end_utc"] = kw["evaluated_start_utc"] + timedelta(hours=hours)
    a = ViabilityAssessment(**kw)
    assert a.data_basis is basis
    return a


def ids(result: RankingResult) -> list[str]:
    return [e.scenario_id for e in result.entries]


# --- eligibility separation ------------------------------------------------------------------


def test_pass_fail_unknown_separation() -> None:
    r = rank_assessments([make("f", F, 99.0), make("u", UNK), make("p", P, 10.0)])
    assert ids(r) == ["p", "u", "f"]
    assert [e.rank for e in r.entries] == [1, None, None]
    assert [e.eligibility for e in r.entries] == [P, UNK, F]


def test_high_scoring_fail_never_overtakes_viable() -> None:
    r = rank_assessments([make("fail-top", F, 100.0), make("pass-low", P, 0.0)])
    assert ids(r) == ["pass-low", "fail-top"]
    assert r.entries[1].rank is None
    assert r.entries[1].score == 100.0  # descriptive score is preserved, not hidden


def test_unknown_never_ranked_and_score_stays_none() -> None:
    r = rank_assessments([make("u1", UNK), make("p", P, 1.0)])
    unk = r.entries[1]
    assert unk.rank is None and unk.score is None and unk.score_bounds is None
    assert unk.score_status is ScoreStatus.ELIGIBILITY_UNKNOWN


def test_all_scenarios_are_preserved() -> None:
    items = [make(f"s{i}", e, 10.0 + i) for i, e in enumerate([P, F, UNK, P, F, UNK, P])]
    assert sorted(ids(rank_assessments(items))) == sorted(a.scenario_id for a in items)


# --- scores: known, bounded, absent ----------------------------------------------------------


def test_known_scores_descend() -> None:
    r = rank_assessments([make("a", P, 40.0), make("b", P, 90.0), make("c", P, 65.5)])
    assert ids(r) == ["b", "c", "a"] and [e.rank for e in r.entries] == [1, 2, 3]


def test_bounded_orders_by_lower_bound_without_inventing_a_score() -> None:
    r = rank_assessments(
        [
            make("bounded", P, bounded_score(60.0, 99.0)),
            make("exact", P, 70.0),
            make("b2", P, bounded_score(80.0, 81.0)),
        ]
    )
    assert ids(r) == ["b2", "exact", "bounded"]
    b = r.entries[0]
    assert b.score is None and b.score_status is ScoreStatus.BOUNDED
    assert (b.score_bounds.lower, b.score_bounds.upper) == (80.0, 81.0)  # type: ignore[union-attr]


def test_exact_before_bounded_at_equal_lower_bound() -> None:
    r = rank_assessments([make("a-bounded", P, bounded_score(70.0, 90.0)), make("z-exact", P, 70.0)])
    assert ids(r) == ["z-exact", "a-bounded"]  # known first even though id sorts later


def test_pass_without_scorable_components_is_ranked_without_inventing_a_number() -> None:
    # No scorable component means all-zero effective weights: such scenarios only compare with each
    # other, and fall through to risk, coverage and id (never a score of 0).
    items = [
        make("c", P, no_components_score(), risk=RiskLevel.HIGH),
        make("b", P, no_components_score(), risk=RiskLevel.LOW, coverage=(50.0, 50.0)),
        make("a", P, no_components_score(), risk=RiskLevel.LOW, coverage=(90.0, 90.0)),
    ]
    r = rank_assessments(items)
    assert ids(r) == ["a", "b", "c"] and [e.rank for e in r.entries] == [1, 2, 3]
    assert all(e.score is None and e.score_bounds is None for e in r.entries)
    assert all(e.score_status is ScoreStatus.NO_SCORABLE_COMPONENTS for e in r.entries)


def test_unscored_pass_cannot_be_mixed_with_scored_pass() -> None:
    # Different effective weights: not comparable, so no unscored scenario can ever sit "below zero".
    with pytest.raises(RankingComparabilityError, match="weights"):
        rank_assessments([make("none", P, no_components_score()), make("zero", P, 0.0)])


def test_pass_unscored_still_ahead_of_unknown_and_fail() -> None:
    items = [
        make("f", F, no_components_score(rank_eligible=False)),
        make("u", UNK, unknown_score(no_active=True)),
        make("none", P, no_components_score()),
    ]
    assert ids(rank_assessments(items)) == ["none", "u", "f"]


def test_fail_ordering_by_score_lower_bound_without_known_before_bounded_rule() -> None:
    # D8 FAIL keys have no "known before bounded": an equal lower bound falls to risk, then id.
    items = [
        make("f-bounded-lo", F, bounded_score(10.0, 20.0, rank_eligible=False)),
        make("f-known", F, known_score(30.0, rank_eligible=False)),
        make("f-bounded-hi", F, bounded_score(30.0, 40.0, rank_eligible=False)),
    ]
    assert ids(rank_assessments(items)) == ["f-bounded-hi", "f-known", "f-bounded-lo"]


def test_fail_unscored_ordered_by_counts_then_risk_then_id() -> None:
    nf = no_components_score(rank_eligible=False)
    items = [
        make("z", F, nf, risk=RiskLevel.LOW),
        make("y", F, nf, risk=RiskLevel.HIGH),
        make("x", F, nf, risk=RiskLevel.LOW, statuses=(CS.FAIL, CS.FAIL)),
    ]
    assert ids(rank_assessments(items)) == ["z", "y", "x"]


def test_fail_orders_by_failed_then_unknown_constraint_count_first() -> None:
    two_fail = make("two-fail", F, 99.0, statuses=(CS.FAIL, CS.FAIL))
    one_fail_one_unknown = make("one-fail-unk", F, 1.0, statuses=(CS.FAIL, CS.UNKNOWN))
    one_fail = make("one-fail", F, 1.0, statuses=(CS.FAIL, CS.PASS))
    assert ids(rank_assessments([two_fail, one_fail_one_unknown, one_fail])) == [
        "one-fail",
        "one-fail-unk",
        "two-fail",
    ]


def test_unknown_orders_by_unknown_count_then_coverage_then_id() -> None:
    items = [
        make("u-many", UNK, statuses=(CS.UNKNOWN, CS.UNKNOWN)),
        make("u-b", UNK, coverage=(80.0, 90.0)),
        make("u-a", UNK, coverage=(80.0, 90.0)),
        make("u-cov", UNK, coverage=(95.0, 99.0)),
    ]
    assert ids(rank_assessments(items)) == ["u-cov", "u-a", "u-b", "u-many"]


# --- tie-breakers ------------------------------------------------------------------------------


def test_risk_tiebreak_low_moderate_high_unknown() -> None:
    items = [
        make(f"r-{r.value}", P, 50.0, risk=r)
        for r in (RiskLevel.UNKNOWN, RiskLevel.HIGH, RiskLevel.LOW, RiskLevel.MODERATE)
    ]
    assert ids(rank_assessments(items)) == [
        "r-low",
        "r-moderate",
        "r-high",
        "r-unknown",
    ]


def test_risk_never_overrides_score() -> None:
    r = rank_assessments(
        [
            make("risky-better", P, 60.0, risk=RiskLevel.UNKNOWN),
            make("safe-worse", P, 59.999999, risk=RiskLevel.LOW),
        ]
    )
    assert ids(r) == ["risky-better", "safe-worse"]


def test_exact_comparison_of_rounded_values_no_tolerance() -> None:
    r = rank_assessments([make("b", P, 70.000001), make("a", P, 70.0)])
    assert ids(r) == ["b", "a"]


def test_coverage_tiebreak_uses_min_of_sun_and_earth() -> None:
    items = [
        make("wide", P, 50.0, coverage=(100.0, 60.0)),  # min 60
        make("even", P, 50.0, coverage=(70.0, 70.0)),  # min 70
        make("best", P, 50.0, coverage=(99.0, 98.0)),  # min 98
    ]
    assert ids(rank_assessments(items)) == ["best", "even", "wide"]


def test_scenario_id_final_tiebreak_code_point_order() -> None:
    items = [make(i, P, 50.0) for i in ("b", "B", "a", "a-1", "A")]
    assert ids(rank_assessments(items)) == ["A", "B", "a", "a-1", "b"]


def test_risk_before_coverage_before_id() -> None:
    items = [
        make("a", P, 50.0, risk=RiskLevel.HIGH, coverage=(100.0, 100.0)),
        make("b", P, 50.0, risk=RiskLevel.LOW, coverage=(10.0, 10.0)),
        make("c", P, 50.0, risk=RiskLevel.LOW, coverage=(20.0, 20.0)),
    ]
    assert ids(rank_assessments(items)) == ["c", "b", "a"]


def test_fail_risk_tiebreak() -> None:
    sb = known_score(40.0, rank_eligible=False)
    items = [
        make("f-hi", F, sb, risk=RiskLevel.HIGH),
        make("f-lo", F, sb, risk=RiskLevel.LOW),
    ]
    assert ids(rank_assessments(items)) == ["f-lo", "f-hi"]


def test_missing_coverage_values_do_not_crash() -> None:
    items = [
        make("a", P, 50.0, coverage=(0.0, 0.0)),
        make("b", P, 50.0, coverage=(0.0, 100.0)),
    ]
    assert ids(rank_assessments(items)) == ["a", "b"]


# --- determinism ----------------------------------------------------------------------------------


def _mixed_population() -> list[ViabilityAssessment]:
    rng = random.Random(7)
    out = []
    for i in range(60):
        elig = rng.choice([P, P, F, UNK])
        risk = rng.choice(list(RiskLevel))
        cov = (float(rng.randint(0, 100)), float(rng.randint(0, 100)))
        if elig is UNK:
            sb: ScoreBreakdown | float | None = None
        else:
            kind = rng.choice(["known", "known", "bounded"])
            ok = elig is P
            if kind == "known":
                sb = known_score(float(rng.randint(0, 4)) * 25.0, rank_eligible=ok)
            else:
                lo = float(rng.randint(0, 3)) * 25.0
                sb = bounded_score(lo, lo + 10.0, rank_eligible=ok)
        out.append(make(f"s{i:03d}", elig, sb, risk=risk, coverage=cov))
    return out


def test_order_independent_of_input_order() -> None:
    items = _mixed_population()
    baseline = rank_assessments(items).model_dump_json()
    rng = random.Random(1)
    for _ in range(10):
        shuffled = items[:]
        rng.shuffle(shuffled)
        assert rank_assessments(shuffled).model_dump_json() == baseline
    assert rank_assessments(reversed(items)).model_dump_json() == baseline  # also accepts any iterable


def test_result_is_valid_contract_and_roundtrips() -> None:
    r = rank_assessments(_mixed_population())
    assert RankingResult.model_validate_json(r.model_dump_json()) == r


def test_scales_to_thousands() -> None:
    items = [make(f"s{i:05d}", P, float(i % 101)) for i in range(2000)]
    r = rank_assessments(items)
    assert len(r.entries) == 2000 and r.entries[0].score == 100.0


# --- empty / singleton -------------------------------------------------------------------------------


def test_empty_input() -> None:
    r = rank_assessments([])
    assert r.entries == [] and r.data_basis is None and r.policy is None
    assert ranking_explanations([], r) == {}


@pytest.mark.parametrize(("elig", "rank"), [(P, 1), (F, None), (UNK, None)])
def test_singleton(elig: Eligibility, rank: int | None) -> None:
    r = rank_assessments([make("only", elig, 33.0 if elig is not UNK else None)])
    assert ids(r) == ["only"] and r.entries[0].rank == rank
    assert r.data_basis is DataBasis.SYNTHETIC and r.policy is ComparabilityPolicy.STRICT


def test_all_unranked_has_no_ranks() -> None:
    r = rank_assessments([make("u", UNK), make("f", F, 5.0)])
    assert all(e.rank is None for e in r.entries)


# --- duplicates ------------------------------------------------------------------------------------


def test_duplicate_ids_rejected() -> None:
    with pytest.raises(RankingComparabilityError, match="duplicate scenario_id.*'x'"):
        rank_assessments([make("x", P, 1.0), make("y", P, 2.0), make("x", F, 3.0)])


def test_duplicate_ids_rejected_by_partition() -> None:
    with pytest.raises(RankingComparabilityError, match="duplicate"):
        partition_comparable([make("x"), make("x")])


# --- comparability ------------------------------------------------------------------------------------


def test_legacy_score_without_phase5_metadata_rejected() -> None:
    legacy = make("legacy", P)
    kw = legacy.model_dump(mode="python")
    kw["score"] = {"method_version": "m1", "score": 10.0, "rank_eligible": True}
    legacy = ViabilityAssessment.model_validate(kw)
    with pytest.raises(RankingComparabilityError, match="Phase 5 metadata"):
        rank_assessments([legacy, make("ok", P, 1.0)])


@pytest.mark.parametrize(
    "other",
    [DataBasis.REAL_TERRAIN_AWARE, DataBasis.REAL_GEOMETRIC_ONLY],
)
@pytest.mark.parametrize("policy", list(ComparabilityPolicy))
def test_synthetic_never_competes_with_real_under_any_policy(other: DataBasis, policy: ComparabilityPolicy) -> None:
    with pytest.raises(RankingComparabilityError, match="data basis"):
        rank_assessments([make("syn", P, 99.0), make("real", P, 1.0, basis=other)], policy)


@pytest.mark.parametrize("policy", list(ComparabilityPolicy))
def test_real_terrain_and_geometric_not_mixed(policy: ComparabilityPolicy) -> None:
    items = [
        make("a", P, 1.0, basis=DataBasis.REAL_TERRAIN_AWARE),
        make("b", P, 1.0, basis=DataBasis.REAL_GEOMETRIC_ONLY),
    ]
    with pytest.raises(RankingComparabilityError, match="real_geometric_only"):
        rank_assessments(items, policy)


def test_mixed_basis_error_even_when_the_odd_one_is_unranked() -> None:
    with pytest.raises(RankingComparabilityError):
        rank_assessments([make("p", P, 5.0), make("f", F, 5.0, basis=DataBasis.REAL_TERRAIN_AWARE)])


@pytest.mark.parametrize("basis", [DataBasis.REAL_TERRAIN_AWARE, DataBasis.REAL_GEOMETRIC_ONLY])
def test_each_real_basis_ranks_alone_and_is_recorded(basis: DataBasis) -> None:
    r = rank_assessments([make("a", P, 1.0, basis=basis), make("b", P, 2.0, basis=basis)])
    assert r.data_basis is basis and all(e.data_basis is basis for e in r.entries)


def test_method_mismatch_rejected_under_both_policies() -> None:
    other = make("b", P, known_score(50.0, method="m2"))
    for policy in ComparabilityPolicy:
        with pytest.raises(RankingComparabilityError, match="scoring method"):
            rank_assessments([make("a", P, 10.0), other], policy)


def test_weights_mismatch_rejected_under_both_policies() -> None:
    other = make("b", P, known_score(50.0, two_active=True))
    for policy in ComparabilityPolicy:
        with pytest.raises(RankingComparabilityError, match="weights"):
            rank_assessments([make("a", P, 10.0), other], policy)


def test_requirements_mismatch_strict_vs_relaxed() -> None:
    a, b = make("a", P, 10.0), make("b", P, known_score(90.0, key=OTHER_KEY))
    with pytest.raises(RankingComparabilityError, match="configuration fingerprint"):
        rank_assessments([a, b])  # strict is the default
    with pytest.raises(RankingComparabilityError):
        rank_assessments([a, b], ComparabilityPolicy.STRICT)
    r = rank_assessments([a, b], ComparabilityPolicy.SAME_METHOD_AND_WEIGHTS)
    assert ids(r) == ["b", "a"] and r.policy is ComparabilityPolicy.SAME_METHOD_AND_WEIGHTS


def test_duration_mismatch_strict_vs_relaxed() -> None:
    a, b = make("a", P, 10.0), make("b", P, 90.0, hours=48.0)
    with pytest.raises(RankingComparabilityError, match="evaluated duration"):
        rank_assessments([a, b])
    assert ids(rank_assessments([a, b], "same_method_and_weights")) == ["b", "a"]


def test_relaxed_still_requires_same_method_weights_basis() -> None:
    relaxed = ComparabilityPolicy.SAME_METHOD_AND_WEIGHTS
    with pytest.raises(RankingComparabilityError):
        rank_assessments([make("a", P, 1.0), make("b", P, known_score(1.0, method="m9"))], relaxed)
    with pytest.raises(RankingComparabilityError):
        rank_assessments(
            [make("a", P, 1.0), make("b", P, 1.0, basis=DataBasis.REAL_TERRAIN_AWARE)],
            relaxed,
        )


def test_equivalent_weights_scale_invariant() -> None:
    # 1:1 on SUN+EARTH is the same weighting no matter the declared scale (exact rationals)
    assert rank_assessments(
        [
            make("a", P, known_score(1.0, two_active=True)),
            make("b", P, known_score(2.0, two_active=True)),
        ]
    )


def test_comparability_error_is_deterministic_regardless_of_input_order() -> None:
    items = [
        make("a", P, 1.0),
        make("b", P, known_score(1.0, key=OTHER_KEY)),
        make("c", P, known_score(1.0, key=OTHER_KEY)),
    ]
    msgs = set()
    for perm in ([0, 1, 2], [2, 1, 0], [1, 2, 0]):
        with pytest.raises(RankingComparabilityError) as ei:
            rank_assessments([items[i] for i in perm])
        msgs.add(str(ei.value))
    assert len(msgs) == 1


def test_unknown_policy_string_rejected() -> None:
    with pytest.raises(ValueError):
        rank_assessments([make("a")], "anything_goes")


def test_unknown_and_fail_must_also_be_comparable() -> None:
    odd = make("u", UNK, unknown_score(key=OTHER_KEY))
    with pytest.raises(RankingComparabilityError):
        rank_assessments([make("p", P, 1.0), odd])


def test_partition_comparable_groups_deterministically() -> None:
    items = [
        make("c", P, known_score(1.0, key=OTHER_KEY)),
        make("a", P, 1.0),
        make("d", P, 1.0, basis=DataBasis.REAL_TERRAIN_AWARE),
        make("b", P, 2.0),
    ]
    groups = partition_comparable(items)
    assert [[a.scenario_id for a in g] for g in groups] == [["a", "b"], ["c"], ["d"]]
    assert [[a.scenario_id for a in g] for g in partition_comparable(reversed(items))] == [["a", "b"], ["c"], ["d"]]
    assert len(partition_comparable(items, "same_method_and_weights")) == 2  # synthetic merged, real apart
    for g in groups:
        assert rank_assessments(g)  # every group is rankable


# --- no mutation / no recalculation ------------------------------------------------------------------


def test_assessments_are_not_mutated() -> None:
    items = _mixed_population()
    before = [a.model_dump_json() for a in items]
    order = [a.scenario_id for a in items]
    rank_assessments(items)
    assert [a.model_dump_json() for a in items] == before
    assert [a.scenario_id for a in items] == order


def test_scores_and_eligibility_are_copied_verbatim() -> None:
    items = _mixed_population()
    by_id = {a.scenario_id: a for a in items}
    for e in rank_assessments(items).entries:
        a = by_id[e.scenario_id]
        assert e.eligibility is a.eligibility and e.score == a.score.score and e.score_status is a.score.status
        assert e.score_bounds == a.score.score_bounds and e.overall_risk is a.overall_risk


# --- serialization and explanation ------------------------------------------------------------------------


def test_serialization_metadata() -> None:
    r = rank_assessments([make("p", P, bounded_score(10.0, 20.0)), make("u", UNK), make("f", F, 5.0)])
    d = json.loads(r.model_dump_json())
    assert d["method_version"] == "m1" and d["data_basis"] == "synthetic" and d["policy"] == "strict"
    assert [e["rank"] for e in d["entries"]] == [1, None, None]
    assert d["entries"][0]["score"] is None and d["entries"][0]["score_status"] == "bounded"
    assert d["entries"][1]["score_status"] == "eligibility_unknown"


def test_explanations() -> None:
    items = [
        make("p", P, bounded_score(10.0, 20.0)),
        make("u", UNK, statuses=(CS.PASS, CS.UNKNOWN)),
        make("f", F, 77.0, statuses=(CS.FAIL, CS.PASS)),
    ]
    r = rank_assessments(items)
    ex = ranking_explanations(items, r)
    assert list(ex) == ids(r)
    assert "Rank 1" in ex["p"] and "lower bound" in ex["p"] and "bounded" in ex["p"]
    n = [make("n", P, no_components_score())]
    assert "no scorable components" in ranking_explanations(n, rank_assessments(n))["n"]
    assert "UNKNOWN" in ex["u"] and "never scored" in ex["u"]
    assert "FAIL" in ex["f"] and "descriptive only" in ex["f"] and "77.0" in ex["f"]
