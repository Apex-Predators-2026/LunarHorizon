"""Phase 3 constraint evaluation on SYNTHETIC series with hand-derived expected values.

Series come from ``helpers.hourly``: sample k holds [k h, k+1 h) under sample-and-hold and the
coverage is [0, n] h, so every duration below is a count of hours. Sun codes: "V" whole disk,
"N" none, float = partial fraction, "U" unknown terrain, "X" no ephemeris. Earth: "V"/"N"/"U".
"""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any

import pytest

from app.viability import analyze_environment, analyze_scenario, prepare_series
from app.viability.constraints import (
    COMPARISON_REL_TOL,
    CONSTRAINT_SPECS,
    admissible_range,
    assess_constraints,
    build_constraint_assessment,
    decide,
    evaluate_constraints,
    meets,
)
from app.viability.enums import (
    CommunicationMode,
    Comparison,
    Condition,
    ConstraintId,
    ConstraintStatus,
    Eligibility,
    MetricStatus,
    PowerSource,
    SamplingPolicy,
    Unit,
    UnknownDataPolicy,
    UnknownReason,
    WindowKind,
)
from app.viability.inputs import ScientificTimeSeries
from app.viability.mission import MissionRequirements, MissionScenario, SpacecraftConfiguration
from app.viability.outputs import ConstraintAssessment, ConstraintEvaluation, Metric, MetricsSummary

from .helpers import METRIC_UNITS, SunCode, at, hourly, make_series

H = 3600.0
PASS, FAIL, UNKNOWN, NA = (
    ConstraintStatus.PASS,
    ConstraintStatus.FAIL,
    ConstraintStatus.UNKNOWN,
    ConstraintStatus.NOT_APPLICABLE,
)
AT_LEAST, AT_MOST = Comparison.AT_LEAST, Comparison.AT_MOST
C = ConstraintId


def scenario(
    series: ScientificTimeSeries,
    hours: float,
    *,
    start_h: float = 0.0,
    dark_h: float | None = None,
    blackout_h: float | None = None,
    threshold: float | None = None,
    policy: UnknownDataPolicy = UnknownDataPolicy.REPORT_UNKNOWN,
    **req: Any,
) -> MissionScenario:
    return MissionScenario(
        scenario_id="phase3-test",
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
        requirements=MissionRequirements(unknown_data_policy=policy, **req),
    )


def check(
    series: ScientificTimeSeries, hours: float, cid: ConstraintId, *, start_h: float = 0.0, **kw: Any
) -> ConstraintEvaluation:
    return assess_constraints(scenario(series, hours, start_h=start_h, **kw), series).constraint(cid)


# --- static definitions -----------------------------------------------------------------------


def test_every_constraint_id_has_a_spec_with_valid_sources() -> None:
    assert set(CONSTRAINT_SPECS) == set(ConstraintId)
    for cid, spec in CONSTRAINT_SPECS.items():
        assert spec.constraint_id is cid
        owner, attr = spec.requirement_field.split(".")
        model = SpacecraftConfiguration if owner == "spacecraft" else MissionRequirements
        assert owner in ("spacecraft", "requirements") and attr in model.model_fields, spec
        if spec.metric_field is not None:
            assert spec.metric_field in MetricsSummary.model_fields
            assert METRIC_UNITS[spec.metric_field] is spec.unit, cid
        else:
            assert spec.unsupported_reason


def test_only_clearance_requirements_are_unsupported() -> None:
    unsupported = {cid for cid, s in CONSTRAINT_SPECS.items() if s.metric_field is None}
    assert unsupported == {C.MIN_SUN_CLEARANCE, C.MIN_EARTH_CLEARANCE}


def test_direction_of_each_constraint() -> None:
    maxima = {cid for cid, s in CONSTRAINT_SPECS.items() if s.comparison is AT_MOST}
    assert maxima == {C.MAX_CONTINUOUS_DARKNESS, C.MAX_COMMUNICATION_BLACKOUT}


def test_sunlight_percent_means_direct_sunlight_not_power_lit() -> None:
    assert CONSTRAINT_SPECS[C.MIN_SUNLIGHT_PERCENT].metric_field == "sunlight_percent"
    assert CONSTRAINT_SPECS[C.MAX_CONTINUOUS_DARKNESS].metric_field == "longest_continuous_darkness"
    assert CONSTRAINT_SPECS[C.MIN_INITIAL_SUNLIGHT].condition is Condition.POWER_ELIGIBLE


# --- pure decision rule -----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("lower", "upper", "expected"),
    [
        (50.0, 50.0, PASS),  # exactly the minimum
        (50.001, 50.001, PASS),  # just above
        (49.999, 49.999, FAIL),  # just below
        (50.0, 80.0, PASS),  # lower bound exactly meets: proven
        (40.0, 50.0, UNKNOWN),  # upper bound exactly meets: cannot be proven to fail
        (40.0, 60.0, UNKNOWN),
        (40.0, 49.9, FAIL),  # even the upper bound misses: proven failure
        (0.0, 100.0, UNKNOWN),
    ],
)
def test_minimum_threshold_rule(lower: float, upper: float, expected: ConstraintStatus) -> None:
    assert decide(AT_LEAST, 50.0, lower, upper) is expected


