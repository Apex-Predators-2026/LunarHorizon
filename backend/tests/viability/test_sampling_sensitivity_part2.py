"""Part 2B: sampling-policy sensitivity report on controlled analytical sequences (ALL DATA SYNTHETIC).

Every expected value below is derived by hand from the two documented support rules (docs §5b), not from the
engine. With samples at whole hours t_i and a 1 h nominal interval:

* sample-and-hold (SH, engine default): sample i represents [t_i, t_(i+1)); the last sample before a gap or the
  series end represents one interval, capped at coverage_end (so a final sample *at* coverage_end holds 0 s).
* nearest-sample (NN): sample i represents [midpoint with i-1, midpoint with i+1); next to a gap or a coverage
  bound it extends half an interval, capped at coverage.

Consequences used throughout: interior outage durations are identical (both ends shift by half an hour); an
outage clipped by the mission start or end differs by half a spacing; with irregular spacing even interior
durations differ; and a mission start between two samples may be represented by different samples.
"""

from __future__ import annotations

import copy
import json
from collections.abc import Sequence
from typing import Any

import pytest

from app.viability import evaluate_scenario
from app.viability.enums import (
    CommunicationMode,
    ConstraintId,
    ConstraintStatus,
    DataBasis,
    Eligibility,
    MetricStatus,
    PowerSource,
    SamplingPolicy,
    ScoreStatus,
    UnknownReason,
)
from app.viability.fixtures import FIXTURE_NAMES, build_fixture, example_scenario
from app.viability.inputs import ScientificTimeSeries
from app.viability.mission import MissionRequirements, MissionScenario, SpacecraftConfiguration
from app.viability.outputs import ViabilityAssessment
from app.viability.sampling_sensitivity import (
    ALTERNATE_POLICY,
    BASELINE_POLICY,
    HELD_CONSTANT,
    OPPORTUNITY_METRICS,
    OUTAGE_METRICS,
    SENSITIVITY_LIMITATIONS,
    CoverageAdequacy,
    MetricComparison,
    PolicySeriesPair,
    SamplingSensitivityReport,
    SensitivityVerdict,
    compare_policy_assessments,
    evaluate_scenario_under_policy,
    prepare_policy_series,
    sampling_sensitivity_report,
)
from app.viability.windows import DEFAULT_SAMPLING_POLICY, prepare_series

from .helpers import SunCode, at, hourly, make_series

H = 3600.0
SH, NN = SamplingPolicy.SAMPLE_HOLD, SamplingPolicy.NEAREST_SAMPLE


def instants(sun: Sequence[SunCode], earth: Sequence[str] | None = None) -> ScientificTimeSeries:
    """Samples at 0, 1, ..., n-1 h with coverage [0, n-1] h: the final sample sits *at* coverage_end, as in the
    real site files, so both policies cover the whole dataset (SH gives that sample 0 s, NN half an hour)."""
    n = len(sun)
    return make_series([float(h) for h in range(n)], sun, earth, coverage_h=(0.0, float(n - 1)))


def scenario(
    series: ScientificTimeSeries,
    start_h: float,
    end_h: float,
    *,
    dark_h: float | None = None,
    blackout_h: float | None = None,
    threshold: float | None = None,
    **requirements: Any,
) -> MissionScenario:
    return MissionScenario(
        scenario_id="part2b-synthetic",
        site=series.site,
        mission_start_utc=at(start_h),
        mission_end_utc=at(end_h),
        spacecraft=SpacecraftConfiguration(
            name="Synthetic lander",
            power_source=PowerSource.SOLAR,
            communication_mode=CommunicationMode.DIRECT_TO_EARTH,
            max_continuous_darkness_s=None if dark_h is None else dark_h * H,
            max_communication_blackout_s=None if blackout_h is None else blackout_h * H,
            solar_power_min_disk_fraction=threshold,
        ),
        requirements=MissionRequirements(**requirements),
    )


def metric(report: SamplingSensitivityReport, name: str) -> MetricComparison:
    return next(m for m in report.metrics if m.name == name)


def known_h(m: MetricComparison) -> tuple[float, float]:
    assert m.baseline.status is MetricStatus.KNOWN and m.alternate.status is MetricStatus.KNOWN
    assert m.baseline.value is not None and m.alternate.value is not None
    return m.baseline.value / H, m.alternate.value / H


