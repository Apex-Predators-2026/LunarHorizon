"""Phase 4B risk indicators on Member 1's real precomputed site files (JPL Horizons + LOLA/Moon Trek).

Expected levels are derived INDEPENDENTLY from the raw file columns with NumPy (state of the first
hourly bin, leading and longest run lengths) and the documented default bands (headroom <= 10 %
HIGH, <= 25 % MODERATE, else LOW), never from the engine's own output. Margins are built here from
the raw columns (observed - required) with the published ``OperationalMargin`` contract.
Indicators are illumination / line-of-sight screening categories only: not probabilities, and
not landing-safety, power or radio-link assessments. The files are read only.
"""

from __future__ import annotations

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
    ConstraintId,
    Eligibility,
    PowerSource,
    RiskLevel,
    Unit,
)
from app.viability.mission import MissionRequirements, MissionScenario, SpacecraftConfiguration
from app.viability.outputs import Metric, OperationalMargin, RiskIndicator
from app.viability.risk import SYNTHETIC_PREFIX, assess_risks, overall_risk
from app.viability.windows import PreparedSeries

SITES_DIR = Path(__file__).resolve().parents[3] / "data" / "sites"
SITES = ("connecting-ridge", "malapert-massif", "peak-near-shackleton", "shackleton-floor")
T0 = datetime(2027, 1, 1, tzinfo=UTC)
H = 3600.0
C = ConstraintId
LOW, MOD, HIGH, UNK = RiskLevel.LOW, RiskLevel.MODERATE, RiskLevel.HIGH, RiskLevel.UNKNOWN