@pytest.mark.parametrize(
    ("lower", "upper", "expected"),
    [
        (48.0, 48.0, PASS),  # exactly the limit
        (47.999, 47.999, PASS),  # just below
        (48.001, 48.001, FAIL),  # just above
        (10.0, 48.0, PASS),  # upper bound exactly at the limit: proven
        (48.0, 60.0, UNKNOWN),  # lower bound exactly at the limit: cannot be proven to fail
        (40.0, 60.0, UNKNOWN),
        (48.1, 60.0, FAIL),  # even the lower bound exceeds: proven failure
    ],
)
def test_maximum_threshold_rule(lower: float, upper: float, expected: ConstraintStatus) -> None:
    assert decide(AT_MOST, 48.0, lower, upper) is expected


def test_tolerance_absorbs_representation_error_only() -> None:
    required = 0.55 * 100.0  # rescue's fraction -> percent conversion
    assert required == 55.00000000000001  # representation error, not a stricter requirement
    assert meets(55.0, required, AT_LEAST)
    assert decide(AT_LEAST, required, 55.0, 55.0) is PASS
    assert not meets(40.0 * (1 - 1e-9), 40.0, AT_LEAST)  # 1e-9 relative is a real shortfall
    assert not meets(48.0 * (1 + 1e-9), 48.0, AT_MOST)
    assert COMPARISON_REL_TOL == 1e-12


def test_zero_threshold_is_exact() -> None:
    assert decide(AT_LEAST, 0.0, 0.0, 0.0) is PASS
    assert decide(AT_MOST, 0.0, 0.0, 0.0) is PASS
    assert decide(AT_MOST, 0.0, 1e-300, 1e-300) is FAIL


def test_inverted_bounds_rejected() -> None:
    with pytest.raises(ValueError, match="exceeds"):
        decide(AT_LEAST, 1.0, 2.0, 1.0)


def test_admissible_ranges() -> None:
    assert admissible_range(Unit.SECONDS, 3600.0) == (0.0, 3600.0)
    assert admissible_range(Unit.PERCENT, 3600.0) == (0.0, 100.0)
    assert admissible_range(Unit.FRACTION, 3600.0) == (0.0, 1.0)
    assert admissible_range(Unit.DEGREES, 3600.0) is None


# --- fully known data: thresholds at, just below and just above --------------------------------

# Direct sunlight 7 h of 10 (70 %); longest darkness 3 h; initial sunlight 3 h.
BASIC = ["V", "V", "V", "N", "N", "N", "V", "V", "V", "V"]


@pytest.mark.parametrize(("required", "expected"), [(70.0, PASS), (70.0001, FAIL), (69.9999, PASS), (0.0, PASS)])
def test_min_sunlight_percent_known(required: float, expected: ConstraintStatus) -> None:
    c = check(hourly(BASIC), 10, C.MIN_SUNLIGHT_PERCENT, min_sunlight_percent=required)
    assert c.measured == Metric.known(70.0, Unit.PERCENT)
    assert c.status is expected and c.unknown_reason is None


@pytest.mark.parametrize(("limit_s", "expected"), [(3 * H, PASS), (3 * H - 1, FAIL), (3 * H + 1, PASS)])
def test_max_darkness_known(limit_s: float, expected: ConstraintStatus) -> None:
    c = check(hourly(BASIC), 10, C.MAX_CONTINUOUS_DARKNESS, dark_h=limit_s / H)
    assert c.measured == Metric.known(3 * H, Unit.SECONDS)
    assert c.status is expected
    [w] = c.evidence_windows
    assert (w.kind, w.start_utc, w.end_utc) == (WindowKind.POWER_DARK, at(3), at(6))


@pytest.mark.parametrize(("required_s", "expected"), [(3 * H, PASS), (3 * H + 1, FAIL), (0.0, PASS)])
def test_min_initial_sunlight_known(required_s: float, expected: ConstraintStatus) -> None:
    c = check(hourly(BASIC), 10, C.MIN_INITIAL_SUNLIGHT, min_initial_sunlight_s=required_s)
    assert c.measured == Metric.known(3 * H, Unit.SECONDS)
    assert c.status is expected
    [w] = c.evidence_windows
    assert (w.kind, w.start_utc, w.end_utc, w.clipped_at_start) == (WindowKind.POWER_LIT, at(0), at(3), True)


# Earth 6 of 10 h (60 %); longest blackout 4 h; initial Earth visibility 2 h.
EARTH = ["V", "V", "N", "N", "N", "N", "V", "V", "V", "V"]