def statuses(report: SamplingSensitivityReport, cid: ConstraintId) -> tuple[ConstraintStatus, ConstraintStatus]:
    c = next(c for c in report.constraints if c.constraint_id is cid)
    return c.baseline_status, c.alternate_status


# Dark samples 2..5 inside a lit series 0..12; landing at 2.5 h, inside the dark run.
#   SH: sample 2 holds [2, 3) -> dark [2.5, 6)   = 3.5 h
#   NN: sample 2 holds [1.5, 2.5) (before landing); samples 3..5 hold [2.5, 5.5) -> dark 3.0 h
START_CLIPPED_SUN: list[SunCode] = ["V", "V", "N", "N", "N", "N", "V", "V", "V", "V", "V", "V", "V"]


# --- agreement and change ----------------------------------------------------------------------------------


def test_policies_agree_on_interior_outage_and_verdict() -> None:
    # Dark samples 4..7. SH dark [4, 8) = 4 h; NN dark [3.5, 7.5) = 4 h: interior durations are identical.
    # Initial power-lit: SH [0, 4) = 4 h; NN [0, 3.5) = 3.5 h (the first dark sample takes over at 3.5 h).
    s = instants(["V"] * 4 + ["N"] * 4 + ["V"] * 7)
    r = sampling_sensitivity_report(
        scenario(s, 0, 12, dark_h=5, blackout_h=2, min_initial_sunlight_s=3 * H, min_sunlight_percent=60.0), s
    )

    assert r.verdict is SensitivityVerdict.UNCHANGED
    assert r.summary.startswith("Verdict unchanged under the two tested sampling methods")
    assert r.baseline.assessment.eligibility is r.alternate.assessment.eligibility is Eligibility.PASS
    assert not r.eligibility_changed and r.changed_constraints == []
    dark = metric(r, "longest_continuous_darkness")
    assert known_h(dark) == (4.0, 4.0) and not dark.changed and dark.delta == 0.0
    initial = metric(r, "initial_sunlight_duration")
    assert known_h(initial) == (4.0, 3.5) and initial.changed and initial.delta == -0.5 * H
    # Sunlight share: 8 of 12 h lit under both (the dark run moved, its length did not).
    pct = metric(r, "sunlight_percent")
    assert pct.baseline.value == pytest.approx(800 / 12) and pct.alternate.value == pytest.approx(800 / 12)
    assert known_h(metric(r, "longest_communication_blackout")) == (0.0, 0.0)
    assert r.coverage.adequacy is CoverageAdequacy.COMPLETE
    # Margins move with the metrics: initial-sunlight headroom 1 h (SH) vs 0.5 h (NN).
    m = next(m for m in r.margins if m.name == "min_initial_sunlight")
    assert m.baseline.value == 1 * H and m.alternate.value == 0.5 * H and m.reference == 3 * H
    assert any("not evidence that the site is safe" in st for st in r.statements)


@pytest.mark.parametrize(
    ("limit_h", "expected"),
    [
        (2.99, (ConstraintStatus.FAIL, ConstraintStatus.FAIL)),  # below both measurements
        (3.0, (ConstraintStatus.FAIL, ConstraintStatus.PASS)),  # exactly the NN value: inclusive pass
        (3.25, (ConstraintStatus.FAIL, ConstraintStatus.PASS)),
        (3.5, (ConstraintStatus.PASS, ConstraintStatus.PASS)),  # exactly the SH value: both pass
    ],
)
def test_threshold_near_measurement_decides_whether_status_changes(
    limit_h: float, expected: tuple[ConstraintStatus, ConstraintStatus]
) -> None:
    s = instants(START_CLIPPED_SUN)
    r = sampling_sensitivity_report(scenario(s, 2.5, 11, dark_h=limit_h), s)

    assert known_h(metric(r, "longest_continuous_darkness")) == (3.5, 3.0)
    assert statuses(r, ConstraintId.MAX_CONTINUOUS_DARKNESS) == expected
    changed = expected[0] is not expected[1]
    assert r.eligibility_changed is changed
    assert r.verdict is (SensitivityVerdict.CHANGED if changed else SensitivityVerdict.UNCHANGED)
    assert r.changed_constraints == ([ConstraintId.MAX_CONTINUOUS_DARKNESS] if changed else [])


