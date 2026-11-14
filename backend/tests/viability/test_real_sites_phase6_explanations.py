"""Phase 6A explanations on Member 1's real precomputed site files (JPL Horizons + LOLA/Moon Trek).

Each scenario runs through the real ``evaluate_scenario`` and is explained with ``explain_assessment_details``.
Two kinds of check:

* ``assert_consistent`` (shared with ``test_explain_phase6``): the text never contradicts the assessment.
* Independent numbers: the longest power-dark run, the longest Earth blackout and the Earth line-of-sight share
  quoted in the explanations are recomputed from the raw file columns with NumPy (hourly sample-and-hold bins),
  never taken from the engine. Values are not pinned, so a regenerated dataset does not break the test.

The four original sites are Connecting Ridge, Malapert Massif, Peak Near Shackleton and the Shackleton floor
(a permanently shadowed control). Files are only read.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from app.viability import evaluate_scenario
from app.viability.adapters import load_site_file
from app.viability.enums import (
    CommunicationMode,
    ConstraintId,
    ConstraintStatus,
    Eligibility,
    ExplanationCategory,
    PowerSource,
    RiskLevel,
    ScoreStatus,
    Severity,
    UnknownReason,
)
from app.viability.explain import ExplanationDetail, explain_assessment_details
from app.viability.inputs import ScientificTimeSeries
from app.viability.mission import MissionRequirements, MissionScenario, SpacecraftConfiguration
from app.viability.outputs import ViabilityAssessment
from app.viability.risk import SYNTHETIC_PREFIX

from .test_explain_phase6 import assert_consistent

SITES_DIR = Path(__file__).resolve().parents[3] / "data" / "sites"
SITES = ("connecting-ridge", "malapert-massif", "peak-near-shackleton", "shackleton-floor")
T0 = datetime(2027, 1, 1, tzinfo=UTC)
H = 3600.0
DARK_LIMIT_H, BLACKOUT_LIMIT_H, THRESHOLD = 50.0, 96.0, 0.25
REQUIREMENTS: dict[str, Any] = {
    "min_mean_solar_disk_fraction": 0.5,
    "min_earth_visibility_percent": 40.0,
    "min_initial_sunlight_s": 24 * H,
    "min_initial_earth_visibility_s": 12 * H,
    "min_sunlight_percent": 50.0,
}


@pytest.fixture(scope="module")
def raw() -> dict[str, dict[str, Any]]:
    return {s: json.loads((SITES_DIR / f"{s}.json").read_text(encoding="utf-8"))["timeline"] for s in SITES}


@pytest.fixture(scope="module")
def series() -> dict[str, ScientificTimeSeries]:
    return {s: load_site_file(SITES_DIR / f"{s}.json") for s in SITES}


def assess(s: ScientificTimeSeries, start: datetime, days: int, **extra: Any) -> ViabilityAssessment:
    scenario = MissionScenario(
        scenario_id="real-phase6-explain",
        site=s.site,
        mission_start_utc=start,
        mission_end_utc=start + timedelta(days=days),
        spacecraft=SpacecraftConfiguration(
            name="Solar DTE lander",
            power_source=PowerSource.SOLAR,
            communication_mode=CommunicationMode.DIRECT_TO_EARTH,
            max_continuous_darkness_s=DARK_LIMIT_H * H,
            max_communication_blackout_s=BLACKOUT_LIMIT_H * H,
            solar_power_min_disk_fraction=THRESHOLD,
        ),
        requirements=MissionRequirements(**{**REQUIREMENTS, **extra}),
    )
    return evaluate_scenario(scenario, s)


def explained(a: ViabilityAssessment) -> dict[str, ExplanationDetail]:
    items = explain_assessment_details(a)
    assert_consistent(a, items)
    return {d.key: d for d in items}


def text(items: dict[str, ExplanationDetail], key: str) -> str:
    return items[key].explanation.message


def _longest_false(mask: np.ndarray) -> int:
    best = cur = 0
    for x in mask:
        cur = 0 if x else cur + 1
        best = max(best, cur)
    return best


def independent(tl: dict[str, Any], first: int, n: int) -> tuple[float, float, float]:
    """(longest power-dark h, longest Earth blackout h, Earth line-of-sight %) for hourly bins [first, first+n)."""
    sl = slice(first, first + n)
    frac = np.asarray(tl["sun_visible_fraction"][sl], dtype=float)
    sun = np.asarray(tl["sun_visible"][sl], dtype=bool)
    earth = np.asarray(tl["earth_visible"][sl], dtype=bool)
    lit = sun & (frac > 0.0) & (frac >= THRESHOLD)
    return float(_longest_false(lit)), float(_longest_false(earth)), float(earth.mean() * 100.0)


# --- sweep: every site, landing dates across the two-year coverage -------------------------------------------


@pytest.mark.parametrize("site", SITES)
@pytest.mark.parametrize("day", [0, 35, 61, 100, 200, 333, 450, 512, 700])
def test_explanations_quote_independently_computed_values(
    site: str, day: int, raw: dict[str, dict[str, Any]], series: dict[str, ScientificTimeSeries]
) -> None:
    a = assess(series[site], T0 + timedelta(days=day), 14)
    items = explained(a)
    dark_h, blackout_h, earth_pct = independent(raw[site], day * 24, 14 * 24)

    dark = text(items, "constraint.max_continuous_darkness")
    assert f"Longest continuous power-dark period: {dark_h:.6g} h; required at most 50 h" in dark
    assert (": PASS" in dark) is (dark_h <= DARK_LIMIT_H)
    blackout = text(items, "constraint.max_communication_blackout")
    assert f"Longest Earth line-of-sight blackout: {blackout_h:.6g} h; required at most 96 h" in blackout
    assert (": PASS" in blackout) is (blackout_h <= BLACKOUT_LIMIT_H)
    earth = text(items, "constraint.min_earth_visibility_percent")
    assert f"Share of mission time with Earth line of sight: {earth_pct:.6g} %" in earth

    # Real NASA-derived, terrain-aware, fully covered: labelled as such, nothing synthetic.
    assert all(not d.explanation.message.startswith(SYNTHETIC_PREFIX) for d in items.values())
    assert "data.synthetic" not in items and "data.geometric_only" not in items
    provenance = text(items, "data.provenance")
    assert a.data_quality.dataset_id in provenance and "generator_version" in provenance
    assert "known for the whole 336 h evaluated range" in text(items, "data.coverage")
    assert a.eligibility is not Eligibility.UNKNOWN


# --- documented scenarios (docs §5c / §5d tables) -----------------------------------------------------------


def test_malapert_lit_season_pass(series: dict[str, ScientificTimeSeries]) -> None:
    a = assess(series["malapert-massif"], datetime(2027, 7, 20, tzinfo=UTC), 14)
    assert a.eligibility is Eligibility.PASS and a.score.status is ScoreStatus.KNOWN
    items = explained(a)
    assert "Eligibility PASS: all 7 configured hard constraint(s) are met." in text(items, "summary.eligibility")
    assert all(d.explanation.severity is not Severity.CRITICAL for d in items.values())
    assert "It is rank-eligible because eligibility is PASS." in text(items, "summary.score")
    assert "Landing power-lit (screening risk LOW)" in text(items, "risk.landing_in_darkness")


def test_peak_near_shackleton_night_landing(series: dict[str, ScientificTimeSeries]) -> None:
    a = assess(series["peak-near-shackleton"], datetime(2027, 4, 1, tzinfo=UTC), 14)
    assert a.eligibility is Eligibility.FAIL
    items = explained(a)
    assert "spanning the whole mission" in text(items, "constraint.max_continuous_darkness")
    landing = text(items, "risk.landing_in_darkness")
    assert "(screening risk HIGH)" in landing and "for the whole mission" in landing
    assert "Mission starts power-dark for the whole mission." in text(items, "constraint.min_initial_sunlight")
    assert "Descriptive only" in text(items, "summary.score")


def test_shackleton_floor_control_fails_everything(series: dict[str, ScientificTimeSeries]) -> None:
    a = assess(series["shackleton-floor"], datetime(2027, 1, 1, tzinfo=UTC), 30)
    assert a.eligibility is Eligibility.FAIL and a.overall_risk is RiskLevel.HIGH
    items = explained(a)
    assert "7 of 7 configured hard constraint(s) are violated" in text(items, "summary.eligibility")
    cons = [d for d in items.values() if d.explanation.category is ExplanationCategory.CONSTRAINT]
    assert len(cons) == 7 and all(": FAIL" in d.explanation.message for d in cons)
    assert "exceeds the limit by 670 h" in text(items, "constraint.max_continuous_darkness")


def test_connecting_ridge_blackout_in_progress_at_landing(series: dict[str, ScientificTimeSeries]) -> None:
    a = assess(series["connecting-ridge"], datetime(2027, 1, 1, tzinfo=UTC), 14)
    assert a.eligibility is Eligibility.FAIL
    items = explained(a)
    blackout = text(items, "constraint.max_communication_blackout")
    assert ": FAIL" in blackout and "already in progress at landing (measured from landing only)" in blackout
    assert "Landing without Earth line of sight (screening risk" in text(items, "risk.landing_without_earth_visibility")
    darkness = a.constraints[0]
    assert darkness.constraint_id is ConstraintId.MAX_CONTINUOUS_DARKNESS and darkness.status is ConstraintStatus.PASS
    # A passing darkness limit can still carry a non-LOW headroom risk; the text keeps both facts.
    margin = text(items, "margin.max_continuous_darkness")
    level = next(r.level for r in a.risks if r.code == "darkness_exposure")
    assert f"Screening risk {level.value.upper()}" in margin and "negative margin" not in margin


def test_malapert_past_dataset_end_is_unknown_not_failed(series: dict[str, ScientificTimeSeries]) -> None:
    a = assess(series["malapert-massif"], datetime(2028, 12, 25, tzinfo=UTC), 14)
    assert a.eligibility is Eligibility.UNKNOWN
    items = explained(a)
    summary = text(items, "summary.eligibility")
    assert "maximum power-darkness and maximum Earth line-of-sight blackout (incomplete data)" in summary
    assert "unknown for 168 h of the 336 h mission" in text(items, "constraint.max_continuous_darkness")
    coverage = items["data.coverage"]
    assert coverage.explanation.severity is Severity.WARNING
    assert "168 h in 1 interval(s) has no sample" in coverage.explanation.message
    assert "Not scored: eligibility is UNKNOWN" in text(items, "summary.score")
    assert "data.warnings" in items


def test_connecting_ridge_without_any_data(series: dict[str, ScientificTimeSeries]) -> None:
    a = assess(series["connecting-ridge"], datetime(2029, 2, 1, tzinfo=UTC), 14)
    assert a.eligibility is Eligibility.UNKNOWN
    items = explained(a)
    assert all(c.unknown_reason is UnknownReason.NO_DATA for c in a.constraints if c.status is ConstraintStatus.UNKNOWN)
    assert "(no data)" in text(items, "summary.eligibility")
    assert "No sample represents any part of it" in text(items, "data.coverage")
    for d in items.values():
        if d.explanation.category is ExplanationCategory.MARGIN:
            assert "physically possible range, not from observations" in d.explanation.message


def test_malapert_unsupported_clearance(series: dict[str, ScientificTimeSeries]) -> None:
    a = assess(series["malapert-massif"], datetime(2027, 1, 1, tzinfo=UTC), 14, min_earth_clearance_deg=2.0)
    assert a.eligibility is Eligibility.UNKNOWN
    items = explained(a)
    item = items["constraint.min_earth_clearance"]
    assert "UNKNOWN, not evaluated" in item.explanation.message
    assert item.risk_codes == ["unsupported_requirement.min_earth_clearance"]
    assert "margin.min_earth_clearance" not in items
    # Every other configured requirement is still explained as decided.
    others = [c for c in a.constraints if c.status is ConstraintStatus.PASS]
    assert len(others) == 7 and all(": PASS" in text(items, f"constraint.{c.constraint_id.value}") for c in others)


def test_explanations_are_deterministic_on_real_data(series: dict[str, ScientificTimeSeries]) -> None:
    a = assess(series["malapert-massif"], datetime(2027, 2, 5, tzinfo=UTC), 14)
    b = assess(series["malapert-massif"], datetime(2027, 2, 5, tzinfo=UTC), 14)
    assert explain_assessment_details(a) == explain_assessment_details(b)
    numbers = re.findall(r"\d+(?:\.\d+)? h", text(explained(a), "constraint.max_continuous_darkness"))
    assert numbers  # specific values, not generic text
