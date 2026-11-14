from datetime import datetime, timezone

from app.rescue import compromise, sensitivity
from app.rescue.schemas import CompromiseRequest, ScienceGoal, SearchOptions, SensitivityRequest
from app.models import MissionRequirements, Scenario, Site
from app.rescue.catalog import PSRS_BY_ID, custom_site


def test_sensitivity_counts_and_window(ev, pns_scenario):
    req = SensitivityRequest(scenario=pns_scenario, date_offsets_hours=[-24, -12, 12, 24],
                             position_offsets_km=[1, 2], bearings=4)
    r = sensitivity(req, ev)
    assert len(r.points) == 4 + 2 * 4
    assert r.base.passes
    lo, hi = r.safe_date_window_hours
    assert lo <= 0 <= hi
    assert r.verdict in ("robust", "sensitive", "fragile")
    assert r.score_min <= r.base.score <= r.score_max


def test_sensitivity_of_failing_plan(ev, pns_scenario):
    bad = pns_scenario.model_copy(update={"requirements": MissionRequirements(min_initial_sun_hours=500)})
    r = sensitivity(SensitivityRequest(scenario=bad), ev)
    assert r.verdict == "fails"
    assert r.safe_date_window_hours is None
    assert r.most_sensitive_constraint == "min_initial_sun_hours"


def test_compromise_both_met(ev, pns_scenario):
    r = compromise(CompromiseRequest(scenario=pns_scenario,
                                     science=ScienceGoal(target_psr_id="shackleton-psr", max_traverse_km=15)), ev)
    assert r.status == "both_met"
    assert r.best.meets_engineering and r.best.meets_science
    assert r.best_for_science.science_score >= r.best.science_score
    # Pareto front: nobody on it is dominated by anyone else on it.
    for a in r.pareto_front:
        assert a.pareto_optimal
        for b in r.pareto_front:
            if a is not b:
                assert not (b.engineering_score > a.engineering_score and b.science_score > a.science_score
                            and b.meets_engineering >= a.meets_engineering)


def test_compromise_tradeoff_when_target_is_deep_in_shadow(ev, pns_scenario):
    psr = PSRS_BY_ID["shackleton-psr"]
    target = custom_site("Shackleton floor centre", psr.lat, psr.lon)
    r = compromise(CompromiseRequest(scenario=pns_scenario,
                                     science=ScienceGoal(target=target, max_traverse_km=2, min_science_score=0.5),
                                     search=SearchOptions(date_window_days=10, include_nearby_points=False)), ev)
    assert r.status == "tradeoff_required"
    assert r.suggestions  # tells each side what to give up
    assert r.best_for_engineering is not None and r.best_for_engineering.meets_engineering


def test_compromise_weights_shift_the_choice(ev):
    sc = Scenario(site=Site(id="peak-near-shackleton", name="Peak Near Shackleton", lat=-89.01701, lon=126.27302),
                  landing_utc=datetime(2027, 1, 7, tzinfo=timezone.utc))
    eng = compromise(CompromiseRequest(scenario=sc, engineering_weight=1, science_weight=0.0001,
                                       science=ScienceGoal(target_psr_id="faustini-psr", min_science_score=0)), ev)
    sci = compromise(CompromiseRequest(scenario=sc, engineering_weight=0.0001, science_weight=1,
                                       science=ScienceGoal(target_psr_id="faustini-psr", min_science_score=0)), ev)
    assert sci.best.science_score >= eng.best.science_score
    assert eng.best.engineering_score >= sci.best.engineering_score


def test_compromise_suggestions_never_contradict(ev, pns_scenario):
    # Sites are within the traverse distance but none is close enough for the science minimum.
    psr = PSRS_BY_ID["shackleton-psr"]
    target = custom_site("Shackleton floor centre", psr.lat, psr.lon)
    goal = ScienceGoal(target=target, max_traverse_km=20, min_science_score=0.99)
    r = compromise(CompromiseRequest(scenario=pns_scenario, science=goal,
                                     search=SearchOptions(date_window_days=10)), ev)
    assert r.status == "tradeoff_required"
    text = " ".join(r.suggestions)
    assert any(o.distance_to_science_km <= 20 for o in r.pareto_front + [r.best_for_science])
    assert "No candidate is within" not in text
    assert "No candidate meets the science minimum (needs to be within 0.2 km of" in text
    # The suggested science minimum is rounded down, so following it never still fails.
    import re
    m = re.search(r"lower the science minimum to (\d\.\d\d)", text)
    if m:
        closest = max((o for o in r.pareto_front if o.meets_engineering), key=lambda o: o.science_score)
        assert float(m.group(1)) <= closest.science_score + 1e-9


def test_describe_violation_equal_rounded_values_use_one_decimal():
    from app.models import Violation
    from app.rescue.explain import describe_violation
    v = Violation(constraint="min_earth_visibility_fraction", required=0.40, actual=0.396, unit="fraction",
                  shortfall=0.004, relative_shortfall=0.01, message="m")
    out = describe_violation(v)
    assert "40.0%" in out and "39.6%" in out and "(needs at least 40.0%)" in out
    v2 = v.model_copy(update={"actual": 0.35})
    assert "35%" in describe_violation(v2) and ".0%" not in describe_violation(v2)