def test_constraint_change_is_reported_with_margins_score_and_wording() -> None:
    s = instants(START_CLIPPED_SUN)
    r = sampling_sensitivity_report(scenario(s, 2.5, 11, dark_h=3.25), s)

    assert r.verdict is SensitivityVerdict.CHANGED
    assert (r.baseline.assessment.eligibility, r.alternate.assessment.eligibility) == (
        Eligibility.FAIL,
        Eligibility.PASS,
    )
    assert r.summary == (
        "Verdict changes depending on how the hourly measurements are interpreted: FAIL under sample-and-hold "
        "(engine default) but PASS under nearest-sample."
    )
    c = r.constraints[0]
    assert c.constraint_id is ConstraintId.MAX_CONTINUOUS_DARKNESS and c.status_changed and c.threshold == 3.25 * H
    assert c.measured.delta == -0.5 * H
    # Signed margin = limit - observed: 3.25 - 3.5 = -0.25 h (violated) vs 3.25 - 3.0 = +0.25 h.
    m = next(m for m in r.margins if m.name == "max_continuous_darkness")
    assert (m.baseline.value, m.alternate.value) == (-0.25 * H, 0.25 * H)
    # Score: both exact (eligibility decided), different, delta = alternate - baseline.
    assert r.score.baseline_status is r.score.alternate_status is ScoreStatus.KNOWN
    assert r.score.changed
    assert r.score.baseline_score is not None and r.score.alternate_score is not None
    assert r.score.delta == pytest.approx(r.score.alternate_score - r.score.baseline_score)
    assert r.score.alternate_score > r.score.baseline_score  # less darkness -> larger darkness margin
    assert r.statements[0].startswith("Maximum continuous power-darkness: FAIL under sample-and-hold, PASS under")
    assert "3.5 h (sample-and-hold) vs 3 h (nearest-sample)" in r.statements[0]


def test_outage_clipped_at_mission_end_changes_blackout_verdict() -> None:
    # Earth not visible from sample 6 on; mission ends at 8.75 h.
    #   SH: blackout [6, 8.75) = 2.75 h.  NN: sample 6 holds from 5.5 h -> [5.5, 8.75) = 3.25 h.
    s = instants(["V"] * 10, ["V"] * 6 + ["N"] * 4)
    r = sampling_sensitivity_report(scenario(s, 0, 8.75, blackout_h=3, min_earth_visibility_percent=60.0), s)

    assert known_h(metric(r, "longest_communication_blackout")) == (2.75, 3.25)
    assert statuses(r, ConstraintId.MAX_COMMUNICATION_BLACKOUT) == (ConstraintStatus.PASS, ConstraintStatus.FAIL)
    # Earth-visible share: 6 / 8.75 = 68.571 % (SH) vs 5.5 / 8.75 = 62.857 % (NN); both >= 60 %.
    ev = metric(r, "earth_visible_percent")
    assert ev.baseline.value == pytest.approx(600 / 8.75) and ev.alternate.value == pytest.approx(550 / 8.75)
    assert statuses(r, ConstraintId.MIN_EARTH_VISIBILITY_PERCENT) == (ConstraintStatus.PASS, ConstraintStatus.PASS)
    assert r.verdict is SensitivityVerdict.CHANGED
    tte = metric(r, "time_to_first_earthset")
    assert known_h(tte) == (6.0, 5.5)


def test_constraints_changed_while_eligibility_stays_fail() -> None:
    # As the start-clipped case, plus an Earth-visibility requirement that fails under both policies.
    earth = ["V"] * 9 + ["N"] + ["V"] * 3
    s = instants(START_CLIPPED_SUN, earth)
    r = sampling_sensitivity_report(scenario(s, 2.5, 11, dark_h=3.25, min_earth_visibility_percent=100.0), s)

    assert r.baseline.assessment.eligibility is r.alternate.assessment.eligibility is Eligibility.FAIL
    assert r.verdict is SensitivityVerdict.CONSTRAINTS_CHANGED
    assert r.changed_constraints == [ConstraintId.MAX_CONTINUOUS_DARKNESS]
    assert statuses(r, ConstraintId.MIN_EARTH_VISIBILITY_PERCENT) == (ConstraintStatus.FAIL, ConstraintStatus.FAIL)
    assert r.summary.startswith("Verdict unchanged (FAIL under both tested sampling methods), but the status of 1")


