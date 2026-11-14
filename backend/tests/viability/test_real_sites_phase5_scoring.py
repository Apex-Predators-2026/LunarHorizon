"""Phase 5A scoring on Member 1's real precomputed site files (JPL Horizons + LOLA/Moon Trek).

Expected scores are derived INDEPENDENTLY from the raw file columns with NumPy (hourly
sample-and-hold bins: mean visible solar-disk fraction, Earth-visible share, longest power-dark and
longest Earth-blackout runs) and the documented formula (docs §5e), never from the engine's own
metrics. The engine path under test is the real pipeline: ``assess_constraints`` (Phase 2/3),
``margins_from_assessment`` (Phase 4A), then ``score_scenario``. The files are only read.

The score is a relative illumination / line-of-sight index, not a power, link or safety estimate.
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from app.viability import prepare_series
from app.viability.adapters import load_site_file
from app.viability.constraints import assess_constraints
from app.viability.enums import (
    CommunicationMode,
    DataBasis,
    Eligibility,
    PowerSource,
    ScoreComponent,
    ScoreStatus,
)
from app.viability.margins import margins_from_assessment
from app.viability.mission import MissionRequirements, MissionScenario, RankingPreferences, SpacecraftConfiguration
from app.viability.outputs import ScoreBreakdown
from app.viability.scoring import score_scenario
from app.viability.windows import PreparedSeries

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
def prepared() -> dict[str, PreparedSeries]:
    return {s: prepare_series(load_site_file(SITES_DIR / f"{s}.json")) for s in SITES}


def mission(p: PreparedSeries, start: datetime, days: int, **prefs: float) -> MissionScenario:
    return MissionScenario(
        scenario_id="real-phase5-score",
        site=p.series.site,
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
        requirements=MissionRequirements(**REQUIREMENTS),
        preferences=RankingPreferences(**prefs) if prefs else RankingPreferences(),
    )


def run(p: PreparedSeries, start: datetime, days: int, **prefs: float) -> tuple[Eligibility, ScoreBreakdown]:
    sc = mission(p, start, days, **prefs)
    a = assess_constraints(sc, p)
    b = score_scenario(
        sc,
        a.environment.metrics,
        margins_from_assessment(a),
        a.eligibility,
        data_basis=a.environment.data_quality.data_basis,
    )
    return a.eligibility, b


def _longest_false(mask: np.ndarray) -> int:
    best = cur = 0
    for x in mask:
        cur = 0 if x else cur + 1
        best = max(best, cur)
    return best


def clamp(x: float) -> float:
    return min(1.0, max(0.0, x))


def expected_components(tl: dict[str, Any], first: int, n: int) -> dict[ScoreComponent, float]:
    """Independent component values for hourly bins [first, first + n)."""
    sl = slice(first, first + n)
    frac = np.asarray(tl["sun_visible_fraction"][sl], dtype=float)
    sun = np.asarray(tl["sun_visible"][sl], dtype=bool)
    earth = np.asarray(tl["earth_visible"][sl], dtype=bool)
    lit = sun & (frac >= THRESHOLD)
    dark = _longest_false(lit) * H
    blackout = _longest_false(earth) * H
    return {
        ScoreComponent.SUNLIGHT: float(frac.mean()),
        ScoreComponent.EARTH_VISIBILITY: float(earth.mean()),
        ScoreComponent.DARKNESS_MARGIN: clamp((DARK_LIMIT_H * H - dark) / (DARK_LIMIT_H * H)),
        ScoreComponent.BLACKOUT_MARGIN: clamp((BLACKOUT_LIMIT_H * H - blackout) / (BLACKOUT_LIMIT_H * H)),
    }


def expected_score(values: dict[ScoreComponent, float]) -> float:
    return 100.0 * sum(values.values()) / len(values)  # four equally weighted active components


@pytest.mark.parametrize("site", SITES)
@pytest.mark.parametrize("day", [0, 35, 61, 100, 200, 333, 450, 512, 700])
def test_two_week_score_matches_independent_computation(
    site: str, day: int, raw: dict[str, dict[str, Any]], prepared: dict[str, PreparedSeries]
) -> None:
    values = expected_components(raw[site], day * 24, 14 * 24)
    eligibility, b = run(prepared[site], T0 + timedelta(days=day), 14)
    assert eligibility is not Eligibility.UNKNOWN  # fully covered
    assert b.status is ScoreStatus.KNOWN and b.score is not None
    assert b.score == pytest.approx(expected_score(values), abs=2e-6)
    assert b.rank_eligible is (eligibility is Eligibility.PASS)
    for c in b.components:
        if c.component in values:
            assert c.weight == 0.25
            assert c.normalized_value == pytest.approx(values[c.component], abs=1e-12)
        else:
            assert c.weight == 0.0 and c.normalized is None
    assert 0.0 <= b.score <= 100.0
    assert b.note is not None and "SYNTHETIC" not in b.note  # real NASA-derived inputs


def test_malapert_lit_season_is_a_scored_pass(
    raw: dict[str, dict[str, Any]], prepared: dict[str, PreparedSeries]
) -> None:
    start = datetime(2027, 7, 20, tzinfo=UTC)
    eligibility, b = run(prepared["malapert-massif"], start, 14)
    values = expected_components(raw["malapert-massif"], 200 * 24, 336)
    assert eligibility is Eligibility.PASS and b.rank_eligible is True
    # 36 h of 50 h darkness -> 0.28 headroom; no Earth blackout -> 1.0
    assert values[ScoreComponent.DARKNESS_MARGIN] == pytest.approx(0.28)
    assert values[ScoreComponent.BLACKOUT_MARGIN] == 1.0
    assert b.score == pytest.approx(expected_score(values), abs=2e-6)


@pytest.mark.parametrize(
    ("site", "start", "days"),
    [
        ("peak-near-shackleton", datetime(2027, 4, 1, tzinfo=UTC), 14),
        ("shackleton-floor", datetime(2027, 3, 1, tzinfo=UTC), 30),
    ],
)
def test_failed_missions_keep_a_descriptive_score_but_are_not_rank_eligible(
    site: str, start: datetime, days: int, raw: dict[str, dict[str, Any]], prepared: dict[str, PreparedSeries]
) -> None:
    first = (start - T0).days * 24
    values = expected_components(raw[site], first, days * 24)
    eligibility, b = run(prepared[site], start, days)
    assert eligibility is Eligibility.FAIL
    assert b.status is ScoreStatus.KNOWN and b.rank_eligible is False
    assert b.score == pytest.approx(expected_score(values), abs=2e-6)
    assert values[ScoreComponent.DARKNESS_MARGIN] == 0.0  # darkness beyond the limit clamps to 0


def test_mission_straddling_dataset_end_is_unknown_and_unscored(prepared: dict[str, PreparedSeries]) -> None:
    eligibility, b = run(prepared["malapert-massif"], datetime(2028, 12, 25, tzinfo=UTC), 14)
    assert eligibility is Eligibility.UNKNOWN
    assert b.status is ScoreStatus.ELIGIBILITY_UNKNOWN and b.score is None and b.score_bounds is None
    assert b.rank_eligible is False


def test_partial_coverage_gives_bounds_matching_independent_unknown_fraction(
    raw: dict[str, dict[str, Any]], prepared: dict[str, PreparedSeries]
) -> None:
    """Sunlight only: 168 h of a 336 h mission lie beyond the data, so the mean fraction is bounded
    by [covered_sum / 336, covered_sum / 336 + 168 / 336]. Eligibility is UNKNOWN, so the score is
    withheld; the same pipeline with a forced FAIL (a descriptive score) exposes the bounds."""
    site = "malapert-massif"
    start = datetime(2028, 12, 25, tzinfo=UTC)
    first = (start - T0).days * 24
    frac = np.asarray(raw[site]["sun_visible_fraction"][first : first + 168], dtype=float)
    lower = frac.sum() / 336.0
    prefs = {
        "sunlight_weight": 1.0,
        "earth_visibility_weight": 0.0,
        "darkness_margin_weight": 0.0,
        "blackout_margin_weight": 0.0,
    }
    sc = mission(prepared[site], start, 14, **prefs)
    a = assess_constraints(sc, prepared[site])
    b = score_scenario(sc, a.environment.metrics, margins_from_assessment(a), Eligibility.FAIL)
    assert b.status is ScoreStatus.BOUNDED and b.score is None and b.score_bounds is not None
    assert b.score_bounds.lower == pytest.approx(100 * lower, abs=2e-6)
    assert b.score_bounds.upper == pytest.approx(100 * (lower + 0.5), abs=2e-6)
    assert b.score_bounds.lower <= 100 * lower and b.score_bounds.upper >= 100 * (lower + 0.5) - 1e-9


def test_scores_do_not_depend_on_which_other_scenarios_are_evaluated(prepared: dict[str, PreparedSeries]) -> None:
    p = prepared["connecting-ridge"]
    alone = run(p, T0 + timedelta(days=100), 14)[1]
    for site in SITES:
        run(prepared[site], T0 + timedelta(days=61), 14)
    assert run(p, T0 + timedelta(days=100), 14)[1].model_dump_json() == alone.model_dump_json()


def test_scoring_does_not_mutate_scientific_data_or_inputs(prepared: dict[str, PreparedSeries]) -> None:
    site = "malapert-massif"
    path = SITES_DIR / f"{site}.json"
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    p = prepared[site]
    series_before = p.series.model_dump_json()
    sc = mission(p, T0 + timedelta(days=200), 14)
    a = assess_constraints(sc, p)
    margins = margins_from_assessment(a)
    snapshot = (sc.model_dump_json(), a.model_dump_json(), [m.model_dump_json() for m in margins])
    score_scenario(sc, a.environment.metrics, margins, a.eligibility)
    assert (sc.model_dump_json(), a.model_dump_json(), [m.model_dump_json() for m in margins]) == snapshot
    assert p.series.model_dump_json() == series_before
    assert hashlib.sha256(path.read_bytes()).hexdigest() == digest


def test_real_data_basis_is_terrain_aware_and_comparability_metadata_is_stable(
    prepared: dict[str, PreparedSeries],
) -> None:
    p = prepared["connecting-ridge"]
    sc = mission(p, T0 + timedelta(days=35), 14)
    a = assess_constraints(sc, p)
    assert a.environment.data_quality.data_basis in (DataBasis.REAL_TERRAIN_AWARE, DataBasis.REAL_GEOMETRIC_ONLY)
    b1 = run(p, T0 + timedelta(days=35), 14)[1]
    b2 = run(p, T0 + timedelta(days=77), 14)[1]  # same configuration, different start
    assert b1.configuration_key == b2.configuration_key == sc.configuration_key()
    assert b1.method_version == b2.method_version
