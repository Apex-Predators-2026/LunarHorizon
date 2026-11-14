"""Phase 2 on Member 1's real precomputed site files (NASA-derived: JPL Horizons + LOLA/Moon Trek).

Three kinds of check:
1. Definitional: our durations equal sample counts x 1 h under sample-and-hold, computed
   independently from the raw file; our windows equal Member 1's own ``intervals()`` runs.
2. Cross-check against Andrew's ``summary`` where the definitions are equivalent (tolerances
   explained per assertion; definitions that differ are NOT forced to agree).
3. Regression values (longest outages with timestamps) to catch unintended changes.
The original files are read only, never modified.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from app.engine.visibility import intervals
from app.viability import analyze_environment, prepare_series
from app.viability.adapters import load_site_file
from app.viability.enums import Condition, ConditionState, MetricStatus, SamplingPolicy, WindowKind
from app.viability.outputs import EnvironmentAnalysis, Metric
from app.viability.windows import PreparedSeries

SITES_DIR = Path(__file__).resolve().parents[3] / "data" / "sites"
SITES = ("connecting-ridge", "malapert-massif", "peak-near-shackleton", "shackleton-floor")
START, END = datetime(2027, 1, 1, tzinfo=UTC), datetime(2029, 1, 1, tzinfo=UTC)
H = 3600.0
N_HOURS = 17544  # 17 545 instantaneous samples, the last one exactly at coverage end


@pytest.fixture(scope="module")
def raw() -> dict[str, dict[str, Any]]:
    return {s: json.loads((SITES_DIR / f"{s}.json").read_text(encoding="utf-8")) for s in SITES}


@pytest.fixture(scope="module")
def prepared() -> dict[str, PreparedSeries]:
    return {s: prepare_series(load_site_file(SITES_DIR / f"{s}.json")) for s in SITES}


@pytest.fixture(scope="module")
def analyses(prepared: dict[str, PreparedSeries]) -> dict[str, EnvironmentAnalysis]:
    return {s: analyze_environment(p, START, END, solar_power_min_disk_fraction=0.25) for s, p in prepared.items()}


def v(m: Metric) -> float:
    assert m.status is MetricStatus.KNOWN, m
    assert m.value is not None
    return m.value


@pytest.mark.parametrize("site", SITES)
def test_full_coverage_everything_known(site: str, analyses: dict[str, EnvironmentAnalysis]) -> None:
    a = analyses[site]
    dq = a.data_quality
    assert dq.sample_count == N_HOURS and dq.uncovered_duration_s == 0.0 and dq.coverage_gap_count == 0
    assert dq.sun_coverage_percent == 100.0 and dq.earth_coverage_percent == 100.0
    assert dq.largest_sample_gap_s == H
    assert dq.provenance.is_synthetic is False
    # Member 1's stated frame is carried as a statement, not as an independent verification.
    assert dq.provenance.coordinate_frame is not None and "MEAN_ME" in dq.provenance.coordinate_frame
    assert "not independently verified" in (dq.provenance.notes or "")
    for name, metric in a.metrics:
        assert metric.status in (MetricStatus.KNOWN, MetricStatus.NOT_APPLICABLE), name


@pytest.mark.parametrize("site", SITES)
def test_durations_equal_independent_sample_counts(
    site: str, raw: dict[str, dict[str, Any]], analyses: dict[str, EnvironmentAnalysis]
) -> None:
    tl, m = raw[site]["timeline"], analyses[site].metrics
    frac = np.asarray(tl["sun_visible_fraction"][:-1])  # last sample represents no time
    lit = np.asarray(tl["sun_visible"][:-1], dtype=bool)  # authoritative "any disk visible" (format 1.1)
    earth = np.asarray(tl["earth_visible"][:-1], dtype=bool)
    assert v(m.sunlight_duration) == H * np.count_nonzero(lit)
    assert v(m.full_sunlight_duration) == H * np.count_nonzero(frac == 1)
    assert v(m.partial_sunlight_duration) == H * np.count_nonzero(lit & (frac < 1))
    assert v(m.power_lit_duration) == H * np.count_nonzero(lit & (frac >= 0.25))
    assert v(m.earth_visible_duration) == H * np.count_nonzero(earth)
    assert v(m.simultaneous_duration) == H * np.count_nonzero(lit & (frac >= 0.25) & earth)
    assert v(m.mean_solar_disk_fraction) == pytest.approx(float(frac.mean()), abs=1e-12)
    sun_el = np.asarray(tl["sun_elevation_deg"][:-1])
    assert v(m.mean_solar_elevation) == pytest.approx(float(sun_el.mean()), abs=1e-12)


@pytest.mark.parametrize("site", SITES)
def test_windows_equal_member1_intervals(
    site: str, raw: dict[str, dict[str, Any]], analyses: dict[str, EnvironmentAnalysis]
) -> None:
    tl, a = raw[site]["timeline"], analyses[site]
    times = np.array([np.datetime64(t.rstrip("Z"), "s") for t in tl["time_utc"]])
    lit = np.asarray(tl["sun_visible"], dtype=bool)  # Member 1: "Sunlit = sun_visible"
    cases = {
        WindowKind.SUNLIGHT: lit,
        WindowKind.DARKNESS: ~lit,
        WindowKind.EARTH_VISIBLE: np.asarray(tl["earth_visible"], dtype=bool),
        WindowKind.COMMUNICATION_BLACKOUT: ~np.asarray(tl["earth_visible"], dtype=bool),
    }
    for kind, on in cases.items():
        theirs = [(a_, b_) for a_, b_ in intervals(times, on) if a_ != b_]  # drop zero-length end runs
        ours = [
            (np.datetime64(w.start_utc.replace(tzinfo=None), "s"), np.datetime64(w.end_utc.replace(tzinfo=None), "s"))
            for w in a.windows_of(kind)
        ]
        assert ours == theirs, kind


@pytest.mark.parametrize("site", SITES)
def test_agrees_with_andrews_summary_where_definitions_match(
    site: str, raw: dict[str, dict[str, Any]], analyses: dict[str, EnvironmentAnalysis]
) -> None:
    summary, m = raw[site]["summary"], analyses[site].metrics
    # His values: means over all 17 545 samples, shown to 0.1 %. Ours: time-weighted over
    # 17 544 h; the endpoint sample changes a percentage by <= 0.006 pp.
    # sunlit_pct == our direct sunlight: both use the authoritative sun_visible flag (format 1.1),
    # so only display rounding and the endpoint differ (before 1.1: up to 0.11 pp from slivers).
    sunlit = v(m.sunlight_percent)
    assert abs(sunlit - summary["sunlit_pct"]) <= 0.05 + 0.006
    # mean_sun_fraction_pct == our mean solar-disk fraction x 100 (rounding errors average out).
    assert abs(100 * v(m.mean_solar_disk_fraction) - summary["mean_sun_fraction_pct"]) <= 0.05 + 0.006
    # earth_visible_pct == our Earth-visible percent (boolean column: no fraction rounding).
    assert abs(v(m.earth_visible_percent) - summary["earth_visible_pct"]) <= 0.05 + 0.006
    # Full-sunlight and threshold-qualified percentages have no counterpart in his summary;
    # they are necessarily no larger than direct sunlight.
    assert v(m.full_sunlight_percent) <= v(m.power_lit_percent) <= sunlit


# site -> (longest without direct sunlight h, start, longest power-dark @0.25 h, start,
#          longest Earth blackout h, start, longest simultaneous window h)
REGRESSION: dict[str, tuple[float, str, float, str, float, str, float]] = {
    "connecting-ridge": (293, "2027-04-20T08", 492, "2028-03-31T13", 352, "2027-01-23T20", 272),
    "malapert-massif": (265, "2027-05-03T04", 266, "2027-05-03T04", 17, "2028-12-10T17", 2107),
    "peak-near-shackleton": (2116, "2028-02-23T06", 2802, "2027-03-05T22", 347, "2027-01-23T20", 272),
    "shackleton-floor": (17544, "2027-01-01T00", 17544, "2027-01-01T00", 17544, "2027-01-01T00", 0),
}


@pytest.mark.parametrize("site", SITES)
def test_longest_outage_regression(site: str, analyses: dict[str, EnvironmentAnalysis]) -> None:
    a = analyses[site]
    dark_h, dark_t, pdark_h, pdark_t, blk_h, blk_t, simul_h = REGRESSION[site]
    for cond, hours, start in (
        (Condition.DIRECT_SUNLIGHT, dark_h, dark_t),
        (Condition.POWER_ELIGIBLE, pdark_h, pdark_t),
        (Condition.EARTH_VISIBLE, blk_h, blk_t),
    ):
        c = a.condition(cond)
        assert v(c.longest_not_met) == hours * H, cond
        w = c.longest_not_met_window
        assert w is not None and f"{w.start_utc:%Y-%m-%dT%H}" == start, cond
        assert w.duration_s == hours * H
    assert v(a.metrics.longest_simultaneous_window) == simul_h * H
    assert v(a.metrics.longest_continuous_darkness) == pdark_h * H  # threshold set -> power-dark


def test_shackleton_floor_control_site(analyses: dict[str, EnvironmentAnalysis]) -> None:
    a = analyses["shackleton-floor"]
    m = a.metrics
    assert v(m.sunlight_duration) == 0.0 and v(m.earth_visible_duration) == 0.0
    assert m.time_to_first_sunset.status is MetricStatus.NOT_APPLICABLE
    assert m.time_to_first_earthset.status is MetricStatus.NOT_APPLICABLE
    assert m.mean_sun_clearance.status is MetricStatus.NOT_APPLICABLE  # never sunlit
    assert a.condition(Condition.DIRECT_SUNLIGHT).initial_state is ConditionState.NOT_MET


def test_partial_sunlight_is_material_at_lit_sites(analyses: dict[str, EnvironmentAnalysis]) -> None:
    # Treating partial as full would overstate sunlight by 6-13 percentage points at these sites.
    for site in ("connecting-ridge", "malapert-massif", "peak-near-shackleton"):
        assert v(analyses[site].metrics.partial_sunlight_percent) > 5.0


def test_two_week_mission_after_landing(prepared: dict[str, PreparedSeries]) -> None:
    landing = datetime(2027, 3, 1, tzinfo=UTC)
    a = analyze_environment(
        prepared["peak-near-shackleton"], landing, datetime(2027, 3, 15, tzinfo=UTC), solar_power_min_disk_fraction=0.25
    )
    total = 14 * 24 * H
    m = a.metrics
    assert a.data_quality.uncovered_duration_s == 0.0 and a.data_quality.sample_count == 14 * 24
    sun = a.condition(Condition.DIRECT_SUNLIGHT)
    assert v(sun.met_duration) + v(sun.not_met_duration) == total
    lit = sum(w.duration_s for w in a.windows_of(WindowKind.SUNLIGHT))
    dark = sum(w.duration_s for w in a.windows_of(WindowKind.DARKNESS))
    assert lit == v(m.sunlight_duration) and lit + dark == total
    assert v(m.sunlight_percent) == pytest.approx(100 * lit / total)
    assert v(m.longest_without_direct_sunlight) == max(w.duration_s for w in a.windows_of(WindowKind.DARKNESS))


@pytest.mark.parametrize("site", ("connecting-ridge", "peak-near-shackleton"))
def test_sampling_policy_sensitivity_is_at_most_one_step(site: str, prepared: dict[str, PreparedSeries]) -> None:
    hold = analyze_environment(prepared[site], START, END)
    series = prepared[site].series
    nearest = analyze_environment(series, START, END, policy=SamplingPolicy.NEAREST_SAMPLE)
    for name in ("sunlight_duration", "earth_visible_duration", "longest_continuous_darkness"):
        assert abs(v(getattr(hold.metrics, name)) - v(getattr(nearest.metrics, name))) <= H, name


def test_sub_precision_sliver_hour_at_peak_near_shackleton(prepared: dict[str, PreparedSeries]) -> None:
    """2027-08-13T21Z: sun_visible true but the 6-decimal fraction is 0.0 (disk sliver < 5e-7).

    Direct sunlight and partial: yes (authoritative flag). Full: no. Power-eligible: yes at
    threshold 0 ("any visible disk"), no at 0.25 (fraction far below). Fraction kept as written.
    """
    hour = (datetime(2027, 8, 13, 21, tzinfo=UTC), datetime(2027, 8, 13, 22, tzinfo=UTC))
    p = prepared["peak-near-shackleton"]
    for threshold, power_lit in ((0.0, 1.0), (0.25, 0.0)):
        m = analyze_environment(p, *hour, solar_power_min_disk_fraction=threshold).metrics
        assert (v(m.sunlight_duration), v(m.partial_sunlight_duration), v(m.full_sunlight_duration)) == (H, H, 0.0)
        assert v(m.power_lit_duration) == power_lit * H
        assert v(m.mean_solar_disk_fraction) == 0.0
    # Isolated: dark on both sides, so it splits a darkness period into two confirmed windows.
    a = analyze_environment(p, hour[0] - timedelta(hours=2), hour[1] + timedelta(hours=2))
    assert [w.duration_s for w in a.windows_of(WindowKind.DARKNESS)] == [2 * H, 2 * H]