def test_unsupported_requirement_is_not_a_coverage_problem() -> None:
    # min_sun_clearance is UNKNOWN (unsupported) under both policies regardless of the data.
    s = instants(START_CLIPPED_SUN)
    r = sampling_sensitivity_report(scenario(s, 2.5, 11, dark_h=3.25, min_sun_clearance_deg=1.0), s)

    # SH: darkness FAIL dominates -> FAIL. NN: darkness PASS + unsupported UNKNOWN -> UNKNOWN.
    assert (r.baseline.assessment.eligibility, r.alternate.assessment.eligibility) == (
        Eligibility.FAIL,
        Eligibility.UNKNOWN,
    )
    assert r.verdict is SensitivityVerdict.CHANGED  # the difference is caused by the darkness check, not data
    assert r.coverage.adequacy is CoverageAdequacy.COMPLETE
    assert r.coverage.unsupported_constraints == [ConstraintId.MIN_SUN_CLEARANCE]
    assert r.coverage.data_limited_constraints == []
    # Withheld score under UNKNOWN eligibility is reported as such, never as 0.
    assert r.score.alternate_status is ScoreStatus.ELIGIBILITY_UNKNOWN and r.score.alternate_score is None


# --- sampling structure ------------------------------------------------------------------------------------


def test_missing_sample_lengthens_the_hold_but_not_the_nearest_support() -> None:
    # No sample at 3 h (spacing 2 h <= max_gap 2.5 h, so not a coverage gap). Sample 2 is dark.
    #   SH: sample 2 holds [2, 4) = 2 h.  NN: sample 2 holds [1.5, 3), sample 4 holds [3, 4.5) -> dark 1.5 h.
    s = make_series(
        [0, 1, 2, 4, 5, 6, 7, 8], ["V", "V", "N", "V", "V", "V", "V", "V"], max_gap_h=2.5, coverage_h=(0.0, 8.0)
    )
    r = sampling_sensitivity_report(scenario(s, 0, 8, dark_h=1.75), s)

    assert known_h(metric(r, "longest_continuous_darkness")) == (2.0, 1.5)
    assert statuses(r, ConstraintId.MAX_CONTINUOUS_DARKNESS) == (ConstraintStatus.FAIL, ConstraintStatus.PASS)
    assert r.coverage.adequacy is CoverageAdequacy.COMPLETE
    assert r.coverage.largest_sample_gap_s == 2 * H
    assert "sampled (spacing up to 2 h)" in r.summary


def test_irregular_sampling_changes_interior_outage_duration() -> None:
    # Irregular series (no nominal interval), samples at 0, 1, 3, 4, 7, 8 h; only the 3 h sample is dark.
    #   SH: [3, 4) = 1 h.  NN: midpoints 2 and 3.5 -> [2, 3.5) = 1.5 h.
    s = make_series(
        [0, 1, 3, 4, 7, 8], ["V", "V", "N", "V", "V", "V"], nominal_h=None, max_gap_h=3.5, coverage_h=(0.0, 8.0)
    )
    r = sampling_sensitivity_report(scenario(s, 0, 8, dark_h=1.25), s)

    assert known_h(metric(r, "longest_continuous_darkness")) == (1.0, 1.5)
    assert statuses(r, ConstraintId.MAX_CONTINUOUS_DARKNESS) == (ConstraintStatus.PASS, ConstraintStatus.FAIL)
    assert r.verdict is SensitivityVerdict.CHANGED
    assert r.coverage.adequacy is CoverageAdequacy.COMPLETE  # both policies still cover [0, 8] completely


