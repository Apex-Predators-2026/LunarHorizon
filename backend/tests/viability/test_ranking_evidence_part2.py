"""Part 2A: pairwise ranking evidence and the ranking-explanation fix.

Three kinds of input, as in Phase 5:

* SYNTHETIC hourly series through the real ``evaluate_scenario`` (``test_phase5_integration.run``): closed-form,
  hand-checkable exact, bounded, FAIL and UNKNOWN cases.
* Validated hand-built assessments (``test_ranking_phase5.make``) for tie-break combinations the engine cannot
  isolate (equal scores with different risk or coverage), and one TEST-ONLY exact twin of a bounded assessment
  (rebuilt through full model validation) for "exact vs bounded at an equal lower bound".
* REAL terrain-aware site files through Rescue's production path, with expectations derived from the computed
  assessments, never pinned (Member 1 may regenerate the terrain).
"""

from __future__ import annotations

import itertools
import math
import random
from datetime import UTC, datetime, timedelta
from fractions import Fraction
from pathlib import Path
from typing import Any

import pytest

from app.models import Scenario
from app.rescue.catalog import get_site
from app.rescue.timeline import PrecomputedTimelineProvider, SyntheticTimelineProvider
from app.viability.compat.rescue import evaluate_timeline_detailed
from app.viability.engine import evaluate_scenario
from app.viability.enums import (
    ComparabilityPolicy,
    ConstraintId,
    ConstraintStatus,
    DataBasis,
    Eligibility,
    MetricStatus,
    RiskLevel,
    ScoreComponent,
    ScoreStatus,
    Unit,
)
from app.viability.outputs import Metric, RankedScenario, RankingResult, ScoreBreakdown, ViabilityAssessment
from app.viability.ranking import (
    ORDER_KEY_CRITERIA,
    RankingCriterion,
    comparability_issues,
    rank_assessments,
    ranking_explanations,
    ranking_order_key,
)
from app.viability.ranking_evidence import (
    EVIDENCE_METHOD_VERSION,
    SYNTHETIC_PREFIX,
    Advantage,
    DifferenceStatus,
    PairwiseEvidence,
    PointsInterval,
    _down,
    _up,
    compare_scenarios,
    explain_adjacent,
    score_difference,
    score_text,
)

from .helpers import assessment_kwargs, hourly
from .test_phase5_integration import GOOD, HALF, T0, UNKNOWN_TAIL, pretend_real_geometric, run, scenario_for
from .test_ranking_phase5 import bounded_score, known_score, make, no_components_score

P, F, UNK = Eligibility.PASS, Eligibility.FAIL, Eligibility.UNKNOWN
CS = ConstraintStatus
V, N, U = "V", "N", "U"
ABOVE = [V] * 44 + [N] * 4  # exact ~94.2: inside UNKNOWN_TAIL's bounds [~90.8, 100]
DEAD = [V] * 2 + [N] * 46  # breaks the 40 h darkness limit -> FAIL
ALL_UNKNOWN = [U] * 48  # terrain unknown throughout -> UNKNOWN
SITES_DIR = Path(__file__).resolve().parents[3] / "data" / "sites"
DATA_END = datetime(2029, 1, 1, tzinfo=UTC)


# --- helpers -----------------------------------------------------------------------------------------


def score_span(a: ViabilityAssessment) -> tuple[Fraction, Fraction]:
    """Exact rational score interval from the stored decimal values (test-side, independent)."""
    b = a.score.score_bounds
    assert b is not None
    if b.status is MetricStatus.KNOWN:
        assert b.value is not None
        return Fraction(repr(b.value)), Fraction(repr(b.value))
    assert b.lower is not None and b.upper is not None
    return Fraction(repr(b.lower)), Fraction(repr(b.upper))


def contains(interval: PointsInterval, lo: Fraction, hi: Fraction) -> bool:
    return Fraction(interval.lower) <= lo and hi <= Fraction(interval.upper)


