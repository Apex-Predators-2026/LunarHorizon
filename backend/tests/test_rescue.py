from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from app.rescue.geo import distance_km
from app.rescue import Evaluator, rescue
from app.rescue.schemas import PlanChange, RequirementOverrides, RescueRequest, SearchOptions
from app.models import MissionRequirements, Scenario, ViabilityMetrics, ViabilityResult, Violation
from app.rescue.catalog import get_site
from app.rescue.timeline import SyntheticTimelineProvider


def apply_changes(req: MissionRequirements, suggestion) -> MissionRequirements:
    return req.model_copy(update={c.constraint: c.suggested for c in suggestion.changes})


def test_no_delay_on_a_good_plan_is_still_viable(ev, pns_scenario):
    r = rescue(RescueRequest(original=pns_scenario), ev)
    assert r.original.passes and r.changed.passes
    assert r.status == "still_viable"
    assert not any(s.keeps_original_plan for s in r.loosening)


def test_delay_that_breaks_the_plan_is_rescued(ev, pns_scenario):
    r = rescue(RescueRequest(original=pns_scenario, change=PlanChange(launch_delay_days=21)), ev)
    assert not r.changed.passes
    assert r.status == "rescued"
    assert 1 <= len(r.alternatives) <= 5
    delayed = pns_scenario.landing_utc + timedelta(days=21)
    for i, a in enumerate(r.alternatives, start=1):
        assert a.rank == i
        assert a.viability.passes
        assert a.scenario.landing_utc >= delayed  # can't land before the new launch allows
        assert a.headline and a.reasons
        assert a.robustness is not None
        assert any(m.metric == "score" for m in a.improvements)
    scores = [a.rank_score for a in r.alternatives]
    assert scores == sorted(scores, reverse=True)
    # The rescue explains which broken requirements it fixes.
    assert any(reason.startswith("Fixes:") for reason in r.alternatives[0].reasons)


def test_alternatives_are_diverse(ev, pns_scenario):
    r = rescue(RescueRequest(original=pns_scenario, change=PlanChange(launch_delay_days=21)), ev)
    alts = r.alternatives
    for i, a in enumerate(alts):
        for b in alts[i + 1:]:
            same_place = distance_km(a.scenario.site.lat, a.scenario.site.lon, b.scenario.site.lat, b.scenario.site.lon) < 6
            close_in_time = abs((a.scenario.landing_utc - b.scenario.landing_utc).total_seconds()) < 48 * 3600
            assert not (same_place and close_in_time)


def test_search_options_are_respected(ev, pns_scenario):
    opts = SearchOptions(date_window_days=5, date_step_hours=24, candidate_site_ids=["connecting-ridge"],
                         include_nearby_points=False, top_n=2, robustness_check=False)
    r = rescue(RescueRequest(original=pns_scenario, change=PlanChange(launch_delay_days=21), search=opts), ev)
    assert r.stats.locations_considered == 2  # original + connecting ridge
    assert r.stats.candidates_evaluated == 2 * 6  # 6 dates (0..5 days)
    assert len(r.alternatives) <= 2
    assert {a.scenario.site.id for a in r.alternatives} <= {"peak-near-shackleton", "connecting-ridge"}
    assert all(a.robustness is None for a in r.alternatives)


def test_max_site_distance_filter(ev, pns_scenario):
    opts = SearchOptions(max_site_distance_km=40, include_nearby_points=False, robustness_check=False)
    r = rescue(RescueRequest(original=pns_scenario, change=PlanChange(launch_delay_days=21), search=opts), ev)
    for a in r.alternatives:
        assert a.distance_km <= 40


def test_impossible_requirements_give_exact_loosening(ev, pns_scenario):
    # A 7-day (168 h) mission can't have 500 h of continuous sun/Earth after landing.
    hard = RequirementOverrides(min_initial_sun_hours=500, min_initial_comms_hours=500)
    opts = SearchOptions(date_window_days=10, robustness_check=False)
    r = rescue(RescueRequest(original=pns_scenario, change=PlanChange(launch_delay_days=21,
                                                                      requirement_overrides=hard), search=opts), ev)
    assert r.status == "no_viable_alternative"
    assert r.alternatives == []
    assert r.loosening and r.near_misses
    assert r.loosening[0].keeps_original_plan
    # Applying any suggestion must make the scenario it names pass.
    for s in r.loosening:
        sc = s.unlocks.model_copy(update={"requirements": apply_changes(s.unlocks.requirements, s)})
        assert ev.evaluate(sc).passes, s.message
    # Near misses are sorted closest first.
    closeness = [n.closeness for n in r.near_misses]
    assert closeness == sorted(closeness)