@pytest.mark.parametrize(("limit_h", "expected"), [(4.0, PASS), (3.5, FAIL), (4.5, PASS)])
def test_max_blackout_known(limit_h: float, expected: ConstraintStatus) -> None:
    c = check(hourly(["V"] * 10, EARTH), 10, C.MAX_COMMUNICATION_BLACKOUT, blackout_h=limit_h)
    assert c.measured == Metric.known(4 * H, Unit.SECONDS)
    assert c.status is expected
    assert [(w.kind, w.start_utc, w.end_utc) for w in c.evidence_windows] == [
        (WindowKind.COMMUNICATION_BLACKOUT, at(2), at(6))
    ]


@pytest.mark.parametrize(("required", "expected"), [(60.0, PASS), (60.5, FAIL), (59.5, PASS)])
def test_min_earth_visibility_known(required: float, expected: ConstraintStatus) -> None:
    c = check(hourly(["V"] * 10, EARTH), 10, C.MIN_EARTH_VISIBILITY_PERCENT, min_earth_visibility_percent=required)
    assert c.measured == Metric.known(60.0, Unit.PERCENT)
    assert c.status is expected


@pytest.mark.parametrize(("required_h", "expected"), [(2.0, PASS), (2.01, FAIL)])
def test_min_initial_earth_visibility_known(required_h: float, expected: ConstraintStatus) -> None:
    c = check(
        hourly(["V"] * 10, EARTH), 10, C.MIN_INITIAL_EARTH_VISIBILITY, min_initial_earth_visibility_s=required_h * H
    )
    assert c.measured == Metric.known(2 * H, Unit.SECONDS)
    assert c.status is expected


def test_min_simultaneous_percent_known() -> None:
    # Both met at hours 0, 2, 8 -> 3 of 10 h.
    s = hourly(["V", "V", "V", "V", "N", "N", "N", "N", "V", "V"], ["V", "N", "V", "N", "V", "N", "V", "N", "V", "N"])
    assert check(s, 10, C.MIN_SIMULTANEOUS_PERCENT, min_simultaneous_percent=30.0).status is PASS
    assert check(s, 10, C.MIN_SIMULTANEOUS_PERCENT, min_simultaneous_percent=31.0).status is FAIL


# --- sunlight semantics and panel thresholds ---------------------------------------------------

# Fractions: 1, .5, .2, 0, 0, 1, 1, .3, 1, 1 -> direct 8 h (80 %), mean fraction 6.0 / 10 = 0.6.
PANEL: list[SunCode] = ["V", 0.5, 0.2, "N", "N", "V", "V", 0.3, "V", "V"]


@pytest.mark.parametrize(
    ("threshold", "power_lit_h", "longest_dark_h", "initial_h"),
    [
        (None, 8.0, 2.0, 3.0),  # power-lit = direct sunlight
        (0.0, 8.0, 2.0, 3.0),  # fraction 0 never counts, even at threshold 0
        (0.25, 7.0, 3.0, 2.0),  # dark at 0.2, 0, 0
        (0.4, 6.0, 3.0, 2.0),  # also dark at 0.3 (1 h)
        (0.6, 5.0, 4.0, 1.0),  # dark at .5, .2, 0, 0
    ],
)
def test_panel_threshold_changes_darkness_and_initial_verdicts(
    threshold: float | None, power_lit_h: float, longest_dark_h: float, initial_h: float
) -> None:
    sc = scenario(hourly(PANEL), 10, threshold=threshold, dark_h=longest_dark_h, min_initial_sunlight_s=initial_h * H)
    a = assess_constraints(sc, hourly(PANEL))
    assert a.environment.metrics.power_lit_duration == Metric.known(power_lit_h * H, Unit.SECONDS)
    assert a.constraint(C.MAX_CONTINUOUS_DARKNESS).measured == Metric.known(longest_dark_h * H, Unit.SECONDS)
    assert a.constraint(C.MAX_CONTINUOUS_DARKNESS).status is PASS  # exactly at the limit
    assert a.constraint(C.MIN_INITIAL_SUNLIGHT).status is PASS
    tighter = scenario(hourly(PANEL), 10, threshold=threshold, dark_h=longest_dark_h - 0.5)
    assert assess_constraints(tighter, hourly(PANEL)).constraint(C.MAX_CONTINUOUS_DARKNESS).status is FAIL


def test_min_sunlight_percent_never_uses_power_lit_time() -> None:
    # Direct 80 %, power-lit at 0.25 only 70 %: a 75 % direct-sunlight requirement passes.
    c = check(hourly(PANEL), 10, C.MIN_SUNLIGHT_PERCENT, threshold=0.25, min_sunlight_percent=75.0)
    assert c.measured == Metric.known(80.0, Unit.PERCENT) and c.status is PASS
    assert check(hourly(PANEL), 10, C.MIN_SUNLIGHT_PERCENT, threshold=0.25, min_sunlight_percent=80.5).status is FAIL


