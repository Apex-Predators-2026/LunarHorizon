"""Phase 2 metrics, outages, bounds and data quality. All data here is SYNTHETIC.

Expected values are derived by hand from the sample states under sample-and-hold.
"""

from __future__ import annotations

import json
from datetime import timedelta
from itertools import pairwise

import pytest

from app.viability import analyze_environment, analyze_scenario, prepare_series
from app.viability.enums import Condition, ConditionState, MetricStatus, SamplingPolicy, Unit
from app.viability.fixtures import example_scenario, load_fixture
from app.viability.inputs import ScientificTimeSeries
from app.viability.metrics import compute_metrics, summarize_data_quality
from app.viability.outputs import EnvironmentAnalysis, Metric

from .helpers import at, hourly, make_series

H = 3600.0
KNOWN, BOUNDED = MetricStatus.KNOWN, MetricStatus.BOUNDED
UNAVAILABLE, NA = MetricStatus.UNAVAILABLE, MetricStatus.NOT_APPLICABLE


def full(
    series: ScientificTimeSeries, threshold: float | None = None, policy: SamplingPolicy | None = None
) -> EnvironmentAnalysis:
    return analyze_environment(
        series,
        series.coverage_start_utc,
        series.coverage_end_utc,
        solar_power_min_disk_fraction=threshold,
        policy=policy,
    )


def known(m: Metric) -> float:
    assert m.status is KNOWN, m
    assert m.value is not None
    return m.value


def bounds(m: Metric) -> tuple[float, float]:
    assert m.status is BOUNDED, m
    assert m.lower is not None and m.upper is not None
    return m.lower, m.upper


# --- 1-4: continuous conditions --------------------------------------------------------------


def test_continuous_sunlight_and_earth_obstruction() -> None:
    a = full(load_fixture("continuous_sunlight"))  # Sun visible, Earth hidden, 24 h
    m = a.metrics
    assert known(m.sunlight_duration) == known(m.full_sunlight_duration) == known(m.power_lit_duration) == 24 * H
    assert known(m.sunlight_percent) == 100.0 and known(m.partial_sunlight_duration) == 0.0
    assert known(m.longest_continuous_darkness) == known(m.longest_without_direct_sunlight) == 0.0
    assert known(m.initial_sunlight_duration) == 24 * H
    assert m.time_to_first_sunset.status is NA
    assert known(m.mean_solar_disk_fraction) == 1.0
    # Earth: continuous obstruction
    assert known(m.earth_visible_duration) == 0.0 and known(m.earth_visible_percent) == 0.0
    assert known(m.longest_communication_blackout) == 24 * H
    assert known(m.initial_earth_visibility_duration) == 0.0
    assert m.time_to_first_earthset.status is NA and m.mean_earth_clearance.status is NA
    assert known(m.simultaneous_duration) == 0.0 and known(m.longest_simultaneous_window) == 0.0
    earth = a.condition(Condition.EARTH_VISIBLE)
    assert earth.initial_state is ConditionState.NOT_MET and earth.time_to_first_transition.status is NA
    assert earth.not_met_window_count == 1 and earth.longest_not_met_window is not None


def test_continuous_darkness_and_earth_visibility() -> None:
    m = full(load_fixture("continuous_darkness")).metrics
    assert known(m.sunlight_duration) == 0.0 and known(m.sunlight_percent) == 0.0
    assert known(m.longest_continuous_darkness) == 24 * H
    assert known(m.initial_sunlight_duration) == 0.0
    assert known(m.mean_solar_disk_fraction) == 0.0  # a measured zero, not a stand-in for unknown
    assert m.mean_sun_clearance.status is NA  # never sunlit: nothing to average
    assert known(m.earth_visible_percent) == 100.0 and known(m.longest_communication_blackout) == 0.0


def test_continuous_earth_visibility_two_hour_sampling() -> None:
    m = full(load_fixture("continuous_earth_visibility")).metrics
    assert known(m.earth_visible_duration) == 72 * H
    assert known(m.longest_communication_blackout) == 0.0
    assert known(m.initial_earth_visibility_duration) == 72 * H
    assert m.time_to_first_earthset.status is NA


# --- 5, 6, 18: partial sunlight, thresholds, disk fraction -----------------------------------


