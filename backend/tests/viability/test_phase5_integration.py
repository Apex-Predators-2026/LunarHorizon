"""Phase 5 integration: scientific input -> windows -> metrics -> constraints -> margins -> risk -> score -> rank.

Everything here goes through the real ``evaluate_scenario`` and ``rank_assessments``; nothing between them is
mocked. Three kinds of input:

* REAL, terrain-aware: Member 1's precomputed site files (``data/sites``). Expected values are derived from
  the raw columns, never pinned (Member 1 regenerates the terrain; generator 1.2 changed Malapert from
  82.6 % to 77.1 % sunlit).
* SYNTHETIC hourly series (``helpers.hourly``): tiny, hand-checkable patterns with closed-form scores.
* One TEST-ONLY real-labelled geometric series, built from a synthetic one, solely to exercise the
  data-basis separation of rankings. It is not scientific data and is never scored for its own sake.

Ranking is an ordering of existing assessments. A bounded score is ordered by its lower bound, which is a
CONSERVATIVE ORDERING POLICY, not an estimate: tests below check it is never reported as an exact score.
"""

from __future__ import annotations

import copy
import math
import random
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from fractions import Fraction
from pathlib import Path
from typing import Any

import pytest

from app.models import Scenario
from app.rescue.catalog import get_site
from app.rescue.engine import Evaluator
from app.rescue.timeline import SyntheticTimelineProvider
from app.viability import (
    ENGINE_VERSION,
    RankingComparabilityError,
    analyze_scenario,
    build_constraint_assessment,
    evaluate_scenario,
    generate_explanations,
    partition_comparable,
    prepare_series,
    rank_assessments,
    ranking_explanations,
)
from app.viability import ranking as ranking_module
from app.viability import scoring as scoring_module
from app.viability.adapters import load_site_file
from app.viability.compat.rescue import evaluate_timeline_detailed, make_evaluate_fn
from app.viability.enums import (
    CommunicationMode,
    ComparabilityPolicy,
    ConstraintStatus,
    DataBasis,
    Eligibility,
    PowerSource,
    RiskLevel,
    ScoreComponent,
    ScoreStatus,
    Unit,
)
from app.viability.inputs import ScientificTimeSeries
from app.viability.margins import margins_from_assessment
from app.viability.mission import MissionRequirements, MissionScenario, RankingPreferences, SpacecraftConfiguration
from app.viability.outputs import Metric, ViabilityAssessment
from app.viability.risk import assess_risks, overall_risk
from app.viability.scoring import SCORING_METHOD_VERSION, score_scenario
from app.viability.windows import PreparedSeries

from .helpers import SunCode, hourly
from .real_data import AFTER_DATA, REGRESSION_START, raw_timeline

REPO = Path(__file__).resolve().parents[3]
SITES_DIR = REPO / "data" / "sites"
DOCS = REPO / "docs" / "viability-engine.md"
SITES = ("connecting-ridge", "malapert-massif", "peak-near-shackleton", "shackleton-floor")
H = 3600.0
COVERAGE_START = REGRESSION_START  # raw index 0 of the raw fixture (regression window, real_data.py)
REAL_START = datetime(2027, 3, 1, tzinfo=UTC)
REAL_DAYS = 14
REAL_REQUIREMENTS: dict[str, Any] = {
    "min_mean_solar_disk_fraction": 0.5,
    "min_earth_visibility_percent": 40.0,
    "min_initial_sunlight_s": 24 * H,
    "min_initial_earth_visibility_s": 12 * H,
    "min_sunlight_percent": 50.0,
}
T0 = REGRESSION_START
DARK_H = 40.0  # synthetic scenarios: 48 h missions, 40 h darkness limit, no other hard requirement


# --- builders --------------------------------------------------------------------------------------------


def scenario_for(
    series: ScientificTimeSeries,
    sid: str,
    start: datetime,
    end: datetime,
    *,
    dark_h: float | None = DARK_H,
    blackout_h: float | None = DARK_H,
    threshold: float | None = None,
    prefs: RankingPreferences | None = None,
    requirements: dict[str, Any] | None = None,
    power: PowerSource = PowerSource.SOLAR,
) -> MissionScenario:
    return MissionScenario(
        scenario_id=sid,
        site=series.site,
        mission_start_utc=start,
        mission_end_utc=end,
        spacecraft=SpacecraftConfiguration(
            name="Test lander",
            power_source=power,
            communication_mode=CommunicationMode.DIRECT_TO_EARTH,
            max_continuous_darkness_s=None if dark_h is None else dark_h * H,
            max_communication_blackout_s=None if blackout_h is None else blackout_h * H,
            solar_power_min_disk_fraction=threshold,
        ),
        requirements=MissionRequirements(**(requirements or {})),
        preferences=prefs or RankingPreferences(),
    )


