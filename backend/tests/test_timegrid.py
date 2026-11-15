"""One time policy on every screen (review item #4; app/timegrid.py).

Missions are evaluated on the hourly data grid: the landing time is rounded to the nearest whole UTC hour (half
rounds up) and the length to whole hours. Every result reports what was evaluated, so the same request gives the
same mission in the Planner readout, Comparison, Mission Rescue and the Feasibility Atlas.
"""
from datetime import datetime, timezone

from fastapi.testclient import TestClient

from app.main import app
from app.models import Scenario, Site
from app.rescue.engine import Evaluator
from app.timegrid import snap_duration_days, snap_time, time_note

client = TestClient(app)
UTC = timezone.utc
CR = {"id": "connecting-ridge", "name": "Connecting Ridge", "lat": -89.4505, "lon": 222.9}


def test_rounding_rules():
    assert snap_time(datetime(2027, 4, 17, 0, 15, tzinfo=UTC)) == datetime(2027, 4, 17, 0, 0, tzinfo=UTC)
    assert snap_time(datetime(2027, 4, 17, 0, 30, tzinfo=UTC)) == datetime(2027, 4, 17, 1, 0, tzinfo=UTC)
    assert snap_time(datetime(2027, 4, 17, 0, 29, 59, tzinfo=UTC)) == datetime(2027, 4, 17, 0, 0, tzinfo=UTC)
    assert snap_time(datetime(2027, 4, 17, 1, 0, tzinfo=UTC)) == datetime(2027, 4, 17, 1, 0, tzinfo=UTC)
    assert round(snap_duration_days(1.01) * 24) == 24
    assert snap_duration_days(7) == 7
    assert snap_duration_days(0.001) * 24 == 1  # at least one hour


def test_note_only_when_something_moved():
    on = datetime(2027, 2, 8, 0, 0, tzinfo=UTC)
    assert time_note(on, 7) is None
    note = time_note(datetime(2027, 2, 8, 0, 15, tzinfo=UTC), 1.01)
    assert "landing evaluated at 2027-02-08 00:00 UTC" in note and "length evaluated as 24 h" in note


def _compare(landing, days=7):
    body = {"scenarios": [{"key": "x", "scenario": {"site": CR, "landing_utc": landing, "duration_days": days}}]}
    r = client.post("/api/compare", json=body)
    assert r.status_code == 200
    return r.json()["results"][0]


def test_comparison_evaluates_the_grid_time_and_says_so():
    on, off = _compare("2027-02-08T00:00:00Z"), _compare("2027-02-08T00:15:00Z")
    # Same mission, same verdict and score: 00:15 is evaluated at 00:00 (it used to start at the 01:00 sample).
    assert off["viability"]["eligibility"] == on["viability"]["eligibility"]
    assert off["viability"]["score"] == on["viability"]["score"]
    assert off["evaluated_landing_utc"].startswith("2027-02-08T00:00")
    assert on["time_note"] is None and "00:00 UTC" in off["time_note"]


def test_rescue_and_comparison_judge_the_same_mission_alike():
    asked = datetime(2027, 2, 8, 0, 15, tzinfo=UTC)
    r = Evaluator(cache_size=0).evaluate(Scenario(site=Site(**CR), landing_utc=asked, duration_days=7))
    c = _compare("2027-02-08T00:15:00Z")
    assert r.eligibility == c["viability"]["eligibility"]
    assert r.score == c["viability"]["score"]


def test_atlas_snaps_its_start_and_reports_it():
    body = {"site_id": "connecting-ridge", "start_utc": "2027-02-08T00:15Z", "count": 3, "durations_days": [7]}
    d = client.post("/api/atlas", json=body).json()
    assert d["start_utc"].startswith("2027-02-08T00:00")
    assert all(t.endswith(":00Z") or t.endswith(":00:00Z") for t in d["landing_utc"])
    assert "first landing evaluated at" in d["time_note"]
    on = client.post("/api/atlas", json=body | {"start_utc": "2027-02-08T00:00Z"}).json()
    assert on.get("time_note") is None  # the Atlas omits empty fields
    # The first cell is the same mission the comparison judged at 00:15.
    assert d["cells"][0][0]["status"] == on["cells"][0][0]["status"]