def test_partial_sunlight_is_not_full_sunlight() -> None:
    a = full(hourly(["V", 0.5, 0.25, "N"]))
    m = a.metrics
    assert known(m.sunlight_duration) == 3 * H
    assert known(m.full_sunlight_duration) == 1 * H
    assert known(m.partial_sunlight_duration) == 2 * H
    assert known(m.partial_sunlight_percent) == 50.0
    assert known(m.mean_solar_disk_fraction) == pytest.approx((1 + 0.5 + 0.25 + 0) / 4)
    assert known(m.longest_without_direct_sunlight) == 1 * H


@pytest.mark.parametrize(
    ("threshold", "power_lit_h"),
    [(None, 5), (0.0, 5), (0.25, 3), (0.2499, 4), (0.5, 2), (1.0, 1)],
)
def test_solar_power_threshold_boundaries(threshold: float | None, power_lit_h: int) -> None:
    # fractions: 1, 0.5, 0.25, 0.2499, 0.001, 0 -> lit iff fraction > 0 and fraction >= threshold
    a = full(hourly(["V", 0.5, 0.25, 0.2499, 0.001, "N"]), threshold)
    m = a.metrics
    assert known(m.power_lit_duration) == power_lit_h * H
    assert known(m.longest_continuous_darkness) == (6 - power_lit_h) * H
    assert known(m.initial_sunlight_duration) == power_lit_h * H
    assert known(m.time_to_first_sunset) == power_lit_h * H
    # Direct and full sunlight never depend on the threshold.
    assert known(m.sunlight_duration) == 5 * H and known(m.full_sunlight_duration) == 1 * H
    assert known(m.longest_without_direct_sunlight) == 1 * H


def test_fractional_disk_average_is_time_weighted() -> None:
    # Irregular spacing: fraction 1 for 3 h, 0.5 for 0.5 h, 0 for 0.5 h.
    s = make_series([0, 3, 3.5, 4], ["V", 0.5, "N", "N"], nominal_h=None, max_gap_h=3.0)
    m = full(s).metrics
    assert known(m.mean_solar_disk_fraction) == pytest.approx((3 * 1.0 + 0.5 * 0.5) / 4)
    # An unweighted mean of the contributing samples (1, 0.5, 0) would give 0.5.
    assert known(m.mean_solar_disk_fraction) != pytest.approx(0.5)


# --- 7: simultaneous availability with three-valued logic ------------------------------------


def test_simultaneous_uses_three_valued_logic() -> None:
    s = hourly(["V", "V", "N", "N", "V", "U", "U"], ["V", "N", "V", "N", "U", "N", "U"])
    # simultaneous: T F F F ? F ?   (Sun dark + Earth unknown -> F; Sun lit + Earth unknown -> ?)
    c = full(s).condition(Condition.SIMULTANEOUS)
    assert bounds(c.met_duration) == (1 * H, 3 * H)
    assert bounds(c.not_met_duration) == (4 * H, 6 * H)
    assert c.unknown_duration_s == 2 * H
    assert bounds(c.met_percent) == pytest.approx((100 / 7, 300 / 7))


def test_sun_known_dark_makes_simultaneous_known_despite_unknown_earth() -> None:
    m = full(hourly(["N", "N", "N"], ["U", "U", "U"])).metrics
    assert known(m.simultaneous_duration) == 0.0
    assert known(m.longest_simultaneous_window) == 0.0
    assert m.earth_visible_duration.status is UNAVAILABLE


def test_simultaneous_windows_and_longest() -> None:
    m = full(load_fixture("mission_boundary")).metrics
    # Sun lit 04-21 h; Earth blocked only 12-13 h (clearance exactly 0 counts as not visible).
    assert known(m.simultaneous_duration) == 16 * H
    assert known(m.longest_simultaneous_window) == 8 * H  # 13-21 h
    assert known(m.simultaneous_percent) == pytest.approx(100 * 16 / 24)


# --- 8-10, 17: outages, mission boundaries, initial conditions -------------------------------


