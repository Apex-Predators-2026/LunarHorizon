"""Missions outside real-data coverage must be UNKNOWN, never silently synthetic.

Real data (data/sites/*.json) covers a fixed range (see tests/data_range.py) for the curated sites. Without
simulation mode (SearchOptions.include_synthetic = true), anything not fully covered by real
data is reported as eligibility 'unknown' with no score, instead of falling back to the
synthetic placeholder and returning a confident pass/fail. Raised by the viability owner.
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.models import Scenario, Site
from app.rescue import Evaluator, compromise, rescue, sensitivity
from app.rescue.catalog import custom_site, get_site
from app.rescue.engine import NO_DATA_SOURCE, is_real
from app.rescue.schemas import (CompromiseRequest, PlanChange, RescueRequest, ScienceGoal, SearchOptions,
                                SensitivityRequest)
from app.rescue.timeline.precomputed import DEFAULT_DATA_DIR
from tests.data_range import data_range, day

pytestmark = pytest.mark.skipif(not (DEFAULT_DATA_DIR / "peak-near-shackleton.json").exists(),
                                reason="precomputed site files not present")

UTC = timezone.utc
PNS = "peak-near-shackleton"
DATA_START, DATA_END = data_range(PNS) if (DEFAULT_DATA_DIR / f"{PNS}.json").exists() else (None, None)


@pytest.fixture(scope="module")
def ev() -> Evaluator:
    return Evaluator()  # default: real data only


def plan(t: datetime, site_id: str = PNS) -> Scenario:
    return Scenario(site=get_site(site_id).to_site(), landing_utc=t)


def assert_unknown_no_data(r, dates: bool = True):
    assert r.eligibility == "unknown" and r.verdict == "unknown" and not r.passes
    assert r.score is None
    assert r.data_source == NO_DATA_SOURCE and not is_real(r)
    assert len(r.violations) == 1 and r.violations[0].is_unknown
    assert r.violations[0].constraint == "data_coverage"
    if dates:  # sites with real data say which period it covers
        assert day(DATA_START) in r.violations[0].message and day(DATA_END) in r.violations[0].message
    else:
        assert "no real" in r.violations[0].message.lower()


@pytest.mark.parametrize("t", [DATA_END - timedelta(days=4),       # crosses the end of the data
                               DATA_END + timedelta(days=60),      # entirely after it
                               DATA_START - timedelta(days=2)])    # starts before it
def test_missions_outside_real_data_are_unknown(ev, t):
    assert_unknown_no_data(ev.evaluate(plan(t)))


def test_missions_inside_real_data_are_unchanged(ev):
    r = ev.evaluate(plan(DATA_END - timedelta(hours=168)))  # latest start of a 7-day mission that ends by the last sample
    assert is_real(r) and r.eligibility in ("pass", "fail") and r.score is not None


def test_sites_without_real_data_are_unknown_by_default(ev):
    # A named site with no precomputed file, and a custom point: both have no real data.
    unlisted = Site(id="unlisted-site", name="Unlisted site", lat=-88.0, lon=40.0)
    assert_unknown_no_data(ev.evaluate(Scenario(site=unlisted, landing_utc=datetime(2027, 6, 1, tzinfo=UTC))),
                           dates=False)
    custom = custom_site("near the peak", -89.02, 126.3)
    assert_unknown_no_data(ev.evaluate(Scenario(site=custom, landing_utc=datetime(2027, 6, 1, tzinfo=UTC))),
                           dates=False)


def test_simulation_mode_uses_synthetic_data_explicitly(ev):
    r = ev.evaluate(plan(DATA_END + timedelta(days=60)), simulation=True)
    assert r.data_source == "synthetic-placeholder" and r.verdict in ("pass", "fail")


def test_rescue_past_the_end_of_data_never_offers_synthetic_alternatives(ev):
    r = rescue(RescueRequest(original=plan(DATA_END - timedelta(days=22)),
                             change=PlanChange(launch_delay_days=20)), ev)
    assert r.changed.verdict == "unknown"
    assert r.alternatives == []  # every candidate date is past the data
    assert r.stats.undecided > 0
    assert "synthetic" not in r.data_source
    assert not any(s.keeps_original_plan for s in r.loosening)
    assert not r.assumptions[0].startswith("SYNTHETIC")


def test_rescue_near_the_end_keeps_real_options_only(ev):
    r = rescue(RescueRequest(original=plan(DATA_END - timedelta(days=31)),
                             change=PlanChange(launch_delay_days=5)), ev)
    for a in r.alternatives:
        assert is_real(a.viability)
    assert r.stats.undecided > 0  # later dates in the window run past the data
    assert "synthetic" not in r.data_source


def test_rescue_simulation_mode_is_opt_in(ev):
    r = rescue(RescueRequest(original=plan(DATA_END - timedelta(days=22)),
                             change=PlanChange(launch_delay_days=20),
                             search=SearchOptions(include_synthetic=True, robustness_check=False, date_window_days=5)), ev)
    assert r.changed.data_source == "synthetic-placeholder"
    assert r.assumptions[0].startswith("SYNTHETIC")


def test_sensitivity_of_unknown_plan_says_unknown(ev):
    s = sensitivity(SensitivityRequest(scenario=plan(DATA_END + timedelta(days=60))), ev)
    assert s.verdict == "unknown"
    assert s.points == [] and s.skipped_points > 0
    assert "no real data" in s.explanation.lower()


def test_sensitivity_near_the_end_skips_slips_past_the_data(ev):
    # A 7-day mission must end by the last sample, so starts up to DATA_END - 7 days fit.
    s = sensitivity(SensitivityRequest(scenario=plan(DATA_END - timedelta(days=8)),
                                       date_offsets_hours=[-24, 24, 48, 72], position_offsets_km=[]), ev)
    assert [p.date_offset_hours for p in s.points] == [-24, 24]
    assert s.skipped_points == 2


def test_compromise_without_real_data_is_tradeoff_with_no_synthetic_options(ev):
    c = compromise(CompromiseRequest(scenario=plan(DATA_END + timedelta(days=60)),
                                     science=ScienceGoal(target_psr_id="shackleton-psr"),
                                     search=SearchOptions(date_window_days=5)), ev)
    assert "synthetic" not in c.data_source
    assert all(is_real(o.viability) for o in c.pareto_front)
