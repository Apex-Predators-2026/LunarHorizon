"""``POST /api/viability/assess-scenario``: the Mission Planner's team ``Scenario`` assessed by the canonical engine.

The planner, Rescue and Comparison must agree on one mission: this endpoint converts the scenario with the same
``requirements_to_canonical`` mapping Rescue and Comparison use, so its verdict and score must equal what
``/api/compare`` reports for the same scenario on the same site file.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

SITE = {
    "malapert-massif": {"id": "malapert-massif", "name": "Malapert Massif", "lat": -85.9635, "lon": 357.6326},
    "connecting-ridge": {"id": "connecting-ridge", "name": "Connecting Ridge", "lat": -89.53432, "lon": 209.94767},
}


def _scenario(site: str, landing: str, days: float, **req: Any) -> dict[str, Any]:
    return {"site": SITE[site], "landing_utc": landing, "duration_days": days, "requirements": req}


def _compare_viability(scenario: dict[str, Any]) -> dict[str, Any]:
    body = {
        "scenarios": [
            {
                "key": "k",
                "scenario": scenario,
                "spacecraft": {
                    "panel_mode": "vertical_sun_tracking",
                    "panel_azimuth_deg": 0,
                    "panel_rated_power_w": None,
                    "average_load_w": None,
                    "battery_capacity_wh": None,
                },
            }
        ],
        "max_points": 50,
    }
    r = client.post("/api/compare", json=body)
    assert r.status_code == 200, r.text
    v: dict[str, Any] = r.json()["results"][0]["viability"]
    return v


@pytest.mark.parametrize(
    ("site", "landing", "days", "expected"),
    [
        ("malapert-massif", "2027-07-20T00:00:00Z", 14, "pass"),
        ("connecting-ridge", "2027-03-01T00:00:00Z", 14, "fail"),
    ],
)
def test_matches_the_comparison_service(site: str, landing: str, days: float, expected: str) -> None:
    sc = _scenario(site, landing, days)
    r = client.post("/api/viability/assess-scenario", json={"scenario": sc})
    assert r.status_code == 200, r.text
    body = r.json()
    a = body["assessment"]
    assert a["eligibility"] == expected
    cmp = _compare_viability(sc)
    assert cmp["eligibility"] == a["eligibility"]
    assert cmp["score"] == body["ranking_status"]["score"]
    assert cmp["configuration_key"] == body["ranking_status"]["comparability"]["configuration_key"]
    assert body["ranking_status"]["rank_eligible"] is (expected == "pass")
    # The requirement mapping is the shared one: battery_hours -> darkness limit in seconds.
    dark = next(c for c in a["constraints"] if c["constraint_id"] == "max_continuous_darkness")
    assert dark["threshold"] == 50 * 3600.0
    assert body["explanation_details"]


def test_failing_constraint_carries_an_evidence_window() -> None:
    sc = _scenario("connecting-ridge", "2027-03-01T00:00:00Z", 14)
    a = client.post("/api/viability/assess-scenario", json={"scenario": sc}).json()["assessment"]
    failed = [c for c in a["constraints"] if c["status"] == "fail"]
    assert failed
    dark = next(c for c in failed if c["constraint_id"] == "max_continuous_darkness")
    assert dark["evidence_windows"], "a failing duration constraint must point at its evidence"
    w = dark["evidence_windows"][0]
    assert w["start_utc"] < w["end_utc"]


def test_mission_past_the_data_is_unknown_not_fail() -> None:
    sites = client.get("/api/sites").json()
    end = next(s for s in sites if s["id"] == "connecting-ridge")["data_stop_utc"]
    # Land 7 days before the end of the data with a 14-day mission: half the mission has no data.
    from datetime import datetime, timedelta

    t_end = datetime.fromisoformat(end)
    landing = (t_end - timedelta(days=7)).strftime("%Y-%m-%dT%H:00:00Z")
    r = client.post("/api/viability/assess-scenario", json={"scenario": _scenario("connecting-ridge", landing, 14)})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["assessment"]["eligibility"] in ("unknown", "fail")
    if body["assessment"]["eligibility"] == "unknown":
        assert body["ranking_status"]["score"] is None
        assert body["ranking_status"]["rank_eligible"] is False
    assert body["input_dataset"]["mission_within_coverage"] is False


def test_custom_site_is_an_honest_404() -> None:
    sc = _scenario("malapert-massif", "2027-07-20T00:00:00Z", 7)
    sc["site"] = {**sc["site"], "id": "custom:-89.46012,221.98000"}
    r = client.post("/api/viability/assess-scenario", json={"scenario": sc})
    assert r.status_code == 404
    assert "precomputed" in r.json()["detail"]


def test_unknown_site_is_404_and_bad_input_is_422() -> None:
    sc = _scenario("malapert-massif", "2027-07-20T00:00:00Z", 7)
    sc["site"] = {**sc["site"], "id": "no-such-site"}
    assert client.post("/api/viability/assess-scenario", json={"scenario": sc}).status_code == 404
    bad = _scenario("malapert-massif", "2027-07-20T00:00:00Z", 0)
    assert client.post("/api/viability/assess-scenario", json={"scenario": bad}).status_code == 422


def test_off_grid_plan_is_evaluated_on_the_same_hourly_grid_as_the_comparison() -> None:
    """Integration (overnight recovery): the Planner's assess-scenario and the Comparison follow one time policy
    (app.timegrid). A landing at 00:15 for 1.01 days is evaluated as 00:00 for 24 h by both, so they agree."""
    sc = _scenario("malapert-massif", "2027-07-20T00:15:00Z", 1.01)
    r = client.post("/api/viability/assess-scenario", json={"scenario": sc})
    assert r.status_code == 200, r.text
    a = r.json()["assessment"]
    assert a["evaluated_start_utc"].startswith("2027-07-20T00:00:00")
    assert a["evaluated_end_utc"].startswith("2027-07-21T00:00:00")
    v = _compare_viability(sc)
    assert a["eligibility"] == v["eligibility"]
    assert v["score"] == r.json()["ranking_status"]["score"]