def test_multiple_alternating_blackouts() -> None:
    c = full(hourly(["V"] * 9, ["V", "V", "N", "N", "V", "N", "N", "N", "V"])).condition(Condition.EARTH_VISIBLE)
    assert c.not_met_window_count == 2 and c.met_window_count == 3
    assert known(c.longest_not_met) == 3 * H
    assert c.longest_not_met_window is not None
    assert (c.longest_not_met_window.start_utc, c.longest_not_met_window.end_utc) == (at(5), at(8))
    assert known(c.not_met_duration) == 5 * H
    assert c.not_met_windows_per_day == pytest.approx(2 / (9 / 24))
    assert known(c.time_to_first_loss) == 2 * H


def test_intermittent_blackouts_fixture() -> None:
    a = full(load_fixture("intermittent_blackouts"))
    c = a.condition(Condition.EARTH_VISIBLE)
    # Earth states: N, V x7, N x9, V x7, N x9, V x7, N x9 (sample 48 h sits on coverage end)
    assert known(c.met_duration) == 21 * H
    assert known(c.longest_not_met) == 9 * H
    assert c.longest_not_met_window is not None and c.longest_not_met_window.start_utc == at(8)
    assert c.not_met_window_count == 4 and c.not_met_windows_per_day == pytest.approx(2.0)
    assert c.initial_state is ConditionState.NOT_MET
    assert known(c.time_to_first_transition) == 1 * H
    assert known(c.time_to_first_loss) == 8 * H


def test_outage_starting_at_mission_start() -> None:
    s = hourly(["V"] * 6, ["N", "N", "N", "V", "V", "V"])
    c = analyze_environment(s, at(1), at(6)).condition(Condition.EARTH_VISIBLE)
    assert c.initial_state is ConditionState.NOT_MET
    assert known(c.initial_met_duration) == 0.0
    assert known(c.longest_not_met) == 2 * H  # clipped to the mission: 1-3 h
    w = c.longest_not_met_window
    assert w is not None and w.start_utc == at(1) and w.clipped_at_start is True  # dark before landing too
    assert known(c.time_to_first_transition) == 2 * H
    assert c.time_to_first_loss.status is NA


def test_outage_continuing_to_mission_end() -> None:
    s = hourly(["V"] * 5, ["V", "V", "N", "N", "N"])
    c = analyze_environment(s, at(0), at(4)).condition(Condition.EARTH_VISIBLE)
    assert known(c.longest_not_met) == 2 * H
    w = c.longest_not_met_window
    assert w is not None and w.end_utc == at(4) and w.clipped_at_end is True  # data show it continues
    assert known(c.time_to_first_loss) == 2 * H


def test_different_initial_sun_and_earth_conditions() -> None:
    a = full(hourly(["V", "V", "N"], ["N", "V", "V"]))
    sun, earth = a.condition(Condition.DIRECT_SUNLIGHT), a.condition(Condition.EARTH_VISIBLE)
    assert sun.initial_state is ConditionState.MET and known(sun.initial_met_duration) == 2 * H
    assert earth.initial_state is ConditionState.NOT_MET and known(earth.initial_met_duration) == 0.0
    assert known(earth.time_to_first_transition) == 1 * H
    assert known(sun.time_to_first_loss) == 2 * H
    assert a.condition(Condition.SIMULTANEOUS).initial_state is ConditionState.NOT_MET


# --- 11-16, 21: missing data, gaps, coverage, bounds -----------------------------------------


def test_missing_samples_fixture_is_bounded_never_dark() -> None:
    a = full(load_fixture("missing_samples"))
    m, dq = a.metrics, a.data_quality
    # Sun unknown: 03-05 h (ephemeris) + 08-14 h (absent samples) = 8 h; Earth adds 18-19 h.
    assert bounds(m.sunlight_duration) == (16 * H, 24 * H)
    assert bounds(m.longest_continuous_darkness) == (0.0, 6 * H)
    assert bounds(m.earth_visible_duration) == (15 * H, 24 * H)
    assert bounds(m.longest_communication_blackout) == (0.0, 6 * H)
    assert bounds(m.mean_solar_disk_fraction) == pytest.approx((16 / 24, 1.0))
    assert bounds(m.initial_sunlight_duration) == (3 * H, 24 * H)
    lo, hi = bounds(m.time_to_first_sunset)
    assert (lo, hi) == (3 * H, 24 * H)
    assert m.time_to_first_sunset.reason and "may not occur" in m.time_to_first_sunset.reason
    assert dq.uncovered_duration_s == 6 * H and dq.coverage_gap_count == 1
    assert dq.sun_unknown_duration_s == 8 * H and dq.earth_unknown_duration_s == 9 * H
    assert dq.sun_coverage_percent == pytest.approx(100 * 16 / 24)
    assert dq.earth_coverage_percent == pytest.approx(100 * 15 / 24)
    assert dq.sample_count == 18 and dq.largest_sample_gap_s == 7 * H
    assert any("not represented by any sample" in w for w in dq.warnings)
    assert any("unknown Sun state" in w for w in dq.warnings)


