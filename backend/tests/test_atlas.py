"""Feasibility Atlas (/api/atlas): every cell is the canonical engine's verdict for that exact mission."""
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.atlas.service import _series, slice_series
from app.main import app
from app.engine.sites import ALL_SITES
from app.models import MissionRequirements, Scenario, Site
from app.viability.compat.rescue import scenario_to_mission
from app.viability.engine import evaluate_scenario

client = TestClient(app)


def _site(site_id):
    s = next(x for x in ALL_SITES if x["id"] == site_id)
    return Site(id=s["id"], name=s["name"], lat=s["lat"], lon=s["lon"])


def post(**kw):
    body = {"site_id": "malapert-massif", "start_utc": "2027-01-01T00:00Z", "count": 20, "durations_days": [7, 28]} | kw
    return client.post("/api/atlas", json=body)


def test_grid_shape_and_counts():
    r = post()
    assert r.status_code == 200
    d = r.json()
    assert d["durations_days"] == [7, 28] and len(d["landing_utc"]) == 20
    assert len(d["cells"]) == 2 and all(len(row) == 20 for row in d["cells"])
    assert sum(d["counts"].values()) == 40
    assert d["landing_utc"][1] == "2027-01-02T00:00Z"  # the stated sampling interval (24 h by default)
    assert "nothing is interpolated" in d["method"]


def test_each_cell_is_the_canonical_verdict_for_that_exact_mission():
    d = post(count=12, step_hours=60).json()
    site = _site("malapert-massif")
    full = _series("malapert-massif")
    for row in d["cells"]:
        for cell in row[::3]:
            landing = datetime.fromisoformat(cell["landing_utc"].replace("Z", "+00:00"))
            sc = Scenario(site=site, landing_utc=landing, duration_days=cell["duration_days"], requirements=MissionRequirements())
            a = evaluate_scenario(scenario_to_mission(sc), full)  # on the whole 5-year series, not the slice
            assert cell["status"] == a.eligibility.value
            assert {c["id"]: c["status"] for c in cell["constraints"]} == {c.constraint_id.value: c.status.value for c in a.constraints}


def test_slicing_never_changes_a_verdict_near_the_end_of_the_data():
    full = _series("malapert-massif")
    end = full.coverage_end_utc
    site = _site("malapert-massif")
    for hours_before, days in [(24 * 40, 28), (24 * 10, 28), (24 * 3, 7), (30, 3)]:
        landing = end - timedelta(hours=hours_before)
        part = slice_series(full, landing, min(end, landing + timedelta(days=days)))
        m = scenario_to_mission(Scenario(site=site, landing_utc=landing, duration_days=days, requirements=MissionRequirements()))
        a, b = evaluate_scenario(m, part), evaluate_scenario(m, full)
        assert a.eligibility == b.eligibility
        assert [c.status for c in a.constraints] == [c.status for c in b.constraints]


def test_landings_without_any_data_are_not_evaluated_not_unknown():
    d = post(start_utc="2030-12-20T00:00Z", count=20, durations_days=[7]).json()
    statuses = [c["status"] for c in d["cells"][0]]
    assert "not_evaluated" in statuses
    first_out = statuses.index("not_evaluated")
    assert all(s == "not_evaluated" for s in statuses[first_out:])
    cell = d["cells"][0][first_out]
    assert "No data for this landing" in cell["reason"] and not cell.get("constraints")
    assert d["data_stop_utc"].startswith("2031-01-01") or d["data_stop_utc"].startswith("2030-12-31")


def test_the_limiting_requirement_explains_each_cell():
    d = post(count=60, durations_days=[28]).json()
    req = {r["id"]: r for r in d["requirements"]}
    row = d["cells"][0]
    fails = [c for c in row if c["status"] == "fail"]
    passes = [c for c in row if c["status"] == "pass"]
    assert fails and passes  # Malapert, 28-day missions in early 2027: a boundary inside the window
    for c in fails:
        lim = next(x for x in c["constraints"] if x["id"] == c["limiting"])
        assert lim["status"] == "fail" and c["reason"].startswith("Fails: ")
        assert req[c["limiting"]]["name"] in c["reason"]
    for c in passes:
        lim = next(x for x in c["constraints"] if x["id"] == c["limiting"])
        assert lim["status"] == "pass"
        # the passing requirement closest to its limit (relative to the limit)
        rel = lambda x: x["margin"] / abs(req[x["id"]]["threshold"])  # noqa: E731
        known = [x for x in c["constraints"] if x["status"] == "pass" and x.get("margin") is not None]
        assert rel(lim) == min(rel(x) for x in known)


def test_requirements_change_the_map():
    loose = post(count=30, durations_days=[14]).json()["counts"]["pass"]
    strict = post(count=30, durations_days=[14], requirements={"battery_hours": 5}).json()
    assert strict["requirements_input"]["battery_hours"] == 5
    assert strict["counts"]["pass"] < loose


def test_bounds_are_enforced():
    assert post(count=121).status_code == 422
    assert post(count=100, durations_days=[1, 2, 3, 4, 5, 6, 7]).status_code == 422  # > 600 cells
    assert post(step_hours=0.5).status_code == 422
    assert post(durations_days=[0]).status_code == 422
    assert post(site_id="nowhere").status_code == 404


@pytest.mark.parametrize("site", ["connecting-ridge", "apollo-11"])
def test_other_sites(site):
    r = post(site_id=site, count=10, durations_days=[7])
    assert r.status_code == 200 and sum(r.json()["counts"].values()) == 10
