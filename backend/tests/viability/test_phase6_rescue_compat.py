"""Phase 6B: the canonical engine behind rescue's ``evaluate_timeline`` contract (no mocks).

Every test here runs the REAL ``evaluate_scenario`` through ``app.viability.compat.rescue`` on
rescue ``Timeline`` objects. Timelines are either rescue's own synthetic provider or small crafted
ones; both carry ``source="synthetic-placeholder"`` because they are synthetic test data. Results
are compared with rescue's placeholder evaluator on the same timelines where the two must agree,
and the documented differences are pinned where they must not.

Real NASA-derived data (the four original site files, whole-Moon sites, rescue's search) is in
``test_real_sites_phase6_compat.py``.
"""

from __future__ import annotations

import json
import math
from datetime import UTC, datetime, timedelta
from typing import Any, TypeVar

import numpy as np
import pytest

from app.timegrid import snap_duration_days
from pydantic import BaseModel

from app.models import MissionRequirements as RescueRequirements
from app.models import Scenario, Site, ViabilityResult
from app.rescue.catalog import custom_site, get_site
from app.rescue.engine import Candidate, Evaluator
from app.rescue.loosen import fixable_by_relaxing, requirement_changes
from app.rescue.timeline import SyntheticTimelineProvider, Timeline
from app.rescue.viability import CHECKS
from app.rescue.viability.placeholder import evaluate_timeline as placeholder_evaluate
from app.viability.adapters.site_file import normalize_longitude_deg
from app.viability.compat.rescue import (
    CONSTRAINT_TO_RESCUE,
    RescueCompatError,
    assessment_to_result,
    evaluate_timeline,
    evaluate_timeline_detailed,
    make_evaluate_fn,
    rescue_longitude,
    scenario_to_mission,
    timeline_to_series,
)
from app.viability.engine import evaluate_scenario
from app.viability.enums import (
    ConstraintId,
    ConstraintStatus,
    DataBasis,
    Eligibility,
    MetricStatus,
    ScoreStatus,
    UnknownReason,
)
from app.viability.outputs import ViabilityAssessment

H = 3600.0
T0 = datetime(2027, 7, 20, tzinfo=UTC)
SYNTHETIC = "synthetic-placeholder"
METRIC_FIELDS = (
    "sunlight_fraction",
    "equivalent_sun_hours",
    "longest_dark_gap_hours",
    "earth_visibility_fraction",
    "longest_comms_gap_hours",
    "initial_sun_hours",
    "initial_comms_hours",
    "hours_to_first_sunset",
    "hours_to_first_earthset",
    "mean_sun_clearance_deg",
    "mean_earth_clearance_deg",
    "mean_solar_elevation_deg",
)
RESCUE_ORDER = [c[0] for c in CHECKS]
LOOSE = {  # every requirement trivially met unless a test sets it
    "min_sunlight_fraction": 0.0,
    "battery_hours": 10_000.0,
    "min_earth_visibility_fraction": 0.0,
    "max_comms_gap_hours": 10_000.0,
    "min_initial_sun_hours": 0.0,
    "min_initial_comms_hours": 0.0,
}
M = TypeVar("M", bound=BaseModel)


def make(model: type[M], **fields: Any) -> M:
    """Build a shared/rescue pydantic model with its defaults (typed for mypy without the pydantic plugin)."""
    return model.model_validate(fields)


# --- crafted rescue timelines ---------------------------------------------------------------
#
# Sun codes per hour:   L = whole disk up (el 5, horizon 0, fraction 1)   D = dark (el -5, fraction 0)
#                       P = partial disk (el 0 = horizon, fraction from `fractions`)   ? = unknown terrain
# Earth codes per hour: V = visible (margin +5)   B = blocked (margin -5)
#                       ? = unknown terrain (horizon NaN; rescue stores earth_visible=False there)