def exact_twin_at_lower_bound(a: ViabilityAssessment, sid: str) -> ViabilityAssessment:
    """TEST ONLY: ``a`` with every bounded component pinned to its lower end, so the score is exact and equals
    ``a``'s lower bound. Rebuilt through full ``ViabilityAssessment`` validation (no ``model_copy`` shortcut)."""
    assert a.score.score_bounds is not None and a.score.score_bounds.lower is not None
    lower = a.score.score_bounds.lower
    data = a.model_dump()
    for c in data["score"]["components"]:
        n = c["normalized"]
        if n is not None and n["status"] is MetricStatus.BOUNDED:
            v = n["lower"]
            c["normalized"] = Metric.known(v, Unit.FRACTION).model_dump()
            c["normalized_value"] = v
            c["contribution"] = c["weight"] * v * 100.0
    data["score"].update(
        score=lower, status=ScoreStatus.KNOWN, score_bounds=Metric.known(lower, Unit.PERCENT).model_dump()
    )
    data["scenario_id"] = sid
    return ViabilityAssessment.model_validate(data)


def legacy(sid: str) -> ViabilityAssessment:
    kw = assessment_kwargs(P, (CS.PASS,))
    kw["scenario_id"] = sid
    kw["score"] = ScoreBreakdown(method_version="legacy", score=40.0, rank_eligible=True)
    return ViabilityAssessment(**kw)


# --- 1. ranking explanation fix (regression) ---------------------------------------------------------


def test_pass_explanation_names_every_tie_break_in_the_actual_key_order() -> None:
    bounded = run(UNKNOWN_TAIL, "a-bounded")
    twin = exact_twin_at_lower_bound(bounded, "z-exact")
    result = rank_assessments([bounded, twin])
    assert [e.scenario_id for e in result.entries] == ["z-exact", "a-bounded"]  # exact first despite its id
    text = ranking_explanations([bounded, twin], result)["z-exact"]
    # The step that decided this order must be stated (it was missing before Part 2A) ...
    assert "exact score precedes a bounded one" in text
    # ... and every PASS key appears in the order ranking.py applies it.
    order = text[text.index("Ordered by") :]
    marks = ["score lower bound", "exact score precedes a bounded one", "lower risk", "higher coverage", "scenario id"]
    positions = [order.index(m) for m in marks]
    assert positions == sorted(positions)
    names = ORDER_KEY_CRITERIA[P]
    assert names.index(RankingCriterion.EXACT_BEFORE_BOUNDED) < names.index(RankingCriterion.OVERALL_RISK)


def test_order_key_criteria_name_every_position_of_the_ranking_key() -> None:
    samples = {
        P: run(GOOD, "p"),
        F: run(DEAD, "f"),
        UNK: run(ALL_UNKNOWN, "u"),
    }
    for elig, a in samples.items():
        assert a.eligibility is elig
        key = ranking_order_key(a)
        names = ORDER_KEY_CRITERIA[elig]
        assert len(key) == len(names) and len(set(names)) == len(names)
        assert names[0] is RankingCriterion.ELIGIBILITY and names[-1] is RankingCriterion.SCENARIO_ID
        assert key[-1] == a.scenario_id


# --- 2. scores: known, disjoint, overlapping, equal, exact vs bounded, unavailable -------------------


def test_known_scores_with_disjoint_values() -> None:
    good, half = run(GOOD, "z-good"), run(HALF, "a-half")
    e = compare_scenarios(half, good)
    assert e.comparable and e.higher_id == "z-good" and e.selected_ranks_higher is False
    assert e.deciding_criterion is RankingCriterion.SCORE_LOWER_BOUND
    d = e.score_difference
    assert d.status is DifferenceStatus.COMPETITOR_HIGHER and d.both_exact and d.interval is not None
    exact = score_span(half)[0] - score_span(good)[0]
    assert contains(d.interval, exact, exact) and d.interval.upper - d.interval.lower <= 2e-6
    assert "higher" in d.statement and "exact score" in d.statement
    assert e.explanation.startswith(SYNTHETIC_PREFIX)
    assert "z-good ranks above a-half: its desirability score is higher everywhere" in e.explanation


def test_bounded_scores_with_disjoint_intervals_establish_superiority() -> None:
    bounded, half = run(UNKNOWN_TAIL, "bounded"), run(HALF, "half")
    lo, hi = score_span(bounded)
    assert lo < hi and score_span(half)[1] < lo
    e = compare_scenarios(bounded, half)
    assert e.higher_id == "bounded" and e.deciding_criterion is RankingCriterion.SCORE_LOWER_BOUND
    d = e.score_difference
    assert d.status is DifferenceStatus.SELECTED_HIGHER and not d.both_exact and d.interval is not None
    assert d.interval.lower > 0.0
    assert contains(d.interval, lo - score_span(half)[1], hi - score_span(half)[0])
    assert "everywhere within the recorded bounds" in e.explanation
    assert e.selected.score is None and e.selected.score_status is ScoreStatus.BOUNDED  # never shown as exact
    assert any("conservative ordering policy" in x for x in e.limitations)


