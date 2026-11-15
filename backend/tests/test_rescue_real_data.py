"""Rescue on the data engine's real precomputed files (data/sites/*.json, Horizons + LOLA)."""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pytest

from app.engine.sites import SITES as ENGINE_SITES
from app.models import MissionRequirements, Scenario, Violation
from app.rescue import Evaluator, rescue, sensitivity
from app.rescue.catalog import NOT_LANDING_SITES, SITES_BY_ID, custom_site, get_site
from app.rescue.engine import is_real
from app.rescue.schemas import PlanChange, RescueRequest, SearchOptions, SensitivityRequest
from app.rescue.timeline import PrecomputedTimelineProvider, SyntheticTimelineProvider
from app.rescue.timeline.precomputed import DEFAULT_DATA_DIR, load_timeline_file
from tests.data_range import data_range

REAL_IDS = ["peak-near-shackleton", "connecting-ridge", "malapert-massif"]
pytestmark = pytest.mark.skipif(not all((DEFAULT_DATA_DIR / f"{i}.json").exists() for i in REAL_IDS),
                                reason="precomputed site files not present")


@pytest.fixture(scope="module")
def ev() -> Evaluator:
    return Evaluator()  # default provider: precomputed where available, synthetic elsewhere


@pytest.fixture
def plan() -> Scenario:
    # A 7-day plan at Peak Near Shackleton that passes on the real data.
    return Scenario(site=get_site("peak-near-shackleton").to_site(), landing_utc=datetime(2027, 10, 15, tzinfo=timezone.utc))


def test_approximate_engine_sites_stay_labelled_approximate():
    """The data engine precomputes some sites at rescue's approximate coordinates; rescue must keep
    saying they're approximate (and keep their descriptions) even though they now have real data."""
    for e in ENGINE_SITES:
        if e["source"].startswith("Approximate") and e["id"] not in NOT_LANDING_SITES:
            s = SITES_BY_ID[e["id"]]
            assert s.approximate and s.name.endswith("(approx.)") and s.description != e["name"], s


def test_catalog_uses_engine_sites_and_skips_controls():
    for e in ENGINE_SITES:
        if e["id"] == "shackleton-floor":
            assert e["id"] not in SITES_BY_ID  # permanently dark validation control, not a landing site
        else:
            s = SITES_BY_ID[e["id"]]
            assert (s.lat, s.lon) == (e["lat"], e["lon"])
            assert s.approximate == e["source"].startswith("Approximate")


@pytest.mark.parametrize("site_id", REAL_IDS)
def test_loader_reads_engine_columnar_files(site_id):
    path = DEFAULT_DATA_DIR / f"{site_id}.json"
    raw = json.loads(path.read_text(encoding="utf-8"))
    tl = load_timeline_file(path, get_site(site_id).to_site())
    assert len(tl) == len(raw["timeline"]["time_utc"]) and tl.step_hours == 1.0
    # Rescue reads exactly the numbers the engine wrote (its own summary agrees).
    assert 100 * tl.sun_visible_fraction.mean() == pytest.approx(raw["summary"]["mean_sun_fraction_pct"], abs=0.1)
    assert 100 * tl.earth_visible.mean() == pytest.approx(raw["summary"]["earth_visible_pct"], abs=0.1)
    assert np.allclose(tl.earth_margin, raw["timeline"]["earth_margin_deg"], atol=2e-3)


def test_loader_rejects_mismatched_columns(tmp_path):
    raw = json.loads((DEFAULT_DATA_DIR / "malapert-massif.json").read_text(encoding="utf-8"))
    raw["timeline"]["sun_visible_fraction"] = raw["timeline"]["sun_visible_fraction"][:-1]
    (tmp_path / "malapert-massif.json").write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ValueError, match="sun_visible_fraction"):
        load_timeline_file(tmp_path / "malapert-massif.json", get_site("malapert-massif").to_site())