def crafted(
    sun: str,
    earth: str | None = None,
    *,
    fractions: dict[int, float] | None = None,
    site: Site | None = None,
    start: datetime = T0,
    keep: list[int] | None = None,
) -> Timeline:
    n = len(sun)
    earth = earth if earth is not None else "V" * n
    assert len(earth) == n
    fractions = fractions or {}
    sun_el, sun_hz, frac = np.zeros(n), np.zeros(n), np.zeros(n)
    earth_el, earth_hz, earth_vis = np.zeros(n), np.zeros(n), np.zeros(n, dtype=bool)
    for i, c in enumerate(sun):
        if c == "L":
            sun_el[i], frac[i] = 5.0, 1.0
        elif c == "D":
            sun_el[i], frac[i] = -5.0, 0.0
        elif c == "P":
            sun_el[i], frac[i] = 0.0, fractions[i]
        else:
            assert c == "?"
            sun_hz[i], frac[i] = math.nan, math.nan
    for i, c in enumerate(earth):
        if c == "V":
            earth_el[i], earth_vis[i] = 5.0, True
        elif c == "B":
            earth_el[i] = -5.0
        else:
            assert c == "?"
            earth_el[i], earth_hz[i] = 5.0, math.nan  # earth_visible stays False, as rescue stores it
    times = (np.datetime64(start.replace(tzinfo=None), "s") + np.arange(n) * np.timedelta64(3600, "s")).astype(
        "datetime64[s]"
    )
    idx = np.arange(n) if keep is None else np.asarray(keep)
    return Timeline(
        site=site or get_site("malapert-massif").to_site(),
        times=times[idx],
        step_hours=1.0,
        sun_az=np.full(n, 180.0)[idx],
        sun_el=sun_el[idx],
        sun_horizon=sun_hz[idx],
        sun_visible_fraction=frac[idx],
        earth_az=np.zeros(n)[idx],
        earth_el=earth_el[idx],
        earth_horizon=earth_hz[idx],
        earth_visible=earth_vis[idx],
        source=SYNTHETIC,
    )


def scenario_for(hours: float, *, site: Site | None = None, start: datetime = T0, **req: Any) -> Scenario:
    return make(
        Scenario,
        site=site or get_site("malapert-massif").to_site(),
        landing_utc=start,
        duration_days=hours / 24.0,
        requirements=make(RescueRequirements, **{**LOOSE, **req}),
    )


def run(sun: str, earth: str | None = None, **req: Any) -> tuple[ViabilityResult, ViabilityAssessment]:
    return evaluate_timeline_detailed(scenario_for(len(sun), **req), crafted(sun, earth))


def statuses(result: ViabilityResult) -> dict[str, str]:
    """Rescue requirement field -> pass / fail / unknown, read from the rescue-facing result."""
    out = {f: "pass" for f in RESCUE_ORDER}
    for v in result.violations:
        out[v.constraint] = "unknown" if v.is_unknown else "fail"
    return out


def rescue_slice(provider: SyntheticTimelineProvider, sc: Scenario) -> Timeline:
    """Exactly what ``Evaluator.evaluate_many`` passes for one landing (rescue's documented layout)."""
    n = max(1, round(sc.duration_days * 24))
    tl = provider.timeline(sc.site, sc.landing_utc, sc.landing_utc + timedelta(hours=n - 1), 1.0)
    return tl.slice(0, n)


# --- 4. PASS / FAIL / UNKNOWN consistency -----------------------------------------------------


