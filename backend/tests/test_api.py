"""API checks: data-engine endpoints (against data/sites, no network) and rescue endpoints."""

import numpy as np
from fastapi.testclient import TestClient

from app.engine.visibility import next_edge
from app.main import app

client = TestClient(app)


# ---------- data engine (Andrew) ----------

def test_next_edge():
    on = np.array([1, 1, 0, 0, 1, 1, 0], dtype=bool)
    assert next_edge(on, 0, False) == 2  # sunlit now -> sets at 2
    assert next_edge(on, 0, True) == 4  # next rise is after that
    assert next_edge(on, 2, True) == 4  # dark now -> rises at 4
    assert next_edge(on, 5, True) is None  # never rises again in the data


def test_list_sites():
    r = client.get("/api/sites")
    assert r.status_code == 200
    ids = {s["id"] for s in r.json()}
    assert {"connecting-ridge", "peak-near-shackleton", "malapert-massif", "shackleton-floor"} <= ids
    floor = next(s for s in r.json() if s["id"] == "shackleton-floor")
    assert floor["summary"]["sunlit_pct"] == 0


def test_unknown_site_404():
    assert client.get("/api/sites/nope/horizon").status_code == 404


def test_horizon():
    h = client.get("/api/sites/connecting-ridge/horizon").json()
    assert len(h["azimuth_deg"]) == len(h["elevation_deg"]) == len(h["distance_m"]) == 720


def test_timeline_range_and_step():
    r = client.get(
        "/api/sites/connecting-ridge/timeline",
        params={"start": "2027-03-01T00:00Z", "end": "2027-03-02T00:00Z", "step_hours": 6},
    )
    steps = r.json()
    assert [s["time_utc"] for s in steps] == [
        "2027-03-01T00:00Z", "2027-03-01T06:00Z", "2027-03-01T12:00Z", "2027-03-01T18:00Z",
    ]
    s = steps[0]
    assert 0 <= s["sun"]["visible_fraction"] <= 1
    assert s["earth"]["visible"] == (s["earth"]["margin_deg"] > 0)


def test_timeline_has_sun_visible_and_radius():
    steps = client.get("/api/sites/peak-near-shackleton/timeline", params={"step_hours": 1}).json()
    s = steps[0]["sun"]
    assert isinstance(s["visible"], bool)
    assert 0.25 < s["angular_radius_deg"] < 0.28  # apparent solar radius
    # The flag is authoritative: it is never contradicted by a clearly positive fraction.
    assert all(st["sun"]["visible"] for st in steps if st["sun"]["visible_fraction"] > 0)


def test_bad_time_422():
    assert client.get("/api/sites/connecting-ridge/timeline", params={"start": "yesterday"}).status_code == 422


def test_status_events_are_consistent():
    tl = client.get("/api/sites/connecting-ridge/timeline", params={"step_hours": 24}).json()
    lit = next(s["time_utc"] for s in tl if s["sun"]["visible_fraction"] > 0)
    st = client.get("/api/sites/connecting-ridge/status", params={"time": lit}).json()
    assert st["sun"]["visible_fraction"] > 0
    assert st["next_sunset_utc"] > lit
    assert st["next_sunrise_utc"] > st["next_sunset_utc"]  # currently lit: it sets before it rises


def test_status_out_of_range_422():
    assert client.get("/api/sites/connecting-ridge/status", params={"time": "2040-01-01"}).status_code == 422


def test_custom_site_validates_coordinates():
    # Anywhere on the Moon is allowed now; only impossible coordinates are rejected (no network needed).
    assert client.post("/api/sites/custom", json={"lat": -95, "lon": 10}).status_code == 422
    assert client.post("/api/sites/custom", json={"lat": 10, "lon": 400}).status_code == 422


# ---------- mission rescue (Member 5) ----------

BASE = {
    "site": {"id": "peak-near-shackleton", "name": "Peak Near Shackleton", "lat": -89.01701, "lon": 126.27302},
    "landing_utc": "2027-01-07T00:00:00Z",
    "duration_days": 7,
}


