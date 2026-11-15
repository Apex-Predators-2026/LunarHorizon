"""Comparison data integration (Member 4): canonical metric states, constraints, risk and coverage, and
unknown samples that stay unknown."""
import math

import numpy as np
from fastapi.testclient import TestClient

from app import store
from app.compare import service
from app.main import app

client = TestClient(app)

MAL = {"id": "malapert-massif", "name": "Malapert Massif", "lat": -85.9635, "lon": 357.6326}
PNS = {"id": "peak-near-shackleton", "name": "Peak Near Shackleton", "lat": -89.01701, "lon": 126.27302}


def _post(*scenarios, **kw):
    items = [{"key": k, "scenario": {"site": site, "landing_utc": "2027-01-15T00:00:00Z", "duration_days": 7}}
             for k, site in scenarios]
    r = client.post("/api/compare", json={"scenarios": items, **kw})
    assert r.status_code == 200
    return {x["key"]: x for x in r.json()["results"]}


def test_assessment_carries_canonical_metric_states_and_versions():
    res = _post(("m", MAL), ("p", PNS))
    a = res["m"]["assessment"]
    assert a["engine_version"] and a["scoring_method_version"] and a["dataset_id"]
    assert a["data_basis"] == "real_terrain_aware" and a["is_synthetic"] is False
    assert 0 <= a["sun_coverage_percent"] <= 100 and 0 <= a["earth_coverage_percent"] <= 100
    for key, m in a["metrics"].items():
        assert m["status"] in ("known", "bounded", "unavailable", "not_applicable"), key
        if m["status"] == "known":
            assert m["value"] is not None and m["lower"] is None
        if m["status"] == "bounded":
            assert m["value"] is None and m["lower"] <= m["upper"]
        if m["status"] == "unavailable":
            assert m["value"] is None and m["lower"] is None and m["reason"]
    # Units converted for display, and consistent with the shared ViabilityResult when known.
    dark = a["metrics"]["longest_power_darkness_h"]
    assert dark["unit"] == "h"
    if dark["status"] == "known":
        assert math.isclose(dark["value"], res["m"]["viability"]["metrics"]["longest_dark_gap_hours"], abs_tol=1e-6)
    assert a["metrics"]["earth_visible_percent"]["unit"] == "%"


def test_constraints_match_the_verdict():
    res = _post(("m", MAL), ("p", PNS))
    for r in res.values():
        statuses = {c["status"] for c in r["assessment"]["constraints"]}
        elig = r["ranking"]["eligibility"]
        assert (elig == "fail") == ("fail" in statuses)
        if elig == "pass":
            assert statuses <= {"pass", "not_applicable"}
        for c in r["assessment"]["constraints"]:
            if c["status"] != "not_applicable":
                assert c["threshold"] is not None and c["message"]
    failed = [c for c in res["p"]["assessment"]["constraints"] if c["status"] == "fail"]
    assert failed and all(c["requirement_field"] for c in failed)


def test_risk_levels_are_reported_verbatim():
    a = _post(("m", MAL))["m"]["assessment"]
    assert a["overall_risk"] in ("low", "moderate", "high", "unknown")
    for risk in a["risks"]:
        assert risk["code"] and risk["level"] and risk["message"]


def test_unknown_samples_stay_unknown(monkeypatch):
    real = store.get_site("malapert-massif")

    class Patched:  # same record with 6 h of unknown terrain horizon in the mission window
        def __init__(self, d):
            self.record, self.site, self.times = d.record, d.site, d.times
            self.cols = {k: np.array(v, copy=True) for k, v in d.cols.items()}
            self.known = {k: np.array(v, copy=True) for k, v in d.known.items()}
            i = int(np.searchsorted(d.times, np.datetime64("2027-01-16T00:00:00")))
            for col in ("sun_horizon_deg", "earth_horizon_deg", "sun_visible_fraction", "earth_margin_deg"):
                self.cols[col][i:i + 6] = np.nan
            self.known["sun_visible"][i:i + 6] = False
            self.known["earth_visible"][i:i + 6] = False

    patched = Patched(real)
    monkeypatch.setattr(service, "_site_record", lambda sid: patched if sid == "malapert-massif" else store.get_site(sid))
    r = _post(("m", MAL))["m"]
    # No fabricated darkness/blackout: window statistics are withheld, unknown samples are null.
    assert r["solar"] is None and r["earth"] is None and r["dark_windows"] == [] and r["blackout_windows"] == []
    assert "Incomplete data" in r["message"]
    tl = r["timeline"]
    assert tl["sun_visible_fraction"][24:30] == [None] * 6 and tl["earth_visible"][24:30] == [None] * 6
    a = r["assessment"]
    assert a["sun_coverage_percent"] < 100 and a["earth_coverage_percent"] < 100
    # The engine reports what it can prove: bounded or unavailable, never a made-up exact value.
    assert a["metrics"]["sunlight_percent"]["status"] in ("bounded", "unavailable")
    assert r["ranking"]["eligibility"] in ("pass", "fail", "unknown")
    if r["ranking"]["eligibility"] == "unknown":
        assert r["ranking"]["rank"] is None and r["ranking"]["score"] is None


def test_custom_site_source_points_at_its_file(monkeypatch):
    assert service._source_path("malapert-massif") == "malapert-massif.json"
    fake = store.CUSTOM_DIR / "custom_x.json"
    monkeypatch.setattr(store, "_site_files", lambda: {"custom_x": fake})
    assert service._source_path("custom_x") == "custom/custom_x.json"


def test_failed_requirements_carry_the_engine_evidence_windows():
    r = _post(("p", PNS))["p"]
    cons = {c["id"]: c for c in r["assessment"]["constraints"]}
    dark = cons["max_continuous_darkness"]
    assert dark["status"] == "fail" and dark["evidence_windows"]
    w = dark["evidence_windows"][0]
    assert w["kind"] == "power_dark"
    assert 0 <= w["start_hour"] < w["end_hour"] <= 7 * 24 + 1e-9
    assert abs((w["end_hour"] - w["start_hour"]) - w["duration_hours"]) < 1e-6
    # The cited window is the measured longest darkness (same engine metric).
    assert abs(w["duration_hours"] - dark["measured"]["value"]) < 1e-6
    assert w["start_utc"].endswith("Z")