@pytest.mark.parametrize(
    ("limit_h", "verdict", "adequacy", "status"),
    [
        (8.0, SensitivityVerdict.UNCHANGED, CoverageAdequacy.DECISIVE, ConstraintStatus.PASS),
        (4.0, SensitivityVerdict.INCONCLUSIVE, CoverageAdequacy.INSUFFICIENT, ConstraintStatus.UNKNOWN),
    ],
)
def test_coverage_gap_is_separated_from_sampling_differences(
    limit_h: float, verdict: SensitivityVerdict, adequacy: CoverageAdequacy, status: ConstraintStatus
) -> None:
    # Gap between samples 4 and 8 (> max_gap 1.5 h). Earth hidden at samples 3, 4 and 8.
    #   SH: hidden [3, 5), unknown [5, 8), hidden [8, 9) -> blackout in [2 h, 6 h].
    #   NN: hidden [2.5, 4.5), unknown [4.5, 7.5), hidden [7.5, 8.5) -> blackout in [2 h, 6 h].
    hours = [0, 1, 2, 3, 4, 8, 9, 10, 11, 12]
    earth = ["V", "V", "V", "N", "N", "N", "V", "V", "V", "V"]
    s = make_series(hours, ["V"] * 10, earth, coverage_h=(0.0, 12.0))
    r = sampling_sensitivity_report(scenario(s, 0, 12, blackout_h=limit_h), s)

    b = metric(r, "longest_communication_blackout")
    for m in (b.baseline, b.alternate):
        assert m.status is MetricStatus.BOUNDED and (m.lower, m.upper) == (2 * H, 6 * H)
    assert not b.changed  # same bounds, shifted in time
    assert r.coverage.baseline_uncovered_duration_s == r.coverage.alternate_uncovered_duration_s == 3 * H
    assert statuses(r, ConstraintId.MAX_COMMUNICATION_BLACKOUT) == (status, status)
    assert r.verdict is verdict and r.coverage.adequacy is adequacy
    if verdict is SensitivityVerdict.INCONCLUSIVE:
        assert r.coverage.data_limited_constraints == [ConstraintId.MAX_COMMUNICATION_BLACKOUT]
        assert r.summary.startswith("Comparison is inconclusive because too much information is missing")
        assert not r.eligibility_changed  # UNKNOWN under both
    assert any("3 h of the mission is covered by no sample under either policy" in n for n in r.coverage.notes)


def test_unknown_sample_state_gives_bounds_under_both_policies() -> None:
    # Sample 3 has no Sun ephemeris ("X"). SH: N [2,3) U [3,4) N [4,5); NN: N [1.5,2.5) U [2.5,3.5) N [3.5,4.5).
    # Longest power-dark lies in [1 h, 3 h] under both; a 2 h limit is undecidable under both.
    s = instants(["V", "V", "N", "X", "N", "V", "V", "V", "V"])
    r = sampling_sensitivity_report(scenario(s, 0, 8, dark_h=2), s)

    d = metric(r, "longest_continuous_darkness")
    for m in (d.baseline, d.alternate):
        assert m.status is MetricStatus.BOUNDED and (m.lower, m.upper) == (1 * H, 3 * H)
    c = r.constraints[0]
    assert c.baseline_unknown_reason is c.alternate_unknown_reason is UnknownReason.INCOMPLETE_DATA
    assert r.verdict is SensitivityVerdict.INCONCLUSIVE
    assert r.coverage.adequacy is CoverageAdequacy.INSUFFICIENT
    # No automatic downgrade or upgrade: each side keeps exactly the canonical pipeline's eligibility.
    assert r.baseline.assessment.eligibility is Eligibility.UNKNOWN


# --- mission timing ----------------------------------------------------------------------------------------


def test_landing_between_samples_is_represented_by_different_samples() -> None:
    # Landing at 1.6 h. SH: sample 1 (dark) holds [1, 2). NN: sample 2 (lit) holds [1.5, 2.5).
    # Initial power-lit: SH 0 h; NN [1.6, 5.5) = 3.9 h (sample 6, dark, takes over at 5.5 h).
    s = instants(["N", "N", "V", "V", "V", "V", "N", "N", "N", "N", "N"])
    r = sampling_sensitivity_report(scenario(s, 1.6, 10, min_initial_sunlight_s=3 * H), s)

    b, a = known_h(metric(r, "initial_sunlight_duration"))
    assert b == 0.0 and a == pytest.approx(3.9)
    assert statuses(r, ConstraintId.MIN_INITIAL_SUNLIGHT) == (ConstraintStatus.FAIL, ConstraintStatus.PASS)
    assert r.verdict is SensitivityVerdict.CHANGED
    assert [m.name for m in r.opportunities] == list(OPPORTUNITY_METRICS)