@pytest.mark.parametrize(
    ("sun", "earth", "req", "expected"),
    [
        ("L" * 48, None, {"min_initial_sun_hours": 24, "min_sunlight_fraction": 0.5}, "pass"),
        ("D" * 48, None, {"min_initial_sun_hours": 24, "min_sunlight_fraction": 0.5}, "fail"),
        ("?" * 10 + "L" * 38, None, {"min_initial_sun_hours": 24, "min_sunlight_fraction": 0.5}, "unknown"),
    ],
    ids=["pass", "fail", "unknown"],
)
def test_canonical_eligibility_maps_exactly(sun: str, earth: str | None, req: dict[str, Any], expected: str) -> None:
    result, assessment = run(sun, earth, **req)
    assert assessment.eligibility.value == expected
    assert result.eligibility == expected and result.verdict == expected
    assert result.passes is (expected == "pass")  # legacy flag: True only for a canonical PASS
    assert result.passes == (not result.violations)
    assert result.score == assessment.score.score  # exact score or None, never a bound
    if expected == "unknown":
        assert result.score is None and assessment.score.status is ScoreStatus.ELIGIBILITY_UNKNOWN
        assert result.violations and all(v.is_unknown for v in result.violations)
        assert all(v.message.startswith("UNKNOWN") for v in result.violations)
    else:
        assert result.score is not None and 0.0 <= result.score <= 100.0  # FAIL keeps a descriptive score
        assert not any(v.is_unknown for v in result.violations)
    old = placeholder_evaluate(scenario_for(len(sun), **req), crafted(sun, earth)) if "?" not in sun else None
    if old is not None:  # fully known: the placeholder reaches the same verdict
        assert old.verdict == expected


def test_fail_with_unknown_keeps_both_flags_and_gets_no_loosening() -> None:
    # Earth blocked throughout (decided failures); Sun unknown at landing (undecidable initial sunlight).
    sc = scenario_for(48, min_earth_visibility_fraction=0.4, min_initial_comms_hours=12, min_initial_sun_hours=24)
    result, assessment = evaluate_timeline_detailed(sc, crafted("?" * 10 + "L" * 38, "B" * 48))
    assert assessment.eligibility is Eligibility.FAIL and result.eligibility == "fail"
    assert statuses(result) == {
        **dict.fromkeys(RESCUE_ORDER, "pass"),
        "min_earth_visibility_fraction": "fail",
        "min_initial_comms_hours": "fail",
        "min_initial_sun_hours": "unknown",
    }
    # Rescue's own rule: a result that fails partly for lack of data gets no "relax this" advice.
    assert not fixable_by_relaxing(Candidate(sc, result, 0.0, 0.0, "unchanged", True))


def test_unknown_never_yields_loosening_advice() -> None:
    sc = scenario_for(48, min_initial_sun_hours=24)
    result = evaluate_timeline(sc, crafted("?" * 10 + "L" * 38))
    assert result.eligibility == "unknown"
    assert not fixable_by_relaxing(Candidate(sc, result, 0.0, 0.0, "unchanged", True))


def _random_case(rng: np.random.Generator) -> tuple[str, str, dict[str, Any]]:
    n = int(rng.integers(24, 121))

    def blocks(alphabet: str, p_unknown: float) -> str:
        out = ""
        while len(out) < n:
            c = "?" if rng.random() < p_unknown else alphabet[int(rng.integers(len(alphabet)))]
            out += c * int(rng.integers(1, 30))
        return out[:n]

    req = {
        "min_sunlight_fraction": float(rng.choice([0.0, 0.3, 0.5, 0.8])),
        "battery_hours": float(rng.integers(5, 80)),
        "min_earth_visibility_fraction": float(rng.choice([0.0, 0.3, 0.5, 0.9])),
        "max_comms_gap_hours": float(rng.integers(5, 80)),
        "min_initial_sun_hours": float(rng.integers(0, 40)),
        "min_initial_comms_hours": float(rng.integers(0, 40)),
    }
    return blocks("LD", 0.3), blocks("VB", 0.3), req


