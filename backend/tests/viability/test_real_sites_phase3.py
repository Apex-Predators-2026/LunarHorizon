"""Phase 3 constraint verdicts on Member 1's real precomputed site files (JPL Horizons + LOLA/Moon Trek).

Expected verdicts are derived INDEPENDENTLY from the raw file columns with NumPy (sample counts,
run lengths, inclusive comparisons), never from the engine's own output. Regression limits come
from the Phase 2 outage table (docs section 5b), itself cross-checked against Member 1's
``intervals()``. These verdicts concern sunlight and Earth line of sight only: they say nothing
about landing safety, power generation or radio links (``STANDARD_LIMITATIONS``).
The original files are read only, never modified.
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
    ConstraintStatus,
    Eligibility,
    MetricStatus,
    PowerSource,
    UnknownReason,
    WindowKind,
)
from app.viability.mission import MissionRequirements, MissionScenario, SpacecraftConfiguration
from app.viability.windows import PreparedSeries

from .helpers import raw_longest_outages

SITES_DIR = Path(__file__).resolve().parents[3] / "data" / "sites"
SITES = ("connecting-ridge", "malapert-massif", "peak-near-shackleton", "shackleton-floor")
T0 = datetime(2027, 1, 1, tzinfo=UTC)
COVERAGE_END = datetime(2029, 1, 1, tzinfo=UTC)
N_HOURS = 17544
H = 3600.0
C = ConstraintId
PASS, FAIL, UNKNOWN = ConstraintStatus.PASS, ConstraintStatus.FAIL, ConstraintStatus.UNKNOWN

# A rescue-default-like lander (app/models.py MissionRequirements defaults) plus a direct-sunlight floor.
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


def mission(
    p: PreparedSeries,
    start: datetime,
    end: datetime,
    *,
    dark_h: float | None = None,
    blackout_h: float | None = None,
    threshold: float | None = None,
    **req: Any,
) -> MissionScenario:
    return MissionScenario(
        scenario_id="real-phase3",
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
        requirements=MissionRequirements(**req),
    )


# --- independent reference computation from the raw columns ------------------------------------


def _longest(mask: np.ndarray, value: bool) -> int:
    best = cur = 0
    for x in mask:
        cur = cur + 1 if bool(x) is value else 0
        best = max(best, cur)
    return best


def _leading(mask: np.ndarray) -> int:
    off = np.flatnonzero(~mask)
    return int(off[0]) if off.size else int(mask.size)


def independent_verdicts(
    tl: dict[str, Any], first: int, n: int, cfg: dict[str, float]
) -> dict[ConstraintId, ConstraintStatus]:
    """Hourly bins [first, first+n): sample-and-hold means sample i covers hour i."""
    sl = slice(first, first + n)
    frac = np.asarray(tl["sun_visible_fraction"][sl], dtype=float)
    sun = np.asarray(tl["sun_visible"][sl], dtype=bool)
    earth = np.asarray(tl["earth_visible"][sl], dtype=bool)
    lit = sun & (frac >= cfg["threshold"])
    measured = {
        C.MAX_CONTINUOUS_DARKNESS: (_longest(lit, False), cfg["dark_h"], "max"),
        C.MAX_COMMUNICATION_BLACKOUT: (_longest(earth, False), cfg["blackout_h"], "max"),
        C.MIN_SUNLIGHT_PERCENT: (100.0 * sun.sum() / n, cfg["min_sunlight_percent"], "min"),
        C.MIN_EARTH_VISIBILITY_PERCENT: (100.0 * earth.sum() / n, cfg["min_earth_visibility_percent"], "min"),
        C.MIN_MEAN_SOLAR_DISK_FRACTION: (float(frac.mean()), cfg["min_mean_solar_disk_fraction"], "min"),
        C.MIN_INITIAL_SUNLIGHT: (_leading(lit), cfg["min_initial_sunlight_s"] / H, "min"),
        C.MIN_INITIAL_EARTH_VISIBILITY: (_leading(earth), cfg["min_initial_earth_visibility_s"] / H, "min"),
    }
    out = {}
    for cid, (value, limit, kind) in measured.items():
        ok = value >= limit if kind == "min" else value <= limit
        out[cid] = PASS if ok else FAIL
    return out


@pytest.mark.parametrize("site", SITES)
@pytest.mark.parametrize("day", [0, 35, 61, 100, 200, 333, 450, 512, 700])
def test_two_week_verdicts_match_independent_computation(
    site: str, day: int, raw: dict[str, dict[str, Any]], prepared: dict[str, PreparedSeries]
) -> None:
    start = T0 + timedelta(days=day)
    kw = dict(TYPICAL)
    a = assess_constraints(mission(prepared[site], start, start + timedelta(days=14), **kw), prepared[site])
    expected = independent_verdicts(raw[site], day * 24, 14 * 24, TYPICAL)
    got = {c.constraint_id: c.status for c in a.constraints if c.constraint_id in expected}
    assert got == expected
    assert a.eligibility is (Eligibility.PASS if all(s is PASS for s in expected.values()) else Eligibility.FAIL)
    # Fully covered real data: every configured verdict is decided, none is UNKNOWN.
    assert a.with_status(UNKNOWN) == []
    assert all(c.measured.status is MetricStatus.KNOWN for c in a.constraints if c.metric_field)


def test_real_scenarios_include_both_outcomes() -> None:
    """Regression: verdicts the independent check above confirms (Malapert lit season vs night)."""
    p = prepare_series(load_site_file(SITES_DIR / "malapert-massif.json"))
    kw = dict(TYPICAL)
    passing = [T0, T0 + timedelta(days=200), T0 + timedelta(days=333)]
    failing = [T0 + timedelta(days=35), T0 + timedelta(days=61)]
    for start in passing:
        assert (
            assess_constraints(mission(p, start, start + timedelta(days=14), **kw), p).eligibility is Eligibility.PASS
        )
    for start in failing:
        assert (
            assess_constraints(mission(p, start, start + timedelta(days=14), **kw), p).eligibility is Eligibility.FAIL
        )


# --- two-year limits at, below and above the measured extremes ---------------------------------

# Measured extremes are re-derived from the raw columns (helpers.raw_longest_outages), never pinned per site.
def outages_h(raw: dict[str, Any], site: str) -> tuple[int, int]:
    runs = raw_longest_outages(raw[site], power_min_fraction=0.25)
    return runs["power_dark"][0], runs["earth_blackout"][0]


@pytest.mark.parametrize("site", SITES)
def test_two_year_outage_limits_exactly_at_and_below(
    site: str, raw: dict[str, dict[str, Any]], prepared: dict[str, PreparedSeries]
) -> None:
    p, (dark, blackout) = prepared[site], outages_h(raw, site)
    # A limit must be > 0 h: where Earth is never blacked out (Malapert, generator 1.2) the blackout limit
    # is a fixed 100 h that can never fail, and only the darkness constraint is probed at its extreme.
    has_blackout = blackout > 0
    at_limit = assess_constraints(
        mission(p, T0, COVERAGE_END, dark_h=dark, blackout_h=blackout if has_blackout else 100, threshold=0.25), p
    )
    assert at_limit.eligibility is Eligibility.PASS
    below = assess_constraints(
        mission(
            p, T0, COVERAGE_END, dark_h=dark - 1, blackout_h=blackout - 1 if has_blackout else 100, threshold=0.25
        ),
        p,
    )
    assert [c.constraint_id for c in below.with_status(FAIL)] == [
        C.MAX_CONTINUOUS_DARKNESS,
        *([C.MAX_COMMUNICATION_BLACKOUT] if has_blackout else []),
    ]
    [w] = below.constraint(C.MAX_CONTINUOUS_DARKNESS).evidence_windows
    assert w.kind is WindowKind.POWER_DARK and w.duration_s == dark * H


@pytest.mark.parametrize("site", SITES[:3])
def test_two_year_percentages_exactly_at_threshold(
    site: str, raw: dict[str, dict[str, Any]], prepared: dict[str, PreparedSeries]
) -> None:
    tl, p = raw[site], prepared[site]
    sun = 100.0 * np.count_nonzero(np.asarray(tl["sun_visible"][:-1], dtype=bool)) / N_HOURS
    earth = 100.0 * np.count_nonzero(np.asarray(tl["earth_visible"][:-1], dtype=bool)) / N_HOURS
    exact = mission(p, T0, COVERAGE_END, min_sunlight_percent=sun, min_earth_visibility_percent=earth)
    assert assess_constraints(exact, p).eligibility is Eligibility.PASS
    above = mission(p, T0, COVERAGE_END, min_sunlight_percent=sun * (1 + 1e-9), min_earth_visibility_percent=earth)
    a = assess_constraints(above, p)
    assert [c.constraint_id for c in a.with_status(FAIL)] == [C.MIN_SUNLIGHT_PERCENT]


def test_control_site_fails_every_illumination_and_earth_requirement(prepared: dict[str, PreparedSeries]) -> None:
    p = prepared["shackleton-floor"]
    a = assess_constraints(mission(p, T0, T0 + timedelta(days=30), **TYPICAL), p)
    assert {c.constraint_id for c in a.with_status(FAIL)} == {
        C.MAX_CONTINUOUS_DARKNESS,
        C.MAX_COMMUNICATION_BLACKOUT,
        C.MIN_SUNLIGHT_PERCENT,
        C.MIN_EARTH_VISIBILITY_PERCENT,
        C.MIN_MEAN_SOLAR_DISK_FRACTION,
        C.MIN_INITIAL_SUNLIGHT,
        C.MIN_INITIAL_EARTH_VISIBILITY,
    }
    assert a.constraint(C.MAX_CONTINUOUS_DARKNESS).measured.value == 30 * 24 * H


def test_mission_landing_in_a_long_night_at_peak_near_shackleton(prepared: dict[str, PreparedSeries]) -> None:
    # Inside PNS's 2802 h power-dark period starting 2027-03-05T22Z (threshold 0.25).
    p = prepared["peak-near-shackleton"]
    start = datetime(2027, 4, 1, tzinfo=UTC)
    a = assess_constraints(mission(p, start, start + timedelta(days=14), **TYPICAL), p)
    init = a.constraint(C.MIN_INITIAL_SUNLIGHT)
    assert init.status is FAIL and init.measured.value == 0.0
    dark = a.constraint(C.MAX_CONTINUOUS_DARKNESS)
    assert dark.status is FAIL and dark.measured.value == 14 * 24 * H
    [w] = dark.evidence_windows
    assert w.clipped_at_start and w.clipped_at_end  # the night extends beyond the mission on both sides


# --- the exact end of Andrew's coverage (2029-01-01T00:00Z) -------------------------------------


def test_mission_ending_exactly_at_coverage_end_is_fully_known(prepared: dict[str, PreparedSeries]) -> None:
    p = prepared["malapert-massif"]
    a = assess_constraints(mission(p, COVERAGE_END - timedelta(days=14), COVERAGE_END, **TYPICAL), p)
    assert a.environment.data_quality.uncovered_duration_s == 0.0
    assert a.with_status(UNKNOWN) == []


def test_one_hour_past_coverage_end_is_unknown_never_fabricated(prepared: dict[str, PreparedSeries]) -> None:
    p = prepared["malapert-massif"]
    end = COVERAGE_END + timedelta(hours=1)
    a = assess_constraints(mission(p, end - timedelta(days=14), end, **TYPICAL), p)
    assert a.environment.data_quality.uncovered_duration_s == H
    for c in a.constraints:
        if c.condition is not None and c.metric_field is not None:
            assert c.condition_unknown_duration_s == H, c.constraint_id
    sun = a.constraint(C.MIN_SUNLIGHT_PERCENT)
    assert sun.measured.status is MetricStatus.BOUNDED
    assert sun.measured.upper is not None and sun.measured.lower is not None
    assert sun.measured.upper - sun.measured.lower == pytest.approx(100.0 / (14 * 24))


def test_mission_straddling_coverage_end(raw: dict[str, dict[str, Any]], prepared: dict[str, PreparedSeries]) -> None:
    p, tl = prepared["malapert-massif"], raw["malapert-massif"]
    start, end = datetime(2028, 12, 25, tzinfo=UTC), datetime(2029, 1, 8, tzinfo=UTC)
    a = assess_constraints(mission(p, start, end, **TYPICAL), p)
    assert a.environment.data_quality.uncovered_duration_s == 7 * 24 * H
    known_h = int(np.count_nonzero(np.asarray(tl["earth_visible"][N_HOURS - 168 : N_HOURS], dtype=bool)))
    earth = a.constraint(C.MIN_EARTH_VISIBILITY_PERCENT)
    assert earth.measured.lower == pytest.approx(100.0 * known_h / 336)
    assert earth.measured.upper == pytest.approx(100.0 * (known_h + 168) / 336)
    assert earth.status is PASS  # proven by the covered week alone (>= 40 %)
    blackout = a.constraint(C.MAX_COMMUNICATION_BLACKOUT)
    assert (blackout.status, blackout.unknown_reason) == (UNKNOWN, UnknownReason.INCOMPLETE_DATA)
    assert a.eligibility is Eligibility.UNKNOWN
    assert a.with_status(FAIL) == []
    assert any("beyond dataset coverage" in w for w in a.environment.data_quality.warnings)


def test_mission_entirely_after_coverage_is_unknown(prepared: dict[str, PreparedSeries]) -> None:
    p = prepared["connecting-ridge"]
    start = datetime(2029, 2, 1, tzinfo=UTC)
    a = assess_constraints(mission(p, start, start + timedelta(days=14), **TYPICAL), p)
    assert a.eligibility is Eligibility.UNKNOWN and a.with_status(FAIL) == []
    for c in a.with_status(UNKNOWN):
        assert c.unknown_reason is UnknownReason.NO_DATA and c.measured.status is MetricStatus.UNAVAILABLE


def test_unsupported_clearance_requirement_on_real_data(prepared: dict[str, PreparedSeries]) -> None:
    p = prepared["malapert-massif"]
    a = assess_constraints(mission(p, T0, T0 + timedelta(days=14), **TYPICAL, min_earth_clearance_deg=2.0), p)
    assert a.with_status(FAIL) == []
    [c] = a.with_status(UNKNOWN)
    assert (c.constraint_id, c.unknown_reason) == (C.MIN_EARTH_CLEARANCE, UnknownReason.UNSUPPORTED)
    assert a.eligibility is Eligibility.UNKNOWN
    # Provenance is carried through untouched: real, NASA-derived, frame stated by Member 1 only.
    dq = a.environment.data_quality
    assert dq.provenance.is_synthetic is False and "not independently verified" in (dq.provenance.notes or "")