def test_overlapping_intervals_do_not_establish_superiority() -> None:
    bounded, above = run(UNKNOWN_TAIL, "a-bounded"), run(ABOVE, "b-above")
    lo, hi = score_span(bounded)
    s = score_span(above)[0]
    assert lo < s < hi  # the exact score lies inside the bounded interval
    e = compare_scenarios(bounded, above)
    assert e.higher_id == "b-above" and e.deciding_criterion is RankingCriterion.SCORE_LOWER_BOUND
    d = e.score_difference
    assert d.status is DifferenceStatus.NOT_ESTABLISHED and d.interval is not None
    assert d.interval.lower < 0.0 < d.interval.upper and contains(d.interval, lo - s, hi - s)
    assert "does not establish which score is higher" in d.statement
    assert "but their score ranges overlap" in e.explanation
    assert "does not prove b-above has a higher desirability score" in e.explanation
    assert "equally good" not in e.explanation and "equal" not in d.statement


def test_exact_before_bounded_at_an_equal_lower_bound() -> None:
    bounded = run(UNKNOWN_TAIL, "a-bounded")
    twin = exact_twin_at_lower_bound(bounded, "z-exact")
    assert twin.score.score == bounded.score.lower_bound
    e = compare_scenarios(bounded, twin)
    assert e.higher_id == "z-exact" and e.deciding_criterion is RankingCriterion.EXACT_BEFORE_BOUNDED
    d = e.score_difference
    assert d.status is DifferenceStatus.NOT_ESTABLISHED and d.interval is not None
    assert d.interval.lower == 0.0 and d.interval.upper > 0.0  # bounded - exact in [0, upper - lower]
    assert "only because" in e.explanation and "does not prove z-exact" in e.explanation
    assert "Equal score lower bound" in e.deciding_detail


def test_exactly_equal_evidence_falls_to_the_scenario_id_tie_break() -> None:
    a, b = run(UNKNOWN_TAIL, "tie-a"), run(UNKNOWN_TAIL, "tie-b")
    e = compare_scenarios(b, a)
    assert e.higher_id == "tie-a" and e.deciding_criterion is RankingCriterion.SCENARIO_ID
    assert e.score_difference.status is DifferenceStatus.NOT_ESTABLISHED
    assert "Neither is preferred by the evidence" in e.explanation
    assert all(c.advantage in (Advantage.EQUAL, Advantage.NOT_ESTABLISHED, Advantage.INACTIVE) for c in e.components)


def test_identical_exact_scores_are_reported_without_claiming_equal_sites() -> None:
    a, b = run(GOOD, "same-a"), run(GOOD, "same-b")
    d = compare_scenarios(a, b).score_difference
    assert d.status is DifferenceStatus.NOT_ESTABLISHED and d.both_exact
    assert d.interval == PointsInterval(lower=0.0, upper=0.0)
    assert "identical" in d.statement and "not mean the sites are physically equivalent" in d.statement


def test_unavailable_score_is_never_read_as_zero() -> None:
    good, unknown = run(GOOD, "good"), run(ALL_UNKNOWN, "unknown")
    assert unknown.eligibility is UNK and unknown.score.score is None
    assert not comparability_issues(good, unknown)  # same configuration: comparable, but not scored
    e = compare_scenarios(unknown, good)
    assert e.higher_id == "good" and e.deciding_criterion is RankingCriterion.ELIGIBILITY
    d = e.score_difference
    assert d.status is DifferenceStatus.UNAVAILABLE and d.interval is None and not d.both_exact
    assert "never treated as 0" in d.statement and e.components == []
    assert e.selected.score is None and e.selected.score_bounds is None
    assert e.selected.excluded_from_viable_ranking and "UNKNOWN" in (e.selected.exclusion_reason or "")
    assert "not scored until the missing data is available" in e.explanation