def synth(
    sun: Sequence[SunCode], sid: str, earth: list[str] | None = None, **kw: Any
) -> tuple[ScientificTimeSeries, MissionScenario]:
    series = hourly(sun, earth)
    scenario = scenario_for(series, sid, T0, T0 + timedelta(hours=len(sun)), **kw)
    return series, scenario


def run(sun: Sequence[SunCode], sid: str, earth: list[str] | None = None, **kw: Any) -> ViabilityAssessment:
    series, scenario = synth(sun, sid, earth, **kw)
    return evaluate_scenario(scenario, series)


def closed_form_score(
    sun_frac: float, earth: float, darkness_h: float, blackout_h: float, limit_h: float = DARK_H
) -> float:
    """Independent formula (docs 5e): equal weights over sun, Earth, darkness margin, blackout margin."""
    dark_margin = max(0.0, min(1.0, (limit_h - darkness_h) / limit_h))
    blackout_margin = max(0.0, min(1.0, (limit_h - blackout_h) / limit_h))
    return 100.0 * (sun_frac + earth + dark_margin + blackout_margin) / 4.0


V, N, U = "V", "N", "U"
GOOD: Sequence[SunCode] = [V] * 48  # always lit
HALF: Sequence[SunCode] = [V] * 24 + [N] * 24  # 24 h dark
LOW: Sequence[SunCode] = [V] * 12 + [N] * 36  # 36 h dark (still within the 40 h limit)
DEAD: Sequence[SunCode] = [V] * 2 + [N] * 46  # 46 h dark: breaks the 40 h limit
UNKNOWN_TAIL: Sequence[SunCode] = [V] * 40 + [U] * 8  # 8 h of unknown terrain: score bounded, eligibility still PASS


@pytest.fixture(scope="module")
def prepared() -> dict[str, PreparedSeries]:
    return {s: prepare_series(load_site_file(SITES_DIR / f"{s}.json")) for s in SITES}


@pytest.fixture(scope="module")
def raw() -> dict[str, dict[str, Any]]:
    return {s: raw_timeline(s) for s in SITES}  # regression window, raw index 0 = T0 (real_data.py)


def real_scenario(
    p: PreparedSeries, sid: str, start: datetime = REAL_START, days: int = REAL_DAYS, **kw: Any
) -> MissionScenario:
    return scenario_for(
        p.series,
        sid,
        start,
        start + timedelta(days=days),
        dark_h=50.0,
        blackout_h=96.0,
        threshold=0.25,
        requirements=REAL_REQUIREMENTS_COPY(),
        **kw,
    )


def REAL_REQUIREMENTS_COPY() -> dict[str, Any]:
    return dict(REAL_REQUIREMENTS)


@pytest.fixture(scope="module")
def real_assessments(prepared: dict[str, PreparedSeries]) -> dict[str, ViabilityAssessment]:
    return {s: evaluate_scenario(real_scenario(prepared[s], s), prepared[s].series) for s in SITES}


# --- 1. the four original sites, whole pipeline ------------------------------------------------------------


@pytest.mark.parametrize("site", SITES)
def test_real_site_pipeline_is_the_composition_of_the_phases(site: str, prepared: dict[str, PreparedSeries]) -> None:
    p = prepared[site]
    scenario = real_scenario(p, f"real-{site}")
    a = evaluate_scenario(scenario, p.series)

    env = analyze_scenario(scenario, p)
    checks = build_constraint_assessment(scenario, env)
    margins = margins_from_assessment(checks)
    risks = assess_risks(scenario, checks, margins)
    assert a.engine_version == ENGINE_VERSION == "0.6.0-phase6"
    assert a.constraints == checks.constraints and a.eligibility is checks.eligibility
    assert a.metrics == env.metrics and a.windows == env.windows and a.data_quality == env.data_quality
    assert a.margins == margins and a.risks == risks and a.overall_risk is overall_risk(risks)
    assert a.score == score_scenario(
        scenario, env.metrics, margins, checks.eligibility, data_basis=env.data_quality.data_basis
    )
    assert a.data_basis is DataBasis.REAL_TERRAIN_AWARE
    assert (
        a.score.method_version == SCORING_METHOD_VERSION and a.score.configuration_key == scenario.configuration_key()
    )
    # Phase 6: explanations are generated from (and only from) the fields checked above.
    assert a.explanations == generate_explanations(
        a.eligibility, a.constraints, a.margins, a.risks, a.data_quality, score=a.score, overall_risk=a.overall_risk
    )
    assert a.explanations