def test_fractional_start_and_duration() -> None:
    # Dark samples 3..6, mission [2.25, 9.65) = 7.4 h.
    #   SH: lit [2.25, 3), dark [3, 7), lit [7, 9.65)   -> initial 0.75 h, dark 4 h, sunlight 3.4 h
    #   NN: lit [2.25, 2.5), dark [2.5, 6.5), lit [6.5, 9.65) -> initial 0.25 h, dark 4 h, sunlight 3.4 h
    s = instants(["V", "V", "V", "N", "N", "N", "N", "V", "V", "V", "V", "V", "V"])
    r = sampling_sensitivity_report(scenario(s, 2.25, 9.65, dark_h=4, min_sunlight_percent=45.0), s)

    assert r.baseline.assessment.evaluated_duration_s == pytest.approx(7.4 * H)
    assert known_h(metric(r, "longest_continuous_darkness")) == (4.0, 4.0)
    b, a = known_h(metric(r, "initial_sunlight_duration"))
    assert (b, a) == pytest.approx((0.75, 0.25))
    b, a = known_h(metric(r, "sunlight_duration"))
    assert (b, a) == pytest.approx((3.4, 3.4))
    b, a = known_h(metric(r, "time_to_first_sunset"))
    assert (b, a) == pytest.approx((0.75, 0.25))
    assert r.verdict is SensitivityVerdict.UNCHANGED  # 45.9 % sunlight and 4 h darkness under both


def test_short_mission_inside_one_sample_spacing() -> None:
    # 18-minute mission [3.6, 3.9): SH uses sample 3 (lit) throughout, NN uses sample 4 (dark) throughout.
    s = instants(["V", "V", "V", "V", "N", "N", "N"])
    r = sampling_sensitivity_report(scenario(s, 3.6, 3.9, min_sunlight_percent=50.0), s)

    pct = metric(r, "sunlight_percent")
    assert (pct.baseline.value, pct.alternate.value) == (100.0, 0.0)
    assert statuses(r, ConstraintId.MIN_SUNLIGHT_PERCENT) == (ConstraintStatus.PASS, ConstraintStatus.FAIL)
    assert r.verdict is SensitivityVerdict.CHANGED


def test_mission_ending_at_dataset_end() -> None:
    # Final sample (dark) sits at coverage_end = 10 h. SH gives it 0 s; NN gives it [9.5, 10).
    s = instants(["V"] * 10 + ["N"])
    r = sampling_sensitivity_report(scenario(s, 6, 10, min_sunlight_percent=90.0), s)

    pct = metric(r, "sunlight_percent")
    assert (pct.baseline.value, pct.alternate.value) == (100.0, 87.5)
    assert known_h(metric(r, "longest_continuous_darkness")) == (0.0, 0.5)
    assert statuses(r, ConstraintId.MIN_SUNLIGHT_PERCENT) == (ConstraintStatus.PASS, ConstraintStatus.FAIL)
    assert r.coverage.adequacy is CoverageAdequacy.COMPLETE


def test_mission_extending_past_dataset_end_is_bounded_not_extrapolated() -> None:
    # Same data, mission [6, 12): [10, 12) is unknown under both policies.
    #   SH lit 4 h known -> sunlight in [66.67 %, 100 %];  NN lit 3.5 h, dark 0.5 h -> [58.33 %, 91.67 %].
    s = instants(["V"] * 10 + ["N"])
    r = sampling_sensitivity_report(scenario(s, 6, 12, min_sunlight_percent=50.0), s)

    pct = metric(r, "sunlight_percent")
    assert pct.baseline.status is pct.alternate.status is MetricStatus.BOUNDED
    assert (pct.baseline.lower, pct.baseline.upper) == pytest.approx((400 / 6, 100.0))
    assert (pct.alternate.lower, pct.alternate.upper) == pytest.approx((350 / 6, 550 / 6))
    assert pct.changed and pct.delta is None and not pct.status_changed
    assert statuses(r, ConstraintId.MIN_SUNLIGHT_PERCENT) == (ConstraintStatus.PASS, ConstraintStatus.PASS)
    assert r.verdict is SensitivityVerdict.UNCHANGED
    assert r.coverage.adequacy is CoverageAdequacy.DECISIVE
    assert r.coverage.baseline_uncovered_duration_s == r.coverage.alternate_uncovered_duration_s == 2 * H