@pytest.mark.parametrize("seed", range(40))
def test_unknown_data_never_creates_a_confirmed_result(seed: int) -> None:
    """Soundness on random crafted missions with unknown terrain blocks.

    The two extreme completions of the unknown samples (all lit + visible / all dark + blocked)
    bracket every possible truth for these monotone checks. A confirmed FAIL must fail in BOTH, a
    PASS must pass in BOTH, and an UNKNOWN must be genuinely undecided (one passes, one fails).
    Bounded scores must contain the scores of both completions.
    """
    sun, earth, req = _random_case(np.random.default_rng(seed))
    sc = scenario_for(len(sun), **req)
    result, assessment = evaluate_timeline_detailed(sc, crafted(sun, earth))
    best_r, best_a = evaluate_timeline_detailed(sc, crafted(sun.replace("?", "L"), earth.replace("?", "V")))
    worst_r, worst_a = evaluate_timeline_detailed(sc, crafted(sun.replace("?", "D"), earth.replace("?", "B")))
    mine, best, worst = statuses(result), statuses(best_r), statuses(worst_r)
    assert "unknown" not in best.values() and "unknown" not in worst.values()
    for field, status in mine.items():
        if status == "fail":
            assert best[field] == worst[field] == "fail", field
        elif status == "pass":
            assert best[field] == worst[field] == "pass", field
        else:
            assert (best[field], worst[field]) == ("pass", "fail"), field
    if result.eligibility in ("pass", "fail"):
        assert best_r.eligibility == worst_r.eligibility == result.eligibility
    bounds = assessment.score.score_bounds
    if assessment.score.status is ScoreStatus.BOUNDED:
        assert result.score is None and bounds is not None
        assert bounds.lower is not None and bounds.upper is not None
        for other in (best_a, worst_a):
            assert other.score.score is not None
            assert bounds.lower <= other.score.score <= bounds.upper


# --- missing and uncertain scores --------------------------------------------------------------


def test_bounded_pass_score_is_none_never_the_lower_bound() -> None:
    result, assessment = run("L" * 20 + "??" + "L" * 26, min_sunlight_fraction=0.5, battery_hours=50)
    assert result.eligibility == "pass" and result.passes
    assert assessment.score.status is ScoreStatus.BOUNDED
    bounds = assessment.score.score_bounds
    assert bounds is not None and bounds.status is MetricStatus.BOUNDED
    assert result.score is None  # the shared contract has no interval field; nothing is approximated
    # Contract limitation (docs/interfaces.md: "Don't show null as 0"): rescue's ranking helper reads 0.
    assert result.score_or_zero == 0.0
    assert bounds.lower is not None and bounds.lower > 0.0


def test_known_score_passes_through_unrounded() -> None:
    result, assessment = run("L" * 30 + "D" * 18, battery_hours=50)
    assert assessment.score.status is ScoreStatus.KNOWN
    assert result.score == assessment.score.score


# --- partial sunlight, panel threshold, inclusive boundaries ------------------------------------


@pytest.mark.parametrize("threshold", [0.0, 0.25, 0.5, 0.999999, 1.0])
def test_partial_sunlight_and_panel_threshold_match_placeholder(threshold: float) -> None:
    """Threshold 0: a zero fraction is never lit. A fraction equal to the threshold is lit (inclusive)."""
    sun = "D" * 6 + "P" * 6 + "L" * 10 + "P" * 6 + "D" * 8 + "P" * 4 + "L" * 8
    partial = [i for i, c in enumerate(sun) if c == "P"]
    values = [0.000001, 0.1, 0.25, 0.5, 0.999999, 0.75]
    fractions = {i: values[k % len(values)] for k, i in enumerate(partial)}
    tl = crafted(sun, fractions=fractions)
    sc = scenario_for(len(sun), panel_threshold=threshold, battery_hours=12, min_initial_sun_hours=1)
    new, old = evaluate_timeline(sc, tl), placeholder_evaluate(sc, tl)
    for field in METRIC_FIELDS:
        a, b = getattr(old.metrics, field), getattr(new.metrics, field)
        assert (a is None) == (b is None), field
        if a is not None:
            assert b == pytest.approx(a, rel=1e-12, abs=1e-12), field
    assert new.verdict == old.verdict
    assert [v.constraint for v in new.violations] == [v.constraint for v in old.violations]