@pytest.mark.parametrize("site", SITES)
def test_real_site_score_matches_independent_raw_computation(
    site: str, real_assessments: dict[str, ViabilityAssessment], raw: dict[str, dict[str, Any]]
) -> None:
    a, tl = real_assessments[site], raw[site]
    i0 = int((REAL_START - COVERAGE_START).total_seconds() // H)
    n = REAL_DAYS * 24
    mean_fraction = sum(tl["sun_visible_fraction"][i0 : i0 + n]) / n
    earth = sum(bool(e) for e in tl["earth_visible"][i0 : i0 + n]) / n
    comp = {c.component: c for c in a.score.components}
    assert a.score.status is ScoreStatus.KNOWN and a.score.score is not None  # fully covered real data: exact
    assert comp[ScoreComponent.SUNLIGHT].normalized_value == pytest.approx(mean_fraction, abs=1e-6)
    assert comp[ScoreComponent.EARTH_VISIBILITY].normalized_value == pytest.approx(earth, abs=1e-6)
    # Exact score = sum of the components' contributions (no component counted twice, none dropped).
    assert math.fsum(c.contribution or 0.0 for c in a.score.components) == pytest.approx(a.score.score, abs=1e-5)
    active = [c for c in a.score.components if c.normalized_value is not None]
    assert math.fsum(c.weight for c in active) == pytest.approx(1.0, abs=1e-12)
    # Scored even if ineligible: eligibility comes from the constraints only.
    assert a.score.rank_eligible is (a.eligibility is Eligibility.PASS)


def test_real_site_eligibility_is_constraint_derived(real_assessments: dict[str, ViabilityAssessment]) -> None:
    floor = real_assessments["shackleton-floor"]  # the Sun never reaches the crater floor
    assert floor.eligibility is Eligibility.FAIL
    assert any(c.status is ConstraintStatus.FAIL for c in floor.constraints)
    for a in real_assessments.values():
        statuses = {c.status for c in a.constraints}
        expected = (
            Eligibility.FAIL
            if ConstraintStatus.FAIL in statuses
            else Eligibility.UNKNOWN
            if ConstraintStatus.UNKNOWN in statuses
            else Eligibility.PASS
        )
        assert a.eligibility is expected


def test_real_sites_rank_together_deterministically(real_assessments: dict[str, ViabilityAssessment]) -> None:
    items = list(real_assessments.values())
    result = rank_assessments(items)
    assert result.data_basis is DataBasis.REAL_TERRAIN_AWARE and result.policy is ComparabilityPolicy.STRICT
    assert sorted(e.scenario_id for e in result.entries) == sorted(real_assessments)
    ranked = [e for e in result.entries if e.rank is not None]
    assert [e.rank for e in ranked] == list(range(1, len(ranked) + 1))
    assert all(e.eligibility is Eligibility.PASS for e in ranked)
    assert all(e.rank is None for e in result.entries if e.eligibility is not Eligibility.PASS)
    scores = [e.score for e in ranked if e.score is not None]
    assert scores == sorted(scores, reverse=True)
    floor = next(e for e in result.entries if e.scenario_id == "shackleton-floor")
    assert floor.rank is None and floor.eligibility is Eligibility.FAIL
    for seed in range(5):  # input order never matters
        shuffled = items[:]
        random.Random(seed).shuffle(shuffled)
        assert rank_assessments(shuffled) == result
    for e in result.entries:  # ranking copies, never recomputes, the assessment's own values
        a = real_assessments[e.scenario_id]
        assert (e.eligibility, e.overall_risk, e.score, e.score_status) == (
            a.eligibility,
            a.overall_risk,
            a.score.score,
            a.score.status,
        )


# --- 2. UNKNOWN eligibility and missing real data ----------------------------------------------------------


def test_mission_outside_real_coverage_is_unknown_and_never_scored(prepared: dict[str, PreparedSeries]) -> None:
    p = prepared["malapert-massif"]
    scenario = real_scenario(p, "outside", start=AFTER_DATA)
    a = evaluate_scenario(scenario, p.series)
    assert a.eligibility is Eligibility.UNKNOWN
    assert a.score.status is ScoreStatus.ELIGIBILITY_UNKNOWN
    assert a.score.score is None and a.score.score_bounds is None and a.score.rank_eligible is False
    assert all(c.normalized_value is None and c.contribution is None for c in a.score.components)
    assert a.data_quality.uncovered_duration_s == a.evaluated_duration_s  # nothing verified


def test_unknown_eligibility_sorts_between_pass_and_fail_without_rank(
    prepared: dict[str, PreparedSeries], real_assessments: dict[str, ViabilityAssessment]
) -> None:
    p = prepared["malapert-massif"]
    unknown = evaluate_scenario(real_scenario(p, "zz-outside", start=AFTER_DATA), p.series)
    result = rank_assessments([*real_assessments.values(), unknown])
    tiers = [e.eligibility for e in result.entries]
    assert tiers == sorted(tiers, key=[Eligibility.PASS, Eligibility.UNKNOWN, Eligibility.FAIL].index)
    entry = next(e for e in result.entries if e.scenario_id == "zz-outside")
    assert entry.rank is None and entry.score is None and entry.score_bounds is None


def test_all_unavailable_data_withholds_the_score() -> None:
    a = run(["X"] * 48, "no-ephemeris")  # ephemeris missing for every sample
    assert a.eligibility is Eligibility.UNKNOWN
    assert (a.score.score, a.score.score_bounds, a.score.status) == (None, None, ScoreStatus.ELIGIBILITY_UNKNOWN)


# --- 3. exact, bounded and unavailable scores ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("sun", "darkness_h", "sun_frac"),
    [(GOOD, 0.0, 1.0), (HALF, 24.0, 0.5), (LOW, 36.0, 0.25)],
)
def test_exact_score_equals_the_closed_form(sun: Sequence[SunCode], darkness_h: float, sun_frac: float) -> None:
    a = run(sun, "exact")
    assert a.eligibility is Eligibility.PASS and a.score.status is ScoreStatus.KNOWN
    assert a.score.score == pytest.approx(closed_form_score(sun_frac, 1.0, darkness_h, 0.0), abs=1e-6)
    assert (
        a.score.score_bounds is not None and a.score.score_bounds.value == a.score.score
    )  # KNOWN: a value, no interval


