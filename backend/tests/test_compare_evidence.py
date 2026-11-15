"""Comparison data integration (Member 4): canonical metric states, constraints, risk and coverage, and
unknown samples that stay unknown."""
import math

import numpy as np
import pytest
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
    # No fabricated darkness/blackout: whole-mission statistics are withheld per body, the gap is its own unknown
    # window, no darkness/blackout window overlaps it, and no rise/set is invented at its edges.
    assert r["solar"] is None and r["earth"] is None and r["power"] is None
    assert set(r["withheld"]) == {"solar", "earth", "power"}
    assert "Incomplete data" in r["message"]
    gap = ("2027-01-16T00:00:00Z", "2027-01-16T06:00:00Z")
    unknown = {(w["kind"], w["start_utc"], w["end_utc"]) for w in r["unknown_windows"]}
    assert unknown == {("sun_unknown", *gap), ("earth_unknown", *gap)}
    for w in r["dark_windows"] + r["blackout_windows"] + r["sun_windows"] + r["earth_windows"]:
        assert w["end_utc"] <= gap[0] or w["start_utc"] >= gap[1], w
    assert all(ev["time_utc"] not in gap for ev in r["events"])
    assert r["sun_known_hours"] == pytest.approx(7 * 24 - 6) and r["earth_known_hours"] == pytest.approx(7 * 24 - 6)
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


def test_show_why_evidence_windows_are_the_engines_own():
    """"Show why" in the comparison reads the engine's evidence windows; they must be exactly the canonical ones,
    inside the evaluated mission, with ordered UTC edges (the frontend refuses anything else)."""
    from app.viability.api.service import assess, assess_request_for_scenario
    from app.models import Scenario

    body = {"site": MAL, "landing_utc": "2027-01-15T00:00:00Z", "duration_days": 7,
            "requirements": {"battery_hours": 10, "max_comms_gap_hours": 10}}  # strict: duration constraints fail
    r = client.post("/api/compare", json={"scenarios": [{"key": "m", "scenario": body}]}).json()["results"][0]
    a = r["assessment"]
    assert a["evaluated_start_utc"] == "2027-01-15T00:00:00Z" and a["evaluated_end_utc"] == "2027-01-22T00:00:00Z"
    canonical = assess(assess_request_for_scenario(Scenario.model_validate(body))).assessment
    by_id = {c.constraint_id.value: c for c in canonical.constraints}
    with_windows = [c for c in a["constraints"] if c["evidence_windows"]]
    assert with_windows, "a failed duration constraint carries its evidence window"
    for c in a["constraints"]:
        want = [(w.kind.value, w.duration_s) for w in by_id[c["id"]].evidence_windows]
        assert [(w["kind"], w["duration_s"]) for w in c["evidence_windows"]] == want
        for w in c["evidence_windows"]:
            assert a["evaluated_start_utc"] <= w["start_utc"] < w["end_utc"] <= a["evaluated_end_utc"]
            assert w["start_utc"].endswith("Z") and w["end_utc"].endswith("Z")
    assert {w["kind"] for w in a["windows"]} >= {"sunlight", "earth_visible"}


# ---------------------------------------------------------------- missing-data integrity (per body, per metric)

def _patched(edit):
    real = store.get_site("malapert-massif")

    class Patched:
        def __init__(self, d):
            self.record, self.site, self.times = d.record, d.site, d.times
            self.cols = {k: np.array(v, copy=True) for k, v in d.cols.items()}
            self.known = {k: np.array(v, copy=True) for k, v in d.known.items()}
            edit(self, int(np.searchsorted(d.times, np.datetime64("2027-01-16T00:00:00"))))

    return Patched(real)


def _post_patched(monkeypatch, edit, **kw):
    patched = _patched(edit)
    monkeypatch.setattr(service, "_site_record", lambda sid: patched if sid == "malapert-massif" else store.get_site(sid))
    return _post(("m", MAL), **kw)["m"]


def test_missing_sun_does_not_erase_valid_earth_information(monkeypatch):
    def sun_only(p, i):
        p.cols["sun_horizon_deg"][i:i + 5] = np.nan
        p.cols["sun_visible_fraction"][i:i + 5] = np.nan
        p.known["sun_visible"][i:i + 5] = False

    full = _post(("m", MAL))["m"]  # before patching
    r = _post_patched(monkeypatch, sun_only)
    assert r["solar"] is None and r["power"] is None and set(r["withheld"]) == {"solar", "power"}
    assert r["earth"] is not None  # Earth is fully known: its statistics stand
    assert r["earth"] == full["earth"]
    assert r["sun_known_hours"] == pytest.approx(7 * 24 - 5) and r["earth_known_hours"] == pytest.approx(7 * 24)
    m = r["assessment"]["metrics"]
    assert m["sunlight_percent"]["status"] == "bounded" and m["earth_visible_percent"]["status"] == "known"