def test_threshold_zero_counts_no_dark_hour_as_lit() -> None:
    result, _ = run("D" * 30 + "L" * 18, panel_threshold=0.0, battery_hours=29.0)
    assert result.metrics.longest_dark_gap_hours == 30.0
    assert statuses(result)["battery_hours"] == "fail"


def test_requirements_exactly_met_pass_and_one_hour_stricter_fails() -> None:
    sun = "L" * 10 + "D" * 30 + "L" * 20
    earth = "V" * 12 + "B" * 20 + "V" * 28
    exact: dict[str, Any] = {
        "battery_hours": 30.0,
        "max_comms_gap_hours": 20.0,
        "min_initial_sun_hours": 10.0,
        "min_initial_comms_hours": 12.0,
    }
    for engine in (evaluate_timeline, placeholder_evaluate):
        assert engine(scenario_for(60, **exact), crafted(sun, earth)).verdict == "pass"
        for field, value in exact.items():
            stricter = value - 1.0 if field in ("battery_hours", "max_comms_gap_hours") else value + 1.0
            r = engine(scenario_for(60, **{**exact, field: stricter}), crafted(sun, earth))
            assert [v.constraint for v in r.violations] == [field], (engine, field)


def test_fraction_equality_tolerance_differs_from_placeholder() -> None:
    """Documented difference (docs section 5c): canonical equality is relative 1e-12; the placeholder
    ignores shortfalls up to 1e-9 absolute. Only a requirement within 1e-9 of the measured mean can
    differ; rescue's own suggestions are whole percents, so they never land in that band."""
    tl = crafted("L" * 30 + "D" * 18)
    exact = 30 / 48
    for required, canonical, placeholder in [(exact, "pass", "pass"), (exact + 5e-10, "fail", "pass")]:
        sc = scenario_for(48, min_sunlight_fraction=required)
        assert evaluate_timeline(sc, tl).verdict == canonical
        assert placeholder_evaluate(sc, tl).verdict == placeholder


# --- unknown never folded into darkness / blackout ----------------------------------------------


def test_unknown_earth_is_not_a_confirmed_blackout() -> None:
    """Documented difference (docs section 5a item 5): rescue stores unknown Earth as earth_visible=False.
    The placeholder counts that as a 60 h blackout and fails; the canonical result is UNKNOWN."""
    sun, earth = "L" * 96, "V" * 18 + "?" * 60 + "V" * 18
    sc = scenario_for(96, max_comms_gap_hours=48)
    new, old = evaluate_timeline(sc, crafted(sun, earth)), placeholder_evaluate(sc, crafted(sun, earth))
    assert new.eligibility == "unknown" and new.score is None
    assert [(v.constraint, v.is_unknown) for v in new.violations] == [("max_comms_gap_hours", True)]
    assert old.verdict == "fail" and not old.violations[0].is_unknown  # why the swap matters


def test_failure_proven_despite_unknown_hours_relaxes_to_a_sound_value() -> None:
    """A FAIL decided from bounds reports the unfavourable bound as ``actual``. Rescue's loosening
    relaxes to that value, which makes the scenario pass for every possible truth."""
    sun = "L" * 10 + "D" * 60 + "?" * 5 + "L" * 21
    sc = scenario_for(96, battery_hours=50)
    result, assessment = evaluate_timeline_detailed(sc, crafted(sun))
    (violation,) = result.violations
    assert violation.constraint == "battery_hours" and not violation.is_unknown
    darkness = assessment.metrics.longest_continuous_darkness
    assert darkness.status is MetricStatus.BOUNDED and (darkness.lower, darkness.upper) == (60 * H, 65 * H)
    assert violation.actual == 65.0
    cand = Candidate(sc, result, 0.0, 0.0, "unchanged", True)
    assert fixable_by_relaxing(cand)
    (change,) = requirement_changes(cand)
    relaxed = sc.model_copy(
        update={"requirements": sc.requirements.model_copy(update={"battery_hours": change.suggested})}
    )
    assert evaluate_timeline(relaxed, crafted(sun)).verdict == "pass"
    lower = sc.model_copy(update={"requirements": sc.requirements.model_copy(update={"battery_hours": 60.0})})
    assert evaluate_timeline(lower, crafted(sun)).verdict == "unknown"  # the lower bound would not be enough


