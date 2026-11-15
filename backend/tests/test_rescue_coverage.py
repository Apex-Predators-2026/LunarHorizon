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
from app.rescue.sensitivity import quick_robustness
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


@pytest.mark.parametrize("t", [DATA_END + timedelta(days=60),      # entirely after the data
                               DATA_START - timedelta(days=2)])    # starts before it
def test_missions_outside_real_data_are_unknown(ev, t):
    assert_unknown_no_data(ev.evaluate(plan(t)))


def test_missions_crossing_the_end_of_data_are_judged_on_real_hours_only(ev):
    # Starts inside the data, ends past it: the canonical engine judges the hours that exist (a provable fail,
    # otherwise unknown), as the Comparison and the Atlas do. Never a pass, never a score, never synthetic.
    r = ev.evaluate(plan(DATA_END - timedelta(days=4)))
    assert r.eligibility in ("fail", "unknown") and is_real(r) and r.score is None


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
    assert r.changed.verdict in ("fail", "unknown")  # judged on the real hours left (a long tail: a fail or unknown)
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
    assert s.skipped_points == len(s.points) > 0  # every requested point is listed, none decided
    dates = [p for p in s.points if p.distance_km == 0]
    positions = [p for p in s.points if p.distance_km > 0]
    # Each slip was looked up on its own: all are outside the real data, so unknown with that reason.
    assert dates and all(p.status == "unknown" and p.reason == "outside_coverage" for p in dates)
    # Landing-position checks are unsupported on real data (no terrain around the site): skipped, not unknown.
    assert positions and all(p.status == "not_evaluated" and p.reason == "position_unsupported" for p in positions)
    assert s.counts.by_reason == {"outside_coverage": len(dates), "position_unsupported": len(positions)}
    assert s.counts.requested == s.counts.unknown + s.counts.skipped
    assert s.safe_date_window_hours is None and s.date_pass_rate is None
    assert "does not cover" in s.explanation


def test_unknown_plan_still_judges_neighbouring_dates_that_real_data_covers(ev):
    # The planned date starts a day before the data, so it can't be judged; slips of +48 h and +72 h lie
    # fully inside the data and are separate missions, judged on their own.
    s = sensitivity(SensitivityRequest(scenario=plan(DATA_START - timedelta(days=1)),
                                       date_offsets_hours=[-24, 48, 72], position_offsets_km=[]), ev)
    assert s.base.verdict == "unknown" and s.verdict == "unknown"
    by = {p.date_offset_hours: p for p in s.points}
    assert by[-24].status == "unknown" and by[-24].reason == "outside_coverage"
    assert all(by[h].status in ("pass", "fail") and by[h].reason is None for h in (48, 72))
    assert s.date_pass_rate is not None  # rate over the slips that could be decided
    assert s.safe_date_window_hours is None  # no window around a plan that is itself undecided
    assert "separate mission" in s.explanation and "can't be judged" in s.explanation
    assert s.counts.passed + s.counts.failed == 2 and s.counts.by_reason == {"outside_coverage": 1}


def test_site_without_any_real_data_says_so_per_point(ev):
    far = custom_site("No data here", -84.0, 30.0)
    s = sensitivity(SensitivityRequest(scenario=Scenario(site=far, landing_utc=DATA_START + timedelta(days=30)),
                                       date_offsets_hours=[-24, 24], position_offsets_km=[1], bearings=2), ev)
    assert s.verdict == "unknown"
    assert [p.reason for p in s.points if p.distance_km == 0] == ["no_real_data", "no_real_data"]
    assert all(p.reason == "position_unsupported" for p in s.points if p.distance_km > 0)
    assert "has no real data" in s.explanation


def test_sensitivity_near_the_end_skips_slips_past_the_data(ev):
    # A 7-day mission must end by the last sample, so starts up to DATA_END - 7 days fit.
    s = sensitivity(SensitivityRequest(scenario=plan(DATA_END - timedelta(days=8)),
                                       date_offsets_hours=[-24, 24, 48, 72], position_offsets_km=[]), ev)
    assert [p.date_offset_hours for p in s.points] == [-24, 24, 48, 72]  # slips past the data stay listed
    # Slips that run past the data are judged on the real hours left: a verdict only where those hours prove it (here a fail or unknown).
    assert all(p.status in ("fail", "unknown") for p in s.points[2:])
    assert all(p.status in ("pass", "fail") for p in s.points[:2])
    assert s.counts.requested == 4 and s.counts.passed + s.counts.failed + s.counts.unknown == 4


def test_compromise_without_real_data_is_tradeoff_with_no_synthetic_options(ev):
    c = compromise(CompromiseRequest(scenario=plan(DATA_END + timedelta(days=60)),
                                     science=ScienceGoal(target_psr_id="shackleton-psr"),
                                     search=SearchOptions(date_window_days=5)), ev)
    assert "synthetic" not in c.data_source
    assert all(is_real(o.viability) for o in c.pareto_front)


# --- landing times that are not on the whole hour ---

@pytest.mark.parametrize("off", [timedelta(minutes=30), timedelta(seconds=20), timedelta(minutes=-20)])
def test_off_grid_landing_time_gets_the_on_grid_verdict(ev, off):
    t = DATA_START + timedelta(days=10)
    on = ev.evaluate(plan(t))
    assert on.verdict != "unknown" and on.score is not None
    r = ev.evaluate(plan(t + off))
    assert r.verdict == on.verdict and r.score == on.score and r.eligibility == on.eligibility
    # the result shows the landing time that was actually evaluated: the nearest whole hour
    # (half an hour rounds up)
    expected = t + timedelta(hours=1) if off == timedelta(minutes=30) else t
    assert r.scenario.landing_utc == expected


def test_rescue_with_a_fractional_launch_delay_is_decided(ev):
    t = DATA_START + timedelta(days=10)
    srch = SearchOptions(robustness_check=False, date_window_days=3)
    on = rescue(RescueRequest(original=plan(t), change=PlanChange(launch_delay_days=1), search=srch), ev)
    assert on.changed.verdict != "unknown"
    r = rescue(RescueRequest(original=plan(t), change=PlanChange(launch_delay_days=0.3), search=srch), ev)
    assert r.changed.verdict != "unknown" and r.changed.score is not None
    assert r.changed.scenario.landing_utc.minute == 0 and r.changed.scenario.landing_utc.second == 0
    assert r.stats.undecided == 0


def test_robustness_with_nothing_checked_claims_nothing(ev):
    rob = quick_robustness(plan(DATA_END + timedelta(days=60)), ev)
    assert rob.checked_points == 0
    assert rob.pass_rate is None
    assert rob.verdict == "unchecked"
    assert rob.note == "Robustness not checked: no real data around this date or site."
