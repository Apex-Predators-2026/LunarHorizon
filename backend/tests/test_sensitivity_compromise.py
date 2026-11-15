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


# --- sensitivity never overclaims -------------------------------------------------------------------

from datetime import timedelta  # noqa: E402

from app.rescue import Evaluator  # noqa: E402
from app.rescue.sensitivity import quick_robustness  # noqa: E402
from app.rescue.timeline.synthetic import SyntheticTimelineProvider  # noqa: E402


class ScriptedEvaluator(Evaluator):
    """Real-data-only behaviour (no simulation, no real data around the site), with chosen answers per slip."""

    def __init__(self, script: dict[float, str], default: str = "pass"):
        super().__init__(provider=SyntheticTimelineProvider(), simulation=False)
        self.script, self.default = script, default

    def has_real_data(self, site, start=None, end=None):
        return False

    def evaluate_many(self, site, starts, duration_days, req, simulation=None):
        results = super().evaluate_many(site, starts, duration_days, req, simulation=True)
        out = []
        for t, r in zip(starts, results):
            off = (t - self.base_time).total_seconds() / 3600
            what = "pass" if off == 0 else self.script.get(off, self.default)
            if what == "pass":
                upd = {"passes": True, "eligibility": "pass", "score": 80.0, "violations": []}
            elif what == "fail":
                upd = {"passes": False, "eligibility": "fail", "score": 20.0}
            else:
                upd = {"passes": False, "eligibility": "unknown", "score": None}
            out.append(r.model_copy(update=upd))
        return out


def _scripted(pns_scenario, script, default="pass"):
    e = ScriptedEvaluator(script, default)
    e.base_time = pns_scenario.landing_utc
    return e


def test_no_evaluable_neighbours_is_not_assessed(pns_scenario):
    e = _scripted(pns_scenario, {}, default="unknown")
    r = sensitivity(SensitivityRequest(scenario=pns_scenario, date_offsets_hours=[-24, 24],
                                       position_offsets_km=[1], bearings=2), e)
    assert r.base.passes
    assert r.verdict == "not_assessed" and r.verdict != "robust"
    assert r.date_pass_rate is None and r.position_pass_rate is None
    assert r.safe_date_window_hours is None
    assert "not assessed" in r.explanation.lower()
    assert "landing-position" in r.explanation.lower()


def test_window_does_not_bridge_unknown_gaps(pns_scenario):
    e = _scripted(pns_scenario, {-12.0: "unknown", 48.0: "unknown", 72.0: "pass"})
    r = sensitivity(SensitivityRequest(scenario=pns_scenario, date_offsets_hours=[-48, -24, -12, 12, 24, 48, 72],
                                       position_offsets_km=[]), e)
    assert r.safe_date_window_hours == (0.0, 24.0)  # -48/-24 and +72 pass but sit behind unknown points
    assert r.safe_date_window_tested == 2
    assert "tested" in r.explanation and "+24 h" in r.explanation
    assert "guarantee" in r.explanation.lower()
    by = {p.date_offset_hours: p.status for p in r.points if p.distance_km == 0}
    assert by[-12.0] == "unknown" and by[48.0] == "unknown" and by[72.0] == "pass"
    unknown = next(p for p in r.points if p.date_offset_hours == -12.0)
    assert unknown.passes is False and unknown.score is None


def test_window_stops_at_a_failing_point(pns_scenario):
    e = _scripted(pns_scenario, {24.0: "fail"})
    r = sensitivity(SensitivityRequest(scenario=pns_scenario, date_offsets_hours=[-24, 12, 24, 48],
                                       position_offsets_km=[]), e)
    assert r.safe_date_window_hours == (-24.0, 12.0)
    assert r.safe_date_window_tested == 2


def test_skipped_position_points_are_listed_as_not_evaluated(pns_scenario):
    e = _scripted(pns_scenario, {})
    r = sensitivity(SensitivityRequest(scenario=pns_scenario, date_offsets_hours=[-24, 24],
                                       position_offsets_km=[1, 2], bearings=4), e)
    pos = [p for p in r.points if p.distance_km > 0]
    assert len(pos) == 8 and all(p.status == "not_evaluated" and not p.passes and p.score is None for p in pos)
    assert all(p.bearing_deg is not None for p in pos)
    assert r.position_pass_rate is None
    assert "not checked" in r.explanation.lower() or "not evaluated" in r.explanation.lower()
    assert "does not show" in r.explanation  # date slips say nothing about landing-position error


def test_counts_add_up(pns_scenario):
    e = _scripted(pns_scenario, {-24.0: "fail", 48.0: "unknown"})
    r = sensitivity(SensitivityRequest(scenario=pns_scenario, date_offsets_hours=[-24, -12, 12, 24, 48],
                                       position_offsets_km=[1], bearings=3), e)
    c = r.counts
    assert c.requested == len(r.points) == 5 + 3
    assert c.evaluated == c.passed + c.failed + c.unknown
    assert c.requested == c.evaluated + c.skipped
    assert (c.passed, c.failed, c.unknown, c.skipped) == (3, 1, 1, 3)
    assert r.skipped_points == c.unknown + c.skipped  # legacy field
    assert r.date_pass_rate == 3 / 4  # unknown does not count as a pass or a fail


def test_quick_robustness_ignores_unknown_points(pns_scenario):
    e = _scripted(pns_scenario, {-24.0: "unknown", -12.0: "unknown"})
    rob = quick_robustness(pns_scenario, e)
    assert rob.checked_points == 2 and rob.passing_points == 2 and rob.verdict == "robust"
    none = quick_robustness(pns_scenario, _scripted(pns_scenario, {}, default="unknown"))
    assert none.verdict == "unchecked" and none.pass_rate is None