@pytest.mark.parametrize(("required", "expected"), [(0.6, PASS), (0.61, FAIL), (0.59, PASS)])
def test_mean_solar_disk_fraction(required: float, expected: ConstraintStatus) -> None:
    c = check(hourly(PANEL), 10, C.MIN_MEAN_SOLAR_DISK_FRACTION, min_mean_solar_disk_fraction=required)
    assert c.measured.status is MetricStatus.KNOWN
    assert c.measured.value == pytest.approx(0.6, rel=1e-15)
    assert c.status is expected
    assert c.condition is None and c.condition_unknown_duration_s is None


def test_zero_fraction_is_never_power_lit_at_threshold_zero() -> None:
    c = check(hourly(["N", "V", "V"]), 3, C.MIN_INITIAL_SUNLIGHT, threshold=0.0, min_initial_sunlight_s=1.0)
    assert c.measured == Metric.known(0.0, Unit.SECONDS) and c.status is FAIL


# --- temporal edge cases at mission start and end ----------------------------------------------


def test_mission_beginning_in_darkness() -> None:
    c = check(hourly(["N", "N", "V", "V"]), 4, C.MIN_INITIAL_SUNLIGHT, min_initial_sunlight_s=1.0)
    assert c.measured == Metric.known(0.0, Unit.SECONDS) and c.status is FAIL
    [w] = c.evidence_windows
    assert (w.kind, w.start_utc, w.end_utc) == (WindowKind.POWER_DARK, at(0), at(2))


@pytest.mark.parametrize(("threshold", "initial_h"), [(0.25, 0.0), (0.1, 3.0), (None, 3.0)])
def test_mission_beginning_with_partial_sunlight(threshold: float | None, initial_h: float) -> None:
    s = hourly([0.2, "V", "V", "N", "V"])
    c = check(s, 5, C.MIN_INITIAL_SUNLIGHT, threshold=threshold, min_initial_sunlight_s=2 * H)
    assert c.measured == Metric.known(initial_h * H, Unit.SECONDS)
    assert c.status is (PASS if initial_h >= 2 else FAIL)


def test_earth_obstructed_at_mission_start() -> None:
    s = hourly(["V"] * 4, ["N", "V", "V", "V"])
    c = check(s, 4, C.MIN_INITIAL_EARTH_VISIBILITY, min_initial_earth_visibility_s=1.0)
    assert c.measured == Metric.known(0.0, Unit.SECONDS) and c.status is FAIL
    assert c.evidence_windows[0].kind is WindowKind.COMMUNICATION_BLACKOUT


@pytest.mark.parametrize(("required_h", "expected"), [(0.0, PASS), (2.0, UNKNOWN), (3.0, UNKNOWN), (4.0, FAIL)])
def test_initial_sunlight_with_unknown_start(required_h: float, expected: ConstraintStatus) -> None:
    # Unknown first hour, then lit 2 h, then dark: initial power-lit time in [0, 3] h.
    c = check(hourly(["U", "V", "V", "N", "V"]), 5, C.MIN_INITIAL_SUNLIGHT, min_initial_sunlight_s=required_h * H)
    assert c.measured == Metric.bounded(0.0, 3 * H, Unit.SECONDS, c.measured.reason)
    assert c.status is expected
    assert c.unknown_reason is (UnknownReason.INCOMPLETE_DATA if expected is UNKNOWN else None)
    assert c.evidence_windows[0].kind is WindowKind.POWER_UNKNOWN


def test_initial_visibility_interrupted_by_unknown_data() -> None:
    # Lit 2 h, unknown 1 h, lit 1 h, dark: initial in [2, 4] h -> 2 h proven, 5 h disproven.
    s = hourly(["V", "V", "U", "V", "N"])
    assert check(s, 5, C.MIN_INITIAL_SUNLIGHT, min_initial_sunlight_s=2 * H).status is PASS
    assert check(s, 5, C.MIN_INITIAL_SUNLIGHT, min_initial_sunlight_s=3 * H).status is UNKNOWN
    assert check(s, 5, C.MIN_INITIAL_SUNLIGHT, min_initial_sunlight_s=5 * H).status is FAIL


def test_outage_continuing_through_mission_end_is_mission_scoped() -> None:
    # Dark from 7 h to 11 h; the mission ends at 10 h, so 3 h of it fall within the mission.
    s = hourly(["V"] * 7 + ["N"] * 4 + ["V"])
    c = check(s, 10, C.MAX_CONTINUOUS_DARKNESS, dark_h=3.0)
    assert c.measured == Metric.known(3 * H, Unit.SECONDS) and c.status is PASS
    [w] = c.evidence_windows
    assert (w.start_utc, w.end_utc, w.clipped_at_end) == (at(7), at(10), True)


def test_darkness_spanning_landing_is_clipped_and_flagged() -> None:
    s = hourly(["N", "N", "N", "V", "V", "V"])
    c = check(s, 4, C.MAX_CONTINUOUS_DARKNESS, start_h=1.0, dark_h=2.0)
    assert c.measured == Metric.known(2 * H, Unit.SECONDS) and c.status is PASS
    assert c.evidence_windows[0].clipped_at_start