def test_missing_sun_terrain_is_unknown_not_dark() -> None:
    result, assessment = run("L" * 20 + "?" * 10 + "L" * 18, battery_hours=5, min_initial_sun_hours=24)
    assert assessment.data_quality.sun_unknown_duration_s == 10 * H
    assert statuses(result)["battery_hours"] == "unknown"  # 10 unknown hours could be dark: undecided
    assert statuses(result)["min_initial_sun_hours"] == "unknown"


def test_sampling_gap_is_uncovered_time_not_darkness_or_light() -> None:
    """Documented difference: the placeholder treats the remaining samples as contiguous."""
    keep = [i for i in range(72) if not 30 <= i < 33]
    tl = crafted("L" * 72, keep=keep)
    sc = scenario_for(72, battery_hours=2)
    result, assessment = evaluate_timeline_detailed(sc, tl)
    dq = assessment.data_quality
    assert dq.uncovered_duration_s == 3 * H and dq.coverage_gap_count == 1
    assert assessment.metrics.longest_continuous_darkness.upper == 3 * H
    assert statuses(result)["battery_hours"] == "unknown"  # 3 uncovered hours vs a 2 h battery
    old = placeholder_evaluate(sc, tl)
    assert old.verdict == "pass" and old.metrics.equivalent_sun_hours == 69.0  # gap silently dropped


# --- coordinates, durations and the final bin ---------------------------------------------------


@pytest.mark.parametrize("lon", [-180.0, -0.0, 0.0, 45.5, 179.999, 180.0, 180.0001, 221.98, 359.999999])
def test_longitude_matches_site_file_adapter_on_its_domain(lon: float) -> None:
    assert rescue_longitude(lon) == normalize_longitude_deg(lon)


@pytest.mark.parametrize(("lon", "expected"), [(360.0, 0.0), (-190.0, 170.0), (540.0, 180.0), (-540.0, 180.0)])
def test_longitude_outside_adapter_domain_wraps_to_same_meridian(lon: float, expected: float) -> None:
    assert rescue_longitude(lon) == pytest.approx(expected, abs=1e-12)
    assert -180.0 <= rescue_longitude(lon) <= 180.0


@pytest.mark.parametrize("lon", [math.nan, math.inf, -math.inf])
def test_non_finite_longitude_rejected(lon: float) -> None:
    with pytest.raises(RescueCompatError, match="finite"):
        rescue_longitude(lon)


def test_custom_site_at_lon_360_evaluates() -> None:
    """Bug fixed in 6B: ``custom_site`` stores ``lon % 360`` = 360.0 for a tiny negative longitude."""
    site = custom_site("Prime-meridian point", -89.0, -1e-15)
    assert site.lon == 360.0
    ev = Evaluator(provider=SyntheticTimelineProvider(), evaluate=make_evaluate_fn(), simulation=True)
    result = ev.evaluate(make(Scenario, site=site, landing_utc=T0, duration_days=2))
    assert result.verdict in ("pass", "fail") and result.data_source == SYNTHETIC
    assert scenario_to_mission(make(Scenario, site=site, landing_utc=T0)).site.lon == 0.0