def test_unknown_samples_give_bounded_not_exact_score() -> None:
    a = run(UNKNOWN_TAIL, "bounded")
    assert a.eligibility is Eligibility.PASS  # even the worst case (8 h dark) meets every hard requirement
    assert a.score.status is ScoreStatus.BOUNDED
    assert a.score.score is None  # never a point estimate
    b = a.score.score_bounds
    assert b is not None and b.lower is not None and b.upper is not None and b.lower < b.upper
    best = closed_form_score(1.0, 1.0, 0.0, 0.0)
    worst = closed_form_score(40 / 48, 1.0, 8.0, 0.0)
    assert b.upper == pytest.approx(best, abs=1e-6) and b.lower == pytest.approx(worst, abs=1e-6)
    assert any(
        c.normalized_value is None and c.normalized is not None for c in a.score.components
    )  # bounded, not exact


def test_bounds_round_outward_never_inward() -> None:
    """True interval from the series by exact rational arithmetic, independent of the engine's rounding.

    7 fully lit hours, 13 hours at 0.3333337 of the disk, 28 unknown hours; weights sun 3 : Earth 1 :
    darkness 1 : blackout 1 (so 1/2, 1/6, 1/6, 1/6 over the four active components). The unknown 28 h
    may be anywhere from fully lit to fully dark: darkness margin in [(40-28)/40, 1].
    """
    prefs = RankingPreferences(sunlight_weight=3.0, earth_visibility_weight=1.0)
    a = run([V] * 7 + [0.3333337] * 13 + [U] * 28, "outward", prefs=prefs)
    assert a.score.status is ScoreStatus.BOUNDED and a.score.score_bounds is not None
    lo_b, hi_b = a.score.score_bounds.lower, a.score.score_bounds.upper
    assert lo_b is not None and hi_b is not None
    known_sum = 7 + 13 * Fraction(3333337, 10**7)
    sun_lo, sun_hi = known_sum / 48, (known_sum + 28) / 48
    dark_lo, dark_hi = Fraction(40 - 28, 40), Fraction(1)
    w_sun, w_other = Fraction(1, 2), Fraction(1, 6)
    low = 100 * (w_sun * sun_lo + w_other * 1 + w_other * dark_lo + w_other * 1)
    high = 100 * (w_sun * sun_hi + w_other * 1 + w_other * dark_hi + w_other * 1)
    slack = Fraction(1, 10**9)  # float noise only
    assert Fraction(lo_b) <= low + slack and low - Fraction(lo_b) < Fraction(1, 10**6) + slack  # rounded DOWN
    assert Fraction(hi_b) >= high - slack and Fraction(hi_b) - high < Fraction(1, 10**6) + slack  # rounded UP
    assert 0.0 <= lo_b < hi_b <= 100.0
    for v in (lo_b, hi_b):  # stored on the 6-decimal grid
        assert round(v, 6) == v