def test_initial_requirement_longer_than_the_mission_fails_within_mission_scope() -> None:
    c = check(hourly(["V"] * 10), 10, C.MIN_INITIAL_SUNLIGHT, min_initial_sunlight_s=11 * H)
    assert c.measured == Metric.known(10 * H, Unit.SECONDS)
    assert c.status is FAIL  # metric is limited to the mission window (same rule as rescue)
    assert "exceeds the mission duration (10 h)" in c.message
    assert c.evidence_windows[0].clipped_at_end


# --- partially and fully unknown data ----------------------------------------------------------

GAPPY = ["V", "V", "U", "U", "V", "V", "V", "V", "V", "V"]  # direct sunlight in [80, 100] %


@pytest.mark.parametrize(
    ("required", "expected", "reason"),
    [
        (80.0, PASS, None),
        (85.0, UNKNOWN, UnknownReason.INCOMPLETE_DATA),
        (100.0, UNKNOWN, UnknownReason.INCOMPLETE_DATA),
    ],
)
def test_partially_unknown_sunlight_percent(
    required: float, expected: ConstraintStatus, reason: UnknownReason | None
) -> None:
    c = check(hourly(GAPPY), 10, C.MIN_SUNLIGHT_PERCENT, min_sunlight_percent=required)
    assert (c.measured.status, c.measured.lower, c.measured.upper) == (MetricStatus.BOUNDED, 80.0, 100.0)
    assert (c.status, c.unknown_reason) == (expected, reason)
    assert c.condition_unknown_duration_s == 2 * H


@pytest.mark.parametrize(("limit_h", "expected"), [(2.0, PASS), (1.0, UNKNOWN), (1e-6, UNKNOWN)])
def test_bounds_prove_darkness_limit_despite_missing_samples(limit_h: float, expected: ConstraintStatus) -> None:
    # No confirmed darkness; the 2 unknown hours could be one dark period: longest in [0, 2] h.
    c = check(hourly(GAPPY), 10, C.MAX_CONTINUOUS_DARKNESS, dark_h=limit_h)
    assert (c.measured.lower, c.measured.upper) == (0.0, 2 * H)
    assert c.status is expected
    assert c.evidence_windows == []  # no confirmed power-dark window


def test_bounds_prove_failure_despite_missing_samples() -> None:
    s = hourly(["N", "N", "N", "U", "N", "N", "N", "N", "N", "N"])
    sun = check(s, 10, C.MIN_SUNLIGHT_PERCENT, min_sunlight_percent=20.0)
    assert (sun.measured.lower, sun.measured.upper, sun.status) == (0.0, 10.0, FAIL)
    dark = check(s, 10, C.MAX_CONTINUOUS_DARKNESS, dark_h=5.0)
    assert (dark.measured.lower, dark.measured.upper, dark.status) == (6 * H, 10 * H, FAIL)
    assert sun.unknown_reason is None


def test_unknown_earth_never_counts_as_blackout() -> None:
    s = hourly(["V"] * 6, ["V", "U", "U", "U", "V", "V"])
    c = check(s, 6, C.MAX_COMMUNICATION_BLACKOUT, blackout_h=2.0)
    assert (c.measured.lower, c.measured.upper) == (0.0, 3 * H)
    assert (c.status, c.unknown_reason) == (UNKNOWN, UnknownReason.INCOMPLETE_DATA)


ALL_UNKNOWN = ["X"] * 10


@pytest.mark.parametrize(
    ("cid", "kw", "expected"),
    [
        (C.MIN_SUNLIGHT_PERCENT, {"min_sunlight_percent": 10.0}, UNKNOWN),
        (C.MIN_SUNLIGHT_PERCENT, {"min_sunlight_percent": 0.0}, PASS),  # every admissible value >= 0
        (C.MAX_CONTINUOUS_DARKNESS, {"dark_h": 9.0}, UNKNOWN),
        (C.MAX_CONTINUOUS_DARKNESS, {"dark_h": 10.0}, PASS),  # cannot exceed the 10 h mission
        (C.MIN_INITIAL_SUNLIGHT, {"min_initial_sunlight_s": 0.0}, PASS),
        (C.MIN_INITIAL_SUNLIGHT, {"min_initial_sunlight_s": 11 * H}, FAIL),  # longer than the mission
        (C.MIN_MEAN_SOLAR_DISK_FRACTION, {"min_mean_solar_disk_fraction": 0.1}, UNKNOWN),
    ],
)
def test_fully_unknown_data_uses_only_admissible_ranges(
    cid: ConstraintId, kw: dict[str, Any], expected: ConstraintStatus
) -> None:
    c = check(hourly(ALL_UNKNOWN), 10, cid, **kw)
    assert c.measured.status is MetricStatus.UNAVAILABLE
    assert c.status is expected
    assert c.unknown_reason is (UnknownReason.NO_DATA if expected is UNKNOWN else None)