def test_decimation_never_hides_a_one_hour_unknown(monkeypatch):
    def one_hour(p, i):
        p.cols["earth_horizon_deg"][i + 3] = np.nan
        p.known["earth_visible"][i + 3] = False

    r = _post_patched(monkeypatch, one_hour, max_points=50)  # 168 samples -> stride 4
    tl = r["timeline"]
    assert tl["stride"] == 4 and tl["source_step_hours"] == 1.0 and tl["step_hours"] == 4.0
    k = next(j for j, t in enumerate(tl["time_utc"]) if t > "2027-01-16T03:00Z") - 1  # the point standing for 03:00
    assert tl["earth_visible"][k] is None and tl["earth_horizon_deg"][k] is None
    assert tl["sun_visible_fraction"][k] is not None  # the Sun is known there
    assert [w["kind"] for w in r["unknown_windows"]] == ["earth_unknown"]


def test_visible_sliver_with_rounded_zero_fraction_is_not_darkness(monkeypatch):
    real = store.get_site("malapert-massif")
    i0 = int(np.searchsorted(real.times, np.datetime64("2027-01-15T00:00:00")))
    dark = [k for k in range(i0, i0 + 168) if real.cols["sun_visible_fraction"][k] == 0.0]
    assert dark, "need a dark hour in the mission"
    k = dark[0]

    def sliver(p, _i):
        p.cols["sun_visible"][k] = True  # visible, fraction written 0.0 (below the file's rounding)

    base = _post(("m", MAL))["m"]  # before patching
    r = _post_patched(monkeypatch, sliver)
    assert r["solar"]["sunlit_hours"] == pytest.approx(base["solar"]["sunlit_hours"] + 1)
    assert r["assessment"]["metrics"]["sunlight_percent"]["value"] > base["assessment"]["metrics"]["sunlight_percent"]["value"]
    j = r["timeline"]["time_utc"].index(str(real.times[k])[:16] + "Z")
    assert r["timeline"]["sun_visible"][j] is True and r["timeline"]["sun_visible_fraction"][j] == 0.0


def test_genuine_zero_and_unknown_stay_distinct_in_json(monkeypatch):
    def gap(p, i):
        p.cols["sun_visible_fraction"][i:i + 2] = np.nan
        p.cols["sun_horizon_deg"][i:i + 2] = np.nan
        p.known["sun_visible"][i:i + 2] = False

    patched = _patched(gap)
    monkeypatch.setattr(service, "_site_record", lambda sid: patched)
    raw = client.post("/api/compare", json={"scenarios": [
        {"key": "m", "scenario": {"site": MAL, "landing_utc": "2027-01-15T00:00:00Z", "duration_days": 7}}]}).text
    assert "NaN" not in raw and "Infinity" not in raw  # every public number is finite or null
    tl = __import__("json").loads(raw)["results"][0]["timeline"]
    fr = tl["sun_visible_fraction"]
    assert None in fr and 0.0 in fr  # unknown is null, a measured zero stays 0.0


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


def test_real_results_carry_the_evaluated_site_file_and_its_hash():
    """The comparison names the exact site file each real result was computed from, with the same SHA-256 the
    canonical assessment API reports for it (the summary report records it for reproduction)."""
    body = {"site": MAL, "landing_utc": "2027-01-15T00:00:00Z", "duration_days": 7}
    r = client.post("/api/compare", json={"scenarios": [{"key": "m", "scenario": body}]}).json()["results"][0]
    a = client.post("/api/viability/assess-scenario", json={"scenario": body}).json()
    assert r["dataset_file"] == "malapert-massif.json"
    assert r["dataset_sha256"] == a["input_dataset"]["sha256"]
    assert len(r["dataset_sha256"]) == 64


def test_demonstration_results_have_no_dataset_hash():
    body = {"site": MAL, "landing_utc": "2035-01-15T00:00:00Z", "duration_days": 7}
    r = client.post("/api/compare", json={"scenarios": [{"key": "d", "scenario": body}], "allow_demo_data": True}).json()["results"][0]
    assert r["data_kind"] == "demonstration"
    assert r["dataset_file"] is None and r["dataset_sha256"] is None