def test_unscored_configuration_is_not_comparable_with_a_scored_one() -> None:
    scored, unscored = make("scored", P, 10.0), make("unscored", P, no_components_score())
    # No active component means all-zero effective weights, so the two never share a ranking under any policy.
    e = compare_scenarios(unscored, scored)
    assert not e.comparable and "effective score weights" in "; ".join(e.comparability_issues)
    assert e.score_difference.status is DifferenceStatus.NOT_COMPARABLE
    assert e.selected.score_text.startswith("not scored")


# --- 3. eligibility tiers ----------------------------------------------------------------------------


def test_pass_versus_fail_versus_unknown() -> None:
    good, dead, unknown = run(GOOD, "z-pass"), run(DEAD, "a-fail"), run(ALL_UNKNOWN, "m-unknown")
    assert (good.eligibility, dead.eligibility, unknown.eligibility) == (P, F, UNK)

    pf = compare_scenarios(dead, good)
    assert pf.higher_id == "z-pass" and pf.deciding_criterion is RankingCriterion.ELIGIBILITY
    assert pf.selected.excluded_from_viable_ranking and not pf.competitor.excluded_from_viable_ranking
    assert pf.selected.failed_constraints == [ConstraintId.MAX_CONTINUOUS_DARKNESS]
    assert "fails max_continuous_darkness" in pf.explanation and "descriptive only" in pf.explanation
    assert any("descriptive only" in x for x in pf.limitations)

    uf = compare_scenarios(dead, unknown)
    assert uf.higher_id == "m-unknown" and uf.deciding_criterion is RankingCriterion.ELIGIBILITY
    assert "Neither m-unknown nor a-fail is a viable candidate" in uf.explanation
    assert "neither receives a rank" in uf.explanation

    result = rank_assessments([dead, unknown, good])
    ev = compare_scenarios(good, dead, ranking=result)
    assert ev.selected.rank == 1 and ev.competitor.rank is None


def test_two_fail_scenarios_are_ordered_without_a_rank() -> None:
    one = make("one-fail", F, 90.0, statuses=(CS.FAIL, CS.PASS))
    two = make("two-fail", F, 10.0, statuses=(CS.FAIL, CS.FAIL))
    e = compare_scenarios(two, one)
    assert e.higher_id == "one-fail" and e.deciding_criterion is RankingCriterion.FAIL_CONSTRAINT_COUNT
    assert "Neither one-fail nor two-fail is a viable candidate" in e.explanation
    lower_fail = make("z-fail", F, 30.0)
    e2 = compare_scenarios(make("a-fail", F, 70.0), lower_fail)
    assert e2.deciding_criterion is RankingCriterion.SCORE_LOWER_BOUND and e2.higher_id == "a-fail"
    assert "Neither receives a rank" in e2.explanation


# --- 4. tie-breaks that the engine cannot isolate (validated hand-built assessments) -----------------


def test_risk_tie_break() -> None:
    low, high = make("z-low", P, 50.0, risk=RiskLevel.LOW), make("a-high", P, 50.0, risk=RiskLevel.HIGH)
    e = compare_scenarios(high, low)
    assert e.higher_id == "z-low" and e.deciding_criterion is RankingCriterion.OVERALL_RISK
    assert "on a tie-break, not on score" in e.explanation and "never changes a score" in e.deciding_detail


def test_coverage_tie_break() -> None:
    full = make("z-full", P, 50.0, coverage=(100.0, 100.0))
    gappy = make("a-gappy", P, 50.0, coverage=(100.0, 92.5))
    e = compare_scenarios(gappy, full)
    assert e.higher_id == "z-full" and e.deciding_criterion is RankingCriterion.MIN_COVERAGE
    assert "92.5%" in e.deciding_detail and e.selected.min_coverage_percent == 92.5


# --- 5. comparability: configuration, data basis, synthetic vs real ----------------------------------


def test_incompatible_configurations_are_never_ordered() -> None:
    a = run(GOOD, "a-40h")
    b = run(GOOD, "b-30h", dark_h=30.0)
    e = compare_scenarios(a, b)
    assert not e.comparable and e.higher_id is None and e.deciding_criterion is None
    assert "requirements/configuration fingerprint" in "; ".join(e.comparability_issues)
    assert e.score_difference.status is DifferenceStatus.NOT_COMPARABLE and e.score_difference.interval is None
    assert e.components == [] and "must not share one leaderboard" in e.explanation
    # The explicit opt-in compares them, and says what that means.
    opt = compare_scenarios(a, b, policy=ComparabilityPolicy.SAME_METHOD_AND_WEIGHTS)
    assert opt.comparable and any("SAME_METHOD_AND_WEIGHTS" in x for x in opt.limitations)


