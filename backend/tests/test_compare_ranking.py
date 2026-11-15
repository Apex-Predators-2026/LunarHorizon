"""Comparison ranking contract (Member 4): only eligible PASS scenarios get canonical ranks.

Unit tests use the viability engine's committed SYNTHETIC fixtures (they cover PASS with an exact score,
PASS with a bounded score, FAIL and UNKNOWN on one comparable configuration). Endpoint tests use the real
precomputed site files.
"""
from fastapi.testclient import TestClient

from app.compare.ranking import Assessed, rank_comparison
from app.main import app
from app.viability import evaluate_scenario
from app.viability.fixtures import example_scenario, load_fixture
from app.viability.ranking import rank_assessments

client = TestClient(app)


def _assess(fixture: str, scenario_id: str = "synthetic-scenario"):
    series = load_fixture(fixture)
    return evaluate_scenario(example_scenario(series, scenario_id), series)


# 24 h fixtures that share data basis, requirements fingerprint and duration -> one comparable group.
PASS_EXACT = "mission_boundary"  # pass, known 72.5
PASS_BOUNDED = "missing_samples"  # pass, score None with bounds
FAIL = "continuous_darkness"  # fail, known (descriptive) score
UNKNOWN = "unknown_terrain"  # unknown, never scored
OTHER_GROUP_PASS = "intermittent_blackouts"  # pass, 48 h -> different configuration and duration


def _rank(*named: tuple[str, str]):
    return rank_comparison([Assessed(key, _assess(fx)) for key, fx in named])


# ---------- unit: contract ----------

def test_only_pass_scenarios_get_ranks():
    info, groups, method = _rank(("fail", FAIL), ("pass", PASS_EXACT), ("unknown", UNKNOWN))
    assert info["pass"].eligibility == "pass" and info["pass"].rank == 1
    assert info["fail"].eligibility == "fail" and info["fail"].rank is None
    assert info["unknown"].eligibility == "unknown" and info["unknown"].rank is None
    assert len(groups) == 1 and groups[0].ranked_keys == ["pass"]
    assert groups[0].keys == ["pass", "unknown", "fail"]  # canonical tiers: PASS, UNKNOWN, FAIL
    assert method


def test_two_pass_scenarios_ranked_by_the_engine_not_by_us():
    info, groups, _ = _rank(("bounded", PASS_BOUNDED), ("exact", PASS_EXACT))
    # The engine's own ranking of the same two assessments (they differ in score status, known vs bounded).
    canonical = rank_assessments([_assess(PASS_BOUNDED, "b"), _assess(PASS_EXACT, "e")])
    rank_by_status = {e.score_status.value: e.rank for e in canonical.entries}
    for key in ("exact", "bounded"):
        assert info[key].rank == rank_by_status[info[key].score_status]
    assert {info["exact"].rank, info["bounded"].rank} == {1, 2}
    assert groups[0].ranked_keys == sorted(("exact", "bounded"), key=lambda k: info[k].rank)


def test_failed_scenario_never_outranks_pass_even_with_higher_score():
    fail = _assess(FAIL)
    passed = _assess(PASS_BOUNDED)  # no exact score at all
    assert fail.score.score is not None and passed.score.score is None
    info, _, _ = rank_comparison([Assessed("fail", fail), Assessed("pass", passed)])
    assert info["pass"].rank == 1
    assert info["fail"].rank is None


def test_missing_score_is_never_zero_and_measured_zero_is_kept():
    info, _, _ = _rank(("bounded", PASS_BOUNDED), ("unknown", UNKNOWN))
    b = info["bounded"]
    assert b.score is None and b.score_status == "bounded"
    assert b.score_lower is not None and b.score_upper is not None and b.score_lower <= b.score_upper
    assert b.score_lower > 0  # the bound is reported as a bound, not collapsed to 0
    u = info["unknown"]
    assert u.score is None and u.score_lower is None and u.score_upper is None
    assert u.score_status == "eligibility_unknown"
    # A real exact 0 must survive: inject a known score of 0 into an otherwise valid PASS assessment.
    a = _assess(PASS_EXACT)
    zero_bounds = a.score.score_bounds.model_copy(update={"value": 0.0})
    zero_score = a.score.model_copy(update={"score": 0.0, "score_bounds": zero_bounds})
    a0 = a.model_copy(update={"score": zero_score})
    info0, _, _ = rank_comparison([Assessed("zero", a0)])
    assert info0["zero"].score == 0.0 and info0["zero"].score_lower == 0.0


def test_unknown_stays_unknown_with_its_reason():
    info, _, _ = _rank(("unknown", UNKNOWN), ("fail", FAIL))
    assert info["unknown"].eligibility == "unknown"
    assert "UNKNOWN" in info["unknown"].explanation and "Not ranked" in info["unknown"].explanation
    assert "FAIL" in info["fail"].explanation