def test_fully_unknown_data_is_not_a_failure() -> None:
    sc = scenario(
        hourly(ALL_UNKNOWN), 10, dark_h=5.0, blackout_h=5.0, min_sunlight_percent=50.0, min_earth_visibility_percent=1.0
    )
    a = assess_constraints(sc, hourly(ALL_UNKNOWN, ["U"] * 10))
    assert a.eligibility is Eligibility.UNKNOWN
    assert a.with_status(FAIL) == []
    assert {c.constraint_id for c in a.with_status(UNKNOWN)} == {
        C.MAX_CONTINUOUS_DARKNESS,
        C.MAX_COMMUNICATION_BLACKOUT,
        C.MIN_SUNLIGHT_PERCENT,
        C.MIN_EARTH_VISIBILITY_PERCENT,
    }


# --- unknown-data policy ---------------------------------------------------------------------


def test_deprecated_worst_case_policy_never_changes_a_verdict() -> None:
    """Lack of evidence is never reported as FAIL: worst_case is accepted but inert."""
    req: dict[str, Any] = {
        "dark_h": 1.0,
        "min_sunlight_percent": 85.0,
        "min_initial_sunlight_s": H,
        "min_sun_clearance_deg": 1.0,
    }
    s = hourly(GAPPY)
    report = assess_constraints(scenario(s, 10, policy=UnknownDataPolicy.REPORT_UNKNOWN, **req), s)
    worst = assess_constraints(scenario(s, 10, policy=UnknownDataPolicy.WORST_CASE, **req), s)
    assert [(c.status, c.unknown_reason) for c in worst.constraints] == [
        (c.status, c.unknown_reason) for c in report.constraints
    ]
    assert worst.eligibility is report.eligibility is Eligibility.UNKNOWN
    assert worst.with_status(FAIL) == []
    assert worst.unknown_data_policy is UnknownDataPolicy.WORST_CASE  # echoed as requested
    for c in worst.with_status(UNKNOWN):
        if c.unknown_reason is not UnknownReason.UNSUPPORTED:
            assert "'worst_case' is deprecated and does not change verdicts" in c.message
    assert worst.constraint(C.MIN_INITIAL_SUNLIGHT).status is PASS  # decided by data: unchanged


def test_no_policy_creates_a_pass_or_fail_from_missing_data() -> None:
    for policy in UnknownDataPolicy:
        c = check(hourly(GAPPY), 10, C.MIN_SUNLIGHT_PERCENT, policy=policy, min_sunlight_percent=90.0)
        assert (c.status, c.unknown_reason) == (UNKNOWN, UnknownReason.INCOMPLETE_DATA)


# --- unsupported requirements ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("cid", "field"),
    [(C.MIN_SUN_CLEARANCE, "min_sun_clearance_deg"), (C.MIN_EARTH_CLEARANCE, "min_earth_clearance_deg")],
)
def test_clearance_requirements_are_unknown_not_passed(cid: ConstraintId, field: str) -> None:
    # Mean clearance (Sun +1 deg, Earth +2 deg here) would exceed 0.5 deg; it must not be used.
    req: dict[str, Any] = {field: 0.5}
    c = check(hourly(["V"] * 4), 4, cid, **req)
    assert (c.status, c.unknown_reason, c.threshold) == (UNKNOWN, UnknownReason.UNSUPPORTED, 0.5)
    assert c.measured.status is MetricStatus.UNAVAILABLE and c.metric_field is None
    assert "not evaluated" in c.message
    a = assess_constraints(scenario(hourly(["V"] * 4), 4, **req), hourly(["V"] * 4))
    assert a.eligibility is Eligibility.UNKNOWN


# --- coverage, gaps and sampling ---------------------------------------------------------------


def test_mission_partially_beyond_dataset_coverage() -> None:
    # 10 h of lit data, 14 h mission: the last 4 h are not represented by any sample.
    s = hourly(["V"] * 10)
    a = assess_constraints(scenario(s, 14, dark_h=4.0, min_sunlight_percent=70.0), s)
    assert a.environment.data_quality.uncovered_duration_s == 4 * H
    sun = a.constraint(C.MIN_SUNLIGHT_PERCENT)
    assert sun.measured.lower == pytest.approx(100 * 10 / 14) and sun.measured.upper == 100.0
    assert sun.status is PASS  # 71.43 % already proven
    assert a.constraint(C.MAX_CONTINUOUS_DARKNESS).status is PASS  # at most the 4 uncovered hours
    assert check(s, 14, C.MAX_CONTINUOUS_DARKNESS, dark_h=3.0).status is UNKNOWN
    assert check(s, 14, C.MIN_SUNLIGHT_PERCENT, min_sunlight_percent=75.0).status is UNKNOWN


def test_mission_entirely_outside_coverage() -> None:
    s = hourly(["V"] * 10)
    a = assess_constraints(scenario(s, 10, start_h=20, min_sunlight_percent=50.0, dark_h=5.0), s)
    assert a.environment.data_quality.uncovered_duration_s == 10 * H
    assert a.eligibility is Eligibility.UNKNOWN
    for cid in (C.MIN_SUNLIGHT_PERCENT, C.MAX_CONTINUOUS_DARKNESS):
        c = a.constraint(cid)
        assert (c.status, c.unknown_reason, c.measured.status) == (
            UNKNOWN,
            UnknownReason.NO_DATA,
            MetricStatus.UNAVAILABLE,
        )