def test_no_scorable_components_is_its_own_status() -> None:
    prefs = RankingPreferences(
        sunlight_weight=0.0,
        earth_visibility_weight=0.0,
        darkness_margin_weight=0.0,
        blackout_margin_weight=0.0,
        clearance_margin_weight=1.0,
    )
    a = run(HALF, "unscored", prefs=prefs)
    assert a.eligibility is Eligibility.PASS and a.score.status is ScoreStatus.NO_SCORABLE_COMPONENTS
    assert a.score.score is None and a.score.score_bounds is None
    assert rank_assessments([a]).entries[0].rank == 1  # eligible and ranked, just without a score
    with pytest.raises(RankingComparabilityError, match="weights"):
        rank_assessments([a, run(HALF, "scored")])  # different effective weights: not comparable


# --- 4. hard constraints dominate -------------------------------------------------------------------------


def test_failing_scenario_is_never_ranked_even_with_a_higher_score() -> None:
    strict = {"min_sunlight_percent": 90.0}  # HALF is lit only 50 % of the time
    failing = run(HALF, "a-fails-but-scores-higher", requirements=strict)
    passing = run(LOW, "z-passes-with-lower-score")
    assert failing.eligibility is Eligibility.FAIL and passing.eligibility is Eligibility.PASS
    assert failing.score.score is not None and passing.score.score is not None
    assert failing.score.score > passing.score.score
    with pytest.raises(RankingComparabilityError, match="requirements|configuration"):
        rank_assessments([failing, passing])  # strict default: different hard requirements are not comparable
    result = rank_assessments([failing, passing], ComparabilityPolicy.SAME_METHOD_AND_WEIGHTS)
    assert [(e.scenario_id, e.rank) for e in result.entries] == [
        ("z-passes-with-lower-score", 1),
        ("a-fails-but-scores-higher", None),
    ]
    assert result.entries[1].score == failing.score.score  # shown, but cannot buy a rank


def test_dead_site_fails_the_darkness_limit_and_follows_all_eligible_sites() -> None:
    assessments = [run(s, sid) for s, sid in ((DEAD, "m-dead"), (GOOD, "z-good"), (HALF, "a-half"))]
    result = rank_assessments(assessments)
    assert [(e.scenario_id, e.rank, e.eligibility) for e in result.entries] == [
        ("z-good", 1, Eligibility.PASS),
        ("a-half", 2, Eligibility.PASS),
        ("m-dead", None, Eligibility.FAIL),
    ]


# --- 5. conservative ordering of bounded scores (D8) ------------------------------------------------------