def test_planner_readout_uses_the_same_hour():
    half = client.get("/api/sites/connecting-ridge/status", params={"time": "2027-02-08T00:30Z"}).json()
    one = client.get("/api/sites/connecting-ridge/status", params={"time": "2027-02-08T01:00Z"}).json()
    assert half["time_utc"] == one["time_utc"]  # half an hour rounds up, as everywhere else


# ---- the final dataset boundary: every screen lets the canonical engine judge a mission that starts inside the
# data and runs past its end: a verdict where the covered hours prove it (these cases have long uncovered tails, so
# they are a fail or unknown; a one-hour tail can prove a pass, see test_one_missing_hour_can_still_prove_a_pass)

def _three_ways(landing, days):
    c = _compare(landing, days)
    r = Evaluator(cache_size=0).evaluate(Scenario(site=Site(**CR), landing_utc=datetime.fromisoformat(landing.replace("Z", "+00:00")),
                                                  duration_days=days))
    a = client.post("/api/atlas", json={"site_id": "connecting-ridge", "start_utc": landing, "count": 1,
                                        "durations_days": [days]}).json()["cells"][0][0]
    return c, r, a


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def test_screens_agree_at_the_end_of_the_data():
    from datetime import timedelta
    from tests.data_range import data_range
    _, last = data_range("connecting-ridge")
    for landing, days in [(last - timedelta(hours=23), 1), (last - timedelta(days=2), 7), (last - timedelta(hours=12), 28)]:
        c, r, a = _three_ways(_iso(landing), days)
        verdict = c["viability"]["eligibility"]
        assert verdict in ("fail", "unknown")  # for these missions the covered hours do not prove a pass
        assert r.eligibility == verdict and a["status"] == verdict
        assert r.data_source.startswith("precomputed")  # real samples only, never the synthetic fallback
        assert r.score is None and c["viability"]["score"] is None


def test_one_missing_hour_can_still_prove_a_pass():
    """The canonical policy is bounded evidence, not "never a pass": a 3 d mission with one hour past the end of the
    data still PASSES when even the worst case for that hour passes. Every screen says so (and the Comparison
    withholds the whole-mission statistics it cannot compute, instead of inventing them)."""
    from datetime import timedelta
    from tests.data_range import data_range
    _, last = data_range("connecting-ridge")
    c, r, a = _three_ways(_iso(last - timedelta(hours=71)), 3)
    assert c["viability"]["eligibility"] == "pass"
    assert r.eligibility == "pass" and a["status"] == "pass"
    assert set(c["withheld"]) >= {"solar", "power", "earth"}  # the figures that need every hour are withheld
    assert all("bounds" in why for why in c["withheld"].values())  # the reason points at the engine's bounds
    body = client.post("/api/compare", json={"scenarios": [{"key": "x", "scenario": {
        "site": CR, "landing_utc": _iso(last - timedelta(hours=71)), "duration_days": 3}}]}).text
    assert "never a pass" not in body and "can show a fail" not in body


def test_comparison_withholds_window_stats_past_the_data():
    from datetime import timedelta
    from tests.data_range import data_range
    _, last = data_range("connecting-ridge")
    c = _compare(_iso(last - timedelta(days=2)), 7)
    assert c["solar"] is None and "Real data ends at" in c["message"]


def test_entirely_after_the_data_is_never_judged():
    from datetime import timedelta
    from tests.data_range import data_range
    _, last = data_range("connecting-ridge")
    landing = _iso(last + timedelta(days=1))
    c, r, a = _three_ways(landing, 1)
    assert c["status"] == "unavailable" and r.eligibility == "unknown" and a["status"] == "not_evaluated"