def test_no_configured_constraints_is_vacuously_eligible_even_without_data() -> None:
    s = hourly(["V"] * 10)
    a = assess_constraints(scenario(s, 10, start_h=20), s)
    assert all(c.status is NA for c in a.constraints)
    assert a.eligibility is Eligibility.PASS  # documented rule; coverage is left to Phase 4 risks
    assert a.environment.data_quality.sun_coverage_percent == 0.0


def test_internal_coverage_gap_is_unknown_not_dark() -> None:
    # Samples at 0-3 h and 7-9 h, max gap 1.5 h: sample 3 holds 1 h, [4, 7) h is uncovered.
    s = make_series([0, 1, 2, 3, 7, 8, 9], ["V"] * 7, coverage_h=(0.0, 10.0))
    a = assess_constraints(scenario(s, 10, dark_h=3.0, min_sunlight_percent=70.0), s)
    assert a.environment.data_quality.coverage_gap_count == 1
    assert a.constraint(C.MAX_CONTINUOUS_DARKNESS).measured == Metric.bounded(
        0.0, 3 * H, Unit.SECONDS, a.constraint(C.MAX_CONTINUOUS_DARKNESS).measured.reason
    )
    assert a.constraint(C.MAX_CONTINUOUS_DARKNESS).status is PASS
    assert a.constraint(C.MIN_SUNLIGHT_PERCENT).status is PASS  # 7 of 10 h proven lit
    assert check(s, 10, C.MAX_CONTINUOUS_DARKNESS, dark_h=2.0).status is UNKNOWN


IRREGULAR_H = [0.0, 0.5, 2.0, 2.25, 4.0]
IRREGULAR_SUN = ["V", "V", "N", "N", "V"]


@pytest.mark.parametrize(
    ("policy", "dark_h", "expected"),
    [
        # sample-and-hold: dark over [2.0, 4.0) = 2 h
        (SamplingPolicy.SAMPLE_HOLD, 2.0, PASS),
        (SamplingPolicy.SAMPLE_HOLD, 1.9, FAIL),
        # nearest-sample: dark over [1.25, 3.125) = 1.875 h
        (SamplingPolicy.NEAREST_SAMPLE, 1.9, PASS),
        (SamplingPolicy.NEAREST_SAMPLE, 1.8, FAIL),
    ],
)
def test_irregular_sampling_and_configurable_policy(
    policy: SamplingPolicy, dark_h: float, expected: ConstraintStatus
) -> None:
    s = make_series(IRREGULAR_H, IRREGULAR_SUN, nominal_h=None, max_gap_h=2.0)
    a = assess_constraints(scenario(s, 4, dark_h=dark_h), s, policy=policy)
    assert a.environment.data_quality.sampling_policy is policy
    assert a.constraint(C.MAX_CONTINUOUS_DARKNESS).status is expected


# --- aggregation -------------------------------------------------------------------------------


def test_confirmed_failure_dominates_unknowns() -> None:
    # Lit 0-1, unknown 2-3, lit 4-5, dark 6-7, lit 8-9: direct sun in [60, 80] %, initial in [2, 6] h,
    # longest darkness exactly 2 h (the unknown period is separated from the dark one by light).
    s = hourly(["V", "V", "U", "U", "V", "V", "N", "N", "V", "V"])
    a = assess_constraints(scenario(s, 10, dark_h=1.0, min_sunlight_percent=70.0, min_initial_sunlight_s=3 * H), s)
    assert a.constraint(C.MAX_CONTINUOUS_DARKNESS).measured == Metric.known(2 * H, Unit.SECONDS)
    assert [c.constraint_id for c in a.with_status(FAIL)] == [C.MAX_CONTINUOUS_DARKNESS]
    assert {c.constraint_id for c in a.with_status(UNKNOWN)} == {C.MIN_SUNLIGHT_PERCENT, C.MIN_INITIAL_SUNLIGHT}
    assert a.eligibility is Eligibility.FAIL


def test_unknowns_without_failure_give_unknown_eligibility() -> None:
    sc = scenario(hourly(GAPPY), 10, dark_h=1.0, min_sunlight_percent=80.0, min_initial_sunlight_s=2 * H)
    a = assess_constraints(sc, hourly(GAPPY))
    assert [c.constraint_id for c in a.with_status(UNKNOWN)] == [C.MAX_CONTINUOUS_DARKNESS]
    assert {c.constraint_id for c in a.with_status(PASS)} == {C.MIN_SUNLIGHT_PERCENT, C.MIN_INITIAL_SUNLIGHT}
    assert a.eligibility is Eligibility.UNKNOWN


