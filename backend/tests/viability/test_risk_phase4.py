"""Phase 4B risk indicators on SYNTHETIC series with hand-derived expected levels.

Series come from ``helpers.hourly``: sample k holds [k h, k+1 h) under sample-and-hold and the
coverage is [0, n] h, so every duration below is a count of hours. Sun codes: "V" whole disk,
"N" none, "X" no ephemeris (unknown). Earth: "V"/"N"/"U". Margins are built here from the
published ``OperationalMargin`` contract with hand-computed values (margin = observed - required
for minimums), never from the concurrently developed margins engine.

Default policy bands on headroom h = margin / reference: h <= 10 % HIGH, h <= 25 % MODERATE,
else LOW (inclusive).
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any

import pytest
from pydantic import TypeAdapter

from app.viability.constraints import assess_constraints
from app.viability.enums import (
    CommunicationMode,
    ConstraintId,
    ConstraintStatus,
    Eligibility,
    MetricStatus,
    PowerSource,
    RiskLevel,
    Unit,
    UnknownDataPolicy,
)
from app.viability.inputs import ScientificTimeSeries
from app.viability.mission import MissionRequirements, MissionScenario, SpacecraftConfiguration
from app.viability.outputs import ConstraintAssessment, Metric, OperationalMargin, RiskIndicator
from app.viability.risk import (
    DEFAULT_RISK_POLICY,
    SYNTHETIC_PREFIX,
    RiskPolicy,
    assess_risks,
    classify_bounds,
    headroom_band,
    overall_risk,
)

from .helpers import SunCode, at, hourly, make_series

H = 3600.0
C = ConstraintId
LOW, MOD, HIGH, UNK = RiskLevel.LOW, RiskLevel.MODERATE, RiskLevel.HIGH, RiskLevel.UNKNOWN
PASS, FAIL, UNKNOWN = Eligibility.PASS, Eligibility.FAIL, Eligibility.UNKNOWN


def scenario(
    series: ScientificTimeSeries,
    hours: float,
    *,
    start_h: float = 0.0,
    dark_h: float | None = None,
    blackout_h: float | None = None,
    threshold: float | None = None,
    sid: str = "phase4-risk",
    **req: Any,
) -> MissionScenario:
    return MissionScenario(
        scenario_id=sid,
        site=series.site,
        mission_start_utc=at(start_h),
        mission_end_utc=at(start_h + hours),
        spacecraft=SpacecraftConfiguration(
            name="Synthetic lander",
            power_source=PowerSource.SOLAR,
            communication_mode=CommunicationMode.DIRECT_TO_EARTH,
            max_continuous_darkness_s=None if dark_h is None else dark_h * H,
            max_communication_blackout_s=None if blackout_h is None else blackout_h * H,
            solar_power_min_disk_fraction=threshold,
        ),
        requirements=MissionRequirements(**req),
    )


def margin(
    cid: ConstraintId | None, reference: float | None, value: Metric, mid: str | None = None
) -> OperationalMargin:
    return OperationalMargin(
        margin_id=mid or (cid.value if cid else "informational"),
        related_constraint=cid,
        reference=reference,
        value=value,
        description="SYNTHETIC test margin",
    )


def pct_margin(cid: ConstraintId, required: float, observed: float) -> OperationalMargin:
    return margin(cid, required, Metric.known(observed - required, Unit.PERCENT))


def run(
    series: ScientificTimeSeries,
    hours: float,
    *,
    margins: list[OperationalMargin] | None = None,
    policy: RiskPolicy = DEFAULT_RISK_POLICY,
    **kw: Any,
) -> tuple[ConstraintAssessment, dict[str, RiskIndicator]]:
    sc = scenario(series, hours, **kw)
    a = assess_constraints(sc, series)
    risks = assess_risks(sc, a, margins or [], policy=policy)
    codes = [r.code for r in risks]
    assert len(codes) == len(set(codes)), "indicator codes must be unique per assessment"
    return a, {r.code: r for r in risks}


# 11 h lit then 9 h dark: direct sunlight 55 % of a 20 h mission.
LIGHT_DARK: Sequence[SunCode] = ["V"] * 11 + ["N"] * 9
# 10 h lit, 4 h unknown, 6 h dark: sunlight in [50, 70] %, longest dark in [6, 10] h.
WITH_UNKNOWN: Sequence[SunCode] = ["V"] * 10 + ["X"] * 4 + ["N"] * 6
# 10 h lit, 30 h dark, 10 h lit: one interior 30 h night.
NIGHT: Sequence[SunCode] = ["V"] * 10 + ["N"] * 30 + ["V"] * 10


# --- pure rules ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("h", "level"),
    [
        (-1.0, HIGH),
        (0.0, HIGH),
        (0.05, HIGH),
        (0.10, HIGH),
        (0.1000001, MOD),
        (0.25, MOD),
        (0.2500001, LOW),
        (3.0, LOW),
    ],
)
def test_headroom_band_inclusive_thresholds(h: float, level: RiskLevel) -> None:
    assert headroom_band(h) is level


def test_headroom_band_absorbs_float_representation_at_threshold() -> None:
    assert headroom_band(1.0 - 0.9) is HIGH  # 0.09999999999999998
    assert headroom_band(1.0 - 0.75) is MOD


def test_classify_bounds_decides_only_when_bounds_agree() -> None:
    assert classify_bounds(LOW, LOW) is LOW
    assert classify_bounds(HIGH, HIGH) is HIGH
    assert classify_bounds(HIGH, LOW) is UNK
    assert classify_bounds(MOD, LOW) is UNK


def _ind(level: RiskLevel) -> RiskIndicator:
    return RiskIndicator(code="x", level=level, rule="r", message="m")


@pytest.mark.parametrize(
    ("levels", "expected"),
    [
        ([], UNK),
        ([LOW], LOW),
        ([LOW, MOD], MOD),
        ([LOW, MOD, UNK], UNK),
        ([UNK, HIGH, LOW], HIGH),
        ([MOD, HIGH], HIGH),
    ],
)
def test_overall_risk_aggregation(levels: list[RiskLevel], expected: RiskLevel) -> None:
    assert overall_risk([_ind(lv) for lv in levels]) is expected


@pytest.mark.parametrize(("hi", "mod"), [(-0.1, 0.25), (0.3, 0.2), (0.1, 1.5), (float("nan"), 0.25)])
def test_risk_policy_rejects_invalid_thresholds(hi: float, mod: float) -> None:
    with pytest.raises(ValueError, match="risk policy"):
        RiskPolicy(high_headroom_fraction=hi, moderate_headroom_fraction=mod)


# --- 1-4: strong, narrow, zero and negative margins ---------------------------------------------


@pytest.mark.parametrize(
    ("required", "level", "eligibility"),
    [
        (25.0, LOW, PASS),  # margin 30 pp, headroom 120 %
        (44.0, MOD, PASS),  # margin 11 pp, headroom exactly 25 %
        (50.0, HIGH, PASS),  # margin 5 pp, headroom exactly 10 %
        (55.0, HIGH, PASS),  # margin 0: exactly at the requirement
        (60.0, HIGH, FAIL),  # margin -5 pp: confirmed violation
    ],
)
def test_minimum_requirement_margin_bands(required: float, level: RiskLevel, eligibility: Eligibility) -> None:
    a, r = run(
        hourly(LIGHT_DARK),
        20,
        min_sunlight_percent=required,
        margins=[pct_margin(C.MIN_SUNLIGHT_PERCENT, required, 55.0)],
    )
    ind = r["margin_headroom.min_sunlight_percent"]
    assert ind.level is level
    assert a.eligibility is eligibility
    assert ind.evidence == Metric.known(55.0 - required, Unit.PERCENT)
    assert f"constraint verdict {a.constraint(C.MIN_SUNLIGHT_PERCENT).status.value}" in ind.message


def test_pass_scenario_can_carry_high_risk() -> None:
    a, r = run(
        hourly(LIGHT_DARK), 20, min_sunlight_percent=55.0, margins=[pct_margin(C.MIN_SUNLIGHT_PERCENT, 55.0, 55.0)]
    )
    assert a.eligibility is PASS
    assert overall_risk(list(r.values())) is HIGH


def test_initial_duration_margin_uses_seconds_reference() -> None:
    # Lit for the first 11 h; 10 h required -> margin 1 h, headroom 10 % -> HIGH.
    _, r = run(
        hourly(LIGHT_DARK),
        20,
        min_initial_sunlight_s=10 * H,
        margins=[margin(C.MIN_INITIAL_SUNLIGHT, 10 * H, Metric.known(1 * H, Unit.SECONDS))],
    )
    assert r["margin_headroom.min_initial_sunlight"].level is HIGH
    assert "margin 1 h against required 10 h" in r["margin_headroom.min_initial_sunlight"].message


# --- 5: unknown margins -------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value", [Metric.unavailable(Unit.PERCENT, "no data"), Metric.not_applicable(Unit.PERCENT)], ids=str
)
def test_unknown_margin_value_is_unknown_risk(value: Metric) -> None:
    _, r = run(hourly(LIGHT_DARK), 20, min_sunlight_percent=25.0, margins=[margin(C.MIN_SUNLIGHT_PERCENT, 25.0, value)])
    assert r["margin_headroom.min_sunlight_percent"].level is UNK


def test_missing_margin_is_unknown_for_pass_and_high_for_fail() -> None:
    _, passing = run(hourly(LIGHT_DARK), 20, min_sunlight_percent=25.0)
    assert passing["margin_headroom.min_sunlight_percent"].level is UNK
    assert "no operational margin supplied" in passing["margin_headroom.min_sunlight_percent"].message
    _, failing = run(hourly(LIGHT_DARK), 20, min_sunlight_percent=60.0)
    assert failing["margin_headroom.min_sunlight_percent"].level is HIGH


def test_zero_reference_follows_verdict() -> None:
    _, r = run(
        hourly(LIGHT_DARK),
        20,
        min_sunlight_percent=0.0,
        margins=[pct_margin(C.MIN_SUNLIGHT_PERCENT, 0.0, 55.0)],
    )
    ind = r["margin_headroom.min_sunlight_percent"]
    assert ind.level is LOW and "relative headroom is undefined" in ind.message


# --- 6: bounded margins crossing thresholds ------------------------------------------------------


@pytest.mark.parametrize(
    ("required", "level", "eligibility"),
    [
        (30.0, LOW, PASS),  # margin [20, 40] -> headroom [67 %, 133 %]: decided despite unknown data
        (48.0, UNK, PASS),  # margin [2, 22] -> [4 %, 46 %]: HIGH vs LOW -> UNKNOWN although PASS
        (65.0, HIGH, UNKNOWN),  # margin [-15, 5] -> [-23 %, 7.7 %]: HIGH either way; verdict stays UNKNOWN
        (75.0, HIGH, FAIL),  # margin [-25, -5]
    ],
)
def test_bounded_margin_levels(required: float, level: RiskLevel, eligibility: Eligibility) -> None:
    value = Metric.bounded(50.0 - required, 70.0 - required, Unit.PERCENT)
    a, r = run(
        hourly(WITH_UNKNOWN),
        20,
        min_sunlight_percent=required,
        margins=[margin(C.MIN_SUNLIGHT_PERCENT, required, value)],
    )
    assert a.constraint(C.MIN_SUNLIGHT_PERCENT).measured == Metric.bounded(
        50.0, 70.0, Unit.PERCENT, a.constraint(C.MIN_SUNLIGHT_PERCENT).measured.reason
    )
    assert a.eligibility is eligibility
    assert r["margin_headroom.min_sunlight_percent"].level is level


@pytest.mark.parametrize(
    ("limit_h", "level", "eligibility"),
    [
        (100.0, LOW, PASS),  # longest dark in [6, 10] h -> headroom [90 %, 94 %]
        (10.5, UNK, PASS),  # headroom [4.8 %, 43 %]
        (6.5, HIGH, UNKNOWN),  # headroom [-54 %, 7.7 %]
        (5.0, HIGH, FAIL),
    ],
)
def test_bounded_darkness_exposure(limit_h: float, level: RiskLevel, eligibility: Eligibility) -> None:
    a, r = run(hourly(WITH_UNKNOWN), 20, dark_h=limit_h)
    assert a.constraint(C.MAX_CONTINUOUS_DARKNESS).measured.status is MetricStatus.BOUNDED
    assert a.eligibility is eligibility
    ind = r["darkness_exposure"]
    assert ind.level is level
    assert "between 6 h and 10 h" in ind.message and "4 h of unknown state" in ind.message


# --- 7-8: long darkness and long Earth blackouts --------------------------------------------------


@pytest.mark.parametrize(
    ("limit_h", "level", "eligibility"),
    [
        (300.0, LOW, PASS),  # 10 % of the limit consumed
        (40.0, MOD, PASS),  # 75 % consumed, headroom exactly 25 %
        (33.0, HIGH, PASS),  # 90.9 % consumed
        (30.0, HIGH, PASS),  # exactly at the limit
        (29.0, HIGH, FAIL),  # limit exceeded
    ],
)
def test_long_darkness_exposure(limit_h: float, level: RiskLevel, eligibility: Eligibility) -> None:
    a, r = run(hourly(NIGHT), 50, dark_h=limit_h)
    ind = r["darkness_exposure"]
    assert (ind.level, a.eligibility) == (level, eligibility)
    assert ind.evidence == Metric.known(30 * H, Unit.SECONDS)
    assert "Longest power-dark period is 30 h" in ind.message
    # Interior night: neither in progress at landing nor at mission end.
    assert "in progress at landing" not in ind.message and "mission end" not in ind.message


@pytest.mark.parametrize(
    ("limit_h", "level", "eligibility"),
    [(300.0, LOW, PASS), (40.0, MOD, PASS), (33.0, HIGH, PASS), (30.0, HIGH, PASS), (29.0, HIGH, FAIL)],
)
def test_long_earth_blackout_exposure(limit_h: float, level: RiskLevel, eligibility: Eligibility) -> None:
    earth = ["V"] * 10 + ["N"] * 30 + ["V"] * 10
    a, r = run(hourly(["V"] * 50, earth), 50, blackout_h=limit_h)
    ind = r["communication_exposure"]
    assert (ind.level, a.eligibility) == (level, eligibility)
    assert "30 h" in ind.message and "not a radio link" in ind.message
    assert "darkness_exposure" not in r  # no darkness limit configured


# --- 9: darkness beginning before landing ---------------------------------------------------------


def test_darkness_in_progress_at_landing() -> None:
    sun: Sequence[SunCode] = ["N"] * 10 + ["V"] * 20
    _, r = run(hourly(sun), 20, start_h=4.0)
    ind = r["landing_in_darkness"]
    assert ind.level is MOD  # confirmed, no limit to scale it, not the whole mission
    assert ind.evidence == Metric.known(6 * H, Unit.SECONDS)
    assert "already in progress at landing" in ind.message and "6 h from landing" in ind.message
    assert "stored energy" in ind.message


@pytest.mark.parametrize(("limit_h", "level"), [(100.0, MOD), (8.0, MOD), (6.5, HIGH), (6.0, HIGH)])
def test_landing_darkness_scaled_by_limit(limit_h: float, level: RiskLevel) -> None:
    sun: Sequence[SunCode] = ["N"] * 10 + ["V"] * 20
    _, r = run(hourly(sun), 20, start_h=4.0, dark_h=limit_h)
    assert r["landing_in_darkness"].level is level
    assert "already in progress at landing" in r["darkness_exposure"].message


def test_darkness_beginning_exactly_at_landing() -> None:
    sun: Sequence[SunCode] = ["V"] * 5 + ["N"] * 10 + ["V"] * 15
    _, r = run(hourly(sun), 20, start_h=5.0)
    assert "beginning exactly at landing" in r["landing_in_darkness"].message


def test_darkness_for_the_whole_mission_is_high_without_a_limit() -> None:
    _, r = run(hourly(["N"] * 30), 20, start_h=5.0)
    ind = r["landing_in_darkness"]
    assert ind.level is HIGH and "(the whole mission)" in ind.message


def test_landing_darkness_followed_by_unknown_uses_bounds() -> None:
    sun: Sequence[SunCode] = ["N"] * 3 + ["X"] * 3 + ["V"] * 10
    _, r = run(hourly(sun), 16)
    assert r["landing_in_darkness"].level is MOD  # [3, 6] h: MODERATE either way without a limit
    assert r["landing_in_darkness"].evidence == Metric.bounded(3 * H, 6 * H, Unit.SECONDS)
    _, limited = run(hourly(sun), 16, dark_h=6.5)
    assert limited["landing_in_darkness"].level is UNK  # 3 h -> MODERATE, 6 h -> HIGH
    _, rest_unknown = run(hourly(["N"] * 3 + ["X"] * 13), 16)
    assert rest_unknown["landing_in_darkness"].level is UNK  # could be dark for the whole mission


def test_unknown_state_at_landing_is_unknown_not_low() -> None:
    _, r = run(hourly(["X"] * 3 + ["V"] * 10), 13)
    assert r["landing_in_darkness"].level is UNK


def test_lit_at_landing_is_low() -> None:
    _, r = run(hourly(NIGHT), 50)
    assert r["landing_in_darkness"].level is LOW
    assert r["landing_in_darkness"].evidence == Metric.known(10 * H, Unit.SECONDS)


# --- 10: communication obstruction at landing vs later blackouts ----------------------------------


EARTH_LANDING_BLOCKED = ["N"] * 4 + ["V"] * 6 + ["N"] * 20 + ["V"] * 10


def test_earth_obstructed_at_landing_distinct_from_later_blackout() -> None:
    _, r = run(hourly(["V"] * 40, EARTH_LANDING_BLOCKED), 40, blackout_h=48.0)
    landing = r["landing_without_earth_visibility"]
    assert landing.level is MOD and landing.evidence == Metric.known(4 * H, Unit.SECONDS)
    assert "radio-link availability" in landing.message
    exposure = r["communication_exposure"]
    assert exposure.level is LOW  # longest blackout 20 h of 48 h
    assert exposure.evidence == Metric.known(20 * H, Unit.SECONDS)


def test_earth_visible_at_landing_with_later_blackout() -> None:
    _, r = run(hourly(["V"] * 40, EARTH_LANDING_BLOCKED), 36, start_h=4.0, blackout_h=21.0)
    assert r["landing_without_earth_visibility"].level is LOW
    assert r["communication_exposure"].level is HIGH  # 20 of 21 h consumed


# --- 11: outages continuing through mission end ---------------------------------------------------


def test_longest_outage_continuing_to_mission_end() -> None:
    _, r = run(hourly(["V"] * 10 + ["N"] * 10 + ["V"] * 10), 18, dark_h=50.0)
    assert "it continues to mission end" in r["darkness_exposure"].message
    assert r["darkness_exposure"].evidence == Metric.known(8 * H, Unit.SECONDS)


def test_shorter_outage_in_progress_at_mission_end_is_reported() -> None:
    sun: Sequence[SunCode] = ["V"] * 10 + ["N"] * 10 + ["V"] * 5 + ["N"] * 5
    _, r = run(hourly(sun), 28, dark_h=50.0)
    msg = r["darkness_exposure"].message
    assert "Longest power-dark period is 10 h" in msg
    assert "a 3 h outage is in progress at mission end" in msg


# --- 12-14: missing data, partial coverage, out-of-range missions ---------------------------------


def test_unknown_samples_produce_moderate_coverage_indicator() -> None:
    _, r = run(hourly(WITH_UNKNOWN), 20)
    sun = r["sun_data_coverage"]
    assert sun.level is MOD and sun.evidence == Metric.known(4 * H, Unit.SECONDS)
    assert "4 h is sampled with an unknown state" in sun.message
    assert r["earth_data_coverage"].level is LOW


def test_coverage_gap_reports_unsampled_interval() -> None:
    hours = [float(h) for h in range(10)] + [float(h) for h in range(17, 30)]
    series = make_series(hours, ["V"] * len(hours), coverage_h=(0.0, 30.0))
    _, r = run(series, 30)
    for code in ("sun_data_coverage", "earth_data_coverage"):
        assert r[code].level is MOD
        assert "7 h in 1 interval(s) has no sample" in r[code].message


def test_mission_partly_beyond_dataset() -> None:
    _, r = run(hourly(["V"] * 20), 20, start_h=10.0, dark_h=5.0)
    sun = r["sun_data_coverage"]
    assert sun.level is MOD and "including at mission end" in sun.message
    assert r["darkness_exposure"].level is UNK  # 0..10 h possible against a 5 h limit


def test_mission_entirely_outside_dataset() -> None:
    a, r = run(hourly(["V"] * 20), 20, start_h=100.0, dark_h=5.0, blackout_h=5.0, min_sunlight_percent=10.0)
    assert a.eligibility is UNKNOWN
    assert all(ind.level is UNK for ind in r.values())
    assert "outside the dataset" in r["sun_data_coverage"].message
    assert overall_risk(list(r.values())) is UNK


def test_out_of_range_low_exposure_only_when_proven_by_admissible_range() -> None:
    # The outage cannot exceed the 20 h mission, so a 1000 h limit leaves >= 98 % headroom in any case.
    a, r = run(hourly(["V"] * 20), 20, start_h=100.0, dark_h=1000.0)
    assert a.constraint(C.MAX_CONTINUOUS_DARKNESS).status is ConstraintStatus.PASS
    assert r["darkness_exposure"].level is LOW
    assert "admissible range" in r["darkness_exposure"].message


def test_power_unknown_from_missing_fractions_counts_as_unknown_sun_coverage() -> None:
    # Centre criterion: no visible_fraction, so a 0.25 panel threshold cannot be tested anywhere.
    series = make_series([float(h) for h in range(10)], ["V"] * 10, coverage_h=(0.0, 10.0), sun_center=True)
    _, r = run(series, 10, threshold=0.25)
    assert r["sun_data_coverage"].level is UNK
    assert r["landing_in_darkness"].level is UNK


# --- 15: unsupported clearance requirements -------------------------------------------------------


def test_unsupported_clearance_requirements_reported_as_unknown() -> None:
    a, r = run(
        hourly(["V"] * 20),
        20,
        min_sun_clearance_deg=1.0,
        min_earth_clearance_deg=2.0,
        margins=[margin(C.MIN_EARTH_CLEARANCE, 2.0, Metric.known(5.0, Unit.DEGREES))],
    )
    assert a.eligibility is UNKNOWN
    for cid in (C.MIN_SUN_CLEARANCE, C.MIN_EARTH_CLEARANCE):
        ind = r[f"unsupported_requirement.{cid.value}"]
        assert ind.level is UNK
        assert "not evaluated by this engine version" in ind.message
        assert f"margin_headroom.{cid.value}" not in r  # no clearance interpretation, margin ignored


# --- 16-17: different requirements, no requirements -----------------------------------------------


def test_different_requirements_change_indicators_not_data() -> None:
    series = hourly(NIGHT)
    _, lenient = run(series, 50, dark_h=300.0)
    _, strict = run(series, 50, dark_h=33.0, blackout_h=10.0)
    assert lenient["darkness_exposure"].level is LOW and strict["darkness_exposure"].level is HIGH
    assert "communication_exposure" not in lenient
    assert strict["communication_exposure"].level is LOW  # Earth always visible: 0 h blackout


def test_no_applicable_requirements() -> None:
    a, r = run(hourly(NIGHT), 50)
    assert a.eligibility is PASS  # vacuous
    assert list(r) == [
        "synthetic_data",
        "sun_data_coverage",
        "earth_data_coverage",
        "landing_in_darkness",
        "landing_without_earth_visibility",
    ]


# --- data basis -----------------------------------------------------------------------------------


def test_synthetic_data_flagged_and_every_message_prefixed() -> None:
    _, r = run(hourly(NIGHT), 50, dark_h=40.0)
    assert r["synthetic_data"].level is UNK
    assert all(ind.message.startswith(SYNTHETIC_PREFIX) for ind in r.values())


def test_geometric_only_data_flagged() -> None:
    _, r = run(hourly(NIGHT, geometric=True), 50)
    assert r["geometric_only_data"].level is UNK
    _, terrain = run(hourly(NIGHT), 50)
    assert "geometric_only_data" not in terrain


# --- margin input validation ----------------------------------------------------------------------


def test_margin_without_related_constraint_or_requirement_is_ignored() -> None:
    _, base = run(hourly(LIGHT_DARK), 20)
    _, r = run(
        hourly(LIGHT_DARK),
        20,
        margins=[
            margin(None, None, Metric.known(3.0, Unit.DEGREES)),
            margin(C.MIN_EARTH_VISIBILITY_PERCENT, None, Metric.not_applicable(Unit.PERCENT)),
        ],
    )
    assert r == base


def test_outage_margin_is_cross_checked_but_not_double_counted() -> None:
    ok = margin(C.MAX_CONTINUOUS_DARKNESS, 40 * H, Metric.known(10 * H, Unit.SECONDS))
    _, without = run(hourly(NIGHT), 50, dark_h=40.0)
    _, with_margin = run(hourly(NIGHT), 50, dark_h=40.0, margins=[ok])
    assert with_margin == without
    contradicting = margin(C.MAX_CONTINUOUS_DARKNESS, 40 * H, Metric.known(-10 * H, Unit.SECONDS))
    with pytest.raises(ValueError, match="confirmed negative"):
        run(hourly(NIGHT), 50, dark_h=40.0, margins=[contradicting])


@pytest.mark.parametrize(
    ("margins", "match"),
    [
        ([pct_margin(C.MIN_SUNLIGHT_PERCENT, 25.0, 55.0)] * 2, "more than one"),
        ([pct_margin(C.MIN_SUNLIGHT_PERCENT, 30.0, 55.0)], "reference"),
        ([margin(C.MIN_SUNLIGHT_PERCENT, None, Metric.known(30.0, Unit.PERCENT))], "reference"),
        ([margin(C.MIN_SUNLIGHT_PERCENT, 25.0, Metric.known(30.0, Unit.FRACTION))], "unit"),
        ([pct_margin(C.MIN_SUNLIGHT_PERCENT, 60.0, 55.0)], "reference"),
    ],
)
def test_inconsistent_margins_rejected(margins: list[OperationalMargin], match: str) -> None:
    with pytest.raises(ValueError, match=match):
        run(hourly(LIGHT_DARK), 20, min_sunlight_percent=25.0, margins=margins)


def test_margin_sign_contradicting_verdict_rejected() -> None:
    positive_on_fail = margin(C.MIN_SUNLIGHT_PERCENT, 60.0, Metric.known(5.0, Unit.PERCENT))
    with pytest.raises(ValueError, match="confirmed positive"):
        run(hourly(LIGHT_DARK), 20, min_sunlight_percent=60.0, margins=[positive_on_fail])


def test_assessment_for_another_scenario_rejected() -> None:
    series = hourly(NIGHT)
    a = assess_constraints(scenario(series, 50, dark_h=40.0), series)
    with pytest.raises(ValueError, match="scenario"):
        assess_risks(scenario(series, 50, dark_h=40.0, sid="other"), a)
    with pytest.raises(ValueError, match="solar_power_min_disk_fraction"):
        assess_risks(scenario(series, 50, dark_h=40.0, threshold=0.5), a)
    with pytest.raises(ValueError, match="mission window"):
        assess_risks(scenario(series, 40, dark_h=40.0), a)


# --- 18-20: serialization, determinism, eligibility preservation ----------------------------------


def test_risk_indicators_json_round_trip() -> None:
    series = hourly(WITH_UNKNOWN)
    sc = scenario(series, 20, dark_h=8.0, min_sunlight_percent=48.0, min_earth_clearance_deg=1.0)
    risks = assess_risks(sc, assess_constraints(sc, series))
    adapter = TypeAdapter(list[RiskIndicator])
    raw = adapter.dump_json(risks)
    assert adapter.validate_json(raw) == risks
    for item in json.loads(raw):
        assert item["level"] in {"low", "moderate", "high", "unknown"}
        assert item["rule"] and item["message"]
        assert "probab" not in item["message"].lower()


def test_deterministic_and_independent_of_margin_order() -> None:
    series = hourly(LIGHT_DARK)
    sc = scenario(series, 20, dark_h=10.0, min_sunlight_percent=50.0, min_initial_sunlight_s=10 * H)
    a = assess_constraints(sc, series)
    ms = [
        pct_margin(C.MIN_SUNLIGHT_PERCENT, 50.0, 55.0),
        margin(C.MIN_INITIAL_SUNLIGHT, 10 * H, Metric.known(1 * H, Unit.SECONDS)),
    ]
    first = assess_risks(sc, a, ms)
    assert assess_risks(sc, a, list(reversed(ms))) == first
    assert TypeAdapter(list[RiskIndicator]).dump_json(assess_risks(sc, a, ms)) == TypeAdapter(
        list[RiskIndicator]
    ).dump_json(first)


def test_policy_changes_levels_only() -> None:
    series = hourly(NIGHT)
    sc = scenario(series, 50, dark_h=40.0)
    a = assess_constraints(sc, series)
    before = a.model_dump()
    default = {r.code: r for r in assess_risks(sc, a)}
    strict = {r.code: r for r in assess_risks(sc, a, policy=RiskPolicy(0.30, 0.50))}
    assert default["darkness_exposure"].level is MOD and strict["darkness_exposure"].level is HIGH
    assert "<= 10 %" in default["darkness_exposure"].rule and "<= 30 %" in strict["darkness_exposure"].rule
    assert a.model_dump() == before and a.eligibility is PASS


@pytest.mark.parametrize(
    ("sun", "kw", "eligibility"),
    [
        (NIGHT, {"dark_h": 30.0}, PASS),
        (NIGHT, {"dark_h": 29.0, "min_sunlight_percent": 50.0}, FAIL),
        (WITH_UNKNOWN, {"dark_h": 8.0, "min_sunlight_percent": 65.0}, UNKNOWN),
        (WITH_UNKNOWN, {"dark_h": 8.0, "min_earth_clearance_deg": 1.0}, UNKNOWN),
        (WITH_UNKNOWN, {"dark_h": 5.0, "min_sunlight_percent": 65.0}, FAIL),
    ],
)
def test_eligibility_preserved_and_consistent(
    sun: Sequence[SunCode], kw: dict[str, Any], eligibility: Eligibility
) -> None:
    for policy in (UnknownDataPolicy.REPORT_UNKNOWN, UnknownDataPolicy.WORST_CASE):
        series = hourly(sun)
        sc = scenario(series, len(sun), unknown_data_policy=policy, **kw)
        a = assess_constraints(sc, series)
        snapshot = a.model_dump_json()
        risks = {r.code: r for r in assess_risks(sc, a)}
        assert a.model_dump_json() == snapshot
        assert a.eligibility is eligibility
        for ev in a.constraints:
            code = {
                C.MAX_CONTINUOUS_DARKNESS: "darkness_exposure",
                C.MAX_COMMUNICATION_BLACKOUT: "communication_exposure",
            }
            ind = risks.get(code.get(ev.constraint_id, f"margin_headroom.{ev.constraint_id.value}")) or risks.get(
                f"unsupported_requirement.{ev.constraint_id.value}"
            )
            if ev.status is ConstraintStatus.NOT_APPLICABLE:
                assert ind is None
            elif ev.status is ConstraintStatus.FAIL:
                assert ind is not None and ind.level is HIGH  # a violation is never below HIGH
            elif ev.status is ConstraintStatus.UNKNOWN:
                assert ind is not None and ind.level in (HIGH, UNK)  # never LOW / MODERATE


def test_unknown_indicators_remain_listed_when_overall_risk_is_high() -> None:
    # Confirmed violation (HIGH) alongside unsupported clearance, unknown samples and synthetic basis.
    _, r = run(hourly(WITH_UNKNOWN), 20, dark_h=5.0, min_earth_clearance_deg=1.0)
    assert overall_risk(list(r.values())) is HIGH
    assert r["darkness_exposure"].level is HIGH
    unknown = {code for code, ind in r.items() if ind.level is UNK}
    assert {"synthetic_data", "unsupported_requirement.min_earth_clearance"} <= unknown
    assert r["sun_data_coverage"].level is MOD  # aggregation never drops or rewrites indicators