def test_different_scientific_data_bases_are_never_ordered() -> None:
    series = hourly(GOOD, geometric=True)
    scenario = scenario_for(series, "geom", T0, T0 + timedelta(hours=len(GOOD)))
    synthetic = evaluate_scenario(scenario, series)
    real_geom = evaluate_scenario(
        scenario.model_copy(update={"scenario_id": "geom-real"}), pretend_real_geometric(series)
    )
    assert (synthetic.data_basis, real_geom.data_basis) == (DataBasis.SYNTHETIC, DataBasis.REAL_GEOMETRIC_ONLY)
    for pol in ComparabilityPolicy:
        e = compare_scenarios(synthetic, real_geom, policy=pol)
        assert not e.comparable and "data basis" in e.comparability_issues[0]
        assert e.explanation.startswith(SYNTHETIC_PREFIX)
        assert any("geometric-only" in x for x in e.limitations)


def test_legacy_score_is_reported_not_raised() -> None:
    e = compare_scenarios(legacy("old"), make("new", P, 40.0))
    assert not e.comparable and "no Phase 5 metadata" in e.comparability_issues[0]
    assert "legacy score 40" in e.selected.score_text


# --- 6. component contributions ----------------------------------------------------------------------


def test_component_contributions_come_from_the_score_breakdown() -> None:
    good, half = run(GOOD, "good"), run(HALF, "half")
    e = compare_scenarios(good, half)
    by = {c.component: c for c in e.components}
    assert [c.component for c in e.components] == list(ScoreComponent)
    for comp in ScoreComponent:
        cg = next(c for c in good.score.components if c.component is comp)
        ch = next(c for c in half.score.components if c.component is comp)
        ev = by[comp]
        assert ev.weight == cg.weight == ch.weight
        if cg.contribution is None:
            assert ev.advantage is Advantage.INACTIVE and ev.contribution_difference is None
            continue
        assert ch.contribution is not None and ev.selected_contribution is not None
        assert contains(ev.selected_contribution, Fraction(repr(cg.contribution)), Fraction(repr(cg.contribution)))
        assert ev.selected_value == cg.normalized and ev.competitor_value == ch.normalized
        diff = Fraction(repr(cg.contribution)) - Fraction(repr(ch.contribution))
        assert ev.contribution_difference is not None and contains(ev.contribution_difference, diff, diff)
    # GOOD is always lit, HALF is dark for 24 h; Earth is visible throughout in both.
    assert by[ScoreComponent.SUNLIGHT].advantage is Advantage.SELECTED
    assert by[ScoreComponent.DARKNESS_MARGIN].advantage is Advantage.SELECTED
    assert by[ScoreComponent.EARTH_VISIBILITY].advantage is Advantage.EQUAL
    assert by[ScoreComponent.CLEARANCE_MARGIN].advantage is Advantage.INACTIVE
    assert "good benefits from" in e.explanation and "greater darkness headroom" in e.explanation
    assert "more sunlight" in e.explanation and "Earth visibility" not in e.explanation
    # Per-component differences sum to the score difference (same weights; exact components).
    total = sum(
        (Fraction(c.contribution_difference.lower) for c in e.components if c.contribution_difference), Fraction(0)
    )
    assert e.score_difference.interval is not None
    assert abs(total - Fraction(e.score_difference.interval.lower)) <= Fraction(1, 10**5)


def test_bounded_component_contribution_is_an_interval() -> None:
    bounded, good = run(UNKNOWN_TAIL, "bounded"), run(GOOD, "good")
    e = compare_scenarios(bounded, good)
    partial = [
        c for c in e.components if c.selected_value is not None and c.selected_value.status is MetricStatus.BOUNDED
    ]
    assert partial, "UNKNOWN_TAIL must leave at least one component bounded"
    for c in partial:
        assert c.selected_contribution is not None and c.selected_contribution.lower < c.selected_contribution.upper
        assert c.advantage in (Advantage.NOT_ESTABLISHED, Advantage.COMPETITOR)