def test_all_applicable_pass_gives_pass() -> None:
    sc = scenario(
        hourly(BASIC, EARTH),
        10,
        dark_h=3.0,
        blackout_h=4.0,
        min_sunlight_percent=70.0,
        min_earth_visibility_percent=60.0,
        min_initial_sunlight_s=3 * H,
        min_initial_earth_visibility_s=2 * H,
        min_mean_solar_disk_fraction=0.7,
        min_simultaneous_percent=30.0,
    )
    a = assess_constraints(sc, hourly(BASIC, EARTH))
    # Simultaneous (power-lit and Earth): hours 0, 1, 6, 7, 8, 9 -> 60 %; mean fraction 0.7.
    assert a.environment.metrics.simultaneous_percent == Metric.known(60.0, Unit.PERCENT)
    assert a.eligibility is Eligibility.PASS
    assert {c.constraint_id for c in a.with_status(NA)} == {C.MIN_SUN_CLEARANCE, C.MIN_EARTH_CLEARANCE}


def test_unconfigured_constraints_are_not_applicable_but_keep_measurements() -> None:
    a = assess_constraints(scenario(hourly(BASIC), 10), hourly(BASIC))
    assert a.eligibility is Eligibility.PASS
    c = a.constraint(C.MAX_CONTINUOUS_DARKNESS)
    assert (c.status, c.threshold, c.unknown_reason, c.evidence_windows) == (NA, None, None, [])
    assert c.measured == Metric.known(3 * H, Unit.SECONDS)


# --- output structure, identity checks and serialization ---------------------------------------


def test_one_result_per_constraint_in_enum_order_with_traceability() -> None:
    a = assess_constraints(scenario(hourly(BASIC), 10, dark_h=3.0, min_sunlight_percent=1.0), hourly(BASIC))
    assert [c.constraint_id for c in a.constraints] == list(ConstraintId)
    for c in a.constraints:
        spec = CONSTRAINT_SPECS[c.constraint_id]
        assert (c.name, c.comparison, c.requirement_field, c.metric_field, c.condition) == (
            spec.name,
            spec.comparison,
            spec.requirement_field,
            spec.metric_field,
            spec.condition,
        )
        assert c.unit is spec.unit and c.message


def test_analysis_must_match_the_scenario() -> None:
    s = hourly(PANEL)
    sc = scenario(s, 10, threshold=0.25, dark_h=3.0)
    other_threshold = analyze_environment(s, at(0), at(10), solar_power_min_disk_fraction=0.5)
    with pytest.raises(ValueError, match="solar_power_min_disk_fraction"):
        evaluate_constraints(sc, other_threshold)
    other_range = analyze_environment(s, at(0), at(9), solar_power_min_disk_fraction=0.25)
    with pytest.raises(ValueError, match="mission window"):
        evaluate_constraints(sc, other_range)
    other_site = sc.model_copy(update={"site": sc.site.model_copy(update={"id": "elsewhere"})})
    with pytest.raises(ValueError, match="site"):
        evaluate_constraints(other_site, analyze_scenario(sc, s))
    with pytest.raises(ValueError, match="site"):
        assess_constraints(other_site, s)


def test_prepared_series_gives_identical_result() -> None:
    s = hourly(GAPPY)
    sc = scenario(s, 10, dark_h=2.0, min_sunlight_percent=85.0)
    assert assess_constraints(sc, prepare_series(s)) == assess_constraints(sc, s)


def test_json_round_trip_and_determinism() -> None:
    s = hourly(GAPPY, ["V", "U", "N", "V", "V", "V", "V", "V", "N", "V"])
    sc = scenario(s, 10, dark_h=2.0, blackout_h=1.0, min_sunlight_percent=85.0, min_earth_clearance_deg=1.0)
    a, b = assess_constraints(sc, s), assess_constraints(sc, s)
    assert a.model_dump_json() == b.model_dump_json()
    assert ConstraintAssessment.model_validate_json(a.model_dump_json()) == a
    doc = json.loads(a.model_dump_json())
    first = doc["constraints"][0]
    assert first["constraint_id"] == "max_continuous_darkness"
    assert first["comparison"] == "at_most" and first["status"] in ("pass", "fail", "unknown")
    assert {c["unknown_reason"] for c in doc["constraints"]} >= {None, "unsupported", "incomplete_data"}


def test_build_from_existing_analysis_equals_one_shot() -> None:
    s = hourly(BASIC)
    sc = scenario(s, 10, dark_h=3.0)
    assert build_constraint_assessment(sc, analyze_scenario(sc, s)) == assess_constraints(sc, s)


def test_mission_window_one_hour_shifted_changes_initial_state() -> None:
    s = hourly(BASIC)
    sc = scenario(s, 6, start_h=3.0, min_initial_sunlight_s=1.0)
    c = assess_constraints(sc, s).constraint(C.MIN_INITIAL_SUNLIGHT)
    assert c.status is FAIL and c.evidence_windows[0].start_utc == sc.mission_start_utc
    assert sc.mission_end_utc - sc.mission_start_utc == timedelta(hours=6)