# Same lander as the Phase 3 real-data tests (rescue-default-like plus a direct-sunlight floor).
TYPICAL: dict[str, float] = {
    "dark_h": 50.0,
    "blackout_h": 96.0,
    "threshold": 0.25,
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


def mission(p: PreparedSeries, start: datetime, end: datetime, **kw: Any) -> MissionScenario:
    dark_h, blackout_h, threshold = kw.pop("dark_h", None), kw.pop("blackout_h", None), kw.pop("threshold", None)
    return MissionScenario(
        scenario_id="real-phase4-risk",
        site=p.series.site,
        mission_start_utc=start,
        mission_end_utc=end,
        spacecraft=SpacecraftConfiguration(
            name="Solar DTE lander",
            power_source=PowerSource.SOLAR,
            communication_mode=CommunicationMode.DIRECT_TO_EARTH,
            max_continuous_darkness_s=None if dark_h is None else dark_h * H,
            max_communication_blackout_s=None if blackout_h is None else blackout_h * H,
            solar_power_min_disk_fraction=threshold,
        ),
        requirements=MissionRequirements(**kw),
    )


def risks_for(
    p: PreparedSeries,
    start: datetime,
    end: datetime,
    cfg: dict[str, Any],
    margins: list[OperationalMargin] | None = None,
) -> tuple[Eligibility, dict[str, RiskIndicator]]:
    sc = mission(p, start, end, **cfg)
    a = assess_constraints(sc, p)
    return a.eligibility, {r.code: r for r in assess_risks(sc, a, margins or [])}


# --- independent reference computation from the raw columns ------------------------------------


def _band(h: float) -> RiskLevel:
    if h <= 0.10 + 1e-12:
        return HIGH
    if h <= 0.25 + 1e-12:
        return MOD
    return LOW


def _longest(mask: np.ndarray, value: bool) -> int:
    best = cur = 0
    for x in mask:
        cur = cur + 1 if bool(x) is value else 0
        best = max(best, cur)
    return best


def _leading(mask: np.ndarray, value: bool) -> int:
    other = np.flatnonzero(mask != value)
    return int(other[0]) if other.size else int(mask.size)


def _landing_level(ok: np.ndarray, limit_h: float) -> RiskLevel:
    if ok[0]:
        return LOW
    dark = _leading(ok, False)
    if dark == ok.size or _band(1.0 - dark / limit_h) is HIGH:
        return HIGH
    return MOD


def independent(tl: dict[str, Any], first: int, n: int) -> tuple[dict[str, RiskLevel], list[OperationalMargin]]:
    """Hourly bins [first, first+n): sample-and-hold means sample i covers hour i."""
    sl = slice(first, first + n)
    frac = np.asarray(tl["sun_visible_fraction"][sl], dtype=float)
    sun = np.asarray(tl["sun_visible"][sl], dtype=bool)
    earth = np.asarray(tl["earth_visible"][sl], dtype=bool)
    lit = sun & (frac >= TYPICAL["threshold"])
    levels = {
        "landing_in_darkness": _landing_level(lit, TYPICAL["dark_h"]),
        "landing_without_earth_visibility": _landing_level(earth, TYPICAL["blackout_h"]),
        "darkness_exposure": _band(1.0 - _longest(lit, False) / TYPICAL["dark_h"]),
        "communication_exposure": _band(1.0 - _longest(earth, False) / TYPICAL["blackout_h"]),
    }
    observed = {
        C.MIN_SUNLIGHT_PERCENT: (100.0 * sun.sum() / n, "min_sunlight_percent", Unit.PERCENT),
        C.MIN_EARTH_VISIBILITY_PERCENT: (100.0 * earth.sum() / n, "min_earth_visibility_percent", Unit.PERCENT),
        C.MIN_MEAN_SOLAR_DISK_FRACTION: (float(frac.mean()), "min_mean_solar_disk_fraction", Unit.FRACTION),
        C.MIN_INITIAL_SUNLIGHT: (_leading(lit, True) * H, "min_initial_sunlight_s", Unit.SECONDS),
        C.MIN_INITIAL_EARTH_VISIBILITY: (_leading(earth, True) * H, "min_initial_earth_visibility_s", Unit.SECONDS),
    }
    margins = []
    for cid, (value, key, unit) in observed.items():
        required = TYPICAL[key]
        margins.append(
            OperationalMargin(
                margin_id=cid.value,
                related_constraint=cid,
                reference=required,
                value=Metric.known(value - required, unit),
                description="independent test margin: observed - required",
            )
        )
        levels[f"margin_headroom.{cid.value}"] = _band((value - required) / required)
    return levels, margins


@pytest.mark.parametrize("site", SITES)
@pytest.mark.parametrize("day", [0, 35, 61, 100, 200, 333, 450, 512, 700])
def test_two_week_risk_levels_match_independent_computation(
    site: str, day: int, raw: dict[str, dict[str, Any]], prepared: dict[str, PreparedSeries]
) -> None:
    start = T0 + timedelta(days=day)
    expected, margins = independent(raw[site], day * 24, 14 * 24)
    _, risks = risks_for(prepared[site], start, start + timedelta(days=14), TYPICAL, margins)
    got = {code: risks[code].level for code in expected}
    assert got == expected
    # Fully covered, terrain-aware, NASA-derived inputs: no data-quality or basis flags.
    assert risks["sun_data_coverage"].level is LOW and risks["earth_data_coverage"].level is LOW
    assert "synthetic_data" not in risks and "geometric_only_data" not in risks
    assert not any(r.message.startswith(SYNTHETIC_PREFIX) for r in risks.values())
    assert UNK not in {r.level for r in risks.values()}


# --- regression examples (values confirmed by the independent check above) ---------------------


def test_peak_near_shackleton_night_landing(prepared: dict[str, PreparedSeries]) -> None:
    start = datetime(2027, 4, 1, tzinfo=UTC)
    elig, r = risks_for(prepared["peak-near-shackleton"], start, start + timedelta(days=14), TYPICAL)
    assert elig is Eligibility.FAIL
    landing = r["landing_in_darkness"]
    assert landing.level is HIGH
    assert landing.evidence == Metric.known(336 * H, Unit.SECONDS)
    assert "already in progress at landing" in landing.message and "(the whole mission)" in landing.message
    assert r["darkness_exposure"].level is HIGH
    assert overall_risk(list(r.values())) is HIGH


def test_malapert_lit_season_pass(prepared: dict[str, PreparedSeries]) -> None:
    start = datetime(2027, 7, 20, tzinfo=UTC)
    elig, r = risks_for(prepared["malapert-massif"], start, start + timedelta(days=14), TYPICAL)
    assert elig is Eligibility.PASS
    dark = r["darkness_exposure"]
    assert dark.level is LOW  # 36 h of 50 h: 28 % headroom
    assert dark.evidence == Metric.known(36 * H, Unit.SECONDS)
    assert "72 % of the 50 h limit" in dark.message and "continues to mission end" in dark.message
    assert r["communication_exposure"].evidence == Metric.known(0.0, Unit.SECONDS)
    assert r["landing_in_darkness"].level is LOW and r["landing_without_earth_visibility"].level is LOW


def test_shackleton_floor_control_is_high_everywhere(prepared: dict[str, PreparedSeries]) -> None:
    start = datetime(2027, 3, 1, tzinfo=UTC)
    elig, r = risks_for(prepared["shackleton-floor"], start, start + timedelta(days=30), TYPICAL)
    assert elig is Eligibility.FAIL
    for code in (
        "landing_in_darkness",
        "landing_without_earth_visibility",
        "darkness_exposure",
        "communication_exposure",
    ):
        assert r[code].level is HIGH, code


def test_malapert_mission_straddling_dataset_end(prepared: dict[str, PreparedSeries]) -> None:
    start = datetime(2028, 12, 25, tzinfo=UTC)
    elig, r = risks_for(prepared["malapert-massif"], start, start + timedelta(days=14), TYPICAL)
    assert elig is Eligibility.UNKNOWN
    for code in ("sun_data_coverage", "earth_data_coverage"):
        assert r[code].level is MOD
        assert r[code].evidence == Metric.known(168 * H, Unit.SECONDS)
        assert "including at mission end" in r[code].message
    assert r["darkness_exposure"].level is UNK and r["communication_exposure"].level is UNK
    assert overall_risk(list(r.values())) is UNK


def test_connecting_ridge_mission_after_dataset(prepared: dict[str, PreparedSeries]) -> None:
    start = datetime(2029, 2, 1, tzinfo=UTC)
    elig, r = risks_for(prepared["connecting-ridge"], start, start + timedelta(days=14), TYPICAL)
    assert elig is Eligibility.UNKNOWN
    assert {ind.level for ind in r.values()} == {UNK}


def test_malapert_unsupported_clearance(prepared: dict[str, PreparedSeries]) -> None:
    elig, r = risks_for(prepared["malapert-massif"], T0, T0 + timedelta(days=14), {"min_earth_clearance_deg": 2.0})
    assert elig is Eligibility.UNKNOWN
    assert r["unsupported_requirement.min_earth_clearance"].level is UNK
