import numpy as np

from app.models import MissionRequirements, ViabilityMetrics
from app.rescue.viability.placeholder import (first_false_hours, find_violations, leading_run_hours, longest_run_hours, score,
                                       compute_metrics)


def test_run_helpers():
    m = np.array([True, True, False, True, True, True, False])
    assert longest_run_hours(m, 2.0) == 6.0
    assert longest_run_hours(np.zeros(4, bool), 1.0) == 0.0
    assert leading_run_hours(m, 1.0) == 2.0
    assert leading_run_hours(~m, 1.0) == 0.0
    assert first_false_hours(m, 1.0) == 2.0
    assert first_false_hours(np.ones(5, bool), 1.0) is None


def _metrics(**kw) -> ViabilityMetrics:
    base = dict(sunlight_fraction=0.6, equivalent_sun_hours=100, longest_dark_gap_hours=40,
                earth_visibility_fraction=0.5, longest_comms_gap_hours=80, initial_sun_hours=30,
                initial_comms_hours=20, hours_to_first_sunset=30, hours_to_first_earthset=20,
                mean_sun_clearance_deg=1, mean_earth_clearance_deg=1, mean_solar_elevation_deg=0.5)
    base.update(kw)
    return ViabilityMetrics(**base)


def test_violations_and_score():
    req = MissionRequirements()
    ok = _metrics()
    assert find_violations(ok, req) == []
    bad = _metrics(sunlight_fraction=0.4, longest_dark_gap_hours=60, initial_comms_hours=0)
    v = {x.constraint: x for x in find_violations(bad, req)}
    assert set(v) == {"min_sunlight_fraction", "battery_hours", "min_initial_comms_hours"}
    assert v["battery_hours"].shortfall == 10 and v["battery_hours"].relative_shortfall == 0.2
    assert abs(v["min_sunlight_fraction"].shortfall - 0.1) < 1e-9
    assert 0 <= score(bad, req) < score(ok, req) <= 100


def test_score_is_half_at_exact_requirements():
    req = MissionRequirements()
    exact = _metrics(sunlight_fraction=req.min_sunlight_fraction, longest_dark_gap_hours=req.battery_hours,
                     earth_visibility_fraction=req.min_earth_visibility_fraction,
                     longest_comms_gap_hours=req.max_comms_gap_hours, initial_sun_hours=req.min_initial_sun_hours,
                     initial_comms_hours=req.min_initial_comms_hours)
    assert abs(score(exact, req) - 50) < 1e-6


def test_metrics_respect_panel_threshold(ev, pns_scenario):
    from datetime import timedelta
    tl = ev.provider.timeline(pns_scenario.site, pns_scenario.landing_utc,
                              pns_scenario.landing_utc + timedelta(days=7), 1.0)
    lenient = compute_metrics(tl, MissionRequirements(panel_threshold=0.0))
    strict = compute_metrics(tl, MissionRequirements(panel_threshold=1.0))
    assert strict.longest_dark_gap_hours >= lenient.longest_dark_gap_hours
