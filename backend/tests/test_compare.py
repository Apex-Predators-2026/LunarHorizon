"""Multi-Scenario Comparison (Member 4): /api/compare and its statistics."""
from datetime import datetime, timezone

import numpy as np
from fastapi.testclient import TestClient

from app.compare.schemas import SpacecraftConfig
from app.compare.service import incidence_factor, runs, windows
from app.main import app
from app.models import Site
from app.rescue.timeline import Timeline

client = TestClient(app)

MALAPERT = {"id": "malapert-massif", "name": "Malapert Massif", "lat": -85.9635, "lon": 357.6326}
PNS = {"id": "peak-near-shackleton", "name": "Peak Near Shackleton", "lat": -89.01701, "lon": 126.27302}


def _item(key, site, landing="2027-01-15T00:00:00Z", days=14, **spacecraft):
    return {"key": key, "scenario": {"site": site, "landing_utc": landing, "duration_days": days},
            "spacecraft": spacecraft}


def _tl(frac, earth, el=None, az=None):
    n = len(frac)
    el = np.full(n, 2.0) if el is None else np.asarray(el, float)
    return Timeline(
        site=Site(**MALAPERT), times=np.datetime64("2027-01-01T00:00:00", "s") + np.arange(n) * np.timedelta64(3600, "s"),
        step_hours=1.0, sun_az=np.zeros(n) if az is None else np.asarray(az, float), sun_el=el,
        sun_horizon=np.zeros(n), sun_visible_fraction=np.asarray(frac, float), earth_az=np.zeros(n),
        earth_el=np.full(n, 3.0), earth_horizon=np.zeros(n), earth_visible=np.asarray(earth, bool), source="test")


# ---------- pure statistics ----------

def test_runs_and_windows_flag_open_edges():
    mask = np.array([1, 1, 0, 0, 0, 1, 0, 1], bool)
    assert runs(mask) == [(0, 2), (5, 6), (7, 8)]
    w = windows(mask, _tl(mask.astype(float), mask))
    assert [(x.start_hour, x.duration_hours, x.open_start, x.open_end) for x in w] == [
        (0, 2, True, False), (5, 1, False, False), (7, 1, False, True)]
    assert w[0].start_utc == "2027-01-01T00:00Z" and w[0].end_utc == "2027-01-01T02:00Z"
    assert runs(np.array([], bool)) == []


def test_incidence_factor_models():
    tl = _tl([1.0, 0.5, 0.0], [1, 1, 1], el=[0.0, 30.0, 10.0], az=[90.0, 90.0, 90.0])
    assert np.allclose(incidence_factor(tl, SpacecraftConfig(panel_mode="two_axis")), [1, 0.5, 0])
    assert np.allclose(incidence_factor(tl, SpacecraftConfig(panel_mode="vertical_sun_tracking")),
                       [1, 0.5 * np.cos(np.radians(30)), 0])
    assert np.allclose(incidence_factor(tl, SpacecraftConfig(panel_mode="horizontal")),
                       [0, 0.5 * np.sin(np.radians(30)), 0])
    # Fixed panel facing away from the Sun gets nothing (max(0, cos θ)).
    back = incidence_factor(tl, SpacecraftConfig(panel_mode="vertical_fixed", panel_azimuth_deg=270))
    assert np.allclose(back, 0)


# ---------- endpoint ----------