def test_pass_in_a_different_group_is_never_ranked_against_the_primary_group():
    info, groups, _ = _rank(("a", PASS_EXACT), ("b", PASS_BOUNDED), ("other", OTHER_GROUP_PASS))
    assert [g.id for g in groups] == ["G1", "G2"] and groups[0].primary and not groups[1].primary
    assert set(groups[0].keys) == {"a", "b"} and groups[1].keys == ["other"]
    assert info["other"].group == "G2" and info["a"].group == "G1"
    assert groups[1].separate_reason and "duration" in groups[1].separate_reason
    # Its rank exists only inside its own group; it never takes a place in the primary group's order.
    assert "other" not in groups[0].ranked_keys


def test_duplicate_scenarios_do_not_break_the_ranking():
    info, groups, _ = _rank(("x", PASS_EXACT), ("y", PASS_EXACT))
    assert sorted(i.rank for i in info.values()) == [1, 2]
    assert len(groups) == 1


def test_empty_input():
    assert rank_comparison([]) == ({}, [], None)


# ---------- endpoint: real data ----------

SITES = {
    "malapert-massif": ("Malapert Massif", -85.9635, 357.6326),
    "peak-near-shackleton": ("Peak Near Shackleton", -89.01701, 126.27302),
    "connecting-ridge": ("Connecting Ridge", -89.53432, 209.94767),
}
LENIENT = {"min_sunlight_fraction": 0.3, "battery_hours": 200, "panel_threshold": 0.25,
           "min_earth_visibility_fraction": 0.3, "max_comms_gap_hours": 200, "min_initial_sun_hours": 0,
           "min_initial_comms_hours": 0}


def _item(key, site, landing="2027-01-15T00:00:00Z", days=14, req=None):
    name, lat, lon = SITES[site]
    sc = {"site": {"id": site, "name": name, "lat": lat, "lon": lon}, "landing_utc": landing, "duration_days": days}
    if req:
        sc["requirements"] = req
    return {"key": key, "scenario": sc}


def _post(items, **kw):
    r = client.post("/api/compare", json={"scenarios": items, **kw})
    assert r.status_code == 200
    j = r.json()
    return {x["key"]: x for x in j["results"]}, j


def test_endpoint_ranks_only_pass_and_matches_viability_verdict():
    res, body = _post([
        _item("strict", "peak-near-shackleton"),  # default requirements: fails at this site/date
        _item("p1", "malapert-massif", req=LENIENT),
        _item("p2", "connecting-ridge", req=LENIENT),
    ])
    for key, r in res.items():
        rk, v = r["ranking"], r["viability"]
        assert rk["eligibility"] == v["eligibility"]  # one verdict, from the engine
        assert (rk["rank"] is not None) == (rk["eligibility"] == "pass")
        if rk["score"] is None:
            assert v["score"] is None  # never 0
    assert res["strict"]["ranking"]["eligibility"] == "fail" and res["strict"]["ranking"]["rank"] is None
    # Different requirements -> 'strict' sits in its own group, never ranked against the lenient ones.
    assert res["strict"]["ranking"]["group"] != res["p1"]["ranking"]["group"]
    assert {res["p1"]["ranking"]["rank"], res["p2"]["ranking"]["rank"]} == {1, 2}
    primary = next(g for g in body["ranking_groups"] if g["primary"])
    assert set(primary["ranked_keys"]) == {"p1", "p2"}
    assert body["ranking_method"]


def test_endpoint_unavailable_scenario_has_no_rank():
    res, body = _post([_item("p1", "malapert-massif", req=LENIENT),
                       _item("gone", "malapert-massif", landing="2035-01-01T00:00:00Z")])
    assert res["gone"]["status"] == "unavailable" and res["gone"]["viability"] is None
    # No data = cannot be decided (UNKNOWN), like Rescue's coverage check; never FAIL, never ranked.
    rk = res["gone"]["ranking"]
    assert rk["eligibility"] == "unknown" and rk["assessed"] is False
    assert rk["rank"] is None and rk["score"] is None and rk["group"] is None
    assert rk["explanation"].startswith("Not ranked: cannot be decided")
    assert all("gone" not in g["keys"] for g in body["ranking_groups"])


def test_endpoint_different_duration_is_a_separate_group():
    res, body = _post([_item("long", "malapert-massif", req=LENIENT),
                       _item("short", "malapert-massif", days=3, req=LENIENT)])
    assert res["long"]["ranking"]["group"] != res["short"]["ranking"]["group"]
    assert len(body["ranking_groups"]) == 2
    other = next(g for g in body["ranking_groups"] if not g["primary"])
    assert "duration" in other["separate_reason"]
    assert any("separate ranking groups" in n for n in body["notes"])