def test_provider_coverage_and_unaligned_times(ev):
    site = get_site("malapert-massif").to_site()
    p: PrecomputedTimelineProvider = ev.provider
    assert p.has_data(site) and p.has_data(site, datetime(2027, 5, 1), datetime(2027, 6, 1))
    _, end = data_range("malapert-massif")
    assert not p.has_data(site, end + timedelta(days=365))
    assert not p.has_data(custom_site("x", site.lat, site.lon))
    # A landing at 12:30 still uses the real hourly data.
    r = ev.evaluate(Scenario(site=site, landing_utc=datetime(2027, 3, 1, 12, 30, tzinfo=timezone.utc)))
    assert is_real(r)
    # Outside the precomputed range -> UNKNOWN by default; synthetic only in simulation mode.
    late = Scenario(site=site, landing_utc=end + timedelta(days=60))
    r = ev.evaluate(late)
    assert r.verdict == "unknown" and r.score is None and r.data_source == "no-real-data"
    assert ev.evaluate(late, simulation=True).data_source == "synthetic-placeholder"


def test_rescue_on_real_data_never_mixes_in_synthetic(ev, plan):
    assert ev.evaluate(plan).passes
    r = rescue(RescueRequest(original=plan, change=PlanChange(launch_delay_days=10)), ev)
    assert r.status == "rescued"
    assert r.alternatives
    for a in r.alternatives:
        assert is_real(a.viability) and a.is_catalog_site
    for n in r.near_misses:
        assert is_real(n.viability)
    assert "synthetic" not in r.data_source
    assert r.stats.synthetic_candidates_excluded > 0
    assert r.assumptions[0].startswith("Real data")


def test_rescue_can_opt_in_to_synthetic(ev, plan):
    opts = SearchOptions(include_synthetic=True, robustness_check=False, date_window_days=10)
    r = rescue(RescueRequest(original=plan, change=PlanChange(launch_delay_days=10), search=opts), ev)
    assert r.stats.synthetic_candidates_excluded == 0
    assert "synthetic" in r.data_source and r.assumptions[0].startswith("SYNTHETIC")


def test_sensitivity_on_real_data_skips_synthetic_positions(ev, plan):
    s = sensitivity(SensitivityRequest(scenario=plan, position_offsets_km=[1], bearings=4), ev)
    assert s.position_pass_rate is None and s.skipped_points == 4
    assert s.date_pass_rate is not None
    # Skipped landing-position points stay in the list, marked not_evaluated; date slips are all evaluated.
    pos = [p for p in s.points if p.distance_km > 0]
    assert len(pos) == 4 and all(p.status == "not_evaluated" and not p.passes for p in pos)
    assert s.counts.skipped == 4 and s.counts.requested == len(s.points)
    assert "skipped" in s.explanation


def test_real_data_shows_malapert_has_the_best_earth_view(ev):
    """Sanity check against the engine summary: Malapert faces Earth, the polar sites do not."""
    t0 = datetime(2027, 1, 1, tzinfo=timezone.utc)
    starts = [t0 + timedelta(days=d) for d in range(0, 700, 14)]
    vis = {}
    for sid in REAL_IDS:
        rs = ev.evaluate_many(get_site(sid).to_site(), starts, 7, Scenario(site=get_site(sid).to_site(), landing_utc=t0).requirements)
        vis[sid] = np.mean([r.metrics.earth_visibility_fraction for r in rs])
    assert vis["malapert-massif"] > 0.95
    assert vis["malapert-massif"] > vis["peak-near-shackleton"] and vis["malapert-massif"] > vis["connecting-ridge"]


def test_synthetic_provider_still_used_in_unit_tests():
    # The other test modules pin the synthetic provider so they don't depend on data files.
    assert SyntheticTimelineProvider().timeline(get_site("malapert-massif").to_site(),
                                                datetime(2027, 1, 1), datetime(2027, 1, 2)).source == "synthetic-placeholder"


