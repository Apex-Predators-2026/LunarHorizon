"""Part 2B: sampling-policy sensitivity on Member 1's real precomputed site files (JPL Horizons + LOLA/Moon Trek).

The files are only read. Expected outage and initial-opportunity durations under BOTH policies are re-derived
independently from the raw ``timeline`` columns (no engine code), on a half-hour grid. For whole-hour mission
bounds [s, e) over hourly samples whose final sample sits at coverage_end:

* sample-and-hold: samples s .. e-1 each represent one hour (two half-hour slots);
* nearest-sample: sample s represents [s, s+0.5), samples s+1 .. e-1 one hour each, and sample e represents
  [e-0.5, e), because supports end at midpoints.

Real-data verdict changes are DISCOVERED from the raw columns (no pinned dates, so regenerated files keep the
tests meaningful) and then confirmed through the full engine path.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from app.viability import evaluate_scenario
from app.viability.adapters import load_site_file
from app.viability.enums import (
    CommunicationMode,
    ConstraintId,
    ConstraintStatus,
    DataBasis,
    Eligibility,
    MetricStatus,
    PowerSource,
    SamplingPolicy,
)
from app.viability.mission import MissionRequirements, MissionScenario, SpacecraftConfiguration
from app.viability.sampling_sensitivity import (
    CoverageAdequacy,
    MetricComparison,
    PolicySeriesPair,
    SamplingSensitivityReport,
    SensitivityVerdict,
    prepare_policy_series,
    sampling_sensitivity_report,
)

from .helpers import longest_true_run

SITES_DIR = Path(__file__).resolve().parents[3] / "data" / "sites"
ORIGINAL = ("connecting-ridge", "peak-near-shackleton", "malapert-massif", "shackleton-floor")
EXTRA = ("haworth-rim", "de-gerlache-rim")
LIT = ("connecting-ridge", "peak-near-shackleton", "malapert-massif")
T0 = datetime(2027, 1, 1, tzinfo=UTC)
DATASET_END = datetime(2029, 1, 1, tzinfo=UTC)
H = 3600.0
DARK_LIMIT_H, BLACKOUT_LIMIT_H, THRESHOLD, INITIAL_SUN_H = 50.0, 96.0, 0.25, 24.0
REQUIREMENTS: dict[str, Any] = {
    "min_mean_solar_disk_fraction": 0.5,
    "min_earth_visibility_percent": 40.0,
    "min_initial_sunlight_s": INITIAL_SUN_H * H,
    "min_initial_earth_visibility_s": 12 * H,
    "min_sunlight_percent": 50.0,
}
SH, NN = SamplingPolicy.SAMPLE_HOLD, SamplingPolicy.NEAREST_SAMPLE


@pytest.fixture(scope="module")
def raw() -> dict[str, dict[str, Any]]:
    return {s: json.loads((SITES_DIR / f"{s}.json").read_text(encoding="utf-8"))["timeline"] for s in ORIGINAL + EXTRA}


@pytest.fixture(scope="module")
def pairs() -> dict[str, PolicySeriesPair]:
    return {s: prepare_policy_series(load_site_file(SITES_DIR / f"{s}.json")) for s in ORIGINAL + EXTRA}


def mission(pair: PolicySeriesPair, start: datetime, end: datetime) -> MissionScenario:
    return MissionScenario(
        scenario_id="real-part2b-sampling",
        site=pair.series.site,
        mission_start_utc=start,
        mission_end_utc=end,
        spacecraft=SpacecraftConfiguration(
            name="Solar DTE lander",
            power_source=PowerSource.SOLAR,
            communication_mode=CommunicationMode.DIRECT_TO_EARTH,
            max_continuous_darkness_s=DARK_LIMIT_H * H,
            max_communication_blackout_s=BLACKOUT_LIMIT_H * H,
            solar_power_min_disk_fraction=THRESHOLD,
        ),
        requirements=MissionRequirements(**REQUIREMENTS),
    )


def hour_index(t: datetime) -> int:
    return int((t - T0).total_seconds() // H)


# --- independent derivation from the raw columns -------------------------------------------------------------


def lit_flags(tl: dict[str, Any]) -> list[bool]:
    """Power-lit per sample: authoritative ``sun_visible`` and fraction >= threshold."""
    return [bool(v) and f >= THRESHOLD for v, f in zip(tl["sun_visible"], tl["sun_visible_fraction"], strict=True)]


def slots(s: int, e: int, policy: SamplingPolicy) -> list[int]:
    """Sample index for each half-hour slot of the whole-hour mission [s, e) (see the module docstring)."""
    if policy is SH:
        return [i for i in range(s, e) for _ in (0, 1)]
    return [s] + [i for i in range(s + 1, e) for _ in (0, 1)] + [e]


def leading(flags: Sequence[bool]) -> int:
    n = 0
    for f in flags:
        if not f:
            break
        n += 1
    return n


def derive(tl: dict[str, Any], s: int, e: int, policy: SamplingPolicy) -> dict[str, float]:
    """Durations in hours under ``policy``, from raw columns only."""
    idx = slots(s, e, policy)
    lit, sun, earth = lit_flags(tl), tl["sun_visible"], tl["earth_visible"]
    return {
        "longest_continuous_darkness": longest_true_run([not lit[i] for i in idx])[0] / 2,
        "longest_without_direct_sunlight": longest_true_run([not sun[i] for i in idx])[0] / 2,
        "longest_communication_blackout": longest_true_run([not earth[i] for i in idx])[0] / 2,
        "initial_sunlight_duration": leading([lit[i] for i in idx]) / 2,
        "initial_earth_visibility_duration": leading([bool(earth[i]) for i in idx]) / 2,
    }


def metric(report: SamplingSensitivityReport, name: str) -> MetricComparison:
    return next(m for m in report.metrics if m.name == name)


def known_h(m: MetricComparison) -> tuple[float, float]:
    assert m.baseline.status is MetricStatus.KNOWN and m.alternate.status is MetricStatus.KNOWN, m.name
    assert m.baseline.value is not None and m.alternate.value is not None
    return m.baseline.value / H, m.alternate.value / H


def check_against_raw(report: SamplingSensitivityReport, tl: dict[str, Any], start: datetime, end: datetime) -> None:
    s, e = hour_index(start), hour_index(end)
    expected = {p: derive(tl, s, e, p) for p in (SH, NN)}
    for name in expected[SH]:
        assert known_h(metric(report, name)) == (expected[SH][name], expected[NN][name]), name
    duration_h = (end - start).total_seconds() / H
    for m in report.metrics:
        if m.delta is None:
            continue
        if m.unit.value == "s":
            # Each policy moves a transition by at most half an hour relative to the other; a duration has two ends.
            assert abs(m.delta) <= 1.0 * H, m.name
        elif m.unit.value == "percent":
            assert abs(m.delta) <= 100.0 * 1.0 / duration_h + 1e-9, m.name


def report_for(pair: PolicySeriesPair, start: datetime, days: float) -> SamplingSensitivityReport:
    return sampling_sensitivity_report(mission(pair, start, start + timedelta(days=days)), pair)


# --- representative missions ---------------------------------------------------------------------------------

REPRESENTATIVE = [
    # (site, landing, days): ordinary missions, a long night, and a mission ending exactly at the dataset end
    ("malapert-massif", datetime(2027, 7, 20, tzinfo=UTC), 14),
    ("malapert-massif", datetime(2027, 2, 5, tzinfo=UTC), 14),
    ("connecting-ridge", datetime(2027, 3, 1, tzinfo=UTC), 14),
    ("connecting-ridge", datetime(2028, 5, 10, 13, tzinfo=UTC), 7),
    ("peak-near-shackleton", datetime(2027, 4, 1, tzinfo=UTC), 14),  # inside its 117-day power-dark period
    ("peak-near-shackleton", datetime(2028, 9, 15, 6, tzinfo=UTC), 14),
    ("shackleton-floor", datetime(2027, 6, 1, tzinfo=UTC), 30),
    ("malapert-massif", DATASET_END - timedelta(days=14), 14),
    ("haworth-rim", datetime(2027, 10, 3, tzinfo=UTC), 14),
    ("de-gerlache-rim", datetime(2028, 1, 20, tzinfo=UTC), 14),
]


@pytest.mark.parametrize(("site", "start", "days"), REPRESENTATIVE)
def test_representative_missions_match_independent_derivation(
    raw: dict[str, dict[str, Any]], pairs: dict[str, PolicySeriesPair], site: str, start: datetime, days: int
) -> None:
    pair = pairs[site]
    sc = mission(pair, start, start + timedelta(days=days))
    r = sampling_sensitivity_report(sc, pair)

    check_against_raw(r, raw[site], sc.mission_start_utc, sc.mission_end_utc)
    assert r.baseline.assessment == evaluate_scenario(sc, pair.series)  # canonical result, unchanged
    assert not r.provenance.is_synthetic and r.data_basis is DataBasis.REAL_TERRAIN_AWARE
    assert not any(lim.startswith("[SYNTHETIC") for lim in r.limitations)
    assert r.coverage.adequacy is CoverageAdequacy.COMPLETE
    assert r.verdict is not SensitivityVerdict.INCONCLUSIVE
    # Constraint verdicts follow from the (independently checked) metrics; a change needs the two measurements
    # to sit on opposite sides of the threshold.
    for c in r.constraints:
        if c.status_changed:
            assert {c.baseline_status, c.alternate_status} == {ConstraintStatus.PASS, ConstraintStatus.FAIL}
            assert c.measured.changed


def test_permanently_shadowed_control_is_insensitive(pairs: dict[str, PolicySeriesPair]) -> None:
    # No Sun or Earth transitions at all: every state-derived metric, constraint, margin, score and risk is
    # identical. Only the time-mean Sun elevation (a continuous angle, not a state) moves, because the samples
    # at the mission edges represent half an hour more or less; it feeds no constraint.
    r = report_for(pairs["shackleton-floor"], datetime(2028, 3, 3, 7, tzinfo=UTC), 30)
    assert r.verdict is SensitivityVerdict.UNCHANGED
    assert r.baseline.assessment.eligibility is Eligibility.FAIL
    assert [m.name for m in r.metrics if m.changed] == ["mean_solar_elevation"]
    elevation = metric(r, "mean_solar_elevation")
    assert elevation.delta is not None and 0.0 < abs(elevation.delta) < 0.01  # degrees
    assert not any(m.changed for m in r.margins)
    assert not r.score.changed and not r.risk.overall_changed and r.risk.changed_indicators == []
    assert known_h(metric(r, "longest_continuous_darkness")) == (720.0, 720.0)


# --- discovered real-data verdict changes --------------------------------------------------------------------


MISSION_DAYS = 14
_LIMIT_H = {
    ConstraintId.MAX_CONTINUOUS_DARKNESS: DARK_LIMIT_H,
    ConstraintId.MAX_COMMUNICATION_BLACKOUT: BLACKOUT_LIMIT_H,
    ConstraintId.MIN_INITIAL_SUNLIGHT: INITIAL_SUN_H,
}
_METRIC = {
    ConstraintId.MAX_CONTINUOUS_DARKNESS: "longest_continuous_darkness",
    ConstraintId.MAX_COMMUNICATION_BLACKOUT: "longest_communication_blackout",
    ConstraintId.MIN_INITIAL_SUNLIGHT: "initial_sunlight_duration",
}


def bad_flags(tl: dict[str, Any], constraint: ConstraintId) -> list[bool]:
    if constraint is ConstraintId.MAX_COMMUNICATION_BLACKOUT:
        return [not e for e in tl["earth_visible"]]
    return [not f for f in lit_flags(tl)]


def initial_run_candidates(tl: dict[str, Any], constraint: ConstraintId) -> list[int]:
    """Whole-hour landings whose sample-and-hold initial power-lit run is exactly the 24 h requirement.

    Nearest-sample then gives 23.5 h: sample s represents only [s, s+0.5) and the first dark sample takes over
    half an hour early, so the requirement is met (inclusive) under one policy and missed under the other.
    """
    lit, n, k = [not b for b in bad_flags(tl, constraint)], int(_LIMIT_H[constraint]), MISSION_DAYS * 24
    return [s for s in range(len(lit) - k) if all(lit[s : s + n]) and not lit[s + n]]


def end_clipped_candidates(tl: dict[str, Any], constraint: ConstraintId) -> list[int]:
    """Whole-hour landings whose mission END falls exactly ``limit`` hours into an outage that continues past it.

    Sample-and-hold measures that end-clipped outage as exactly the limit (inclusive PASS); nearest-sample gives
    limit + 0.5 h (FAIL), because the outage starts at the midpoint before its first sample and the outage
    sample at the mission end represents [e-0.5, e).
    """
    bad, n, k = bad_flags(tl, constraint), int(_LIMIT_H[constraint]), MISSION_DAYS * 24
    return [e - k for e in range(k, len(bad)) if not bad[e - n - 1] and all(bad[e - n : e + 1])]


def expected_status(constraint: ConstraintId, hours: float) -> ConstraintStatus:
    limit = _LIMIT_H[constraint]
    ok = hours >= limit if constraint is ConstraintId.MIN_INITIAL_SUNLIGHT else hours <= limit
    return ConstraintStatus.PASS if ok else ConstraintStatus.FAIL


@pytest.mark.parametrize(
    ("finder", "constraint"),
    [
        (initial_run_candidates, ConstraintId.MIN_INITIAL_SUNLIGHT),
        (end_clipped_candidates, ConstraintId.MAX_CONTINUOUS_DARKNESS),
        (end_clipped_candidates, ConstraintId.MAX_COMMUNICATION_BLACKOUT),
    ],
)
def test_discovered_real_data_verdict_changes(
    raw: dict[str, dict[str, Any]],
    pairs: dict[str, PolicySeriesPair],
    finder: Callable[[dict[str, Any], ConstraintId], list[int]],
    constraint: ConstraintId,
) -> None:
    changed: list[tuple[str, datetime]] = []
    candidates = 0
    for site in LIT:
        tl = raw[site]
        for s in finder(tl, constraint):
            candidates += 1
            start = T0 + timedelta(hours=s)
            end = start + timedelta(days=MISSION_DAYS)
            r = sampling_sensitivity_report(mission(pairs[site], start, end), pairs[site])
            check_against_raw(r, tl, start, end)
            c = next(c for c in r.constraints if c.constraint_id is constraint)
            derived = {p: derive(tl, s, s + MISSION_DAYS * 24, p)[_METRIC[constraint]] for p in (SH, NN)}
            assert c.baseline_status is expected_status(constraint, derived[SH])
            assert c.alternate_status is expected_status(constraint, derived[NN]) is ConstraintStatus.FAIL
            if c.baseline_status is ConstraintStatus.FAIL:  # a longer outage elsewhere already fails it
                continue
            assert constraint in r.changed_constraints
            if r.baseline.assessment.eligibility is Eligibility.PASS:
                # Every other check passed under the default policy, so the verdict itself changes.
                assert r.alternate.assessment.eligibility is Eligibility.FAIL
                assert r.verdict is SensitivityVerdict.CHANGED and r.changed_constraints == [constraint]
                assert r.summary.startswith("Verdict changes depending on how the hourly measurements")
                changed.append((site, start))
            else:
                assert r.verdict in (SensitivityVerdict.CONSTRAINTS_CHANGED, SensitivityVerdict.CHANGED)
    assert candidates > 0
    # Genuine PASS -> FAIL cases exist in the committed files (generator 1.2); see docs/member2-part2-sampling.md.
    assert changed, f"no real-data verdict change found for {constraint.value}"


# --- dataset boundary ---------------------------------------------------------------------------------------


def test_dataset_boundary(pairs: dict[str, PolicySeriesPair]) -> None:
    pair = pairs["malapert-massif"]
    # Ends exactly at the final sample: nearest-sample gives that sample [end - 0.5 h, end); coverage complete.
    at_end = report_for(pair, DATASET_END - timedelta(days=14), 14)
    assert at_end.coverage.adequacy is CoverageAdequacy.COMPLETE
    assert at_end.coverage.baseline_uncovered_duration_s == at_end.coverage.alternate_uncovered_duration_s == 0.0

    # One hour past the end: one uncovered hour under both policies (never extrapolated).
    past = sampling_sensitivity_report(
        mission(pair, DATASET_END - timedelta(days=14) + timedelta(hours=1), DATASET_END + timedelta(hours=1)), pair
    )
    assert past.coverage.baseline_uncovered_duration_s == past.coverage.alternate_uncovered_duration_s == 1 * H
    assert past.coverage.adequacy in (CoverageAdequacy.DECISIVE, CoverageAdequacy.INSUFFICIENT)

    # A week past the end (docs §5c example): UNKNOWN for lack of data under both -> inconclusive, not "changed".
    beyond = sampling_sensitivity_report(
        mission(pair, datetime(2028, 12, 25, tzinfo=UTC), datetime(2029, 1, 8, tzinfo=UTC)), pair
    )
    assert beyond.baseline.assessment.eligibility is Eligibility.UNKNOWN
    assert beyond.alternate.assessment.eligibility is Eligibility.UNKNOWN
    assert beyond.verdict is SensitivityVerdict.INCONCLUSIVE
    assert beyond.coverage.adequacy is CoverageAdequacy.INSUFFICIENT
    assert (
        beyond.coverage.baseline_uncovered_duration_s == beyond.coverage.alternate_uncovered_duration_s == 7 * 86400.0
    )
    assert ConstraintId.MAX_CONTINUOUS_DARKNESS in beyond.coverage.data_limited_constraints


def test_weekly_sweep_is_consistent(raw: dict[str, dict[str, Any]], pairs: dict[str, PolicySeriesPair]) -> None:
    """Weekly 14-day landings at the four original sites: every report is internally consistent."""
    for site in ORIGINAL:
        for week in range(0, 104, 1):
            start = T0 + timedelta(days=7 * week)
            end = start + timedelta(days=14)
            if end > DATASET_END:
                break
            r = sampling_sensitivity_report(mission(pairs[site], start, end), pairs[site])
            assert r.coverage.adequacy is CoverageAdequacy.COMPLETE
            assert r.verdict is not SensitivityVerdict.INCONCLUSIVE
            if r.eligibility_changed:
                assert r.changed_constraints
            for c in r.constraints:
                if c.status_changed:
                    assert c.measured.changed
            for name in ("longest_continuous_darkness", "longest_communication_blackout"):
                b, a = known_h(metric(r, name))
                assert abs(a - b) <= 1.0
            if week % 13 == 0:
                check_against_raw(r, raw[site], start, end)
