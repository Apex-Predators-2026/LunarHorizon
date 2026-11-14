from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

BASE = {
    "site": {"id": "peak-near-shackleton", "name": "Peak Near Shackleton", "lat": -89.01701, "lon": 126.27302},
    "landing_utc": "2027-01-07T00:00:00Z",
    "duration_days": 7,
}


def test_health_and_sites():
    assert client.get("/api/health").json() == {"status": "ok"}
    assert isinstance(client.get("/api/sites").json(), list)  # Andrew's curated list (may be empty)
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


def test_bad_input_is_422():
    assert client.post("/api/rescue", json={"original": {**BASE, "site": {"name": "x", "lat": -95, "lon": 0}}}
                       ).status_code == 422
    assert client.post("/api/rescue", json={"original": BASE, "search": {"candidate_site_ids": ["nope"]}}
                       ).status_code == 422
    assert client.post("/api/rescue/compromise", json={"scenario": BASE, "science": {"target_psr_id": "nope"}}
                       ).status_code == 422