def test_health_and_sites():
    assert client.get("/api/health").json() == {"status": "ok"}
    assert isinstance(client.get("/api/sites").json(), list)
    body = client.get("/api/rescue/sites").json()
    assert any(s["id"] == "malapert-massif" for s in body["sites"])
    assert body["psrs"]


def test_rescue_endpoint():
    r = client.post("/api/rescue", json={"original": BASE, "change": {"launch_delay_days": 21},
                                         "search": {"date_window_days": 15}})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] in ("still_viable", "rescued", "no_viable_alternative")
    assert body["changed"]["scenario"]["landing_utc"].startswith("2027-01-28")
    for a in body["alternatives"]:
        assert a["viability"]["passes"] is True


def test_sensitivity_and_compromise_endpoints():
    r = client.post("/api/rescue/sensitivity", json={"scenario": BASE})
    assert r.status_code == 200, r.text
    assert r.json()["verdict"] in ("robust", "sensitive", "fragile", "fails")
    r = client.post("/api/rescue/compromise", json={"scenario": BASE, "science": {"target_psr_id": "haworth-psr"},
                                                    "search": {"date_window_days": 10}})
    assert r.status_code == 200, r.text
    assert r.json()["status"] in ("both_met", "tradeoff_required")


def test_times_without_timezone_are_422():
    for bad in ["2027-01-07T00:00:00", "2027-01-07"]:
        r = client.post("/api/rescue", json={"original": {**BASE, "landing_utc": bad}})
        assert r.status_code == 422, bad
        assert "timezone" in r.text
    for ok in ["2027-01-07T00:00:00Z", "2027-01-07T02:00:00+02:00"]:
        r = client.post("/api/rescue/sensitivity", json={"scenario": {**BASE, "landing_utc": ok},
                                                          "date_offsets_hours": [24], "position_offsets_km": []})
        assert r.status_code == 200, (ok, r.text)
        assert r.json()["base"]["scenario"]["landing_utc"].startswith("2027-01-07T00:00:00")


def test_bad_input_is_422():
    assert client.post("/api/rescue", json={"original": {**BASE, "site": {"name": "x", "lat": -95, "lon": 0}}}
                       ).status_code == 422
    assert client.post("/api/rescue", json={"original": BASE, "search": {"candidate_site_ids": ["nope"]}}
                       ).status_code == 422
    assert client.post("/api/rescue/compromise", json={"scenario": BASE, "science": {"target_psr_id": "nope"}}
                       ).status_code == 422


# ---------- JPL verify / validation (network stubbed) ----------

def test_verify_uses_the_stored_hour(monkeypatch):
    import app.main as main

    seen = {}

    def fake_verify(lat, lon, when, stored):
        seen.update(lat=lat, when=str(when), stored=stored)
        return {"time_utc": str(when), "bodies": {}}

    monkeypatch.setattr(main, "verify", fake_verify)
    r = client.get("/api/sites/connecting-ridge/verify", params={"time": "2027-01-12T03:20Z"})
    assert r.status_code == 200
    assert seen["when"].startswith("2027-01-12T03:00") and seen["lat"] == -89.53432
    assert set(seen["stored"]) == {"sun", "earth"} and "elevation_deg" in seen["stored"]["sun"]


def test_verify_rejects_out_of_range_and_reports_outages(monkeypatch):
    import app.main as main

    assert client.get("/api/sites/connecting-ridge/verify", params={"time": "2040-01-01"}).status_code == 422

    def down(*_):
        raise OSError("Horizons unreachable")

    monkeypatch.setattr(main, "verify", down)
    assert client.get("/api/sites/connecting-ridge/verify", params={"time": "2027-01-12T03:00Z"}).status_code == 502


def test_validation_report_is_served():
    r = client.get("/api/validation")
    assert r.status_code == 200 and "sites" in r.json()