def test_unknown_terrain_is_unknown_not_dark() -> None:
    a = full(load_fixture("unknown_terrain"))
    m = a.metrics
    assert bounds(m.sunlight_duration) == (10 * H, 24 * H)
    assert bounds(m.longest_continuous_darkness) == (0.0, 14 * H)
    assert known(m.earth_visible_percent) == 100.0
    assert bounds(m.simultaneous_duration) == (10 * H, 24 * H)
    # Terrain unknown does not mean ephemeris unknown: elevation is still known everywhere.
    assert known(m.mean_solar_elevation) == pytest.approx(1.5)
    assert a.data_quality.sun_coverage_percent == pytest.approx(100 * 10 / 24)


def test_irregular_sampling_fixture() -> None:
    s = load_fixture("irregular_sampling")
    a = full(s)
    m = a.metrics
    assert known(m.sunlight_duration) == 6 * H  # last partial sample 05:30, dark from 06:00
    assert known(m.full_sunlight_duration) == 4.5 * H
    assert known(m.partial_sunlight_duration) == 1.5 * H
    assert known(m.longest_continuous_darkness) == 6 * H
    assert known(m.time_to_first_sunset) == 6 * H
    assert a.data_quality.largest_sample_gap_s == 2 * H and a.data_quality.sample_count == 15
    # Time-weighted disk fraction, weights = spacing to the next sample.
    t = [x.time_utc for x in s.samples]
    f = [x.sun.visible_fraction or 0.0 for x in s.samples]
    expected = sum(fi * (b - a_).total_seconds() for fi, a_, b in zip(f, t, t[1:], strict=False)) / (12 * H)
    assert known(m.mean_solar_disk_fraction) == pytest.approx(expected)


def test_dataset_shorter_than_mission_bounds_instead_of_extrapolating() -> None:
    s = hourly(["V"] * 4)  # coverage [0, 4] h
    a = analyze_environment(s, at(0), at(6))
    m = a.metrics
    assert bounds(m.sunlight_duration) == (4 * H, 6 * H)
    assert bounds(m.sunlight_percent) == pytest.approx((100 * 4 / 6, 100.0))
    assert bounds(m.longest_continuous_darkness) == (0.0, 2 * H)
    assert bounds(m.time_to_first_sunset) == (4 * H, 6 * H)
    assert a.data_quality.uncovered_duration_s == 2 * H
    assert any("beyond dataset coverage" in w for w in a.data_quality.warnings)


def test_unaligned_mission_metrics() -> None:
    s = hourly(["V", "V", "N", "N", "V", "V"])
    m = analyze_environment(s, at(0.5), at(4.25)).metrics
    assert known(m.sunlight_duration) == 1.75 * H
    assert known(m.sunlight_percent) == pytest.approx(100 * 1.75 / 3.75)
    assert known(m.longest_continuous_darkness) == 2 * H
    assert known(m.initial_sunlight_duration) == 1.5 * H
    assert known(m.time_to_first_sunset) == 1.5 * H


def test_unknown_inside_outage_gives_bounds() -> None:
    m = full(hourly(["N", "N", "U", "N", "V"])).metrics
    assert bounds(m.longest_continuous_darkness) == (2 * H, 4 * H)  # unknown may or may not break it


def test_unknown_next_to_sunlight_does_not_blur_longest_darkness() -> None:
    m = full(hourly(["N", "N", "N", "V", "U", "V"])).metrics
    assert known(m.longest_continuous_darkness) == 3 * H  # both extremes coincide
    assert bounds(m.sunlight_duration) == (2 * H, 3 * H)


