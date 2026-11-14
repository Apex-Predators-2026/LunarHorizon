"""Rescue on the data engine's real precomputed files (data/sites/*.json, Horizons + LOLA)."""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pytest

from app.engine.sites import SITES as ENGINE_SITES
from app.models import Scenario
from app.rescue import Evaluator, rescue, sensitivity
from app.rescue.catalog import SITES_BY_ID, custom_site, get_site
from app.rescue.engine import is_real
from app.rescue.schemas import PlanChange, RescueRequest, SearchOptions, SensitivityRequest
from app.rescue.timeline import PrecomputedTimelineProvider, SyntheticTimelineProvider
from app.rescue.timeline.precomputed import DEFAULT_DATA_DIR, load_timeline_file

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


def test_catalog_uses_engine_sites_and_skips_controls():
    for e in ENGINE_SITES:
        if e["id"] == "shackleton-floor":
            assert e["id"] not in SITES_BY_ID  # permanently dark validation control, not a landing site
        else:
            s = SITES_BY_ID[e["id"]]
            assert (s.lat, s.lon) == (e["lat"], e["lon"]) and not s.approximate


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
    assert not p.has_data(site, datetime(2030, 1, 1))
    assert not p.has_data(custom_site("x", site.lat, site.lon))
    # A landing at 12:30 still uses the real hourly data.
    r = ev.evaluate(Scenario(site=site, landing_utc=datetime(2027, 3, 1, 12, 30, tzinfo=timezone.utc)))
    assert is_real(r)
    # Outside the precomputed range -> synthetic fallback, clearly labelled.
    r = ev.evaluate(Scenario(site=site, landing_utc=datetime(2030, 3, 1, tzinfo=timezone.utc)))
    assert r.data_source == "synthetic-placeholder"


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
    assert all(p.distance_km == 0 for p in s.points)
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