def test_policy_dependent_coverage_makes_comparison_inconclusive_not_changed() -> None:
    # hourly(): samples 0..5, coverage [0, 6]. SH lets sample 5 hold [5, 6); NN stops at 5.5 h, so [5.5, 6)
    # is represented by no sample under NN only. SH sunlight 100 % (PASS at 95 %); NN in [91.67, 100] (UNKNOWN).
    s = hourly(["V"] * 6)
    r = sampling_sensitivity_report(scenario(s, 0, 6, min_sunlight_percent=95.0), s)

    assert (r.baseline.assessment.eligibility, r.alternate.assessment.eligibility) == (
        Eligibility.PASS,
        Eligibility.UNKNOWN,
    )
    assert r.eligibility_changed
    assert r.verdict is SensitivityVerdict.INCONCLUSIVE  # an UNKNOWN for missing data is not a verdict change
    assert "eligibility is PASS under sample-and-hold and UNKNOWN under nearest-sample" in r.summary
    pct = metric(r, "sunlight_percent")
    assert pct.became_uncertain and not pct.became_known and pct.status_changed
    assert (pct.alternate.lower, pct.alternate.upper) == pytest.approx((550 / 6, 100.0))
    assert (r.coverage.baseline_uncovered_duration_s, r.coverage.alternate_uncovered_duration_s) == (0.0, 0.5 * H)
    assert any("differs between the policies" in n for n in r.coverage.notes)
    assert any("is known under sample-and-hold but not under nearest-sample" in st for st in r.statements)


def test_mission_without_any_data_is_inconclusive() -> None:
    s = instants(["V"] * 11)
    r = sampling_sensitivity_report(scenario(s, 20, 30, dark_h=5, min_sunlight_percent=50.0), s)

    assert r.verdict is SensitivityVerdict.INCONCLUSIVE
    assert r.summary == (
        "Comparison is inconclusive because too much information is missing: eligibility is UNKNOWN under both "
        "methods, and the undecided checks lack data."
    )
    assert r.coverage.adequacy is CoverageAdequacy.INSUFFICIENT
    assert any("The Sun or Earth state is unknown for the entire mission" in n for n in r.coverage.notes)
    assert r.coverage.baseline_sun_coverage_percent == r.coverage.alternate_sun_coverage_percent == 0.0
    for c in r.constraints:
        assert c.baseline_unknown_reason is c.alternate_unknown_reason is UnknownReason.NO_DATA
    for m in r.outages:
        assert m.baseline.status is m.alternate.status is MetricStatus.UNAVAILABLE
    assert r.score.baseline_status is ScoreStatus.ELIGIBILITY_UNKNOWN


# --- provenance, purity, determinism, canonical path --------------------------------------------------------


def test_report_structure_and_synthetic_provenance() -> None:
    s = instants(START_CLIPPED_SUN)
    r = sampling_sensitivity_report(scenario(s, 2.5, 11, dark_h=3.25), s)

    assert r.baseline.policy is BASELINE_POLICY is DEFAULT_SAMPLING_POLICY is SH and r.baseline.engine_default
    assert r.alternate.policy is ALTERNATE_POLICY is NN and not r.alternate.engine_default
    assert r.baseline.assumptions[0].startswith("Sample-and-hold")
    assert r.alternate.assumptions[0].startswith("Nearest-sample")
    assert r.held_constant == list(HELD_CONSTANT)
    assert r.provenance.is_synthetic and r.data_basis is DataBasis.SYNTHETIC
    assert r.limitations[0].startswith("[SYNTHETIC DATA]")
    assert r.limitations[1:] == list(SENSITIVITY_LIMITATIONS)
    assert [m.name for m in r.outages] == list(OUTAGE_METRICS)
    assert len(r.metrics) == 24
    assert all(not risk.message or risk.message.startswith("[SYNTHETIC") for risk in r.baseline.assessment.risks)
    assert r.dataset_id == s.dataset_id and r.site == s.site
    assert not any("probability" in st.lower() or "confidence" in st.lower() for st in r.statements)


def test_inputs_are_not_mutated_and_output_is_deterministic() -> None:
    s = make_series(
        [0, 1, 3, 4, 7, 8], ["V", "V", "N", "V", "V", "V"], nominal_h=None, max_gap_h=3.5, coverage_h=(0.0, 8.0)
    )
    sc = scenario(s, 0.5, 7.75, dark_h=1.25, blackout_h=2, min_sunlight_percent=50.0)
    before = (copy.deepcopy(s.model_dump(mode="json")), copy.deepcopy(sc.model_dump(mode="json")))

    first = sampling_sensitivity_report(sc, s).model_dump_json()
    second = sampling_sensitivity_report(sc, prepare_policy_series(s)).model_dump_json()

    assert first == second
    assert (s.model_dump(mode="json"), sc.model_dump(mode="json")) == before
    restored = SamplingSensitivityReport.model_validate_json(first)
    assert restored.model_dump_json() == first
    assert json.loads(first)["verdict"] == "changed"