def test_bounded_score_is_ordered_by_lower_bound_and_never_shown_as_exact() -> None:
    bounded = run(UNKNOWN_TAIL, "a-bounded")  # bounds ~[90.8, 100]; sorts first by id
    above = run([V] * 44 + [N] * 4, "b-exact-above")  # exact ~94.2: above the lower bound, below the upper
    below = run(HALF, "c-exact-below")  # exact 72.5: below the lower bound
    bounds = bounded.score.score_bounds
    assert bounds is not None and bounds.lower is not None and bounds.upper is not None
    assert above.score.score is not None and below.score.score is not None
    assert below.score.score < bounds.lower < above.score.score <= bounds.upper
    result = rank_assessments([below, above, bounded])
    # Ordered by the lower bound (90.8), NOT by the optimistic upper bound (100) and not by a midpoint.
    assert [e.scenario_id for e in result.entries] == ["b-exact-above", "a-bounded", "c-exact-below"]
    entry = next(e for e in result.entries if e.scenario_id == "a-bounded")
    assert entry.score is None, "a bounded score must not be presented as an exact value"
    assert entry.score_status is ScoreStatus.BOUNDED and entry.score_bounds == bounded.score.score_bounds
    text = ranking_explanations([below, above, bounded], result)["a-bounded"]
    assert "bounded" in text and "lower bound" in text


def test_exact_beats_bounded_with_the_same_lower_bound() -> None:
    bounded = run(UNKNOWN_TAIL, "a-bounded")
    lower = bounded.score.score_bounds.lower if bounded.score.score_bounds else None
    assert lower is not None
    # Build the exact twin by copying the bounded assessment with an exact score equal to its lower bound.
    exact_score = bounded.score.model_copy(
        update={
            "score": lower,
            "status": ScoreStatus.KNOWN,
            "score_bounds": Metric.known(lower, Unit.PERCENT),
        }
    )
    twin = bounded.model_copy(update={"scenario_id": "z-exact", "score": exact_score})
    result = rank_assessments([bounded, twin])
    assert [e.scenario_id for e in result.entries] == ["z-exact", "a-bounded"]  # known before bounded, despite id order


def test_lower_bound_policy_is_documented_as_conservative_ordering() -> None:
    doc = (ranking_module.__doc__ or "").lower()
    assert "conservative" in doc and "lower bound" in doc and "never" in doc
    text = " ".join(DOCS.read_text(encoding="utf-8").lower().split())  # unwrap line breaks
    spots = [i for i in range(len(text)) if text.startswith("conservative ordering", i)]
    assert spots, "docs must name the conservative ordering policy"
    windows = [text[max(0, i - 200) : i + 1600] for i in spots]
    assert any("not an estimate" in w and "score = null" in w for w in windows)


# --- 6. data basis and synthetic separation ---------------------------------------------------------------


def pretend_real_geometric(series: ScientificTimeSeries) -> ScientificTimeSeries:
    """TEST ONLY: flips the synthetic flag of a geometric-only synthetic series so the data-basis plumbing
    can be exercised. This is not scientific data."""
    payload = series.model_dump(mode="json")
    payload["provenance"]["is_synthetic"] = False
    payload["provenance"]["notes"] = "TEST-ONLY real-labelled geometric series (not scientific data)."
    return ScientificTimeSeries.model_validate(payload)


def test_three_data_bases_are_never_ranked_together(prepared: dict[str, PreparedSeries]) -> None:
    p = prepared["malapert-massif"]
    terrain = evaluate_scenario(real_scenario(p, "terrain"), p.series)
    series, scenario = synth(GOOD, "synthetic")
    synthetic = evaluate_scenario(scenario, series)
    geo = pretend_real_geometric(hourly(GOOD, geometric=True))
    geometric = evaluate_scenario(scenario_for(geo, "geometric", T0, T0 + timedelta(hours=48)), geo)
    assert (terrain.data_basis, synthetic.data_basis, geometric.data_basis) == (
        DataBasis.REAL_TERRAIN_AWARE,
        DataBasis.SYNTHETIC,
        DataBasis.REAL_GEOMETRIC_ONLY,
    )
    for policy in ComparabilityPolicy:
        with pytest.raises(RankingComparabilityError, match="data"):
            rank_assessments([terrain, synthetic], policy)
        with pytest.raises(RankingComparabilityError, match="data"):
            rank_assessments([synthetic, geometric], policy)
    groups = partition_comparable([terrain, synthetic, geometric])
    assert sorted(len(g) for g in groups) == [1, 1, 1]
    for g in groups:
        assert rank_assessments(g).data_basis is g[0].data_basis


