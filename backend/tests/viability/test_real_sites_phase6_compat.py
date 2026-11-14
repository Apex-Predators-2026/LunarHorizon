"""Phase 6B on real NASA-derived data: canonical engine vs rescue's placeholder, side by side.

Real inputs only: Member 1's precomputed ``data/sites/*.json`` (JPL Horizons + Moon Trek LOLA,
generator 1.2) read by rescue's own ``PrecomputedTimelineProvider``, rescue's own ``Evaluator``
(including its coverage policy), and the REAL canonical engine through
``app.viability.compat.rescue.make_evaluate_fn``. Nothing is mocked. Temporary files are copies
of a real site file with documented edits (missing terrain, a sub-precision sliver, older metadata).

Differences are classified: identical (all metrics, verdicts, violations on fully covered data);
expected (score formula; coverage policy; the file's last instant; unknown handling); anything
else fails the test.
"""

from __future__ import annotations

import copy
import json
import math
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from functools import cache
from pathlib import Path
from typing import Any, TypeVar

import pytest
from pydantic import BaseModel

from app.models import MissionRequirements as RescueRequirements
from app.models import Scenario, Site, ViabilityResult
from app.rescue import compromise, rescue, sensitivity
from app.rescue.catalog import SITES, custom_site, get_site
from app.rescue.engine import NO_DATA_SOURCE, Evaluator, is_real
from app.rescue.schemas import (
    CompromiseRequest,
    PlanChange,
    RescueRequest,
    ScienceGoal,
    SearchOptions,
    SensitivityRequest,
)
from app.rescue.timeline import PrecomputedTimelineProvider, SyntheticTimelineProvider
from app.viability.adapters import load_site_file
from app.viability.adapters.site_file import normalize_longitude_deg
from app.viability.compat.rescue import (
    SOURCE,
    assessment_to_result,
    evaluate_timeline_detailed,
    make_evaluate_fn,
    precomputed_file_info,
    scenario_to_mission,
    timeline_to_series,
)
from app.viability.engine import evaluate_scenario
from app.viability.enums import ConstraintStatus, Eligibility, ScoreStatus, VisibilityState

SITES_DIR = Path(__file__).resolve().parents[3] / "data" / "sites"
ORIGINAL_FOUR = ("peak-near-shackleton", "connecting-ridge", "malapert-massif", "shackleton-floor")
WHOLE_MOON = ("apollo-12", "apollo-15", "change-4", "change-6", "slim", "chandrayaan-3")
DATA_START = datetime(2027, 1, 1, tzinfo=UTC)
DATA_END = datetime(2029, 1, 1, tzinfo=UTC)  # last sample instant of every committed file
H = 3600.0
M = TypeVar("M", bound=BaseModel)


def make(model: type[M], **fields: Any) -> M:
    """Build a shared/rescue pydantic model with its defaults (typed for mypy without the pydantic plugin)."""
    return model.model_validate(fields)


pytestmark = pytest.mark.skipif(
    not all((SITES_DIR / f"{s}.json").exists() for s in (*ORIGINAL_FOUR, *WHOLE_MOON)),
    reason="precomputed site files not present",
)

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
REQUIREMENT_SETS = {
    "default": make(RescueRequirements),
    "strict": make(
        RescueRequirements,
        min_sunlight_fraction=0.6,
        battery_hours=24,
        panel_threshold=0.5,
        min_earth_visibility_fraction=0.55,
        max_comms_gap_hours=24,
        min_initial_sun_hours=72,
        min_initial_comms_hours=48,
    ),
    "threshold0": make(RescueRequirements, panel_threshold=0.0),
    "threshold1": make(RescueRequirements, panel_threshold=1.0, battery_hours=120),
}


