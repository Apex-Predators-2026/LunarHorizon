"""Missions outside real-data coverage must be UNKNOWN, never silently synthetic.

Real data (data/sites/*.json) covers 2027-01-01 .. 2029-01-01 for the curated sites. Without
simulation mode (SearchOptions.include_synthetic = true), anything not fully covered by real
data is reported as eligibility 'unknown' with no score, instead of falling back to the
synthetic placeholder and returning a confident pass/fail. Raised by the viability owner.
"""
from datetime import datetime, timezone

import pytest

from app.models import Scenario, Site
from app.rescue import Evaluator, compromise, rescue, sensitivity
from app.rescue.catalog import custom_site, get_site
from app.rescue.engine import NO_DATA_SOURCE, is_real
from app.rescue.schemas import (CompromiseRequest, PlanChange, RescueRequest, ScienceGoal, SearchOptions,
                                SensitivityRequest)
from app.rescue.timeline.precomputed import DEFAULT_DATA_DIR

pytestmark = pytest.mark.skipif(not (DEFAULT_DATA_DIR / "peak-near-shackleton.json").exists(),
                                reason="precomputed site files not present")

UTC = timezone.utc
PNS = "peak-near-shackleton"


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
        assert "2027-01-01" in r.violations[0].message and "2029-01-01" in r.violations[0].message
    else:
        assert "no real" in r.violations[0].message.lower()


@pytest.mark.parametrize("t", [datetime(2028, 12, 28, tzinfo=UTC),   # crosses the end of the data
                               datetime(2030, 3, 1, tzinfo=UTC),     # entirely after it
                               datetime(2026, 12, 30, tzinfo=UTC)])  # starts before it
def test_missions_outside_real_data_are_unknown(ev, t):
    assert_unknown_no_data(ev.evaluate(plan(t)))


def test_missions_inside_real_data_are_unchanged(ev):
    r = ev.evaluate(plan(datetime(2028, 12, 24, 23, tzinfo=UTC)))  # last hour that fits a 7-day mission
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
    r = ev.evaluate(plan(datetime(2030, 3, 1, tzinfo=UTC)), simulation=True)
    assert r.data_source == "synthetic-placeholder" and r.verdict in ("pass", "fail")


def test_rescue_past_the_end_of_data_never_offers_synthetic_alternatives(ev):
    r = rescue(RescueRequest(original=plan(datetime(2028, 12, 10, tzinfo=UTC)),
                             change=PlanChange(launch_delay_days=20)), ev)
    assert r.changed.verdict == "unknown"
    assert r.alternatives == []  # every candidate date is past the data
    assert r.stats.undecided > 0
    assert "synthetic" not in r.data_source
    assert not any(s.keeps_original_plan for s in r.loosening)
    assert not r.assumptions[0].startswith("SYNTHETIC")


def test_rescue_near_the_end_keeps_real_options_only(ev):
    r = rescue(RescueRequest(original=plan(datetime(2028, 12, 1, tzinfo=UTC)),
                             change=PlanChange(launch_delay_days=5)), ev)
    for a in r.alternatives:
        assert is_real(a.viability)
    assert r.stats.undecided > 0  # later dates in the window run past the data
    assert "synthetic" not in r.data_source


def test_rescue_simulation_mode_is_opt_in(ev):
    r = rescue(RescueRequest(original=plan(datetime(2028, 12, 10, tzinfo=UTC)),
                             change=PlanChange(launch_delay_days=20),
                             search=SearchOptions(include_synthetic=True, robustness_check=False, date_window_days=5)), ev)
    assert r.changed.data_source == "synthetic-placeholder"
    assert r.assumptions[0].startswith("SYNTHETIC")


def test_sensitivity_of_unknown_plan_says_unknown(ev):
    s = sensitivity(SensitivityRequest(scenario=plan(datetime(2030, 3, 1, tzinfo=UTC))), ev)
    assert s.verdict == "unknown"
    assert s.points == [] and s.skipped_points > 0
    assert "no real data" in s.explanation.lower()


def test_sensitivity_near_the_end_skips_slips_past_the_data(ev):
    # Data ends 2029-01-01 00:00, so the latest 7-day start that fits is 2028-12-25 01:00.
    s = sensitivity(SensitivityRequest(scenario=plan(datetime(2028, 12, 24, tzinfo=UTC)),
                                       date_offsets_hours=[-24, 24, 48, 72], position_offsets_km=[]), ev)
    assert [p.date_offset_hours for p in s.points] == [-24, 24]
    assert s.skipped_points == 2


def test_compromise_without_real_data_is_tradeoff_with_no_synthetic_options(ev):
    c = compromise(CompromiseRequest(scenario=plan(datetime(2030, 3, 1, tzinfo=UTC)),
                                     science=ScienceGoal(target_psr_id="shackleton-psr"),
                                     search=SearchOptions(date_window_days=5)), ev)
    assert "synthetic" not in c.data_source
    assert all(is_real(o.viability) for o in c.pareto_front)