@pytest.mark.parametrize(
    ("sun", "expected"),
    [
        (["V", "U", "N", "N"], (1, 2)),  # sunset during the unknown hour
        (["V", "U", "V", "N"], (1, 3)),  # unknown hour may hide an earlier sunset
        (["N", "U", "V", "N"], (1, 3)),
        (["V", "V", "U"], (2, 3)),  # may not occur at all
        (["U", "N", "N"], (0, 3)),
    ],
)
def test_first_sunset_bounds(sun: list[str], expected: tuple[int, int]) -> None:
    m = full(hourly(sun)).metrics
    assert bounds(m.time_to_first_sunset) == (expected[0] * H, expected[1] * H)


def test_first_transition_and_initial_bounds() -> None:
    sun = full(hourly(["V", "U", "N"])).condition(Condition.DIRECT_SUNLIGHT)
    assert bounds(sun.time_to_first_transition) == (1 * H, 2 * H)
    sun = full(hourly(["V", "U", "V", "N"])).condition(Condition.DIRECT_SUNLIGHT)
    assert bounds(sun.initial_met_duration) == (1 * H, 3 * H)
    sun = full(hourly(["U", "V", "N"])).condition(Condition.DIRECT_SUNLIGHT)
    assert sun.initial_state is ConditionState.UNKNOWN
    assert sun.time_to_first_transition.status is UNAVAILABLE
    assert bounds(sun.initial_met_duration) == (0.0, 2 * H)


def test_all_unknown_sun_is_unavailable_never_zero() -> None:
    m = full(hourly(["X", "X", "X"])).metrics
    for metric in (
        m.sunlight_duration,
        m.sunlight_percent,
        m.longest_continuous_darkness,
        m.mean_solar_disk_fraction,
        m.mean_solar_elevation,
        m.mean_sun_clearance,
        m.initial_sunlight_duration,
        m.time_to_first_sunset,
        m.simultaneous_duration,  # Earth visible but Sun unknown -> unknown
    ):
        assert metric.status is UNAVAILABLE and metric.reason, metric
    assert known(m.earth_visible_percent) == 100.0


def test_angle_means_bounded_by_admissible_range() -> None:
    m = full(hourly(["V", "X"])).metrics  # second hour: ephemeris missing
    assert bounds(m.mean_solar_elevation) == pytest.approx(((2.0 - 90.0) / 2, (2.0 + 90.0) / 2))
    assert bounds(m.mean_sun_clearance) == pytest.approx(((1.0 - 180.0) / 2, (1.0 + 180.0) / 2))
    m = full(hourly(["V", "U"])).metrics  # terrain unknown, elevation known
    assert known(m.mean_solar_elevation) == pytest.approx((2.0 + 1.5) / 2)


# --- 19: time-weighted geometry --------------------------------------------------------------


def test_time_weighted_geometric_means() -> None:
    s = make_series([0, 3, 4], ["V", "N", "N"], ["V", "N", "N"], nominal_h=None, max_gap_h=3.0)
    m = full(s).metrics
    assert known(m.mean_solar_elevation) == pytest.approx((2.0 * 3 + 0.0 * 1) / 4)  # unweighted would be 1.0
    assert known(m.mean_sun_clearance) == pytest.approx(1.0)  # only while sunlit
    assert known(m.mean_earth_clearance) == pytest.approx(2.0)


def test_geometric_only_series() -> None:
    a = full(load_fixture("geometric_only"))
    assert known(a.metrics.mean_earth_clearance) == pytest.approx(3.0)  # clearance = elevation
    assert any("geometric_only" in w for w in a.data_quality.warnings)
    assert "local horizontal plane" in a.condition(Condition.DIRECT_SUNLIGHT).definition


def test_centre_criterion_sun_does_not_invent_disk_fractions() -> None:
    a = full(hourly(["V", "N"], sun_center=True), threshold=0.25)
    m = a.metrics
    assert known(m.sunlight_duration) == 1 * H
    assert bounds(m.full_sunlight_duration) == (0.0, 1 * H)  # centre up: full disk not implied
    assert m.partial_sunlight_duration.status is UNAVAILABLE
    assert m.mean_solar_disk_fraction.status is UNAVAILABLE
    assert m.power_lit_duration.status is UNAVAILABLE
    assert any("criterion is 'center'" in w for w in a.data_quality.warnings)
    assert any("Power threshold set" in w for w in a.data_quality.warnings)


