"""Phase 2 sampling semantics and visibility windows. All data here is SYNTHETIC."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from itertools import pairwise

import pytest

from app.viability.enums import Condition, SamplingPolicy, WindowKind
from app.viability.fixtures import load_fixture
from app.viability.outputs import VisibilityWindow
from app.viability.windows import (
    WINDOW_KINDS,
    build_range_timeline,
    extract_windows,
    prepare_series,
)

from .helpers import at, hourly, make_series

H = 3600.0
W = WindowKind


def spans(windows: list[VisibilityWindow], kind: WindowKind) -> list[tuple[datetime, datetime]]:
    return [(w.start_utc, w.end_utc) for w in windows if w.kind is kind]


def hours_of(windows: list[VisibilityWindow], kind: WindowKind) -> list[tuple[float, float]]:
    t0 = datetime(2027, 1, 1, tzinfo=UTC)
    return [((a - t0) / timedelta(hours=1), (b - t0) / timedelta(hours=1)) for a, b in spans(windows, kind)]


# --- sample-and-hold supports ----------------------------------------------------------------


def test_last_sample_at_coverage_end_represents_no_time() -> None:
    s = make_series([0, 1, 2, 3], ["V", "V", "N", "N"])  # coverage [0, 3] h, like Andrew's files
    w = extract_windows(s, at(0), at(3))
    assert hours_of(w, W.SUNLIGHT) == [(0, 2)]
    assert hours_of(w, W.DARKNESS) == [(2, 3)]
    assert hours_of(w, W.UNKNOWN_DATA) == []
    # Beyond coverage the last state is NOT extended: the extra hour is unknown, not darkness.
    w = extract_windows(s, at(0), at(4))
    assert hours_of(w, W.DARKNESS) == [(2, 3)]
    assert hours_of(w, W.UNKNOWN_DATA) == [(3, 4)]
    assert hours_of(w, W.SUN_UNKNOWN) == [(3, 4)]


@pytest.mark.parametrize(("coverage_end", "dark_end"), [(4.0, 4.0), (3.5, 3.5), (3.0, 3.0)])
def test_last_sample_holds_one_step_capped_at_coverage_end(coverage_end: float, dark_end: float) -> None:
    s = make_series([0, 1, 2, 3], ["V", "V", "N", "N"], coverage_h=(0.0, coverage_end))
    w = extract_windows(s, at(0), at(5))
    assert hours_of(w, W.DARKNESS) == [(2, dark_end)]
    assert hours_of(w, W.UNKNOWN_DATA) == [(dark_end, 5)]


def test_coverage_gap_is_unknown_and_sample_before_holds_one_nominal_step() -> None:
    s = make_series([0, 1, 2, 6, 7], ["V"] * 5, nominal_h=1.0, max_gap_h=1.5)
    w = extract_windows(s, at(0), at(7))
    assert hours_of(w, W.SUNLIGHT) == [(0, 3), (6, 7)]
    assert hours_of(w, W.UNKNOWN_DATA) == [(3, 6)]
    assert hours_of(w, W.DARKNESS) == []  # a gap is never darkness


def test_irregular_series_sample_before_gap_represents_no_time() -> None:
    s = make_series([0, 1, 2, 6, 7], ["V"] * 5, nominal_h=None, max_gap_h=1.5)
    w = extract_windows(s, at(0), at(7))
    assert hours_of(w, W.SUNLIGHT) == [(0, 2), (6, 7)]
    assert hours_of(w, W.UNKNOWN_DATA) == [(2, 6)]


def test_spacing_equal_to_max_gap_is_not_a_gap() -> None:
    s = make_series([0, 1.5, 3], ["V", "N", "N"], nominal_h=1.0, max_gap_h=1.5)
    w = extract_windows(s, at(0), at(3))
    assert hours_of(w, W.SUNLIGHT) == [(0, 1.5)]
    assert hours_of(w, W.DARKNESS) == [(1.5, 3)]
    assert hours_of(w, W.UNKNOWN_DATA) == []


def test_time_before_first_sample_is_unknown_under_sample_hold() -> None:
    s = make_series([1, 2, 3], ["V", "V", "V"], coverage_h=(0.0, 3.0))
    w = extract_windows(s, at(0), at(3))
    assert hours_of(w, W.UNKNOWN_DATA) == [(0, 1)]
    assert hours_of(w, W.SUNLIGHT) == [(1, 3)]


def test_irregular_sampling_holds_until_next_sample() -> None:
    s = make_series([0, 0.25, 1.0, 1.1, 3.0], ["V", "N", "V", "N", "N"], nominal_h=None, max_gap_h=2.0)
    w = extract_windows(s, at(0), at(3))
    assert hours_of(w, W.SUNLIGHT) == [(0, 0.25), (1.0, 1.1)]
    assert hours_of(w, W.DARKNESS) == [(0.25, 1.0), (1.1, 3.0)]


# --- nearest-sample policy -------------------------------------------------------------------


def test_nearest_sample_boundaries_at_midpoints() -> None:
    s = hourly(["V", "V", "N", "N"])  # samples 0..3 h, coverage [0, 4] h
    w = extract_windows(s, at(0), at(4), policy=SamplingPolicy.NEAREST_SAMPLE)
    assert hours_of(w, W.SUNLIGHT) == [(0, 1.5)]  # first sample cannot reach before coverage start
    assert hours_of(w, W.DARKNESS) == [(1.5, 3.5)]  # last sample extends half a step
    assert hours_of(w, W.UNKNOWN_DATA) == [(3.5, 4)]


def test_nearest_sample_gap_extends_half_step_each_side() -> None:
    s = make_series([0, 1, 2, 6, 7], ["V"] * 5, coverage_h=(0.0, 7.0))
    w = extract_windows(s, at(0), at(7), policy=SamplingPolicy.NEAREST_SAMPLE)
    assert hours_of(w, W.UNKNOWN_DATA) == [(2.5, 5.5)]
    assert hours_of(w, W.SUNLIGHT) == [(0, 2.5), (5.5, 7)]


# --- evaluated range: clipping, alignment, coverage ------------------------------------------


def test_unaligned_range_is_clipped_exactly() -> None:
    s = hourly(["V", "V", "N", "N", "V", "V"])
    w = extract_windows(s, at(0.5), at(4.25))
    sun = [x for x in w if x.kind is W.SUNLIGHT]
    dark = [x for x in w if x.kind is W.DARKNESS]
    assert [(x.duration_s, x.clipped_at_start, x.clipped_at_end) for x in sun] == [
        (1.5 * H, True, False),
        (0.25 * H, False, True),
    ]
    assert [(x.duration_s, x.clipped_at_start, x.clipped_at_end) for x in dark] == [(2 * H, False, False)]


def test_range_starting_on_a_transition_is_not_clipped() -> None:
    s = hourly(["V", "V", "N", "N", "V", "V"])
    (dark,) = [x for x in extract_windows(s, at(2), at(4)) if x.kind is W.DARKNESS]
    assert (dark.clipped_at_start, dark.clipped_at_end) == (False, False)


def test_window_at_unknown_boundary_counts_as_clipped() -> None:
    s = hourly(["N", "N", "V"])  # nothing known before coverage start
    (dark,) = [x for x in extract_windows(s, at(0), at(3)) if x.kind is W.DARKNESS]
    assert dark.clipped_at_start is True


def test_range_beyond_coverage_is_unknown_not_extrapolated() -> None:
    s = hourly(["V", "V"])  # coverage [0, 2] h
    w = extract_windows(s, at(-1), at(3))
    assert hours_of(w, W.UNKNOWN_DATA) == [(-1, 0), (2, 3)]
    assert hours_of(w, W.SUNLIGHT) == [(0, 2)]
    assert hours_of(w, W.EARTH_UNKNOWN) == [(-1, 0), (2, 3)]
    unknown = [x for x in w if x.kind is W.UNKNOWN_DATA]
    assert unknown[0].clipped_at_start and unknown[1].clipped_at_end


def test_microsecond_arithmetic_has_no_gaps_or_overlaps() -> None:
    hours = [0, 1 / 3, 2 / 3, 1.0, 4 / 3]
    s = make_series(hours, ["V", "N", "U", "V", "N"], nominal_h=None, max_gap_h=1.0)
    start, end = at(0) + timedelta(microseconds=1), at(4 / 3) - timedelta(microseconds=1)
    w = extract_windows(s, start, end)
    sun = sorted((x for x in w if x.kind in (W.SUNLIGHT, W.DARKNESS, W.SUN_UNKNOWN)), key=lambda x: x.start_utc)
    assert sun[0].start_utc == start and sun[-1].end_utc == end
    for a, b in pairwise(sun):
        assert a.end_utc == b.start_utc  # exact adjacency, no float drift
    assert sum((x.end_utc - x.start_utc for x in sun), timedelta()) == end - start
    assert all(x.duration_s > 0 for x in w)


# --- partition / ordering properties ---------------------------------------------------------


@pytest.mark.parametrize("fixture", ["missing_samples", "unknown_terrain", "irregular_sampling", "mission_boundary"])
def test_complementary_windows_partition_the_range(fixture: str) -> None:
    s = load_fixture(fixture)
    w = extract_windows(s, s.coverage_start_utc, s.coverage_end_utc, solar_power_min_disk_fraction=0.3)
    total = s.coverage_end_utc - s.coverage_start_utc
    for cond in (Condition.DIRECT_SUNLIGHT, Condition.POWER_ELIGIBLE, Condition.EARTH_VISIBLE):
        kinds = {k for k in WINDOW_KINDS[cond] if k is not None}
        part = sorted((x for x in w if x.kind in kinds), key=lambda x: x.start_utc)
        assert part[0].start_utc == s.coverage_start_utc and part[-1].end_utc == s.coverage_end_utc
        assert all(a.end_utc == b.start_utc for a, b in pairwise(part))
        assert sum((x.end_utc - x.start_utc for x in part), timedelta()) == total
    for kind in W:
        same = [x for x in w if x.kind is kind]
        assert all(a.end_utc < b.start_utc for a, b in pairwise(same)), kind  # maximal, disjoint
    assert w == sorted(w, key=lambda x: (x.start_utc, list(W).index(x.kind)))


def test_power_windows_follow_threshold() -> None:
    s = hourly(["V", 0.5, 0.2, "N"])
    w = extract_windows(s, at(0), at(4), solar_power_min_disk_fraction=0.25)
    assert hours_of(w, W.SUNLIGHT) == [(0, 3)]
    assert hours_of(w, W.POWER_LIT) == [(0, 2)]
    assert hours_of(w, W.POWER_DARK) == [(2, 4)]
    assert hours_of(w, W.FULL_SUNLIGHT) == [(0, 1)]
    assert hours_of(w, W.PARTIAL_SUNLIGHT) == [(1, 3)]


# --- inputs and reuse ------------------------------------------------------------------------


def test_prepared_series_gives_identical_windows() -> None:
    s = load_fixture("missing_samples")
    prepared = prepare_series(s)
    a = extract_windows(s, s.coverage_start_utc, s.coverage_end_utc)
    b = extract_windows(prepared, s.coverage_start_utc, s.coverage_end_utc)
    assert a == b


def test_prepared_series_policy_conflict_rejected() -> None:
    prepared = prepare_series(load_fixture("continuous_sunlight"))
    with pytest.raises(ValueError, match="prepared with"):
        build_range_timeline(prepared, at(0), at(1), policy=SamplingPolicy.NEAREST_SAMPLE)


@pytest.mark.parametrize(
    ("start", "end", "match"),
    [
        (at(2), at(1), "after start"),
        (at(1), at(1), "after start"),
        (datetime(2027, 1, 1), at(1), "timezone"),
    ],
)
def test_invalid_range_rejected(start: datetime, end: datetime, match: str) -> None:
    with pytest.raises(ValueError, match=match):
        extract_windows(load_fixture("continuous_sunlight"), start, end)


@pytest.mark.parametrize("threshold", [-0.1, 1.5, True])
def test_invalid_threshold_rejected(threshold: float) -> None:
    with pytest.raises(ValueError, match="solar_power_min_disk_fraction"):
        extract_windows(load_fixture("continuous_sunlight"), at(0), at(1), solar_power_min_disk_fraction=threshold)