def test_new_duration_and_requirements_are_applied(ev, pns_scenario):
    r = rescue(RescueRequest(original=pns_scenario, change=PlanChange(
        launch_delay_days=3, new_duration_days=10, requirement_overrides=RequirementOverrides(battery_hours=30))), ev)
    assert r.changed.scenario.duration_days == 10
    assert r.changed.scenario.requirements.battery_hours == 30
    assert r.changed.scenario.requirements.max_comms_gap_hours == pns_scenario.requirements.max_comms_gap_hours
    assert r.changed.scenario.landing_utc == pns_scenario.landing_utc + timedelta(days=3)


def test_synthetic_data_is_flagged(ev, pns_scenario):
    r = rescue(RescueRequest(original=pns_scenario, change=PlanChange(launch_delay_days=1)), ev)
    assert "synthetic" in r.data_source
    assert r.assumptions[0].startswith("SYNTHETIC DATA")


def _fake_result(scenario: Scenario, passes: bool, score: float) -> ViabilityResult:
    m = ViabilityMetrics(sunlight_fraction=1, equivalent_sun_hours=1, longest_dark_gap_hours=0,
                         earth_visibility_fraction=1, longest_comms_gap_hours=0, initial_sun_hours=1,
                         initial_comms_hours=1, hours_to_first_sunset=None, hours_to_first_earthset=None,
                         mean_sun_clearance_deg=1, mean_earth_clearance_deg=1, mean_solar_elevation_deg=1)
    v = [] if passes else [Violation(constraint="battery_hours", required=50, actual=60, unit="h", shortfall=10,
                                     relative_shortfall=0.2, message="Longest power gap is 60 h, above 50 h.")]
    return ViabilityResult(scenario=scenario, passes=passes, score=score, metrics=m, violations=v,
                           source="fake", data_source="fake")


def test_rescue_uses_whatever_evaluator_it_is_given(pns_scenario):
    """Swapping in Brandon's evaluator must just work: rescue only reads passes/score/violations."""
    target_day = pns_scenario.landing_utc + timedelta(days=21 + 4)

    def fake(scenario, timeline):
        ok = scenario.site.id == "malapert-massif" and scenario.landing_utc == target_day
        return _fake_result(scenario, ok, 80 if ok else 30)

    ev = Evaluator(provider=SyntheticTimelineProvider(), simulation=True, evaluate=fake)
    opts = SearchOptions(date_window_days=10, date_step_hours=24, include_nearby_points=False, robustness_check=False)
    r = rescue(RescueRequest(original=pns_scenario, change=PlanChange(launch_delay_days=21), search=opts), ev)
    assert r.status == "rescued"
    assert len(r.alternatives) == 1
    a = r.alternatives[0]
    assert a.scenario.site.id == "malapert-massif" and a.scenario.landing_utc == target_day
    assert a.kind == "site_and_date"
    assert a.date_shift_hours == pytest.approx(96)


def test_unknown_site_id_raises(ev, pns_scenario):
    with pytest.raises(KeyError):
        rescue(RescueRequest(original=pns_scenario, search=SearchOptions(candidate_site_ids=["atlantis"])), ev)


def test_times_without_a_timezone_are_rejected():
    """Team decision: a mission time with no timezone is an error, never silently assumed to be UTC."""
    with pytest.raises(ValidationError, match="timezone"):
        Scenario(site=get_site("malapert-massif").to_site(), landing_utc=datetime(2027, 3, 1))


def test_aware_times_are_converted_to_utc(ev):
    plus2 = timezone(timedelta(hours=2))
    sc = Scenario(site=get_site("malapert-massif").to_site(), landing_utc=datetime(2027, 3, 1, 2, tzinfo=plus2))
    assert sc.landing_utc == datetime(2027, 3, 1, tzinfo=timezone.utc) and sc.landing_utc.tzinfo == timezone.utc
    rescue(RescueRequest(original=sc, change=PlanChange(launch_delay_days=2),
                         search=SearchOptions(date_window_days=3, robustness_check=False)), ev)