def test_data_dir_points_at_repo_data():
    assert DEFAULT_DATA_DIR == Path(__file__).resolve().parents[2] / "data" / "sites"


# ---- speed-ups must not change results: fast window path + evaluation cache ----------------------------

from app.rescue import compromise  # noqa: E402
from app.rescue.fastpath import window_series  # noqa: E402
from app.rescue.schemas import CompromiseRequest, ScienceGoal  # noqa: E402
from app.viability.compat import rescue as compat  # noqa: E402
from app.viability.engine import evaluate_scenario  # noqa: E402


def _slow() -> Evaluator:
    """The behaviour before the speed-ups: no cache, every window converted from scratch."""
    return Evaluator(cache_size=0, fast_windows=False)


def _mid_start(site_id: str = "connecting-ridge") -> datetime:
    first, _ = data_range(site_id)
    return datetime(first.year + 1, 10, 15, tzinfo=timezone.utc)  # well inside the data, whatever its range


def _dump(model) -> dict:
    return model.model_dump(mode="json")


@pytest.mark.parametrize("site_id", REAL_IDS)
def test_window_series_equals_the_canonical_conversion(site_id):
    """The fast path hands the engine exactly the series the compat layer builds for each window."""
    site = get_site(site_id).to_site()
    prov = PrecomputedTimelineProvider(fallback=SyntheticTimelineProvider())
    _, last = data_range(site_id)
    t0 = _mid_start(site_id)
    n = 7 * 24
    # one fetch, the last window ending exactly on the file's final sample
    final = last - timedelta(hours=n)
    starts = [t0 + timedelta(hours=12 * k) for k in range(6)] + [final]
    tl = prov.timeline(site, min(starts), max(starts) + timedelta(hours=n - 1))
    full = compat.timeline_to_series(tl)
    for t in starts:
        scen = Scenario(site=site, landing_utc=t, duration_days=7)
        i = tl.index_of(t)
        mission = compat.scenario_to_mission(scen)
        canonical = compat.timeline_to_series(tl.slice(i, i + n), mission_end_utc=mission.mission_end_utc)
        fast = window_series(full, tl, mission.mission_end_utc, i, i + n)
        assert fast == canonical
        assert (compat.assessment_to_result(evaluate_scenario(mission, fast), scen, tl.source)
                == compat.evaluate_timeline(scen, tl.slice(i, i + n)))


def test_evaluate_many_same_with_fast_path_cache_and_without():
    site = get_site("connecting-ridge").to_site()
    req = Scenario(site=site, landing_utc=_mid_start()).requirements
    starts = [_mid_start() + timedelta(hours=12 * k) for k in range(20)]
    before = _slow().evaluate_many(site, starts, 7, req)
    ev = Evaluator()
    cold = ev.evaluate_many(site, starts, 7, req)
    warm = ev.evaluate_many(site, starts, 7, req)  # served from the cache
    assert cold == before and warm == before
    assert ev.evaluations == len(starts) and ev.cache_hits == len(starts)
    # a different subset of the same starts reuses what it can and still agrees
    assert ev.evaluate_many(site, starts[5:9], 7, req) == before[5:9]


def test_rescue_response_unchanged_by_speedups():
    """Connecting Ridge, 10-day delay, default search options: alternatives (order, scores, verdicts),
    summary and everything else equal the pre-optimisation behaviour, also on a repeat from the cache."""
    sc = Scenario(site=get_site("connecting-ridge").to_site(), landing_utc=_mid_start())
    req = RescueRequest(original=sc, change=PlanChange(launch_delay_days=10))
    expected = rescue(req, _slow())
    ev = Evaluator()
    got = rescue(req, ev)
    again = rescue(req, ev)
    assert _dump(got) == _dump(expected) and _dump(again) == _dump(expected)
    assert [a.viability.score for a in got.alternatives] == [a.viability.score for a in expected.alternatives]
    assert [a.viability.verdict for a in got.alternatives] == [a.viability.verdict for a in expected.alternatives]
    assert got.summary == expected.summary and got.status == expected.status
    assert ev.cache_hits > 0