def test_competitor_strength_is_named_when_established() -> None:
    lit_no_earth = run(GOOD, "z-lit", earth=[N] * 8 + [V] * 40)  # always lit, 8 h blackout at start
    dark_earth = run(HALF, "a-earth")  # 24 h dark, Earth always visible
    e = compare_scenarios(lit_no_earth, dark_earth)
    by = {c.component: c.advantage for c in e.components}
    assert by[ScoreComponent.SUNLIGHT] is Advantage.SELECTED
    assert by[ScoreComponent.EARTH_VISIBILITY] is Advantage.COMPETITOR
    loser = e.competitor.scenario_id if e.selected_ranks_higher else e.selected.scenario_id
    assert f", while {loser} has" in e.explanation or f"{loser} benefits from" in e.explanation
    assert "stronger Earth visibility" in e.explanation


# --- 7. conservative rounding ------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("x", "down", "up"),
    [
        (Fraction(1, 3), 0.333333, 0.333334),
        (Fraction(-1, 3), -0.333334, -0.333333),
        (Fraction(0), 0.0, 0.0),
        (Fraction(-1, 10**9), -0.000001, 0.0),
        (Fraction(5, 4), 1.25, 1.25),
    ],
)
def test_outward_rounding_values(x: Fraction, down: float, up: float) -> None:
    assert _down(x) == pytest.approx(down, abs=1e-15) and _up(x) == pytest.approx(up, abs=1e-15)
    assert Fraction(_down(x)) <= x <= Fraction(_up(x))
    assert math.copysign(1.0, _up(Fraction(-1, 10**9))) == 1.0  # never -0.0


def test_outward_rounding_always_contains_the_exact_value() -> None:
    rng = random.Random(20261114)
    for _ in range(2000):
        x = Fraction(rng.randint(-(10**12), 10**12), rng.choice([1, 3, 7, 10**6, 10**7, 3 * 10**6 + 1]))
        lo, hi = _down(x), _up(x)
        assert Fraction(lo) <= x <= Fraction(hi)
        assert hi - lo <= 1e-6 + 1e-9 * max(1.0, abs(float(x)))


def test_score_difference_on_grid_values_is_exact() -> None:
    hi = make("hi", P, bounded_score(79.044225, 80.499087))
    lo = make("lo", P, known_score(80.499086))
    d = score_difference(hi, lo)
    assert d.status is DifferenceStatus.NOT_ESTABLISHED and d.interval is not None
    assert d.interval.lower == pytest.approx(-1.454861, abs=1e-12)
    assert d.interval.upper == pytest.approx(0.000001, abs=1e-12)
    assert Fraction(d.interval.lower) <= Fraction("79.044225") - Fraction("80.499086")
    assert Fraction(d.interval.upper) >= Fraction("80.499087") - Fraction("80.499086")


# --- 8. agreement with the actual ranking, determinism, immutability ---------------------------------


def _random_assessment(rng: random.Random, i: int) -> ViabilityAssessment:
    elig = rng.choice([P, P, P, F, UNK])
    risk = rng.choice(list(RiskLevel))
    cov = (100.0, rng.choice([100.0, 100.0, 95.0, 80.0]))
    if elig is UNK:
        return make(f"s{i:02d}", UNK, risk=risk, coverage=cov, statuses=rng.choice([(CS.UNKNOWN,), (CS.UNKNOWN,) * 2]))
    lo = float(rng.choice([20, 40, 40, 60, 60, 80]))
    sb = (
        bounded_score(lo, lo + rng.choice([5.0, 10.0]), rank_eligible=elig is P)
        if rng.random() < 0.4
        else known_score(lo, rank_eligible=elig is P)
    )
    statuses = (CS.PASS,) if elig is P else rng.choice([(CS.FAIL,), (CS.FAIL, CS.FAIL), (CS.FAIL, CS.UNKNOWN)])
    return make(f"s{i:02d}", elig, sb, risk=risk, coverage=cov, statuses=statuses)


