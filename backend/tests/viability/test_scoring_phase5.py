"""Phase 5A explainable scoring: component formulas, uncertainty, eligibility handling, metadata.

All inputs here are SYNTHETIC hand-built metrics and margins. Expected values are computed in the
tests from the documented formulas (docs §5e, D1-D8) with exact rational arithmetic, never by
calling the code under test. Real lunar data is covered in ``test_real_sites_phase5_scoring.py``.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import random
from datetime import UTC, datetime
from fractions import Fraction
from typing import Any

import pytest

from app.viability.enums import (
    CommunicationMode,
    ConstraintId,
    DataBasis,
    Eligibility,
    MetricStatus,
    PowerSource,
    ScoreComponent,
    ScoreComponentStatus,
    ScoreStatus,
    Unit,
)
from app.viability.mission import MissionRequirements, MissionScenario, RankingPreferences, SpacecraftConfiguration
from app.viability.outputs import Metric, MetricsSummary, OperationalMargin, ScoreBreakdown
from app.viability.scoring import SCORING_METHOD_VERSION, rank_assessments, score_scenario

from .helpers import unavailable_metrics

C = ScoreComponent
H = 3600.0
DARK_LIMIT = 100.0 * H
BLACKOUT_LIMIT = 50.0 * H
T0 = datetime(2027, 1, 1, tzinfo=UTC)
ZERO = {
    "sunlight_weight": 0.0,
    "earth_visibility_weight": 0.0,
    "simultaneous_weight": 0.0,
    "darkness_margin_weight": 0.0,
    "blackout_margin_weight": 0.0,
    "clearance_margin_weight": 0.0,
}


def scenario(
    *,
    dark: float | None = None,
    blackout: float | None = None,
    requirements: dict[str, Any] | None = None,
    **weights: float,
) -> MissionScenario:
    """Weights default to a single active component unless given: pass e.g. ``sunlight_weight=1``."""
    prefs = {**ZERO, **weights}
    return MissionScenario(
        scenario_id="synthetic-score-1",
        site={"id": "site-1", "name": "Synthetic", "lat": -89.5, "lon": 45.0},  # type: ignore[arg-type]
        mission_start_utc=T0,
        mission_end_utc=datetime(2027, 1, 15, tzinfo=UTC),
        spacecraft=SpacecraftConfiguration(
            name="lander",
            power_source=PowerSource.SOLAR,
            communication_mode=CommunicationMode.DIRECT_TO_EARTH,
            max_continuous_darkness_s=dark,
            max_communication_blackout_s=blackout,
        ),
        requirements=MissionRequirements(**(requirements or {})),
        preferences=RankingPreferences(**prefs),
    )


def metrics(sun: Metric | None = None, earth: Metric | None = None, sim: Metric | None = None) -> MetricsSummary:
    over: dict[str, Metric] = {}
    if sun is not None:
        over["mean_solar_disk_fraction"] = sun
    if earth is not None:
        over["earth_visible_percent"] = earth
    if sim is not None:
        over["simultaneous_percent"] = sim
    return unavailable_metrics(**over)


def frac(v: float) -> Metric:
    return Metric.known(v, Unit.FRACTION)


def pct(v: float) -> Metric:
    return Metric.known(v, Unit.PERCENT)


def margin(cid: ConstraintId, value: Metric, reference: float) -> OperationalMargin:
    return OperationalMargin(
        margin_id=cid.value, related_constraint=cid, reference=reference, value=value, description="synthetic margin"
    )


def dark_margin(seconds: float, limit: float = DARK_LIMIT) -> OperationalMargin:
    return margin(ConstraintId.MAX_CONTINUOUS_DARKNESS, Metric.known(seconds, Unit.SECONDS), limit)


def blackout_margin(seconds: float, limit: float = BLACKOUT_LIMIT) -> OperationalMargin:
    return margin(ConstraintId.MAX_COMMUNICATION_BLACKOUT, Metric.known(seconds, Unit.SECONDS), limit)


def score(
    sc: MissionScenario,
    m: MetricsSummary | None = None,
    margins: list[OperationalMargin] | None = None,
    elig: Eligibility = Eligibility.PASS,
    **kw: Any,
) -> ScoreBreakdown:
    return score_scenario(sc, m or metrics(), margins or [], elig, **kw)


def component(b: ScoreBreakdown, c: ScoreComponent) -> Any:
    return next(x for x in b.components if x.component is c)


def down6(x: Fraction) -> float:
    return math.floor(x * 10**6) / 10**6


def up6(x: Fraction) -> float:
    return math.ceil(x * 10**6) / 10**6


# --- structure -----------------------------------------------------------------------------------


def test_lists_six_components_in_enum_order_with_method_version() -> None:
    b = score(scenario(sunlight_weight=1), metrics(sun=frac(0.5)))
    assert [c.component for c in b.components] == list(ScoreComponent)
    assert b.method_version == SCORING_METHOD_VERSION and SCORING_METHOD_VERSION
    assert b.configuration_key is not None and b.configuration_key.startswith("sha256:")


def test_result_round_trips_through_the_contract_validator() -> None:
    sc = scenario(sunlight_weight=1, earth_visibility_weight=2, dark=DARK_LIMIT, darkness_margin_weight=1)
    b = score(sc, metrics(sun=frac(0.3), earth=pct(45.5)), [dark_margin(30 * H)])
    assert ScoreBreakdown.model_validate(b.model_dump(mode="json")) == b


def test_rank_assessments_is_the_ranking_module_function() -> None:
    from app.viability import ranking

    assert rank_assessments is ranking.rank_assessments  # re-exported, not a copy (integration step)


# --- component formulas and boundaries -----------------------------------------------------------


@pytest.mark.parametrize("v", [0.0, 1e-9, 0.25, 1 / 3, 0.5, 0.999999, 1.0])
def test_sunlight_uses_mean_solar_disk_fraction(v: float) -> None:
    b = score(scenario(sunlight_weight=1), metrics(sun=frac(v)))
    assert b.status is ScoreStatus.KNOWN
    assert b.score == round(100 * v, 6)
    assert component(b, C.SUNLIGHT).normalized_value == v


def test_sunlight_ignores_sunlight_percent_and_panel_threshold_metrics() -> None:
    m = unavailable_metrics(mean_solar_disk_fraction=frac(0.4), sunlight_percent=pct(99.0), power_lit_percent=pct(98.0))
    assert score(scenario(sunlight_weight=1), m).score == 40.0


@pytest.mark.parametrize("v", [0.0, 12.5, 40.0, 100.0])
def test_earth_visibility_is_percent_over_100(v: float) -> None:
    b = score(scenario(earth_visibility_weight=1), metrics(earth=pct(v)))
    assert b.score == round(v, 6)
    assert component(b, C.EARTH_VISIBILITY).normalized_value == v / 100


@pytest.mark.parametrize("v", [0.0, 7.0, 100.0])
def test_simultaneous_is_percent_over_100(v: float) -> None:
    b = score(scenario(simultaneous_weight=1), metrics(sim=pct(v)))
    assert b.score == round(v, 6)


def test_percent_noise_slightly_above_100_clamps_to_one() -> None:
    b = score(scenario(earth_visibility_weight=1), metrics(earth=pct(100.0000000001)))
    assert b.score == 100.0


@pytest.mark.parametrize(
    ("margin_s", "expected"),
    [(0.0, 0.0), (DARK_LIMIT / 4, 0.25), (DARK_LIMIT / 2, 0.5), (DARK_LIMIT, 1.0), (DARK_LIMIT * 3, 1.0), (-1.0, 0.0)],
)
def test_darkness_margin_is_clamped_margin_over_limit(margin_s: float, expected: float) -> None:
    sc = scenario(dark=DARK_LIMIT, darkness_margin_weight=1)
    b = score(sc, margins=[dark_margin(margin_s)], elig=Eligibility.FAIL if margin_s < 0 else Eligibility.PASS)
    assert component(b, C.DARKNESS_MARGIN).normalized_value == expected
    assert b.score == round(100 * expected, 6)


@pytest.mark.parametrize(
    ("margin_s", "expected"),
    [(0.0, 0.0), (BLACKOUT_LIMIT * 0.8, 0.8), (BLACKOUT_LIMIT, 1.0), (-5 * BLACKOUT_LIMIT, 0.0)],
)
def test_blackout_margin_is_clamped_margin_over_limit(margin_s: float, expected: float) -> None:
    sc = scenario(blackout=BLACKOUT_LIMIT, blackout_margin_weight=1)
    b = score(sc, margins=[blackout_margin(margin_s)], elig=Eligibility.FAIL if margin_s < 0 else Eligibility.PASS)
    assert component(b, C.BLACKOUT_MARGIN).normalized_value == expected


def test_margin_equals_one_minus_outage_over_limit() -> None:
    # outage D = 30 h of a 100 h limit -> margin 70 h -> 0.7 = 1 - D/t
    sc = scenario(dark=DARK_LIMIT, darkness_margin_weight=1)
    assert score(sc, margins=[dark_margin(70 * H)]).score == 70.0


def test_clearance_is_unsupported_even_with_a_positive_weight_and_never_estimated() -> None:
    sc = scenario(sunlight_weight=1, clearance_margin_weight=5)
    m = unavailable_metrics(mean_solar_disk_fraction=frac(0.5), mean_sun_clearance=Metric.known(30.0, Unit.DEGREES))
    b = score(sc, m)
    c = component(b, C.CLEARANCE_MARGIN)
    assert c.status is ScoreComponentStatus.UNSUPPORTED
    assert c.weight == 0.0 and c.normalized is None and c.declared_weight == 5.0
    assert b.score == 50.0  # clearance contributes nothing


def test_only_clearance_weighted_means_no_scorable_components() -> None:
    b = score(scenario(clearance_margin_weight=1), metrics(sun=frac(1.0)))
    assert b.status is ScoreStatus.NO_SCORABLE_COMPONENTS
    assert b.score is None and b.score_bounds is None and b.rank_eligible is True


# --- exact scores, rounding, weights -------------------------------------------------------------


def test_weighted_sum_uses_normalised_weights() -> None:
    sc = scenario(sunlight_weight=1, earth_visibility_weight=3)
    b = score(sc, metrics(sun=frac(1.0), earth=pct(0.0)))
    assert component(b, C.SUNLIGHT).weight == 0.25 and component(b, C.EARTH_VISIBILITY).weight == 0.75
    assert b.score == 25.0
    assert component(b, C.SUNLIGHT).contribution == 25.0
    assert component(b, C.EARTH_VISIBILITY).contribution == 0.0


def test_exact_score_is_rounded_to_nearest_six_decimals() -> None:
    b = score(scenario(sunlight_weight=1), metrics(sun=frac(1 / 3)))
    assert b.score == 33.333333
    b2 = score(scenario(sunlight_weight=1), metrics(sun=frac(2 / 3)))
    assert b2.score == 66.666667


def test_known_score_carries_matching_known_bounds() -> None:
    b = score(scenario(sunlight_weight=1), metrics(sun=frac(0.123456789)))
    assert b.status is ScoreStatus.KNOWN
    assert b.score_bounds is not None and b.score_bounds.status is MetricStatus.KNOWN
    assert b.score_bounds.value == b.score and b.score_bounds.unit is Unit.PERCENT


def test_all_equal_weights_with_perfect_inputs_reach_exactly_100_never_above() -> None:
    sc = scenario(
        sunlight_weight=1,
        earth_visibility_weight=1,
        simultaneous_weight=1,
        dark=DARK_LIMIT,
        darkness_margin_weight=1,
        blackout=BLACKOUT_LIMIT,
        blackout_margin_weight=1,
    )
    m = metrics(sun=frac(1.0), earth=pct(100.0), sim=pct(100.0))
    b = score(sc, m, [dark_margin(DARK_LIMIT), blackout_margin(BLACKOUT_LIMIT)])
    assert b.score == 100.0


def test_all_worst_inputs_score_exactly_zero() -> None:
    sc = scenario(sunlight_weight=1, earth_visibility_weight=1, dark=DARK_LIMIT, darkness_margin_weight=1)
    b = score(sc, metrics(sun=frac(0.0), earth=pct(0.0)), [dark_margin(0.0)], Eligibility.FAIL)
    assert b.score == 0.0 and b.status is ScoreStatus.KNOWN


@pytest.mark.parametrize("factor", [1e-300, 1e-12, 0.001, 7.0, 1e6, 1e300])
def test_weight_scaling_invariance(factor: float) -> None:
    m = metrics(sun=frac(0.2), earth=pct(80.0), sim=pct(10.0))
    base = scenario(sunlight_weight=1.0, earth_visibility_weight=2.0, simultaneous_weight=3.0)
    scaled = scenario(
        sunlight_weight=1.0 * factor, earth_visibility_weight=2.0 * factor, simultaneous_weight=3.0 * factor
    )
    a, b = score(base, m), score(scaled, m)
    assert a.score == b.score
    for x, y in zip(a.components, b.components, strict=True):
        assert x.weight == pytest.approx(y.weight, rel=1e-12, abs=0.0)


def test_zero_weight_component_is_excluded_whatever_its_measurement() -> None:
    sc = scenario(sunlight_weight=1, earth_visibility_weight=0)
    for earth in (pct(0.0), pct(100.0), Metric.unavailable(Unit.PERCENT, "missing")):
        b = score(sc, metrics(sun=frac(0.6), earth=earth))
        assert b.score == 60.0 and b.status is ScoreStatus.KNOWN
        c = component(b, C.EARTH_VISIBILITY)
        assert c.status is ScoreComponentStatus.ZERO_WEIGHT and c.weight == 0.0 and c.normalized is None


def test_weights_follow_configuration_not_available_observations() -> None:
    sc = scenario(sunlight_weight=1, earth_visibility_weight=1)
    full = score(sc, metrics(sun=frac(0.5), earth=pct(50.0)))
    missing = score(sc, metrics(sun=frac(0.5)))
    assert [c.weight for c in full.components] == [c.weight for c in missing.components]
    assert component(missing, C.EARTH_VISIBILITY).weight == 0.5  # not removed, not re-normalised


# --- uncertainty ---------------------------------------------------------------------------------


def test_unavailable_active_metric_widens_bounds_to_unit_interval() -> None:
    sc = scenario(sunlight_weight=1, earth_visibility_weight=1)
    b = score(sc, metrics(sun=frac(0.5)))  # earth UNAVAILABLE
    assert b.status is ScoreStatus.BOUNDED and b.score is None
    assert b.score_bounds is not None and (b.score_bounds.lower, b.score_bounds.upper) == (25.0, 75.0)
    c = component(b, C.EARTH_VISIBILITY)
    assert c.normalized is not None and (c.normalized.lower, c.normalized.upper) == (0.0, 1.0)
    assert c.normalized_value is None and c.contribution is None


def test_only_unavailable_component_gives_zero_to_hundred_not_zero_score() -> None:
    b = score(scenario(sunlight_weight=1), metrics())
    assert b.score is None and b.score_bounds is not None
    assert (b.score_bounds.lower, b.score_bounds.upper) == (0.0, 100.0)


def test_bounded_metric_bounds_are_used() -> None:
    m = metrics(earth=Metric.bounded(40.0, 60.0, Unit.PERCENT))
    b = score(scenario(earth_visibility_weight=1), m)
    assert b.status is ScoreStatus.BOUNDED and b.score is None
    assert b.score_bounds is not None and (b.score_bounds.lower, b.score_bounds.upper) == (40.0, 60.0)


def test_bounds_round_outward_at_six_decimals() -> None:
    # weights 1/3 each; exact lower = 100/3 * (x + y + z) with awkward rationals
    lo, hi = 0.1234567, 0.7654321
    sc = scenario(sunlight_weight=1, earth_visibility_weight=1, simultaneous_weight=1)
    m = metrics(
        sun=Metric.bounded(lo, hi, Unit.FRACTION),
        earth=pct(100 / 3),
        sim=Metric.bounded(lo * 100, hi * 100, Unit.PERCENT),
    )
    b = score(sc, m)
    assert b.score_bounds is not None and b.score_bounds.lower is not None and b.score_bounds.upper is not None
    third = Fraction(1, 3)
    exact_lo = 100 * third * (Fraction(lo) + Fraction(100 / 3) / 100 + Fraction(lo * 100) / 100)
    exact_hi = 100 * third * (Fraction(hi) + Fraction(100 / 3) / 100 + Fraction(hi * 100) / 100)
    assert b.score_bounds.lower <= float(exact_lo) and float(exact_lo) - b.score_bounds.lower <= 2e-6
    assert b.score_bounds.upper >= float(exact_hi) and b.score_bounds.upper - float(exact_hi) <= 2e-6
    assert b.score_bounds.lower == pytest.approx(down6(exact_lo), abs=1e-6)
    assert b.score_bounds.upper == pytest.approx(up6(exact_hi), abs=1e-6)
    assert b.score_bounds.lower < b.score_bounds.upper


def test_bounds_are_never_a_score_and_never_leave_zero_to_hundred() -> None:
    sc = scenario(sunlight_weight=1, earth_visibility_weight=1)
    m = metrics(sun=Metric.bounded(0.9, 1.0, Unit.FRACTION), earth=pct(100.0))
    b = score(sc, m)
    assert b.score is None
    assert b.score_bounds is not None and b.score_bounds.upper is not None and b.score_bounds.upper <= 100.0
    assert b.lower_bound == b.score_bounds.lower


def test_degenerate_bounded_metric_with_equal_ends_is_a_known_component() -> None:
    m = metrics(earth=Metric.bounded(50.0, 50.0, Unit.PERCENT))
    b = score(scenario(earth_visibility_weight=1), m)
    assert b.status is ScoreStatus.KNOWN and b.score == 50.0


def test_bounded_margin_gives_interval_of_clamped_ratios() -> None:
    sc = scenario(dark=DARK_LIMIT, darkness_margin_weight=1)
    mg = margin(ConstraintId.MAX_CONTINUOUS_DARKNESS, Metric.bounded(-10 * H, 40 * H, Unit.SECONDS), DARK_LIMIT)
    b = score(sc, margins=[mg], elig=Eligibility.FAIL)
    assert b.score_bounds is not None and (b.score_bounds.lower, b.score_bounds.upper) == (0.0, 40.0)


def test_missing_or_unavailable_margin_for_a_configured_limit_is_bounded_zero_to_one() -> None:
    sc = scenario(dark=DARK_LIMIT, darkness_margin_weight=1)
    unavailable = margin(ConstraintId.MAX_CONTINUOUS_DARKNESS, Metric.unavailable(Unit.SECONDS, "no data"), DARK_LIMIT)
    for margins in ([], [unavailable]):
        b = score(sc, margins=margins)
        assert b.status is ScoreStatus.BOUNDED
        assert b.score_bounds is not None and (b.score_bounds.lower, b.score_bounds.upper) == (0.0, 100.0)


def test_unsupported_clearance_margin_is_never_read_as_a_score_input() -> None:
    sc = scenario(sunlight_weight=1, clearance_margin_weight=1)
    clearance = margin(ConstraintId.MIN_SUN_CLEARANCE, Metric.unavailable(Unit.DEGREES, "unsupported: clearance"), 5.0)
    b = score(sc, metrics(sun=frac(0.5)), [clearance])
    assert b.score == 50.0


def test_unavailable_is_never_converted_to_a_zero_observation() -> None:
    sc = scenario(sunlight_weight=1, earth_visibility_weight=1)
    unavailable = score(sc, metrics(sun=frac(1.0)))
    zero = score(sc, metrics(sun=frac(1.0), earth=pct(0.0)))
    assert zero.score == 50.0
    assert unavailable.score is None and unavailable.score_bounds is not None
    assert unavailable.score_bounds.lower == zero.score  # zero is only the lower bound


# --- missing / non-applicable requirements -------------------------------------------------------


def test_missing_limit_makes_margin_component_not_configured_and_excluded() -> None:
    sc = scenario(sunlight_weight=1, darkness_margin_weight=1)  # no darkness limit configured
    b = score(sc, metrics(sun=frac(0.8)))
    c = component(b, C.DARKNESS_MARGIN)
    assert c.status is ScoreComponentStatus.NOT_CONFIGURED and c.weight == 0.0 and c.declared_weight == 1.0
    assert component(b, C.SUNLIGHT).weight == 1.0 and b.score == 80.0


def test_not_applicable_margin_for_unconfigured_limit_is_ignored() -> None:
    sc = scenario(sunlight_weight=1, darkness_margin_weight=1)
    na = margin(ConstraintId.MAX_CONTINUOUS_DARKNESS, Metric.not_applicable(Unit.SECONDS), 1.0)
    na = na.model_copy(update={"reference": None})
    assert score(sc, metrics(sun=frac(0.8)), [na]).score == 80.0


def test_rescue_style_configuration_gives_four_quarter_weights() -> None:
    sc = scenario(
        dark=DARK_LIMIT,
        blackout=BLACKOUT_LIMIT,
        sunlight_weight=1,
        earth_visibility_weight=1,
        darkness_margin_weight=1,
        blackout_margin_weight=1,
    )
    b = score(sc, metrics(sun=frac(0.4), earth=pct(60.0)), [dark_margin(50 * H), blackout_margin(25 * H)])
    assert [c.weight for c in b.components] == [0.25, 0.25, 0.0, 0.25, 0.25, 0.0]
    assert b.score == pytest.approx(100 * 0.25 * (0.4 + 0.6 + 0.5 + 0.5), abs=1e-6)


# --- invalid thresholds, contradictions ----------------------------------------------------------


@pytest.mark.parametrize("limit", [0.0, -5.0, math.nan, math.inf, -math.inf])
def test_invalid_limits_raise_value_error(limit: float) -> None:
    sc = scenario(dark=DARK_LIMIT, darkness_margin_weight=1)
    bad = sc.model_copy(
        update={
            "spacecraft": SpacecraftConfiguration.model_construct(
                **{**sc.spacecraft.model_dump(), "max_continuous_darkness_s": limit}
            )
        }
    )
    with pytest.raises(ValueError, match="limit"):
        score(bad, margins=[dark_margin(1.0)])


def test_pass_with_a_negative_outage_margin_is_contradictory() -> None:
    sc = scenario(dark=DARK_LIMIT, darkness_margin_weight=1)
    with pytest.raises(ValueError, match="contradict"):
        score(sc, margins=[dark_margin(-1.0)], elig=Eligibility.PASS)


def test_pass_with_an_uncertain_margin_straddling_zero_is_contradictory() -> None:
    sc = scenario(dark=DARK_LIMIT, darkness_margin_weight=1)
    mg = margin(ConstraintId.MAX_CONTINUOUS_DARKNESS, Metric.bounded(-H, H, Unit.SECONDS), DARK_LIMIT)
    with pytest.raises(ValueError, match="contradict"):
        score(sc, margins=[mg], elig=Eligibility.PASS)


def test_unknown_with_a_definitely_violated_margin_is_contradictory() -> None:
    sc = scenario(dark=DARK_LIMIT, darkness_margin_weight=1)
    with pytest.raises(ValueError, match="contradict"):
        score(sc, margins=[dark_margin(-1.0)], elig=Eligibility.UNKNOWN)


def test_unknown_with_a_straddling_margin_is_consistent() -> None:
    sc = scenario(dark=DARK_LIMIT, darkness_margin_weight=1)
    mg = margin(ConstraintId.MAX_CONTINUOUS_DARKNESS, Metric.bounded(-H, H, Unit.SECONDS), DARK_LIMIT)
    assert score(sc, margins=[mg], elig=Eligibility.UNKNOWN).status is ScoreStatus.ELIGIBILITY_UNKNOWN


def test_margin_reference_must_match_the_configured_limit() -> None:
    sc = scenario(dark=DARK_LIMIT, darkness_margin_weight=1)
    with pytest.raises(ValueError, match="reference"):
        score(sc, margins=[dark_margin(10.0, limit=DARK_LIMIT * 2)])


def test_margin_must_be_in_seconds_and_unique() -> None:
    sc = scenario(dark=DARK_LIMIT, darkness_margin_weight=1)
    wrong_unit = margin(ConstraintId.MAX_CONTINUOUS_DARKNESS, Metric.known(0.5, Unit.FRACTION), DARK_LIMIT)
    with pytest.raises(ValueError, match="seconds"):
        score(sc, margins=[wrong_unit])
    with pytest.raises(ValueError, match="duplicate"):
        score(sc, margins=[dark_margin(1.0), dark_margin(2.0)])


# --- eligibility handling ------------------------------------------------------------------------


def test_unknown_eligibility_withholds_the_score_even_with_complete_data() -> None:
    sc = scenario(sunlight_weight=1, earth_visibility_weight=1)
    b = score(sc, metrics(sun=frac(0.9), earth=pct(90.0)), elig=Eligibility.UNKNOWN)
    assert b.status is ScoreStatus.ELIGIBILITY_UNKNOWN
    assert b.score is None and b.score_bounds is None and b.rank_eligible is False
    assert all(c.normalized is None and c.contribution is None for c in b.components)
    assert [c.weight for c in b.components][:2] == [0.5, 0.5]  # weights kept, configuration only
    assert b.configuration_key == sc.configuration_key()


def test_unknown_eligibility_with_no_active_component_is_still_eligibility_unknown() -> None:
    b = score(scenario(clearance_margin_weight=1), elig=Eligibility.UNKNOWN)
    assert b.status is ScoreStatus.ELIGIBILITY_UNKNOWN and b.score is None


def test_fail_keeps_a_descriptive_score_but_is_not_rank_eligible() -> None:
    sc = scenario(sunlight_weight=1, dark=DARK_LIMIT, darkness_margin_weight=1)
    b = score(sc, metrics(sun=frac(0.5)), [dark_margin(-50 * H)], Eligibility.FAIL)
    assert b.status is ScoreStatus.KNOWN and b.score == 25.0 and b.rank_eligible is False
    assert component(b, C.DARKNESS_MARGIN).normalized_value == 0.0  # clamped, not negative


def test_fail_with_missing_data_gets_bounds_never_pass_eligibility() -> None:
    b = score(scenario(sunlight_weight=1), metrics(), elig=Eligibility.FAIL)
    assert b.status is ScoreStatus.BOUNDED and b.rank_eligible is False


def test_only_pass_is_rank_eligible() -> None:
    sc = scenario(sunlight_weight=1)
    flags = {e: score(sc, metrics(sun=frac(1.0)), elig=e).rank_eligible for e in Eligibility}
    assert flags == {Eligibility.PASS: True, Eligibility.UNKNOWN: False, Eligibility.FAIL: False}


def test_score_value_does_not_depend_on_eligibility_for_pass_and_fail() -> None:
    sc = scenario(sunlight_weight=1, earth_visibility_weight=1)
    m = metrics(sun=frac(0.3), earth=pct(70.0))
    assert score(sc, m, elig=Eligibility.PASS).score == score(sc, m, elig=Eligibility.FAIL).score == 50.0


def test_pass_with_bounded_score_stays_rank_eligible_with_null_score() -> None:
    b = score(scenario(sunlight_weight=1), metrics(), elig=Eligibility.PASS)
    assert b.rank_eligible is True and b.score is None and b.status is ScoreStatus.BOUNDED


# --- monotonicity, stability, determinism --------------------------------------------------------


def test_score_is_monotone_in_every_component() -> None:
    sc = scenario(
        sunlight_weight=2,
        earth_visibility_weight=1,
        simultaneous_weight=1,
        dark=DARK_LIMIT,
        darkness_margin_weight=3,
        blackout=BLACKOUT_LIMIT,
        blackout_margin_weight=1,
    )
    steps = [i / 20 for i in range(21)]
    base = {"sun": 0.5, "earth": 50.0, "sim": 50.0, "dark": 0.5, "black": 0.5}

    def run(**ov: float) -> float:
        p = {**base, **ov}
        b = score(
            sc,
            metrics(sun=frac(p["sun"]), earth=pct(p["earth"]), sim=pct(p["sim"])),
            [dark_margin(p["dark"] * DARK_LIMIT), blackout_margin(p["black"] * BLACKOUT_LIMIT)],
        )
        assert b.score is not None
        return b.score

    for key, scale in (("sun", 1.0), ("earth", 100.0), ("sim", 100.0), ("dark", 1.0), ("black", 1.0)):
        series = [run(**{key: s * scale}) for s in steps]
        assert series == sorted(series)
        assert series[0] < series[-1]


def test_bounds_contain_the_exact_score_of_every_consistent_observation() -> None:
    rng = random.Random(20270101)
    sc = scenario(sunlight_weight=1, earth_visibility_weight=2, simultaneous_weight=3)
    for _ in range(200):
        s_lo, s_hi = sorted((rng.random(), rng.random()))
        e_lo, e_hi = sorted((rng.random() * 100, rng.random() * 100))
        sim = rng.random() * 100
        bounded = score(
            sc,
            metrics(
                sun=Metric.bounded(s_lo, s_hi, Unit.FRACTION),
                earth=Metric.bounded(e_lo, e_hi, Unit.PERCENT),
                sim=pct(sim),
            ),
        )
        point = score(
            sc,
            metrics(sun=frac(rng.uniform(s_lo, s_hi)), earth=pct(rng.uniform(e_lo, e_hi)), sim=pct(sim)),
        )
        assert bounded.score_bounds is not None and point.score is not None
        assert bounded.score_bounds.lower is not None and bounded.score_bounds.upper is not None
        assert bounded.score_bounds.lower <= point.score <= bounded.score_bounds.upper
        assert 0.0 <= bounded.score_bounds.lower and bounded.score_bounds.upper <= 100.0


def test_extreme_weight_ratios_are_numerically_stable() -> None:
    sc = scenario(sunlight_weight=1e-150, earth_visibility_weight=1e150)
    b = score(sc, metrics(sun=frac(1.0), earth=pct(0.0)))
    assert b.score == 0.0
    b2 = score(sc, metrics(sun=frac(0.0), earth=pct(100.0)))
    assert b2.score == 100.0
    assert sum(c.weight for c in b.components) == pytest.approx(1.0, abs=1e-15)


def test_weight_ratio_that_underflows_is_rejected_not_silently_dropped() -> None:
    sc = scenario(sunlight_weight=1e-300, earth_visibility_weight=1e300)
    with pytest.raises(ValueError, match="underflows"):
        score(sc, metrics(sun=frac(1.0), earth=pct(0.0)))


def test_output_is_deterministic_and_serialises_identically() -> None:
    sc = scenario(sunlight_weight=1, earth_visibility_weight=1, dark=DARK_LIMIT, darkness_margin_weight=1)
    args = (sc, metrics(sun=frac(0.37), earth=pct(61.1)), [dark_margin(33 * H)], Eligibility.PASS)
    outputs = {score_scenario(*args).model_dump_json() for _ in range(5)}
    assert len(outputs) == 1


def test_margin_list_order_does_not_matter() -> None:
    sc = scenario(dark=DARK_LIMIT, blackout=BLACKOUT_LIMIT, darkness_margin_weight=1, blackout_margin_weight=2)
    ms = [dark_margin(10 * H), blackout_margin(20 * H)]
    assert score(sc, margins=ms) == score(sc, margins=list(reversed(ms)))


def test_irrelevant_margins_in_the_list_are_ignored() -> None:
    sc = scenario(sunlight_weight=1)
    other = margin(ConstraintId.MIN_SUNLIGHT_PERCENT, Metric.known(-5.0, Unit.PERCENT), 50.0)
    assert score(sc, metrics(sun=frac(0.5)), [other]).score == 50.0


def test_score_is_independent_of_other_scenarios_evaluated() -> None:
    sc = scenario(sunlight_weight=1, earth_visibility_weight=1)
    m = metrics(sun=frac(0.2), earth=pct(80.0))
    alone = score(sc, m)
    for v in (0.0, 1.0):  # evaluate unrelated scenarios in between
        score(scenario(sunlight_weight=1), metrics(sun=frac(v)))
    assert score(sc, m) == alone


def test_inputs_are_not_mutated() -> None:
    sc = scenario(sunlight_weight=1, dark=DARK_LIMIT, darkness_margin_weight=1)
    m = metrics(sun=frac(0.5))
    ms = [dark_margin(10 * H)]
    before = (
        copy.deepcopy(sc.model_dump()),
        copy.deepcopy(m.model_dump()),
        copy.deepcopy([x.model_dump() for x in ms]),
    )
    score_scenario(sc, m, ms, Eligibility.PASS)
    assert (sc.model_dump(), m.model_dump(), [x.model_dump() for x in ms]) == before


# --- requirements fingerprint --------------------------------------------------------------------


def _independent_key(sc: MissionScenario) -> str:
    """Re-implementation of the documented canonical serialisation (docs §5e D7)."""

    def num(v: float | None) -> float | None:
        return None if v is None else float(v) + 0.0

    r, s = sc.requirements, sc.spacecraft
    payload = {
        "key_version": 1,
        "mission_duration_us": int((sc.mission_end_utc - sc.mission_start_utc).total_seconds() * 1_000_000),
        "spacecraft": {
            "power_source": s.power_source.value,
            "communication_mode": s.communication_mode.value,
            "max_continuous_darkness_s": num(s.max_continuous_darkness_s),
            "max_communication_blackout_s": num(s.max_communication_blackout_s),
            "solar_power_min_disk_fraction": num(s.solar_power_min_disk_fraction),
        },
        "requirements": {k: num(getattr(r, k)) for k in MissionRequirements.model_fields if k != "unknown_data_policy"},
    }
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return "sha256:" + hashlib.sha256(text.encode("ascii")).hexdigest()


def test_configuration_key_matches_independent_sha256_of_canonical_json() -> None:
    sc = scenario(
        sunlight_weight=1,
        dark=DARK_LIMIT,
        blackout=BLACKOUT_LIMIT,
        requirements={"min_sunlight_percent": 50, "min_earth_visibility_percent": 40.0},
    )
    b = score(sc, metrics(sun=frac(0.5)))
    assert b.configuration_key == _independent_key(sc)


def test_fingerprint_ignores_identity_and_preferences_but_not_requirements() -> None:
    a = scenario(sunlight_weight=1, requirements={"min_sunlight_percent": 50.0})
    renamed = a.model_copy(update={"scenario_id": "other", "name": "Other"})
    reweighted = scenario(earth_visibility_weight=9, requirements={"min_sunlight_percent": 50.0})
    stricter = scenario(sunlight_weight=1, requirements={"min_sunlight_percent": 51.0})
    longer = a.model_copy(update={"mission_end_utc": datetime(2027, 1, 16, tzinfo=UTC)})
    m = metrics(sun=frac(0.5), earth=pct(50.0))
    keys = [score(x, m).configuration_key for x in (a, renamed, reweighted, stricter, longer)]
    assert keys[0] == keys[1] == keys[2]
    assert keys[3] != keys[0] and keys[4] != keys[0]


def test_fingerprint_is_the_same_across_repeated_calls() -> None:
    sc = scenario(sunlight_weight=1)
    assert len({score(sc).configuration_key for _ in range(3)}) == 1


# --- synthetic labelling and notes ---------------------------------------------------------------


def test_synthetic_basis_marks_the_score_note() -> None:
    b = score(scenario(sunlight_weight=1), metrics(sun=frac(0.5)), data_basis=DataBasis.SYNTHETIC)
    assert b.note is not None and b.note.startswith("[SYNTHETIC DATA] ")
    assert "validated" not in b.note.replace("not validated", "").replace("not scientifically validated", "")


@pytest.mark.parametrize("basis", [DataBasis.REAL_TERRAIN_AWARE, DataBasis.REAL_GEOMETRIC_ONLY, None])
def test_real_or_unspecified_basis_is_not_marked_synthetic(basis: DataBasis | None) -> None:
    b = score(scenario(sunlight_weight=1), metrics(sun=frac(0.5)), data_basis=basis)
    assert b.note is not None and "SYNTHETIC" not in b.note


def test_synthetic_label_applies_to_every_score_state() -> None:
    sc = scenario(sunlight_weight=1)
    for elig, m in ((Eligibility.UNKNOWN, metrics(sun=frac(1.0))), (Eligibility.PASS, metrics())):
        b = score(sc, m, elig=elig, data_basis=DataBasis.SYNTHETIC)
        assert b.note is not None and b.note.startswith("[SYNTHETIC DATA]")


def test_note_states_the_illumination_proxy_limitation() -> None:
    b = score(scenario(sunlight_weight=1), metrics(sun=frac(0.5)))
    assert b.note is not None and "illumination proxy" in b.note and "not" in b.note
    c = component(b, C.SUNLIGHT)
    assert c.note is not None and "illumination proxy" in c.note


def test_components_explain_their_status_in_notes() -> None:
    b = score(scenario(sunlight_weight=1, clearance_margin_weight=1), metrics(sun=frac(0.5)))
    assert "clearance" in (component(b, C.CLEARANCE_MARGIN).note or "").lower()
    assert component(b, C.EARTH_VISIBILITY).note is not None