@pytest.mark.parametrize("name", FIXTURE_NAMES)
def test_baseline_is_exactly_the_canonical_engine_result(name: str) -> None:
    series = build_fixture(name)
    sc = example_scenario(series)
    canonical_before = evaluate_scenario(sc, series).model_dump_json()

    r = sampling_sensitivity_report(sc, series)

    assert r.baseline.assessment.model_dump_json() == canonical_before
    assert evaluate_scenario(sc, series).model_dump_json() == canonical_before  # default unchanged afterwards
    assert evaluate_scenario_under_policy(sc, series, SH).model_dump_json() == canonical_before
    assert r.alternate.assessment.data_quality.sampling_policy is NN
    # Independently checked alternate path: Phase 2 through the supported policy parameter.
    alt = evaluate_scenario_under_policy(sc, prepare_series(series, NN), NN)
    assert alt == r.alternate.assessment


def test_nominal_default_outputs_unchanged_on_analytical_case() -> None:
    s = instants(START_CLIPPED_SUN)
    sc = scenario(s, 2.5, 11, dark_h=3.25)
    canonical: ViabilityAssessment = evaluate_scenario(sc, s)
    r = sampling_sensitivity_report(sc, s)
    assert r.baseline.assessment == canonical
    assert canonical.eligibility is Eligibility.FAIL  # the default verdict is never downgraded or upgraded


# --- input validation --------------------------------------------------------------------------------------


def test_rejects_wrong_policies_and_mismatched_inputs() -> None:
    s = instants(START_CLIPPED_SUN)
    sc = scenario(s, 2.5, 11, dark_h=3.25)
    b = evaluate_scenario_under_policy(sc, s, SH)
    a = evaluate_scenario_under_policy(sc, s, NN)

    with pytest.raises(ValueError, match="baseline must use"):
        compare_policy_assessments(a, b)
    with pytest.raises(ValueError, match="alternate must use"):
        compare_policy_assessments(b, b)
    other = evaluate_scenario_under_policy(scenario(s, 2.5, 11, dark_h=4), s, NN)
    with pytest.raises(ValueError, match="configuration differs"):
        compare_policy_assessments(b, other)
    shifted = evaluate_scenario_under_policy(scenario(s, 2.0, 11, dark_h=3.25), s, NN)
    with pytest.raises(ValueError, match="evaluated range differs"):
        compare_policy_assessments(b, shifted)

    with pytest.raises(ValueError, match="sample-and-hold baseline"):
        PolicySeriesPair(prepare_series(s, NN), prepare_series(s, SH))
    with pytest.raises(ValueError, match="same scientific measurements"):
        PolicySeriesPair(prepare_series(s, SH), prepare_series(instants(["V"] * 13), NN))
    with pytest.raises(ValueError, match="prepared with"):
        evaluate_scenario_under_policy(sc, prepare_series(s, SH), NN)

    foreign = make_series([0, 1, 2], ["V"] * 3).model_copy(
        update={"site": sc.site.model_copy(update={"id": "another-site"})}
    )
    with pytest.raises(ValueError, match="series is for site"):
        sampling_sensitivity_report(sc, foreign)


def test_report_validator_rejects_inconsistent_verdicts() -> None:
    s = instants(START_CLIPPED_SUN)
    r = sampling_sensitivity_report(scenario(s, 2.5, 11, dark_h=3.25), s)
    data = r.model_dump(mode="json")

    with pytest.raises(ValueError, match="verdict contradicts"):
        SamplingSensitivityReport.model_validate({**data, "verdict": "unchanged"})
    with pytest.raises(ValueError, match="eligibility_changed contradicts"):
        SamplingSensitivityReport.model_validate({**data, "eligibility_changed": False})
    with pytest.raises(ValueError, match="changed_constraints"):
        SamplingSensitivityReport.model_validate({**data, "changed_constraints": []})
    swapped = {**data, "baseline": data["alternate"], "alternate": data["baseline"]}
    with pytest.raises(ValueError, match="baseline must be the engine default"):
        SamplingSensitivityReport.model_validate(swapped)