@pytest.mark.parametrize("seed", range(8))
def test_pairwise_order_agrees_with_rank_assessments(seed: int) -> None:
    rng = random.Random(seed)
    items = [_random_assessment(rng, i) for i in range(12)]
    result = rank_assessments(items)
    order = [e.scenario_id for e in result.entries]
    by_id = {a.scenario_id: a for a in items}
    for i, x in enumerate(order):
        for y in order[i + 1 :]:
            e = compare_scenarios(by_id[y], by_id[x], ranking=result)
            assert e.higher_id == x and e.selected_ranks_higher is False
            ka, kb = ranking_order_key(by_id[x]), ranking_order_key(by_id[y])
            assert e.deciding_criterion is not None
            if by_id[x].eligibility is by_id[y].eligibility:
                pos = ORDER_KEY_CRITERIA[by_id[x].eligibility].index(e.deciding_criterion)
                assert ka[:pos] == kb[:pos] and ka[pos] != kb[pos] and ka < kb
            else:
                assert e.deciding_criterion is RankingCriterion.ELIGIBILITY
    adjacent = explain_adjacent(list(reversed(items)))
    assert [(x.selected.scenario_id, x.competitor.scenario_id) for x in adjacent] == list(itertools.pairwise(order))


def test_swapping_arguments_mirrors_the_evidence() -> None:
    a, b = run(UNKNOWN_TAIL, "a-bounded"), run(ABOVE, "b-above")
    ab, ba = compare_scenarios(a, b), compare_scenarios(b, a)
    assert ab.higher_id == ba.higher_id and ab.deciding_criterion is ba.deciding_criterion
    assert ab.selected_ranks_higher is not ba.selected_ranks_higher
    assert ab.score_difference.interval is not None and ba.score_difference.interval is not None
    assert ab.score_difference.interval.lower == -ba.score_difference.interval.upper
    assert ab.score_difference.interval.upper == -ba.score_difference.interval.lower
    swap = {Advantage.SELECTED: Advantage.COMPETITOR, Advantage.COMPETITOR: Advantage.SELECTED}
    assert [swap.get(c.advantage, c.advantage) for c in ab.components] == [c.advantage for c in ba.components]
    assert ab.explanation == ba.explanation  # phrased by rank, not by argument order


def test_explain_adjacent_is_independent_of_input_order() -> None:
    items = [run(s, sid) for s, sid in ((GOOD, "good"), (HALF, "half"), (UNKNOWN_TAIL, "tail"), (ABOVE, "above"))]
    first = explain_adjacent(items)
    for seed in range(5):
        shuffled = items[:]
        random.Random(seed).shuffle(shuffled)
        assert explain_adjacent(shuffled) == first
    assert len(first) == 3 and all(e.method_version == EVIDENCE_METHOD_VERSION for e in first)


def test_inputs_are_not_modified() -> None:
    a, b = run(UNKNOWN_TAIL, "a"), run(DEAD, "b")
    result = rank_assessments([a, b])
    before = (a.model_dump_json(), b.model_dump_json(), result.model_dump_json())
    compare_scenarios(a, b, ranking=result)
    explain_adjacent([a, b], result)
    score_difference(a, b)
    assert (a.model_dump_json(), b.model_dump_json(), result.model_dump_json()) == before


def test_evidence_round_trips_through_json() -> None:
    e = compare_scenarios(run(UNKNOWN_TAIL, "a"), run(GOOD, "b"))
    assert PairwiseEvidence.model_validate_json(e.model_dump_json()) == e


# --- 9. contract errors -----------------------------------------------------------------------------


def test_contract_errors() -> None:
    a, b = make("a", P, 60.0, risk=RiskLevel.LOW), make("b", P, 60.0, risk=RiskLevel.HIGH)
    with pytest.raises(ValueError, match="itself"):
        compare_scenarios(a, a)
    with pytest.raises(ValueError, match="not in the supplied ranking"):
        compare_scenarios(a, b, ranking=rank_assessments([a]))
    result = rank_assessments([a, b])
    with pytest.raises(ValueError, match="differs from the ranking's policy"):
        compare_scenarios(a, b, ranking=result, policy=ComparabilityPolicy.SAME_METHOD_AND_WEIGHTS)
    # A ranking whose order contradicts the policy (risk tie-break reversed; keys 1-3 equal so it validates).
    entries = list(reversed(result.entries))
    reordered = RankingResult(
        method_version=result.method_version,
        entries=[RankedScenario(**{**e.model_dump(), "rank": i + 1}) for i, e in enumerate(entries)],
        data_basis=result.data_basis,
        policy=result.policy,
    )
    with pytest.raises(ValueError, match="orders these scenarios differently"):
        compare_scenarios(a, b, ranking=reordered)
    stale = make("a", P, 61.0)
    with pytest.raises(ValueError, match="does not match"):
        compare_scenarios(stale, b, ranking=result)
    with pytest.raises(ValueError, match="without an assessment"):
        explain_adjacent([a], result)