@pytest.mark.parametrize("hours", [0.48, 1.0, 1.44])
def test_missions_shorter_than_two_samples_evaluate(hours: float) -> None:
    """Bug fixed in 6B: rescue passes ONE sample for a mission under 1.5 h (it used to raise). The sample
    represents one step at most; any remainder past that has no sample and stays unknown."""
    provider = SyntheticTimelineProvider()
    sc = make(Scenario, site=get_site("malapert-massif").to_site(), landing_utc=T0, duration_days=hours / 24)
    tl = rescue_slice(provider, sc)
    assert len(tl) == 1
    result, assessment = evaluate_timeline_detailed(sc, tl)
    assert assessment.data_quality.uncovered_duration_s == pytest.approx(max(0.0, hours - 1.0) * H)
    assert assessment.evaluated_duration_s == pytest.approx(hours * H)
    # The Evaluator applies the hourly grid (app.timegrid, main 3cc2355): the length is snapped to whole hours
    # (here 1 h) before the engine runs, so it must equal the compat layer's answer for the snapped mission.
    snapped = sc.model_copy(update={"duration_days": snap_duration_days(sc.duration_days)})
    assert snapped.duration_days * 24 == pytest.approx(1.0)
    expected, _ = evaluate_timeline_detailed(snapped, rescue_slice(provider, snapped))
    got = Evaluator(provider=provider, evaluate=make_evaluate_fn(), simulation=True).evaluate(sc)
    assert got == expected


def test_single_sample_without_a_bin_is_still_rejected() -> None:
    tl = crafted("L" * 3).slice(0, 1)
    with pytest.raises(RescueCompatError, match="at least 2 samples"):
        timeline_to_series(tl)
    with pytest.raises(RescueCompatError, match="at least 2 samples"):
        timeline_to_series(tl, mission_end_utc=T0 + timedelta(hours=2))  # more than one step: not a bin


@pytest.mark.parametrize(("days", "uncovered_h"), [(7.0, 0.0), (7.4, 0.0), (7.3, 0.2), (2.02, 0.48), (0.06, 0.44)])
def test_fractional_durations_cover_the_final_partial_bin_only(days: float, uncovered_h: float) -> None:
    """``round(duration * 24)`` samples: the last sample is held for at most one step (exactly as inside the
    full dataset), capped at mission end; the at most half step beyond that has no sample and stays unknown."""
    sc = make(Scenario, site=get_site("malapert-massif").to_site(), landing_utc=T0, duration_days=days)
    _, assessment = evaluate_timeline_detailed(sc, rescue_slice(SyntheticTimelineProvider(), sc))
    assert assessment.data_quality.uncovered_duration_s == pytest.approx(uncovered_h * H)
    assert assessment.evaluated_duration_s == pytest.approx(days * 86400)


def test_partial_bin_extension_note_and_exact_coverage() -> None:
    tl = crafted("L" * 3)
    end = T0 + timedelta(hours=2, minutes=30)
    s = timeline_to_series(tl, mission_end_utc=end)
    assert s.coverage_end_utc == end
    assert "part of one step" in (s.provenance.notes or "")


# --- unsupported constraints and the rescue field mapping ----------------------------------------


def test_rescue_scenarios_configure_only_the_six_mapped_constraints() -> None:
    _, assessment = run("L" * 48)
    applicable = {c.constraint_id for c in assessment.constraints if c.status is not ConstraintStatus.NOT_APPLICABLE}
    assert applicable == set(CONSTRAINT_TO_RESCUE)
    not_applicable = {c.constraint_id for c in assessment.constraints} - applicable
    assert {
        ConstraintId.MIN_SUNLIGHT_PERCENT,
        ConstraintId.MIN_SIMULTANEOUS_PERCENT,
        ConstraintId.MIN_SUN_CLEARANCE,
        ConstraintId.MIN_EARTH_CLEARANCE,
    } <= not_applicable