def test_sensitivity_and_compromise_unchanged_by_speedups():
    sc = Scenario(site=get_site("connecting-ridge").to_site(), landing_utc=_mid_start())
    assert _dump(sensitivity(SensitivityRequest(scenario=sc), Evaluator())) == \
        _dump(sensitivity(SensitivityRequest(scenario=sc), _slow()))
    creq = CompromiseRequest(scenario=sc, science=ScienceGoal(target_psr_id="shackleton-psr"),
                             search=SearchOptions(date_window_days=10, date_step_hours=24))
    ev = Evaluator()
    rescue(RescueRequest(original=sc, search=creq.search), ev)  # fills the cache with overlapping evaluations
    assert _dump(compromise(creq, ev)) == _dump(compromise(creq, _slow()))


def test_cached_results_are_copies():
    site = get_site("connecting-ridge").to_site()
    req = Scenario(site=site, landing_utc=_mid_start()).requirements
    ev = Evaluator()
    first = ev.evaluate_many(site, [_mid_start()], 7, req)[0]
    first.metrics.sunlight_fraction = -1.0
    n_viol = len(first.violations)
    first.violations.append(Violation(constraint="x", required=1, actual=0, unit="h", shortfall=1,
                                      relative_shortfall=1, message="mutated"))
    again = ev.evaluate_many(site, [_mid_start()], 7, req)[0]  # from the cache
    assert ev.cache_hits == 1 and len(again.violations) == n_viol and again.metrics.sunlight_fraction != -1.0
    assert again == _slow().evaluate_many(site, [_mid_start()], 7, req)[0]


def test_cache_is_thread_safe():
    """The router shares one Evaluator across a thread pool: hammer a tiny cache from several threads."""
    import threading
    site = get_site("connecting-ridge").to_site()
    res = Evaluator(cache_size=0).evaluate_many(site, [_mid_start()], 2, Scenario(site=site, landing_utc=_mid_start()).requirements)[0]
    ev = Evaluator(cache_size=4)
    errors = []

    def hammer(seed: int):
        try:
            for i in range(3000):
                key = ("k", (i * 7 + seed) % 11)
                ev._cache_put(key, res)
                ev._cache_get(key)
                ev._cache_get(("k", (i + seed) % 11))
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=hammer, args=(s,)) for s in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert not errors and len(ev._cache) <= 4


def test_cache_is_bounded_and_never_mixes_real_and_synthetic():
    site = get_site("connecting-ridge").to_site()
    req = Scenario(site=site, landing_utc=_mid_start()).requirements
    ev = Evaluator(cache_size=3)
    ev.evaluate_many(site, [_mid_start() + timedelta(hours=h) for h in range(10)], 2, req)
    assert len(ev._cache) == 3
    # past the real data: unknown without simulation, synthetic with it, whichever is asked first
    _, last = data_range("connecting-ridge")
    late = last + timedelta(days=30)
    for order in ((False, True), (True, False)):
        ev = Evaluator()
        out = {sim: ev.evaluate_many(site, [late, late + timedelta(hours=1)], 2, req, simulation=sim)
               for sim in order}
        assert all(not is_real(r) and r.eligibility == "unknown" for r in out[False])
        assert all(r.data_source == "synthetic-placeholder" for r in out[True])


# ---------------------------------------------------------------- demo scenario and release gate

DEMO_PATH = Path(__file__).resolve().parents[1] / "app" / "rescue" / "demo_scenario.json"


def _demo_request() -> RescueRequest:
    d = json.loads(DEMO_PATH.read_text(encoding="utf-8"))
    return RescueRequest(original=Scenario(**d["original"]), change=PlanChange(**d["change"]))


