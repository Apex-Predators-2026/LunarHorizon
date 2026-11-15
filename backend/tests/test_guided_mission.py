"""The frontend's guided mission (frontend/src/features/guide/mission.ts) must be reproducible by the live engine.

If the site data is regenerated and this storyline stops holding, this test fails and the guide's scenario must be
re-chosen; the guide never hardcodes an outcome, so it would still be truthful, only less instructive.
"""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

GUIDED = {
    "site": {"id": "peak-near-shackleton", "name": "Peak Near Shackleton", "lat": -89.01701, "lon": 126.27302},
    "landing_utc": "2027-10-10T00:00:00Z",
    "duration_days": 14,
    "requirements": {},
}
DELAY_DAYS = 4


def test_guided_plan_passes_then_fails_after_the_delay_and_rescue_recovers() -> None:
    a = client.post("/api/viability/assess-scenario", json={"scenario": GUIDED}).json()["assessment"]
    assert a["eligibility"] == "pass"

    r = client.post("/api/rescue", json={"original": GUIDED, "change": {"launch_delay_days": DELAY_DAYS}})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "rescued"
    assert body["changed"]["eligibility"] == "fail"
    assert any(not v["is_unknown"] for v in body["changed"]["violations"])
    assert body["alternatives"], "Rescue must offer at least one alternative"

    # The delayed plan's violated requirement has an evidence window for "Show why".
    delayed = {**GUIDED, "landing_utc": body["changed"]["scenario"]["landing_utc"]}
    d = client.post("/api/viability/assess-scenario", json={"scenario": delayed}).json()["assessment"]
    failed = [c for c in d["constraints"] if c["status"] == "fail"]
    assert failed and failed[0]["evidence_windows"]

    # The recommended alternative really passes under the canonical assessment.
    top = body["alternatives"][0]["scenario"]
    t = client.post("/api/viability/assess-scenario", json={"scenario": top}).json()["assessment"]
    assert t["eligibility"] == "pass"