@cache
def _raw(site_id: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((SITES_DIR / f"{site_id}.json").read_text(encoding="utf-8"))
    return data


def site_from_file(site_id: str) -> Site:
    s = _raw(site_id)["site"]
    return Site(id=site_id, name=s["name"], lat=s["lat"], lon=s["lon"])


@pytest.fixture(scope="module")
def provider() -> PrecomputedTimelineProvider:
    return PrecomputedTimelineProvider(fallback=SyntheticTimelineProvider(), data_dir=SITES_DIR)


@pytest.fixture(scope="module")
def canonical(provider: PrecomputedTimelineProvider) -> Evaluator:
    """Rescue's real Evaluator (default: real data only) with the canonical engine plugged in."""
    return Evaluator(provider=provider, evaluate=make_evaluate_fn(precomputed_data_dir=SITES_DIR))


@pytest.fixture(scope="module")
def placeholder(provider: PrecomputedTimelineProvider) -> Evaluator:
    return Evaluator(provider=provider)


def compare(old: ViabilityResult, new: ViabilityResult) -> list[str]:
    """Every difference except the score (whose formula differs by design; checked separately)."""
    out = []
    if old.verdict != new.verdict or old.passes != new.passes:
        out.append(f"verdict {old.verdict} -> {new.verdict}")
    for f in METRIC_FIELDS:
        a, b = getattr(old.metrics, f), getattr(new.metrics, f)
        if (a is None) != (b is None) or (
            a is not None and b is not None and not math.isclose(a, b, rel_tol=1e-12, abs_tol=1e-12)
        ):
            out.append(f"{f} {a} -> {b}")
    va = [(v.constraint, v.unit, v.is_unknown) for v in old.violations]
    vb = [(v.constraint, v.unit, v.is_unknown) for v in new.violations]
    if va != vb:
        out.append(f"violations {va} -> {vb}")
    else:
        for x, y in zip(old.violations, new.violations, strict=True):
            for attr in ("required", "actual", "shortfall", "relative_shortfall"):
                if not math.isclose(getattr(x, attr), getattr(y, attr), rel_tol=1e-12, abs_tol=1e-12):
                    out.append(f"{x.constraint}.{attr} {getattr(x, attr)} -> {getattr(y, attr)}")
    if old.data_source != new.data_source:
        out.append(f"data_source {old.data_source} -> {new.data_source}")
    return out


def documented_canonical_score(r: ViabilityResult) -> float:
    """Phase 5 formula (docs section 5f) recomputed from the rescue-facing metrics only: four active
    components, weight 1/4 each (both outage limits set; default preferences)."""
    m, q = r.metrics, r.scenario.requirements

    def clamp(x: float) -> float:
        return min(1.0, max(0.0, x))

    parts = (
        m.sunlight_fraction,
        m.earth_visibility_fraction,
        clamp(1.0 - m.longest_dark_gap_hours / q.battery_hours),
        clamp(1.0 - m.longest_comms_gap_hours / q.max_comms_gap_hours),
    )
    return 100.0 * math.fsum(parts) / 4.0


def landings(step_days: int, duration_days: int) -> list[datetime]:
    last = DATA_END - timedelta(days=duration_days)
    out, t, k = [], DATA_START, 0
    while t <= last:
        out.append(t)
        k += 1
        t = DATA_START + timedelta(days=step_days * k, hours=(5 * k) % 24)
    return out


# --- 6. side by side on the four original datasets ------------------------------------------------


@pytest.mark.parametrize("site_id", ORIGINAL_FOUR)
@pytest.mark.parametrize("req_name", list(REQUIREMENT_SETS))
def test_side_by_side_original_four_sites(
    site_id: str, req_name: str, canonical: Evaluator, placeholder: Evaluator
) -> None:
    """Same sites, landings, durations, requirements and timelines (rescue's own batch evaluation).

    Identical: all 12 metrics, eligibility, legacy ``passes``, violations (field, unit, required,
    actual, shortfall), ``data_source``. Expected: ``score`` (canonical Phase 5 formula, reproduced
    here from the metrics). Unexplained: none allowed.
    """
    site = site_from_file(site_id)  # shackleton-floor is a control, so not in rescue's catalog
    req = REQUIREMENT_SETS[req_name]
    unexplained: list[str] = []
    verdicts: set[str] = set()
    for days in (3, 7, 14, 30):
        starts = landings(61, days)
        old = placeholder.evaluate_many(site, starts, days, req)
        new = canonical.evaluate_many(site, starts, days, req)
        for t, a, b in zip(starts, old, new, strict=True):
            assert is_real(a) and is_real(b), "comparison must run on real data"
            assert b.source == SOURCE and a.source == "placeholder-v1"
            unexplained += [f"{t:%Y-%m-%dT%H} {days}d: {d}" for d in compare(a, b)]
            verdicts.add(b.verdict)
            assert a.score is not None and b.score is not None  # fully covered: always scored
            assert b.score == pytest.approx(documented_canonical_score(b), abs=1e-6)
    assert not unexplained, "unexplained differences:\n" + "\n".join(unexplained[:30])
    assert "unknown" not in verdicts  # fully covered real data never yields UNKNOWN
    if site_id == "shackleton-floor":
        assert verdicts == {"fail"}  # permanently shadowed control


def test_shackleton_floor_control_is_dark_and_blocked(canonical: Evaluator) -> None:
    site = site_from_file("shackleton-floor")
    r = canonical.evaluate(make(Scenario, site=site, landing_utc=datetime(2027, 6, 1, tzinfo=UTC), duration_days=14))
    m = r.metrics
    assert (m.sunlight_fraction, m.earth_visibility_fraction) == (0.0, 0.0)
    assert m.longest_dark_gap_hours == m.longest_comms_gap_hours == 14 * 24
    assert {v.constraint for v in r.violations} == set(RescueRequirements.model_fields) - {"panel_threshold"}
    assert not any(v.is_unknown for v in r.violations)


# --- whole-Moon sites (generator 1.2) ---------------------------------------------------------------


@pytest.mark.parametrize("site_id", WHOLE_MOON)
def test_whole_moon_sites_match_placeholder(site_id: str, canonical: Evaluator, placeholder: Evaluator) -> None:
    site = site_from_file(site_id)
    mission = scenario_to_mission(make(Scenario, site=site, landing_utc=DATA_START))
    assert mission.site.lon == normalize_longitude_deg(site.lon) and mission.site.lat == site.lat
    for days in (7, 29):
        starts = landings(97, days)
        for t, a, b in zip(
            starts,
            placeholder.evaluate_many(site, starts, days, make(RescueRequirements)),
            canonical.evaluate_many(site, starts, days, make(RescueRequirements)),
            strict=True,
        ):
            assert compare(a, b) == [], (site_id, t, days)
            assert b.score == pytest.approx(documented_canonical_score(b), abs=1e-6)


# --- 5. coverage policy: rescue's provider vs canonical bounded semantics ----------------------------

PNS = "peak-near-shackleton"


@pytest.mark.parametrize(
    ("landing", "days", "label"),
    [
        (datetime(2026, 12, 30, tzinfo=UTC), 7, "begins before the data"),
        (datetime(2028, 12, 28, tzinfo=UTC), 7, "runs past the data"),
        (datetime(2028, 12, 20, tzinfo=UTC), 14, "runs past the data"),
        (datetime(2030, 3, 1, tzinfo=UTC), 7, "entirely outside"),
    ],
)
def test_rescue_withholds_verdicts_outside_coverage(
    landing: datetime, days: int, label: str, canonical: Evaluator
) -> None:
    """Default mode never falls back to synthetic data and never sends the mission to the engine."""
    sc = make(Scenario, site=get_site(PNS).to_site(), landing_utc=landing, duration_days=days)
    r = canonical.evaluate(sc)
    assert r.eligibility == "unknown" and not r.passes and r.score is None, label
    assert r.source == "rescue-coverage-check" and r.data_source == NO_DATA_SOURCE
    assert [(v.constraint, v.is_unknown) for v in r.violations] == [("data_coverage", True)]
    assert "synthetic" not in r.data_source


def test_canonical_bounded_policy_can_prove_what_rescue_withholds(canonical: Evaluator) -> None:
    """Expected policy difference (documented, not forced equal): applied to the whole site file, the
    canonical engine bounds a partially covered mission and may PROVE a failure from the covered part;
    rescue answers UNKNOWN for anything not fully covered. Neither ever reports an unproven verdict."""
    series = load_site_file(SITES_DIR / f"{PNS}.json")
    site = get_site(PNS).to_site()
    eligibilities = set()
    for landing, days in [
        (datetime(2026, 12, 30, tzinfo=UTC), 7),
        (datetime(2028, 12, 20, tzinfo=UTC), 14),
        (datetime(2028, 12, 28, tzinfo=UTC), 7),
        (datetime(2029, 2, 1, tzinfo=UTC), 14),
    ]:
        sc = make(Scenario, site=site, landing_utc=landing, duration_days=days)
        direct = evaluate_scenario(scenario_to_mission(sc), series)
        assert direct.data_quality.uncovered_duration_s > 0
        assert direct.score.status is not ScoreStatus.KNOWN  # never an exact score on partial data
        for c in direct.constraints:
            if c.status is ConstraintStatus.FAIL:  # a proven failure has bounds entirely past the limit
                m = c.measured
                lo = m.value if m.lower is None else m.lower
                hi = m.value if m.upper is None else m.upper
                assert lo is not None and hi is not None and c.threshold is not None
                assert (lo > c.threshold) if c.comparison and c.comparison.value == "at_most" else (hi < c.threshold)
        eligibilities.add(direct.eligibility)
        assert canonical.evaluate(sc).verdict == "unknown"
    assert Eligibility.FAIL in eligibilities and Eligibility.UNKNOWN in eligibilities


def test_sites_without_real_data_are_unknown_by_default(canonical: Evaluator) -> None:
    landing = datetime(2027, 6, 1, tzinfo=UTC)
    for site in (custom_site("near the peak", -89.02, 126.3), Site(id="unlisted", name="Unlisted", lat=-88, lon=40)):
        r = canonical.evaluate(make(Scenario, site=site, landing_utc=landing))
        assert r.eligibility == "unknown" and r.data_source == NO_DATA_SOURCE and r.score is None
        assert "no real" in r.violations[0].message.lower()


def test_explicit_simulation_mode_is_synthetic_and_labelled(canonical: Evaluator) -> None:
    sc = make(Scenario, site=get_site(PNS).to_site(), landing_utc=datetime(2030, 3, 1, tzinfo=UTC))
    r = canonical.evaluate(sc, simulation=True)
    assert r.data_source == "synthetic-placeholder" and r.source == SOURCE and not is_real(r)
    assert r.verdict in ("pass", "fail")  # definite verdicts, but on synthetic data, labelled as such


def test_inside_coverage_is_real_and_scored(canonical: Evaluator) -> None:
    for landing in (DATA_START, datetime(2027, 6, 1, tzinfo=UTC), DATA_END - timedelta(days=7)):
        r = canonical.evaluate(make(Scenario, site=get_site(PNS).to_site(), landing_utc=landing))
        assert is_real(r) and r.source == SOURCE and r.score is not None, landing


def _boundary_cases() -> Iterator[tuple[Site, int, RescueRequirements]]:
    relaxed = make(RescueRequirements, panel_threshold=0.0, battery_hours=20, max_comms_gap_hours=20)
    for cs in SITES:
        if not (SITES_DIR / f"{cs.id}.json").exists():
            continue
        for days in (1, 3, 7, 14):
            for req in (make(RescueRequirements), relaxed):
                yield cs.to_site(), days, req


def test_last_sample_hour_is_unknown_never_flipped(canonical: Evaluator, placeholder: Evaluator) -> None:
    """Expected difference: rescue counts the file's final instant (2029-01-01T00:00Z) as covering one more
    hour, so the latest landing it accepts ends at 01:00. The canonical engine does not invent that hour:
    the score is bounded (None) and a verdict may become UNKNOWN, but PASS and FAIL never swap and every
    canonical failure is a placeholder failure too. One hour earlier the results are identical."""
    flips: list[str] = []
    for site, days, req in _boundary_cases():
        last = DATA_END - timedelta(hours=days * 24 - 1)
        a, b = (
            placeholder.evaluate_many(site, [last], days, req)[0],
            canonical.evaluate_many(site, [last], days, req)[0],
        )
        assert is_real(b) and b.score is None  # the unknown hour bounds the score
        if b.verdict != a.verdict:
            if b.verdict != "unknown":
                flips.append(f"{site.id} {days}d: {a.verdict} -> {b.verdict}")
            assert all(v.is_unknown for v in b.violations if v.constraint not in {w.constraint for w in a.violations})
        decided_fail = {v.constraint for v in b.violations if not v.is_unknown}
        assert decided_fail <= {v.constraint for v in a.violations}, (site.id, days)
        if days == 1 and req.min_initial_sun_hours == 24 and a.verdict == "pass":
            assert b.verdict == "unknown"  # 24 h of initial sun needs the uncovered last hour too
            assert [(v.constraint, v.is_unknown) for v in b.violations] == [("min_initial_sun_hours", True)]
        earlier = last - timedelta(hours=1)
        a2, b2 = (
            placeholder.evaluate_many(site, [earlier], days, req)[0],
            canonical.evaluate_many(site, [earlier], days, req)[0],
        )
        assert compare(a2, b2) == [] and b2.score is not None
        later = canonical.evaluate_many(site, [last + timedelta(hours=1)], days, req)[0]
        assert later.source == "rescue-coverage-check"
    assert not flips, flips


# --- missing terrain, slivers and precision metadata (copies of a real file) ------------------------


def _write_copy(
    tmp: Path, site_id: str, start: str, hours: int, edit: Any = None, meta: dict[str, Any] | None = None
) -> dict[str, Any]:
    data = copy.deepcopy(_raw(site_id))
    tl = data["timeline"]
    i0 = tl["time_utc"].index(start)
    for k, col in tl.items():
        if isinstance(col, list):
            tl[k] = col[i0 : i0 + hours]
    if meta is not None:
        data["meta"] = meta
    if edit is not None:
        edit(tl)
    (tmp / f"{site_id}.json").write_text(json.dumps(data), encoding="utf-8")
    return data


def _null_terrain(tl: dict[str, Any], body: str, rows: range) -> None:
    keys = (
        ("sun_horizon_deg", "sun_visible_fraction", "sun_visible")
        if body == "sun"
        else ("earth_horizon_deg", "earth_margin_deg", "earth_visible")
    )
    for k in keys:
        for i in rows:
            tl[k][i] = None


def test_missing_terrain_is_unknown_and_never_relaxed(tmp_path: Path) -> None:
    """A real file with terrain gaps (as a whole-Moon custom site can have): rescue's provider turns the
    nulls into NaN / earth_visible=False, the canonical engine reports UNKNOWN, and rescue offers no
    loosening for it."""

    def edit(tl: dict[str, Any]) -> None:
        _null_terrain(tl, "sun", range(10))
        _null_terrain(tl, "earth", range(40, 52))

    _write_copy(tmp_path, "malapert-massif", "2027-07-20T00:00Z", 24 * 20, edit)
    provider = PrecomputedTimelineProvider(fallback=SyntheticTimelineProvider(), data_dir=tmp_path)
    ev = Evaluator(provider=provider, evaluate=make_evaluate_fn(precomputed_data_dir=tmp_path))
    site = get_site("malapert-massif").to_site()
    sc = make(Scenario, site=site, landing_utc=datetime(2027, 7, 20, tzinfo=UTC))
    r = ev.evaluate(sc)
    assert r.data_source == "precomputed:malapert-massif.json" and r.source == SOURCE
    assert r.eligibility == "unknown" and r.score is None
    assert r.violations and all(v.is_unknown for v in r.violations)
    assert "min_initial_sun_hours" in {v.constraint for v in r.violations}

    # The rescue path and the canonical site-file path see the same unknown states.
    tl = provider.timeline(site, sc.landing_utc, sc.landing_utc + timedelta(hours=167), 1.0)
    via_rescue = timeline_to_series(tl, precomputed_data_dir=tmp_path)
    via_file = load_site_file(tmp_path / "malapert-massif.json")
    for a, b in zip(via_rescue.samples, via_file.samples[:168], strict=True):
        assert (a.sun.state, a.earth.state) == (b.sun.state, b.earth.state)
    assert sum(s.sun.state is VisibilityState.UNKNOWN for s in via_rescue.samples) == 10
    assert sum(s.earth.state is VisibilityState.UNKNOWN for s in via_rescue.samples) == 12

    opts = make(
        SearchOptions, candidate_site_ids=[], include_nearby_points=False, robustness_check=False, date_window_days=1
    )
    resp = rescue(make(RescueRequest, original=sc, change=make(PlanChange, launch_delay_days=0), search=opts), ev)
    assert resp.changed.verdict == "unknown"
    assert not any(s.keeps_original_plan for s in resp.loosening)
    assert resp.stats.undecided >= 1 and "synthetic" not in resp.data_source


def test_sub_precision_sliver_never_changes_a_rescue_verdict(tmp_path: Path) -> None:
    """Rescue's Timeline has no ``sun_visible``: a sliver (flag true, fraction written 0.0) reads as dark
    on the rescue path but partial on the site-file path. Only direct-sunlight quantities can differ;
    power-lit time needs fraction > 0, so every rescue requirement is decided identically."""
    start = "2027-07-20T00:00Z"
    sliver_at: list[int] = []

    def edit(tl: dict[str, Any]) -> None:
        frac = tl["sun_visible_fraction"]
        i = next(k for k in range(1, len(frac)) if frac[k] == 0.0 and frac[k - 1] > 0.0)  # first sunset hour
        tl["sun_visible"][i] = True  # light below the 6-decimal rounding
        sliver_at.append(i)

    _write_copy(tmp_path, "malapert-massif", start, 24 * 40, edit)
    (i,) = sliver_at
    site = get_site("malapert-massif").to_site()
    landing = datetime(2027, 7, 20, tzinfo=UTC) + timedelta(hours=max(0, i - 48))
    for days in (3, 7, 14):
        sc = make(Scenario, site=site, landing_utc=landing, duration_days=days)
        provider = PrecomputedTimelineProvider(fallback=SyntheticTimelineProvider(), data_dir=tmp_path)
        n = days * 24
        tl = provider.timeline(site, landing, landing + timedelta(hours=n - 1), 1.0)
        via_rescue, a1 = evaluate_timeline_detailed(sc, tl, precomputed_data_dir=tmp_path)
        a2 = evaluate_scenario(scenario_to_mission(sc), load_site_file(tmp_path / "malapert-massif.json"))
        via_file = assessment_to_result(a2, sc, tl.source)
        assert [c.status for c in a1.constraints] == [c.status for c in a2.constraints]
        assert via_rescue.verdict == via_file.verdict and via_rescue.violations == via_file.violations
        for f in METRIC_FIELDS:
            if f != "mean_sun_clearance_deg":  # averaged over direct-sunlight time
                assert getattr(via_rescue.metrics, f) == getattr(via_file.metrics, f), f
        sun_rescue, sun_file = a1.metrics.sunlight_duration.value, a2.metrics.sunlight_duration.value
        assert sun_rescue is not None and sun_file == sun_rescue + H  # the sliver hour
        assert a1.metrics.power_lit_duration.value == a2.metrics.power_lit_duration.value


@pytest.mark.parametrize(
    ("meta_edit", "expected"),
    [
        ({}, 6),  # generator 1.2: explicit meta.fraction_decimals
        ({"fraction_decimals": None, "generator_version": "1.1"}, 6),  # fallback by version
        ({"fraction_decimals": None, "generator_version": "1.0"}, 3),
        ({"fraction_decimals": None, "generator_version": None}, None),  # not stated: never guessed
        ({"fraction_decimals": "6"}, None),  # malformed: never coerced
    ],
    ids=["1.2-explicit", "1.1-fallback", "1.0-fallback", "unstated", "malformed"],
)
def test_precision_metadata_and_generator_fallback(
    tmp_path: Path, meta_edit: dict[str, Any], expected: int | None
) -> None:
    meta = {k: v for k, v in {**_raw(PNS)["meta"], **meta_edit}.items() if v is not None}
    _write_copy(tmp_path, PNS, "2027-03-01T00:00Z", 24 * 4, meta=meta)
    provider = PrecomputedTimelineProvider(fallback=SyntheticTimelineProvider(), data_dir=tmp_path)
    site = get_site(PNS).to_site()
    landing = datetime(2027, 3, 1, tzinfo=UTC)
    tl = provider.timeline(site, landing, landing + timedelta(hours=47), 1.0)
    info = precomputed_file_info(tl.source, tmp_path)
    assert info is not None and info.fraction_decimals == expected
    sc = make(Scenario, site=site, landing_utc=landing, duration_days=2)
    series = timeline_to_series(tl, mission_end_utc=landing + timedelta(days=2), precomputed_data_dir=tmp_path)
    assert series.fraction_decimals == expected
    if expected is not None and "fraction_decimals" not in meta_edit:  # untouched 1.2 file: matches the adapter
        assert series.fraction_decimals == load_site_file(tmp_path / f"{PNS}.json").fraction_decimals
    # Precision metadata is provenance only on this path: it never changes a result.
    result = evaluate_timeline_detailed(sc, tl, precomputed_data_dir=tmp_path)[0]
    reference = Evaluator(provider=provider).evaluate(sc)
    assert compare(reference, result) == []


def test_committed_files_convert_identically_through_rescue_and_site_file_paths(
    provider: PrecomputedTimelineProvider,
) -> None:
    """Two full years, four original sites: identical Sun/Earth states sample for sample, except exactly
    at sub-precision slivers (none in the committed generator 1.2 files), and the same precision."""
    for site_id in ORIGINAL_FOUR:
        site = site_from_file(site_id)
        tl = provider.timeline(site, DATA_START, DATA_END, 1.0)
        via_rescue = timeline_to_series(tl, precomputed_data_dir=SITES_DIR)
        via_file = load_site_file(SITES_DIR / f"{site_id}.json")
        assert len(via_rescue.samples) == len(via_file.samples) == 17_545
        assert via_rescue.fraction_decimals == via_file.fraction_decimals == 6
        raw = _raw(site_id)["timeline"]
        slivers = {
            i
            for i, (f, v) in enumerate(zip(raw["sun_visible_fraction"], raw["sun_visible"], strict=True))
            if v and f == 0.0
        }
        sun_diff = {
            i
            for i, (a, b) in enumerate(zip(via_rescue.samples, via_file.samples, strict=True))
            if a.sun.state != b.sun.state
        }
        assert sun_diff == slivers, site_id
        assert all(a.earth.state == b.earth.state for a, b in zip(via_rescue.samples, via_file.samples, strict=True))


# --- rescue's search, sensitivity and compromise on the canonical engine -----------------------------


def test_rescue_search_matches_placeholder_except_ranking(canonical: Evaluator, placeholder: Evaluator) -> None:
    plan = make(Scenario, site=get_site(PNS).to_site(), landing_utc=datetime(2027, 3, 1, tzinfo=UTC))
    req = make(
        RescueRequest,
        original=plan,
        change=make(PlanChange, launch_delay_days=14, reason="test"),
        search=make(SearchOptions, date_window_days=20, robustness_check=False),
    )
    old, new = rescue(req, placeholder), rescue(req, canonical)
    assert new.status == old.status
    assert new.stats == old.stats  # same candidates, passing count, undecided, exclusions
    assert compare(old.changed, new.changed) == [] and compare(old.original, new.original) == []
    # Near misses are ranked by relative shortfall, which is identical: same list.
    assert [n.scenario for n in new.near_misses] == [n.scenario for n in old.near_misses]
    # Expected difference: Violation.message wording is the engine's own (rescue shows it verbatim); the
    # numbers behind it are identical (compare() above and in the side-by-side tests).
    assert [len(n.why_it_fails) for n in new.near_misses] == [len(n.why_it_fails) for n in old.near_misses]
    assert all(r.strip() for n in new.near_misses for r in n.why_it_fails)
    # Loosening: identical suggestions (same requirement changes, same unlocked plans, same wording).
    assert [s.model_dump(exclude={"unlocks_score"}) for s in new.loosening] == [
        s.model_dump(exclude={"unlocks_score"}) for s in old.loosening
    ]
    for s in new.loosening:  # every suggestion really makes its scenario pass on the canonical engine
        relaxed = s.unlocks.requirements.model_copy(update={c.constraint: c.suggested for c in s.changes})
        assert canonical.evaluate(s.unlocks.model_copy(update={"requirements": relaxed})).verdict == "pass"
    # Alternatives: all real, all canonical PASS; their order may differ (score formula; expected).
    assert new.alternatives
    for a in new.alternatives:
        assert a.viability.verdict == "pass" and is_real(a.viability) and a.viability.source == SOURCE
        assert a.viability.score is not None
    assert new.data_source == old.data_source and "synthetic" not in new.data_source


def test_rescue_with_robustness_runs_on_canonical_engine(canonical: Evaluator) -> None:
    plan = make(Scenario, site=get_site("connecting-ridge").to_site(), landing_utc=datetime(2027, 9, 1, tzinfo=UTC))
    r = rescue(make(RescueRequest, original=plan, change=make(PlanChange, launch_delay_days=10)), canonical)
    assert r.status in ("still_viable", "rescued", "no_viable_alternative")
    for a in r.alternatives:
        assert a.robustness is not None and 0.0 <= a.robustness.pass_rate <= 1.0


def test_rescue_past_end_of_data_stays_unknown_on_canonical_engine(canonical: Evaluator) -> None:
    plan = make(Scenario, site=get_site(PNS).to_site(), landing_utc=datetime(2028, 12, 10, tzinfo=UTC))
    r = rescue(make(RescueRequest, original=plan, change=make(PlanChange, launch_delay_days=20)), canonical)
    assert r.changed.verdict == "unknown" and r.alternatives == []
    assert r.stats.undecided > 0 and not any(s.keeps_original_plan for s in r.loosening)
    assert "synthetic" not in r.data_source and not r.assumptions[0].startswith("SYNTHETIC")


def test_sensitivity_matches_placeholder(canonical: Evaluator, placeholder: Evaluator) -> None:
    plan = make(Scenario, site=get_site("malapert-massif").to_site(), landing_utc=datetime(2027, 7, 20, tzinfo=UTC))
    req = make(SensitivityRequest, scenario=plan)
    old, new = sensitivity(req, placeholder), sensitivity(req, canonical)
    assert (new.verdict, new.skipped_points, new.most_sensitive_constraint) == (
        old.verdict,
        old.skipped_points,
        old.most_sensitive_constraint,
    )
    assert [(p.date_offset_hours, p.passes, p.failing_constraints) for p in new.points] == [
        (p.date_offset_hours, p.passes, p.failing_constraints) for p in old.points
    ]


def test_compromise_runs_on_canonical_engine_with_real_data_only(canonical: Evaluator) -> None:
    plan = make(Scenario, site=get_site(PNS).to_site(), landing_utc=datetime(2027, 3, 1, tzinfo=UTC))
    c = compromise(
        make(
            CompromiseRequest,
            scenario=plan,
            science=make(ScienceGoal, target_psr_id="shackleton-psr"),
            search=make(SearchOptions, date_window_days=5),
        ),
        canonical,
    )
    assert "synthetic" not in c.data_source
    for o in c.pareto_front:
        assert is_real(o.viability) and o.meets_engineering == o.viability.passes
        assert o.viability.score is not None and o.engineering_score == pytest.approx(
            o.viability.score / 100, abs=1e-4
        )  # rescue rounds to 4 dp


def test_simulation_mode_labels_every_result(canonical: Evaluator) -> None:
    """Simulation mode may combine real (catalog) and synthetic (nearby points) candidates. Each result
    carries its own ``data_source``; rescue's ranking itself is Member 5's (see the Phase 6B report)."""
    plan = make(Scenario, site=get_site(PNS).to_site(), landing_utc=datetime(2027, 3, 1, tzinfo=UTC))
    opts = make(SearchOptions, include_synthetic=True, robustness_check=False, date_window_days=6)
    r = rescue(make(RescueRequest, original=plan, change=make(PlanChange, launch_delay_days=3), search=opts), canonical)
    assert r.assumptions[0].startswith("SYNTHETIC")
    for a in r.alternatives:
        src = a.viability.data_source
        assert src.startswith("precomputed:") or src == "synthetic-placeholder"
        assert is_real(a.viability) == src.startswith("precomputed:")
        assert a.viability.source == SOURCE