# --- entry points, policy, serialization -----------------------------------------------------


def test_analyze_scenario_uses_mission_window_and_threshold() -> None:
    s = load_fixture("intermittent_sunlight")
    sc = example_scenario(s)
    sc = sc.model_copy(
        update={
            "mission_end_utc": sc.mission_start_utc + timedelta(hours=12),
            "spacecraft": sc.spacecraft.model_copy(update={"solar_power_min_disk_fraction": 0.5}),
        }
    )
    a = analyze_scenario(sc, s)
    assert a.evaluated_end_utc - a.evaluated_start_utc == timedelta(hours=12)
    assert a.solar_power_min_disk_fraction == 0.5
    assert a == analyze_environment(s, sc.mission_start_utc, sc.mission_end_utc, solar_power_min_disk_fraction=0.5)


def test_analyze_scenario_rejects_other_site() -> None:
    s = load_fixture("intermittent_sunlight")
    sc = example_scenario(s)
    other = sc.model_copy(update={"site": sc.site.model_copy(update={"id": "another-site"})})
    with pytest.raises(ValueError, match="another-site"):
        analyze_scenario(other, s)


def test_prepared_series_and_wrappers_agree() -> None:
    s = load_fixture("missing_samples")
    a = analyze_environment(prepare_series(s), s.coverage_start_utc, s.coverage_end_utc)
    assert a == full(s)
    assert compute_metrics(s, s.coverage_start_utc, s.coverage_end_utc) == a.metrics
    assert summarize_data_quality(s, s.coverage_start_utc, s.coverage_end_utc) == a.data_quality


def test_nearest_policy_recorded_and_differs_only_at_edges() -> None:
    s = load_fixture("intermittent_sunlight")
    hold, nearest = full(s), full(s, policy=SamplingPolicy.NEAREST_SAMPLE)
    assert nearest.data_quality.sampling_policy is SamplingPolicy.NEAREST_SAMPLE
    assert "Nearest-sample" in nearest.data_quality.assumptions[0]
    assert "Sample-and-hold" in hold.data_quality.assumptions[0]
    # Same samples, so interior durations agree; only the two range edges move by <= half a step.
    assert abs(known(hold.metrics.sunlight_duration) - known(nearest.metrics.sunlight_duration)) <= H


def test_metric_units() -> None:
    m = full(load_fixture("intermittent_sunlight")).metrics
    assert m.sunlight_duration.unit is Unit.SECONDS and m.sunlight_percent.unit is Unit.PERCENT
    assert m.mean_solar_disk_fraction.unit is Unit.FRACTION and m.mean_solar_elevation.unit is Unit.DEGREES


# --- 22: JSON ---------------------------------------------------------------------------------


@pytest.mark.parametrize("fixture", ["missing_samples", "continuous_darkness", "mission_boundary"])
def test_analysis_json_round_trip(fixture: str) -> None:
    a = full(load_fixture(fixture), threshold=0.25)
    text = a.model_dump_json()
    assert "NaN" not in text and "Infinity" not in text
    assert EnvironmentAnalysis.model_validate_json(text) == a
    data = json.loads(text)
    assert data["evaluated_start_utc"].endswith("Z")
    assert {c["condition"] for c in data["conditions"]} == {c.value for c in Condition}
    assert all(w["duration_s"] > 0 for w in data["windows"])


@pytest.mark.parametrize("fixture", ["missing_samples", "irregular_sampling"])
def test_largest_sample_gap_matches_brute_force(fixture: str) -> None:
    s = load_fixture(fixture)
    times = [x.time_utc for x in s.samples]
    for start_h, end_h in [(0, 24), (5, 9), (6.5, 7.2), (7.5, 13.9), (-3, 1), (23, 30), (4.6, 5.05), (30, 40)]:
        start, end = at(start_h), at(end_h)
        gaps = [(b - a).total_seconds() for a, b in pairwise(times) if a < end and b > start]
        expected = max(gaps) if gaps else None
        assert summarize_data_quality(s, start, end).largest_sample_gap_s == expected, (start_h, end_h)