def test_unsupported_canonical_constraint_is_never_dropped_silently() -> None:
    """An UNKNOWN (unsupported) constraint with no rescue field would vanish from ``violations`` and could
    turn an UNKNOWN into a PASS; the layer refuses instead. Rescue scenarios cannot configure it."""
    sc = scenario_for(48)
    mission = scenario_to_mission(sc)
    mission = mission.model_copy(
        update={"requirements": mission.requirements.model_copy(update={"min_sun_clearance_deg": 1.0})}
    )
    series = timeline_to_series(crafted("L" * 48), mission_end_utc=mission.mission_end_utc)
    assessment = evaluate_scenario(mission, series)
    clearance = next(c for c in assessment.constraints if c.constraint_id is ConstraintId.MIN_SUN_CLEARANCE)
    assert clearance.status is ConstraintStatus.UNKNOWN and clearance.unknown_reason is UnknownReason.UNSUPPORTED
    assert assessment.eligibility is Eligibility.UNKNOWN
    with pytest.raises(RescueCompatError, match="no rescue requirement field"):
        assessment_to_result(assessment, sc, SYNTHETIC)


def test_violations_follow_rescue_requirement_order() -> None:
    sc = scenario_for(
        48,
        min_sunlight_fraction=0.5,
        battery_hours=10,
        min_earth_visibility_fraction=0.5,
        max_comms_gap_hours=10,
        min_initial_sun_hours=5,
        min_initial_comms_hours=5,
    )
    tl = crafted("D" * 48, "B" * 48)
    new, old = evaluate_timeline(sc, tl), placeholder_evaluate(sc, tl)
    assert [v.constraint for v in new.violations] == RESCUE_ORDER == [v.constraint for v in old.violations]
    for a, b in zip(new.violations, old.violations, strict=True):
        assert (a.required, a.actual, a.unit, a.shortfall) == pytest.approx((b.required, b.actual, b.unit, b.shortfall))


# --- serialization, types, synthetic labelling ---------------------------------------------------


@pytest.mark.parametrize("sun", ["L" * 48, "D" * 48, "?" * 10 + "L" * 38], ids=["pass", "fail", "unknown"])
def test_results_serialize_like_the_placeholder(sun: str) -> None:
    sc = scenario_for(48, min_initial_sun_hours=24, min_sunlight_fraction=0.5)
    result = evaluate_timeline(sc, crafted(sun))
    raw: dict[str, Any] = json.loads(result.model_dump_json())
    assert ViabilityResult.model_validate(raw) == result
    reference: dict[str, Any] = json.loads(placeholder_evaluate(sc, crafted("L" * 48)).model_dump_json())
    assert set(raw) == set(reference) and set(raw["metrics"]) == set(reference["metrics"])
    assert raw["eligibility"] in ("pass", "fail", "unknown")
    assert raw["score"] is None or isinstance(raw["score"], float)
    for v in raw["violations"]:
        assert v["constraint"] in RESCUE_ORDER and v["unit"] in ("h", "fraction")
        assert isinstance(v["is_unknown"], bool) and v["shortfall"] >= 0.0
    for key in ("sunlight_fraction", "longest_dark_gap_hours", "initial_sun_hours"):
        assert isinstance(raw["metrics"][key], float)


def test_explicit_simulation_mode_is_labelled_synthetic_everywhere() -> None:
    sc = make(Scenario, site=get_site("peak-near-shackleton").to_site(), landing_utc=T0)
    ev = Evaluator(provider=SyntheticTimelineProvider(), evaluate=make_evaluate_fn(), simulation=True)
    result = ev.evaluate(sc)
    assert result.data_source == SYNTHETIC and result.source.startswith("viability-engine/")
    _, assessment = evaluate_timeline_detailed(sc, rescue_slice(SyntheticTimelineProvider(), sc))
    assert assessment.data_basis is DataBasis.SYNTHETIC
    assert assessment.data_quality.provenance.is_synthetic is True
    assert any(w.startswith("SYNTHETIC data") for w in assessment.data_quality.warnings)
    assert assessment.score.note is not None and assessment.score.note.startswith("[SYNTHETIC DATA]")
    assert all(r.message.startswith("[SYNTHETIC DATA]") for r in assessment.risks)