def test_score_text_never_turns_a_bound_into_a_score() -> None:
    assert score_text(make("k", P, 12.5)) == "exact score 12.5"
    b = score_text(make("b", P, bounded_score(10.0, 20.0)))
    assert "between 10 and 20" in b and "no exact value" in b and "exact score" not in b
    assert score_text(make("u", UNK)) == "not scored: eligibility is UNKNOWN"


# --- 10. real terrain-aware data (Rescue production path) --------------------------------------------


@pytest.fixture(scope="module")
def real() -> Any:
    if not all((SITES_DIR / f"{s}.json").exists() for s in ("connecting-ridge", "malapert-massif")):
        pytest.skip("precomputed site files not present")
    provider = PrecomputedTimelineProvider(fallback=SyntheticTimelineProvider(), data_dir=SITES_DIR)

    def evaluate(site: str, landing: datetime, days: float) -> ViabilityAssessment:
        sc = Scenario.model_validate({"site": get_site(site).to_site(), "landing_utc": landing, "duration_days": days})
        n = round(days * 24)
        tl = provider.timeline(sc.site, landing, landing + timedelta(hours=n - 1), 1.0)
        assert tl.source.startswith("precomputed")
        return evaluate_timeline_detailed(sc, tl, precomputed_data_dir=SITES_DIR)[1]

    return evaluate


def test_real_exact_vs_bounded_with_overlapping_ranges(real: Any) -> None:
    exact = real("connecting-ridge", DATA_END - timedelta(hours=72), 3.0)
    bounded = real("connecting-ridge", DATA_END - timedelta(hours=71), 3.0)
    assert exact.eligibility is P and bounded.eligibility is P
    assert exact.score.status is ScoreStatus.KNOWN and bounded.score.status is ScoreStatus.BOUNDED
    assert exact.data_basis is DataBasis.REAL_TERRAIN_AWARE and not comparability_issues(exact, bounded)
    result = rank_assessments([bounded, exact])
    e = compare_scenarios(bounded, exact, ranking=result)
    assert e.higher_id == result.entries[0].scenario_id
    s, (lo, hi) = score_span(exact)[0], score_span(bounded)
    d = e.score_difference
    assert d.interval is not None and contains(d.interval, lo - s, hi - s)
    expected = (
        DifferenceStatus.NOT_ESTABLISHED
        if lo <= s <= hi
        else (DifferenceStatus.SELECTED_HIGHER if lo > s else DifferenceStatus.COMPETITOR_HIGHER)
    )
    assert d.status is expected
    if expected is DifferenceStatus.NOT_ESTABLISHED:
        assert "does not prove" in e.explanation and not e.explanation.startswith(SYNTHETIC_PREFIX)


def test_real_disjoint_exact_scores_name_their_drivers(real: Any) -> None:
    a = real("malapert-massif", datetime(2027, 3, 1, tzinfo=UTC), 7.0)
    b = real("malapert-massif", datetime(2028, 6, 15, tzinfo=UTC), 7.0)
    if not (a.eligibility is b.eligibility is P):
        pytest.skip("site data changed: both windows no longer pass")
    e = compare_scenarios(a, b)
    assert e.comparable and e.score_difference.both_exact
    sa, sb = score_span(a)[0], score_span(b)[0]
    if sa != sb:  # distinct exact scores: the score decides, and the difference is established for the winner
        assert e.deciding_criterion is RankingCriterion.SCORE_LOWER_BOUND
        assert e.higher_id == (a.scenario_id if sa > sb else b.scenario_id)
        assert e.score_difference.status is (
            DifferenceStatus.SELECTED_HIGHER if sa > sb else DifferenceStatus.COMPETITOR_HIGHER
        )
    established = [c for c in e.components if c.advantage in (Advantage.SELECTED, Advantage.COMPETITOR)]
    for c in established:
        assert c.contribution_difference is not None and not c.contribution_difference.contains_zero
    if established:
        assert "benefits from" in e.explanation or " has " in e.explanation