def test_synthetic_scores_are_labelled_and_cannot_be_mistaken_for_verified() -> None:
    a = run(GOOD, "synthetic-label")
    assert a.data_basis is DataBasis.SYNTHETIC and a.data_quality.provenance.is_synthetic is True
    assert a.score.note is not None and a.score.note.startswith("[SYNTHETIC DATA]")
    real = rank_assessments([a])
    assert real.data_basis is DataBasis.SYNTHETIC and real.entries[0].data_basis is DataBasis.SYNTHETIC


def test_simulation_mode_is_explicit_and_labelled_through_rescue() -> None:
    site = get_site("malapert-massif").to_site()
    outside = Scenario(site=site, landing_utc=AFTER_DATA, duration_days=7)
    real = Evaluator(evaluate=make_evaluate_fn()).evaluate(outside)  # default: simulation off
    assert real.eligibility == "unknown" and real.score is None and real.data_source == "no-real-data"
    sim = Evaluator(evaluate=make_evaluate_fn(), simulation=True).evaluate(outside)
    assert sim.data_source == "synthetic-placeholder"  # simulation is visible in the result
    inside = Scenario(site=site, landing_utc=REAL_START, duration_days=7)
    verified = Evaluator(evaluate=make_evaluate_fn()).evaluate(inside)
    assert verified.data_source.startswith("precomputed:") and verified.eligibility in ("pass", "fail")
    provider = SyntheticTimelineProvider()
    tl = provider.timeline(
        site, outside.landing_utc, outside.landing_utc + timedelta(hours=outside.duration_days * 24 - 1), 1.0
    )
    _, assessment = evaluate_timeline_detailed(outside, tl.slice(0, int(outside.duration_days * 24)))
    assert assessment.data_basis is DataBasis.SYNTHETIC
    assert assessment.score.note is not None and assessment.score.note.startswith("[SYNTHETIC DATA]")


# --- 7. configurations are not silently ranked as comparable -----------------------------------------------


def test_different_mission_configurations_are_not_ranked_together() -> None:
    a = run(HALF, "a")
    stricter_limit = run(HALF, "b", dark_h=30.0, blackout_h=30.0)
    other_threshold = run(HALF, "c", threshold=0.25)
    other_requirements = run(HALF, "d", requirements={"min_earth_visibility_percent": 10.0})
    assert (
        len(
            {
                a.score.configuration_key,
                stricter_limit.score.configuration_key,
                other_threshold.score.configuration_key,
                other_requirements.score.configuration_key,
            }
        )
        == 4
    )
    for other in (stricter_limit, other_threshold, other_requirements):
        with pytest.raises(RankingComparabilityError):
            rank_assessments([a, other])
    groups = partition_comparable([a, stricter_limit, other_threshold, other_requirements])
    assert sorted(len(g) for g in groups) == [1, 1, 1, 1]
    # Explicit opt-in drops only the requirements fingerprint and duration, never the method or weights.
    relaxed = rank_assessments([a, stricter_limit, other_requirements], ComparabilityPolicy.SAME_METHOD_AND_WEIGHTS)
    assert relaxed.policy is ComparabilityPolicy.SAME_METHOD_AND_WEIGHTS and len(relaxed.entries) == 3
    reweighted = run(HALF, "e", prefs=RankingPreferences(sunlight_weight=5.0))
    with pytest.raises(RankingComparabilityError, match="weights"):
        rank_assessments([a, reweighted], ComparabilityPolicy.SAME_METHOD_AND_WEIGHTS)


def test_configuration_key_ignores_identity_but_not_configuration() -> None:
    _, one = synth(HALF, "one")
    _, two = synth(HALF, "two", prefs=RankingPreferences(sunlight_weight=2.0))
    assert one.configuration_key() == two.configuration_key()  # id and preferences are not part of it
    _, three = synth(HALF, "three", threshold=0.5)
    assert three.configuration_key() != one.configuration_key()


# --- 8. determinism and tie-breaking ---------------------------------------------------------------------


def test_equal_scores_break_ties_by_scenario_id_independent_of_input_order() -> None:
    twins = [run(HALF, sid) for sid in ("m", "c", "x", "a")]
    expected = ["a", "c", "m", "x"]
    for seed in range(6):
        items = twins[:]
        random.Random(seed).shuffle(items)
        result = rank_assessments(items)
        assert [e.scenario_id for e in result.entries] == expected
        assert [e.rank for e in result.entries] == [1, 2, 3, 4]


