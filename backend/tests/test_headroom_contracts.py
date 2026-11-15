"""TDD suite for canonical operational headroom exposure across Viability, Compare, and Rescue."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np
from fastapi.testclient import TestClient

from app.main import app
from app.models import MissionRequirements, Scenario
from app.rescue import Evaluator, rescue, sensitivity
from app.rescue.catalog import get_site
from app.rescue.schemas import PlanChange, RescueRequest, SearchOptions, SensitivityRequest
from app.rescue.timeline import Timeline
from app.viability.compat.rescue import evaluate_timeline_detailed

UTC = timezone.utc
client = TestClient(app)


def _timeline_with_gaps(
    start: datetime,
    hours: int,
    *,
    dark_span: tuple[int, int] | None,
    blackout_span: tuple[int, int] | None,
) -> Timeline:
    site = get_site("malapert-massif").to_site()
    t0 = np.datetime64(start.astimezone(UTC).replace(tzinfo=None), "s")
    times = t0 + np.arange(hours, dtype="timedelta64[h]").astype("timedelta64[s]")
    sun_el = np.full(hours, 2.0, dtype=float)
    sun_frac = np.ones(hours, dtype=float)
    earth_el = np.full(hours, 4.0, dtype=float)
    earth_vis = np.ones(hours, dtype=bool)
    for h in range(hours):
        if dark_span is not None and dark_span[0] <= h < dark_span[1]:
            sun_el[h] = -1.0
            sun_frac[h] = 0.0
        if blackout_span is not None and blackout_span[0] <= h < blackout_span[1]:
            earth_el[h] = -2.0
            earth_vis[h] = False
    return Timeline(
        site=site,
        times=times,
        step_hours=1.0,
        sun_az=np.zeros(hours, dtype=float),
        sun_el=sun_el,
        sun_horizon=np.zeros(hours, dtype=float),
        sun_visible_fraction=sun_frac,
        earth_az=np.full(hours, 180.0, dtype=float),
        earth_el=earth_el,
        earth_horizon=np.zeros(hours, dtype=float),
        earth_visible=earth_vis,
        source="synthetic-test",
    )


def test_comfortable_vs_borderline_darkness_headroom_for_50h_limit():
    start = datetime(2027, 1, 15, 0, 0, tzinfo=UTC)
    site = get_site("malapert-massif").to_site()
    req = MissionRequirements(
        battery_hours=50,
        max_comms_gap_hours=96,
        min_sunlight_fraction=0.5,
        min_earth_visibility_fraction=0.4,
        min_initial_sun_hours=24,
        min_initial_comms_hours=12,
    )
    sc = Scenario(site=site, landing_utc=start, duration_days=7, requirements=req)

    tl_roomy = _timeline_with_gaps(start, 7 * 24, dark_span=(40, 55), blackout_span=(20, 68))  # 15 h dark, 48 h blackout
    res_roomy, _ = evaluate_timeline_detailed(sc, tl_roomy)
    assert res_roomy.passes and res_roomy.headroom is not None
    hr_roomy = res_roomy.headroom
    assert hr_roomy.status == "comfortable"
    assert hr_roomy.darkness is not None
    assert hr_roomy.darkness.margin.status == "known"
    assert hr_roomy.darkness.margin.value == 35.0
    assert hr_roomy.communication_blackout is not None
    assert hr_roomy.communication_blackout.margin.value == 48.0
    assert hr_roomy.initial_sunlight.first_end_hours.value == 40.0
    assert hr_roomy.initial_earth.first_end_hours.value == 20.0
    assert "not a guarantee of spacecraft survival" in hr_roomy.screening_note.lower()

    tl_tight = _timeline_with_gaps(start, 7 * 24, dark_span=(40, 89), blackout_span=(20, 68))  # 49 h dark, 48 h blackout
    res_tight, _ = evaluate_timeline_detailed(sc, tl_tight)
    assert res_tight.passes and res_tight.headroom is not None
    hr_tight = res_tight.headroom
    assert hr_tight.status == "limited"
    assert hr_tight.darkness is not None
    assert hr_tight.darkness.margin.value == 1.0
    assert hr_tight.darkness.margin_class == "narrow"
    assert hr_tight.closest_constraint is not None
    assert hr_tight.closest_constraint.requirement_field == "battery_hours"
    assert "passes with limited darkness margin" in hr_tight.qualified_verdict.lower()
    assert "not a guarantee" in hr_tight.screening_note.lower()


def test_initial_windows_still_expose_duration_and_first_set_when_minimum_is_zero():
    start = datetime(2027, 1, 15, 0, 0, tzinfo=UTC)
    site = get_site("malapert-massif").to_site()
    req = MissionRequirements(battery_hours=50, min_initial_sun_hours=0, min_initial_comms_hours=0)
    sc = Scenario(site=site, landing_utc=start, duration_days=3, requirements=req)
    tl = _timeline_with_gaps(start, 72, dark_span=(30, 40), blackout_span=None)
    res, _ = evaluate_timeline_detailed(sc, tl)
    assert res.passes and res.headroom is not None
    assert res.headroom.initial_sunlight.duration.value == 30.0
    assert res.headroom.initial_sunlight.first_end_hours.value == 30.0
    assert res.headroom.initial_earth.duration.value == 72.0
    assert res.headroom.initial_earth.first_end_hours.status == "not_applicable"
    assert "stays" in res.headroom.initial_earth.summary_text.lower()


def test_compare_exposes_canonical_margins_and_headroom():
    mal = {"id": "malapert-massif", "name": "Malapert Massif", "lat": -85.9635, "lon": 357.6326}
    r = client.post(
        "/api/compare",
        json={"scenarios": [{"key": "a", "scenario": {"site": mal, "landing_utc": "2027-01-15T00:00:00Z", "duration_days": 7}}]},
    )
    assert r.status_code == 200
    a = r.json()["results"][0]["assessment"]
    assert "time_to_first_sunset_h" in a["metrics"]
    assert "time_to_first_earthset_h" in a["metrics"]
    assert len(a["margins"]) > 0
    assert a["headroom"] is not None
    assert a["headroom"]["screening_note"]
    assert a["headroom"]["initial_sunlight"] is not None
    assert a["headroom"]["initial_earth"] is not None


def test_rescue_and_sensitivity_expose_headroom_and_tested_date_slips(ev, pns_scenario):
    r_still = rescue(
        RescueRequest(
            original=pns_scenario,
            search=SearchOptions(date_window_days=2, include_nearby_points=False),
        ),
        ev,
    )
    assert r_still.status == "still_viable"
    assert r_still.changed.headroom is not None
    assert r_still.changed_robustness is not None
    assert len(r_still.changed_robustness.date_checks) > 0
    assert "not a survival guarantee" in r_still.summary.lower() or "not a guarantee" in r_still.summary.lower()

    r_resc = rescue(RescueRequest(original=pns_scenario, change=PlanChange(launch_delay_days=21)), ev)
    assert r_resc.status == "rescued"
    alt = r_resc.alternatives[0]
    assert alt.viability.headroom is not None
    assert alt.robustness is not None and len(alt.robustness.date_checks) > 0

    sens = sensitivity(
        SensitivityRequest(scenario=pns_scenario, date_offsets_hours=[-24, -12, 12, 24], position_offsets_km=[]),
        ev,
    )
    assert sens.screening_note and "not a guarantee" in sens.screening_note.lower()
    date_pts = [p for p in sens.points if p.distance_km == 0]
    assert any(p.darkness_headroom_h is not None for p in date_pts if p.status in ("pass", "fail"))
