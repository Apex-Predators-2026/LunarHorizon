"""Rescue with the 'unknown' verdict, nullable scores and the panel-threshold fix
(changes agreed with the viability owner)."""
from datetime import datetime, timedelta, timezone

import numpy as np

from app.models import MissionRequirements, Scenario, ViabilityMetrics, ViabilityResult, Violation
from app.rescue import Evaluator, compromise, rescue
from app.rescue.catalog import get_site
from app.rescue.schemas import CompromiseRequest, PlanChange, RescueRequest, ScienceGoal, SearchOptions
from app.rescue.timeline import SyntheticTimelineProvider
from app.rescue.timeline.base import Timeline
from app.rescue.viability.placeholder import compute_metrics, evaluate_timeline

T0 = datetime(2027, 1, 7, tzinfo=timezone.utc)
METRICS = ViabilityMetrics(sunlight_fraction=1, equivalent_sun_hours=1, longest_dark_gap_hours=0,
                           earth_visibility_fraction=1, longest_comms_gap_hours=0, initial_sun_hours=1,
                           initial_comms_hours=1, hours_to_first_sunset=None, hours_to_first_earthset=None,
                           mean_sun_clearance_deg=1, mean_earth_clearance_deg=1, mean_solar_elevation_deg=1)


def _violation(unknown: bool) -> Violation:
    if unknown:
        return Violation(constraint="min_earth_visibility_fraction", required=0.4, actual=0.0, unit="fraction",
                         shortfall=0.4, relative_shortfall=1.0, is_unknown=True,
                         message="UNKNOWN: Earth visibility could not be determined (terrain data missing).")
    return Violation(constraint="battery_hours", required=50, actual=55, unit="h", shortfall=5,
                     relative_shortfall=0.1, message="Longest power gap is 55 h, above the 50 h requirement.")


def _result(sc: Scenario, verdict: str, *, mixed: bool = False) -> ViabilityResult:
    violations = {"pass": [], "fail": [_violation(False)], "unknown": [_violation(True)]}[verdict]
    if mixed:
        violations = [_violation(False), _violation(True)]
    return ViabilityResult(scenario=sc, passes=verdict == "pass", eligibility=verdict,
                           score={"pass": 80.0, "fail": 40.0}.get(verdict), metrics=METRICS,
                           violations=violations, source="fake", data_source="fake")


def _rescue_with(verdict_for, **search):
    ev = Evaluator(provider=SyntheticTimelineProvider(), simulation=True,
                   evaluate=lambda sc, tl: _result(sc, *verdict_for(sc)))
    plan = Scenario(site=get_site("peak-near-shackleton").to_site(), landing_utc=T0)
    opts = SearchOptions(date_window_days=6, date_step_hours=24, include_nearby_points=False,
                         robustness_check=False, **search)
    return rescue(RescueRequest(original=plan, change=PlanChange(launch_delay_days=1), search=opts), ev)


def test_unknown_is_neither_an_alternative_nor_a_near_miss():
    def verdict(sc):
        if sc.site.id == "malapert-massif" and sc.landing_utc == T0 + timedelta(days=3):
            return ("pass",)
        return ("unknown",) if sc.site.id == "connecting-ridge" else ("fail",)

    r = _rescue_with(verdict)
    assert r.status == "rescued"
    assert [a.scenario.site.id for a in r.alternatives] == ["malapert-massif"]
    assert r.stats.undecided == 7  # connecting ridge, 7 dates
    assert all(n.viability.eligibility == "fail" for n in r.near_misses)
    # No loosening advice is built from undecided (missing-data) results.
    assert all(s.unlocks.site.id != "connecting-ridge" for s in r.loosening)


def test_missing_data_never_gets_loosening_advice_and_summary_says_so():
    r = _rescue_with(lambda sc: ("unknown",))
    assert r.status == "no_viable_alternative"
    assert r.alternatives == [] and r.near_misses == [] and r.loosening == []
    assert "can't be checked" in r.summary and "missing data" in r.summary
    assert r.changed.score is None  # unscored result passes through without becoming 0


def test_failure_that_is_partly_unknown_gets_no_loosening():
    r = _rescue_with(lambda sc: ("fail",))
    assert r.loosening  # plain failures do get advice
    ev = Evaluator(provider=SyntheticTimelineProvider(), simulation=True, evaluate=lambda sc, tl: _result(sc, "fail", mixed=True))
    plan = Scenario(site=get_site("peak-near-shackleton").to_site(), landing_utc=T0)
    r2 = rescue(RescueRequest(original=plan, change=PlanChange(launch_delay_days=1),
                              search=SearchOptions(date_window_days=3, date_step_hours=24, include_nearby_points=False,
                                                   robustness_check=False)), ev)
    assert r2.loosening == []
    assert r2.near_misses  # still listed as failures, ranked on their known shortfalls only


def test_compromise_tolerates_unscored_results():
    ev = Evaluator(provider=SyntheticTimelineProvider(), simulation=True, evaluate=lambda sc, tl: _result(sc, "unknown"))
    plan = Scenario(site=get_site("peak-near-shackleton").to_site(), landing_utc=T0)
    c = compromise(CompromiseRequest(scenario=plan, science=ScienceGoal(target_psr_id="shackleton-psr"),
                                     search=SearchOptions(date_window_days=2, include_nearby_points=False)), ev)
    assert c.status == "tradeoff_required"
    assert all(o.engineering_score == 0 and not o.meets_engineering for o in c.pareto_front)


def test_verdict_falls_back_to_passes_for_older_evaluators():
    sc = Scenario(site=get_site("malapert-massif").to_site(), landing_utc=T0)
    old = ViabilityResult(scenario=sc, passes=False, score=10, metrics=METRICS, violations=[_violation(False)],
                          source="old", data_source="x")
    assert old.eligibility is None and old.verdict == "fail" and not old.violations[0].is_unknown


def _dark_timeline(hours: int = 48) -> Timeline:
    site = get_site("malapert-massif").to_site()
    times = np.arange(np.datetime64("2027-01-01T00:00"), np.datetime64("2027-01-01T00:00") + np.timedelta64(hours, "h"),
                      np.timedelta64(1, "h")).astype("datetime64[s]")
    z = np.zeros(hours)
    return Timeline(site=site, times=times, step_hours=1.0, sun_az=z, sun_el=z - 5, sun_horizon=z,
                    sun_visible_fraction=z, earth_az=z, earth_el=z + 5, earth_horizon=z,
                    earth_visible=np.ones(hours, bool), source="test")


def test_total_darkness_is_never_lit_even_with_threshold_zero():
    m = compute_metrics(_dark_timeline(), MissionRequirements(panel_threshold=0.0))
    assert m.sunlight_fraction == 0
    assert m.longest_dark_gap_hours == 48 and m.initial_sun_hours == 0
    assert m.hours_to_first_sunset is None


def test_placeholder_reports_eligibility():
    sc = Scenario(site=get_site("malapert-massif").to_site(), landing_utc=datetime(2027, 1, 1, tzinfo=timezone.utc),
                  duration_days=3)
    r = evaluate_timeline(sc, _dark_timeline(72))  # 72 h dark > 50 h battery
    assert r.eligibility == "fail" and not r.passes and r.verdict == "fail"
    assert "battery_hours" in {v.constraint for v in r.violations}