def test_compare_real_sites_match_engine_data():
    r = client.post("/api/compare", json={"scenarios": [_item("a", MALAPERT), _item("b", PNS)]})
    assert r.status_code == 200
    a, b = r.json()["results"]
    assert a["key"] == "a" and a["status"] == "ok" and a["data_kind"] == "real"
    assert a["data_source"].startswith("precomputed")
    assert len(a["timeline"]["hour"]) == 14 * 24
    # Window totals add up to the mission and match the summary numbers.
    s = a["solar"]
    assert abs(sum(w["duration_hours"] for w in a["sun_windows"]) - s["sunlit_hours"]) < 1e-9
    assert abs(s["sunlit_hours"] + sum(w["duration_hours"] for w in a["dark_windows"]) - 14 * 24) < 1e-9
    assert s["longest_dark_hours"] == max([w["duration_hours"] for w in a["dark_windows"]], default=0)
    e = b["earth"]
    assert abs(e["visible_hours"] + sum(w["duration_hours"] for w in b["blackout_windows"]) - 14 * 24) < 1e-9
    # Viability comes from the team evaluator and agrees with our own Earth statistics.
    assert a["viability"]["source"] and a["viability"]["metrics"]["earth_visibility_fraction"] == e["visible_fraction"] \
        or b["viability"]["metrics"]["earth_visibility_fraction"] == e["visible_fraction"]
    assert b["viability"]["metrics"]["longest_comms_gap_hours"] == e["longest_blackout_hours"]


def test_compare_events_alternate():
    b = client.post("/api/compare", json={"scenarios": [_item("b", PNS)]}).json()["results"][0]
    sun = [ev["type"] for ev in b["events"] if ev["type"] in ("sunrise", "sunset")]
    assert all(x != y for x, y in zip(sun, sun[1:]))


def test_out_of_range_is_unavailable_not_fabricated():
    r = client.post("/api/compare", json={"scenarios": [_item("x", MALAPERT, landing="2031-01-01T00:00:00Z")]})
    res = r.json()["results"][0]
    assert res["status"] == "unavailable" and res["data_kind"] == "unavailable"
    assert res["viability"] is None and res["timeline"] is None
    from tests.data_range import data_range, day  # the real data's end date, not a fixed year
    assert day(data_range("malapert-massif")[1]) in res["message"]


def test_unknown_site_unavailable_then_demo_when_opted_in():
    site = {"id": "custom:-88.00000,100.00000", "name": "Somewhere", "lat": -88.0, "lon": 100.0}
    off = client.post("/api/compare", json={"scenarios": [_item("x", site)]}).json()
    assert off["results"][0]["status"] == "unavailable"
    on = client.post("/api/compare", json={"scenarios": [_item("x", site)], "allow_demo_data": True}).json()
    res = on["results"][0]
    assert res["status"] == "ok" and res["data_kind"] == "demonstration"
    assert res["data_source"].startswith("synthetic")
    assert "DEMONSTRATION" in on["notes"][0]


def test_power_ceiling_uses_spacecraft_config():
    item = _item("p", PNS, panel_rated_power_w=400, average_load_w=100, battery_capacity_wh=5000)
    p = client.post("/api/compare", json={"scenarios": [item]}).json()["results"][0]["power"]
    assert p["battery_endurance_hours"] == 50
    assert abs(p["idealized_energy_wh"] - 400 * p["equivalent_full_power_hours"]) < 1e-6
    assert abs(p["idealized_energy_to_load_ratio"] - p["idealized_energy_wh"] / (100 * 14 * 24)) < 1e-9
    assert 0 <= p["mean_incidence_factor"] <= 1


def test_decimation_and_limits():
    r = client.post("/api/compare", json={"scenarios": [_item("l", MALAPERT, days=200)], "max_points": 500})
    tl = r.json()["results"][0]["timeline"]
    assert len(tl["hour"]) <= 500 and tl["step_hours"] > 1
    assert client.post("/api/compare", json={"scenarios": []}).status_code == 422
    too_many = [_item(str(i), MALAPERT) for i in range(7)]
    assert client.post("/api/compare", json={"scenarios": too_many}).status_code == 422


def test_science_context_present_for_every_result():
    res = client.post("/api/compare", json={"scenarios": [_item("a", PNS)]}).json()["results"][0]
    sc = res["science_context"]
    assert sc["nearest_psr_id"] and sc["distance_to_psr_edge_km"] >= 0
    assert "demonstration" in sc["source"]
    assert datetime.fromisoformat(res["timeline"]["time_utc"][0].replace("Z", "+00:00")) == \
        datetime(2027, 1, 15, tzinfo=timezone.utc)