def test_risk_only_breaks_ties_and_never_changes_a_score() -> None:
    base = run(HALF, "base")
    low = base.model_copy(update={"scenario_id": "z-low-risk", "overall_risk": RiskLevel.LOW})
    high = base.model_copy(update={"scenario_id": "a-high-risk", "overall_risk": RiskLevel.HIGH})
    result = rank_assessments([high, low])  # equal score and kind: lower risk first despite the later id
    assert [e.scenario_id for e in result.entries] == ["z-low-risk", "a-high-risk"]
    assert low.score == high.score == base.score  # the score ignored the risk level
    better = run(GOOD, "z-better-score")
    worse_but_safe = base.model_copy(update={"scenario_id": "a-safe", "overall_risk": RiskLevel.LOW})
    worse_but_risky = better.model_copy(update={"scenario_id": "b-risky", "overall_risk": RiskLevel.HIGH})
    result = rank_assessments([worse_but_safe, worse_but_risky])
    assert result.entries[0].scenario_id == "b-risky"  # a higher score beats a lower risk level


def test_repeated_evaluation_is_bit_for_bit_identical() -> None:
    series, scenario = synth(UNKNOWN_TAIL, "repeat")
    first, second = evaluate_scenario(scenario, series), evaluate_scenario(scenario, series)
    assert first == second and first.model_dump_json() == second.model_dump_json()


# --- 9. separation of concerns: no mutation, no feedback into eligibility or risk -----------------------


def test_scoring_preferences_change_only_the_score() -> None:
    series, scenario = synth(HALF, "prefs-a")
    other = scenario.model_copy(
        update={
            "scenario_id": "prefs-b",
            "preferences": RankingPreferences(sunlight_weight=9.0, earth_visibility_weight=0.0),
        }
    )
    a, b = evaluate_scenario(scenario, series), evaluate_scenario(other, series)
    assert a.score.score != b.score.score
    for field in (
        "eligibility",
        "constraints",
        "metrics",
        "windows",
        "margins",
        "risks",
        "overall_risk",
        "data_quality",
        "limitations",
    ):
        assert getattr(a, field) == getattr(b, field), field


def test_evaluation_and_ranking_do_not_mutate_their_inputs() -> None:
    series, scenario = synth(UNKNOWN_TAIL, "mut")
    series_before, scenario_before = series.model_dump_json(), scenario.model_dump_json()
    a = evaluate_scenario(scenario, series)
    assert series.model_dump_json() == series_before and scenario.model_dump_json() == scenario_before
    items = [a, run(HALF, "other"), run(DEAD, "dead")]
    snapshot = copy.deepcopy([x.model_dump(mode="json") for x in items])
    rank_assessments(items)
    partition_comparable(items)
    ranking_explanations(items, rank_assessments(items))
    assert [x.model_dump(mode="json") for x in items] == snapshot


def test_ranking_cannot_change_eligibility_risk_or_score() -> None:
    items = [run(GOOD, "g"), run(HALF, "h"), run(DEAD, "d"), run(["X"] * 48, "x")]
    result = rank_assessments(items)
    by_id = {a.scenario_id: a for a in items}
    for e in result.entries:
        a = by_id[e.scenario_id]
        assert e.eligibility is a.eligibility and e.overall_risk is a.overall_risk and e.score == a.score.score
    assert {e.scenario_id: e.rank for e in result.entries} == {"g": 1, "h": 2, "d": None, "x": None}


# --- 10. public surface ---------------------------------------------------------------------------------


def test_public_exports_and_reexports() -> None:
    import app.viability as pkg

    assert pkg.rank_assessments is ranking_module.rank_assessments is scoring_module.rank_assessments
    assert pkg.score_scenario is scoring_module.score_scenario and pkg.evaluate_scenario is evaluate_scenario
    assert pkg.ENGINE_VERSION == ENGINE_VERSION == "0.6.0-phase6"
    for name in ("RankingComparabilityError", "partition_comparable", "ranking_explanations", "SCORING_METHOD_VERSION"):
        assert name in pkg.__all__


def test_docs_have_a_phase5_section() -> None:
    text = DOCS.read_text(encoding="utf-8")
    for needle in (
        "Scoring formulas",
        "Effective scoring weights",
        "Configuration fingerprint",
        "Deterministic tie-breakers",
        "Conservative ordering",
    ):
        assert needle.lower() in text.lower(), needle