def _demo_in_data_range(req: RescueRequest) -> None:
    first, last = data_range(req.original.site.id)
    end = req.original.landing_utc + timedelta(days=req.change.launch_delay_days + 31 + req.original.duration_days)
    if req.original.landing_utc < first or end > last:
        pytest.skip("demo scenario is outside the data's time range")


def test_demo_scenario_transition():
    """The preset: passes as planned, fails after the delay (battery darkness), rescue finds a pass."""
    d = json.loads(DEMO_PATH.read_text(encoding="utf-8"))
    assert d["story"] and d["change"]["launch_delay_days"] > 0
    req = _demo_request()
    _demo_in_data_range(req)
    res = rescue(req, Evaluator())
    assert res.status == "rescued"
    assert res.original.verdict == "pass" and not res.original.violations
    assert res.changed.verdict == "fail"
    assert [v.constraint for v in res.changed.violations] == ["battery_hours"]
    assert res.changed.violations[0].actual > res.changed.violations[0].required
    assert res.alternatives and all(a.viability.verdict == "pass" for a in res.alternatives)
    assert res.alternatives[0].rank == 1 and res.stats.passing >= len(res.alternatives)
    # Version 2: the story's numbers are recorded under "verified" and recomputed here, on real data and the hourly grid.
    v = d["verified"]
    assert d["version"] == 2
    assert res.original.score == v["original"]["score"] and res.original.verdict == v["original"]["verdict"]
    bad = res.changed.violations[0]
    assert res.changed.scenario.landing_utc == datetime.fromisoformat(v["delayed"]["landing_utc"].replace("Z", "+00:00"))
    assert (bad.constraint, bad.actual, bad.required) == (v["delayed"]["constraint"], v["delayed"]["actual_h"],
                                                          v["delayed"]["limit_h"])
    first = res.alternatives[0]
    fa = v["first_alternative"]
    assert (first.scenario.site.id, first.date_shift_hours, first.viability.verdict, first.viability.score) == (
        fa["site_id"], fa["date_shift_hours"], fa["verdict"], fa["score"])
    assert first.scenario.landing_utc == datetime.fromisoformat(fa["landing_utc"].replace("Z", "+00:00"))
    # The story quotes exactly these numbers; nothing in it is free text a recomputation can't catch.
    story = d["story"]
    for quoted in (f"{bad.actual:.0f} h", f"{bad.required:.0f} h", f"{fa['date_shift_hours']:.0f} h",
                   f"{fa['date_shift_hours'] / 24:g} days", "2027-02-16 12:00 UTC", "2027-02-13"):
        assert quoted in story, quoted


def test_demo_scenario_does_not_depend_on_default_requirements():
    """Every requirement is written out, so changing MissionRequirements' defaults cannot change the demo."""
    d = json.loads(DEMO_PATH.read_text(encoding="utf-8"))
    written = d["original"]["requirements"]
    assert set(written) == set(MissionRequirements.model_fields)
    assert _demo_request().original.requirements == MissionRequirements(**written)
    assert d["verified"]["delayed"]["limit_h"] == written[d["verified"]["delayed"]["constraint"]]


def _release_gate(req: RescueRequest) -> None:
    _demo_in_data_range(req)
    res = rescue(req, Evaluator())
    assert res.alternatives
    direct = Evaluator(cache_size=0, fast_windows=False)  # the canonical engine, nothing reused
    for a in res.alternatives:
        again = direct.evaluate(a.scenario)
        assert again.verdict == "pass" and a.viability.verdict == "pass"
        assert again.score == a.viability.score and again.passes == a.viability.passes
        assert again.violations == a.viability.violations


def test_release_gate_demo_alternatives_pass_canonical_engine():
    _release_gate(_demo_request())


def test_release_gate_second_case_alternatives_pass_canonical_engine():
    sc = Scenario(site=get_site("malapert-massif").to_site(), landing_utc=datetime(2027, 7, 15, tzinfo=timezone.utc))
    _release_gate(RescueRequest(original=sc, change=PlanChange(launch_delay_days=14)))
