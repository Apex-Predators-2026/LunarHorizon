"""Phase 6A: evidence-based explanations of a ``ViabilityAssessment``.

All series here are SYNTHETIC (``helpers.hourly``: one sample per hour, sample-and-hold) and every scenario
runs through the real ``evaluate_scenario`` pipeline, so the explanations are checked against the
authoritative assessment fields rather than against hand-built expectations of the text alone.

``assert_consistent`` is the shared contract check (also used by the real-site tests): it re-derives, from
the assessment's own fields, everything an explanation is allowed to state (verdict words, risk levels,
score state) and fails on any contradiction.
"""

from __future__ import annotations

import copy
import random
import re
from collections.abc import Sequence
from datetime import timedelta
from typing import Any

import pytest

from app.viability import evaluate_scenario
from app.viability.enums import (
    CommunicationMode,
    ConstraintId,
    ConstraintStatus,
    Eligibility,
    ExplanationCategory,
    MetricStatus,
    PowerSource,
    RiskLevel,
    ScoreStatus,
    Severity,
    Unit,
    UnknownReason,
)
from app.viability.explain import (
    EXPLANATION_METHOD_VERSION,
    STANDARD_LIMITATIONS,
    ExplanationDetail,
    build_explanation_details,
    explain_assessment,
    explain_assessment_details,
    generate_explanations,
)
from app.viability.inputs import ScientificTimeSeries
from app.viability.mission import MissionRequirements, MissionScenario, RankingPreferences, SpacecraftConfiguration
from app.viability.outputs import (
    ConstraintEvaluation,
    Explanation,
    Metric,
    RiskIndicator,
    ViabilityAssessment,
)
from app.viability.risk import SYNTHETIC_PREFIX

from .helpers import T0, SunCode, assessment_kwargs, data_quality, hourly, make_series

H = 3600.0
CATEGORY_ORDER = list(ExplanationCategory)  # SUMMARY, CONSTRAINT, MARGIN, RISK, DATA_QUALITY, LIMITATION
STATUS_TOKEN = {
    ConstraintStatus.PASS: ": PASS",
    ConstraintStatus.FAIL: ": FAIL",
    ConstraintStatus.UNKNOWN: ": UNKNOWN",
}
STATUS_SEVERITY = {
    ConstraintStatus.FAIL: Severity.CRITICAL,
    ConstraintStatus.UNKNOWN: Severity.WARNING,
    ConstraintStatus.PASS: Severity.INFO,
}
# Wording an explanation must never use: advice to weaken requirements, or probability claims.
FORBIDDEN = ("weaken", "relax", "loosen", "lower the requirement", "chance of", "likelihood")
ALLOWED_PROBABILITY = ("not a probability", "not probabilities", "no probability")


# --- builders ---------------------------------------------------------------------------------------------


def scenario_for(
    series: ScientificTimeSeries,
    hours: float,
    *,
    start_h: float = 0.0,
    dark_h: float | None = 40.0,
    blackout_h: float | None = 40.0,
    threshold: float | None = None,
    power: PowerSource = PowerSource.SOLAR,
    comms: CommunicationMode = CommunicationMode.DIRECT_TO_EARTH,
    prefs: RankingPreferences | None = None,
    **requirements: Any,
) -> MissionScenario:
    start = T0 + timedelta(hours=start_h)
    return MissionScenario(
        scenario_id="explain-test",
        site=series.site,
        mission_start_utc=start,
        mission_end_utc=start + timedelta(hours=hours),
        spacecraft=SpacecraftConfiguration(
            name="Synthetic lander",
            power_source=power,
            communication_mode=comms,
            max_continuous_darkness_s=None if dark_h is None else dark_h * H,
            max_communication_blackout_s=None if blackout_h is None else blackout_h * H,
            solar_power_min_disk_fraction=threshold,
        ),
        requirements=MissionRequirements(**requirements),
        preferences=prefs or RankingPreferences(),
    )


def run(sun: Sequence[SunCode], earth: Sequence[str] | None = None, **kw: Any) -> ViabilityAssessment:
    series = hourly(sun, earth)
    hours = kw.pop("hours", float(len(sun)))
    return evaluate_scenario(scenario_for(series, hours, **kw), series)


def explain(a: ViabilityAssessment) -> list[ExplanationDetail]:
    items = explain_assessment_details(a)
    assert_consistent(a, items)
    return items


def keyed(items: Sequence[ExplanationDetail]) -> dict[str, ExplanationDetail]:
    return {d.key: d for d in items}


def msg(items: Sequence[ExplanationDetail], key: str) -> str:
    return keyed(items)[key].explanation.message


# --- the shared contract check ----------------------------------------------------------------------------


def assert_consistent(a: ViabilityAssessment, items: list[ExplanationDetail]) -> None:
    """Every explanation agrees with the authoritative assessment fields (see module docstring)."""
    explanations = [d.explanation for d in items]
    # Same items through every entry point, deterministically.
    assert explain_assessment(a) == explanations
    assert explain_assessment_details(a) == items
    assert (
        generate_explanations(
            a.eligibility,
            a.constraints,
            a.margins,
            a.risks,
            a.data_quality,
            score=a.score,
            overall_risk=a.overall_risk,
        )
        == explanations
    )
    keys = [d.key for d in items]
    assert len(keys) == len(set(keys)), "keys must be unique"

    synthetic = a.data_quality.provenance.is_synthetic
    for e in explanations:
        assert 0 < len(e.message) <= 500
        assert e.message.startswith(SYNTHETIC_PREFIX) is synthetic
        low = e.message.lower()
        for word in FORBIDDEN:
            assert word not in low, (word, e.message)
        for m in re.finditer("probabilit", low):
            around = low[max(0, m.start() - 6) : m.end() + 4]
            assert any(p in around for p in ALLOWED_PROBABILITY), e.message

    # Category order.
    ranks = [CATEGORY_ORDER.index(e.category) for e in explanations]
    assert ranks == sorted(ranks)

    # Verdict summary first; it names exactly the authoritative eligibility.
    assert items[0].key == "summary.eligibility"
    head = explanations[0].message.removeprefix(SYNTHETIC_PREFIX)
    assert head.startswith(f"Eligibility {a.eligibility.value.upper()}")
    for other in Eligibility:
        if other is not a.eligibility:
            assert all(f"Eligibility {other.value.upper()}" not in e.message for e in explanations)

    # One constraint item per configured constraint, with the verdict word and nothing contradicting it.
    configured = {c.constraint_id: c for c in a.constraints if c.status is not ConstraintStatus.NOT_APPLICABLE}
    citems = [d for d in items if d.explanation.category is ExplanationCategory.CONSTRAINT]
    rank = {ConstraintStatus.FAIL: 0, ConstraintStatus.UNKNOWN: 1, ConstraintStatus.PASS: 2}
    order = list(ConstraintId)
    assert [d.explanation.related_constraint for d in citems] == sorted(
        configured, key=lambda cid: (rank[configured[cid].status], order.index(cid))
    )
    for d in citems:
        cid = d.explanation.related_constraint
        assert cid is not None
        ev = configured[cid]
        text = d.explanation.message
        assert d.key == f"constraint.{cid.value}"
        assert STATUS_TOKEN[ev.status] in text
        for st, token in STATUS_TOKEN.items():
            if st is not ev.status:
                assert token not in text
        if ev.status is not ConstraintStatus.FAIL:
            assert "FAIL" not in text and "violat" not in text.lower()
        assert d.explanation.severity is STATUS_SEVERITY[ev.status]
        if ev.unknown_reason is UnknownReason.UNSUPPORTED:
            assert "not evaluated" in text and "neither passed nor failed" in text

    # Margin items: one per configured constraint with a numeric margin; wording follows the verdict.
    mitems = [d for d in items if d.explanation.category is ExplanationCategory.MARGIN]
    numeric = [cid for cid in configured if configured[cid].unknown_reason is not UnknownReason.UNSUPPORTED]
    assert sorted(d.explanation.related_constraint for d in mitems if d.explanation.related_constraint) == sorted(
        numeric
    )
    for d in mitems:
        cid = d.explanation.related_constraint
        assert cid is not None
        status = configured[cid].status
        text = d.explanation.message
        if status is ConstraintStatus.FAIL:
            assert "negative margin" in text and d.explanation.severity is Severity.CRITICAL
        elif status is ConstraintStatus.UNKNOWN:
            assert "margin uncertain" in text and "violat" not in text.lower()
        else:
            assert "negative margin" not in text and "uncertain" not in text

    # Every risk indicator is explained exactly once, at its own level.
    claimed = [code for d in items for code in d.risk_codes]
    assert sorted(claimed) == sorted(r.code for r in a.risks)
    levels = {r.code: r.level for r in a.risks}
    for d in items:
        if d.explanation.category not in (ExplanationCategory.MARGIN, ExplanationCategory.RISK):
            continue
        for code in d.risk_codes:
            stated = re.findall(r"[Ss]creening risk (HIGH|MODERATE|LOW|UNKNOWN)\b", d.explanation.message)
            assert stated == [levels[code].value.upper()], (code, d.explanation.message)

    # Overall risk summary.
    risk_text = msg(items, "summary.risk")
    if a.risks:
        assert f"Overall screening risk {a.overall_risk.value.upper()}" in risk_text
    assert "not probabilities" in risk_text or not a.risks

    # Score summary follows the score state and never overrides eligibility.
    s = a.score
    score_text = msg(items, "summary.score")
    if s.status is ScoreStatus.KNOWN:
        assert s.score is not None and f"{s.score:.2f} / 100 (exact)" in score_text
    elif s.status is ScoreStatus.BOUNDED:
        assert "(bounded; no exact value exists)" in score_text and "(exact)" not in score_text
        assert s.score_bounds is not None and s.score_bounds.lower is not None and s.score_bounds.upper is not None
        found = re.search(r"between (\d+\.\d\d) and (\d+\.\d\d) / 100", score_text)
        assert found is not None
        assert float(found.group(1)) <= s.score_bounds.lower and float(found.group(2)) >= s.score_bounds.upper
    elif s.status in (ScoreStatus.ELIGIBILITY_UNKNOWN, ScoreStatus.NO_SCORABLE_COMPONENTS):
        assert "Not scored" in score_text and "not a score of 0" in score_text
    if a.eligibility is Eligibility.FAIL and s.status in (ScoreStatus.KNOWN, ScoreStatus.BOUNDED):
        assert "Descriptive only" in score_text and "does not override FAIL" in score_text
    if a.eligibility is not Eligibility.PASS:
        assert "rank-eligible because" not in score_text

    # Data basis and standing limitations are always explained.
    assert ("data.synthetic" in keys) is synthetic
    for key in ("data.coverage", "limitation.sampling", "limitation.illumination_power", "limitation.line_of_sight"):
        assert key in keys


# --- verdicts ---------------------------------------------------------------------------------------------


def test_pass_explains_every_met_requirement() -> None:
    a = run(["V"] * 48, min_sunlight_percent=50.0, min_earth_visibility_percent=40.0)
    assert a.eligibility is Eligibility.PASS
    items = explain(a)
    assert msg(items, "summary.eligibility").endswith(
        "Eligibility PASS: all 4 configured hard constraint(s) are met. It covers illumination and Earth "
        "line-of-sight requirements only, not landing safety or mission success."
    )
    sun = msg(items, "constraint.min_sunlight_percent")
    assert "PASS" in sun and "100 %" in sun and "required at least 50 %" in sun
    dark = msg(items, "constraint.max_continuous_darkness")
    assert "longest continuous power-dark period: 0 h; required at most 40 h" in dark.lower()
    assert "above the 10 % narrow band" in msg(items, "margin.min_sunlight_percent")
    assert all(d.explanation.severity is not Severity.CRITICAL for d in items)


def test_vacuous_pass_with_no_configured_constraint() -> None:
    a = run(["V"] * 24, dark_h=None, blackout_h=None)
    assert a.eligibility is Eligibility.PASS and all(c.status is ConstraintStatus.NOT_APPLICABLE for c in a.constraints)
    items = explain(a)
    assert "Eligibility PASS (vacuous): no hard constraints are configured" in msg(items, "summary.eligibility")
    assert not [d for d in items if d.explanation.category is ExplanationCategory.CONSTRAINT]


def test_multiple_failures_state_how_far_each_limit_is_missed() -> None:
    a = run(["N"] * 24 + ["V"] * 24, ["N"] * 48, dark_h=20.0, blackout_h=20.0)
    assert a.eligibility is Eligibility.FAIL
    items = explain(a)
    summary = msg(items, "summary.eligibility")
    assert "2 of 2 configured hard constraint(s) are violated" in summary
    assert "maximum power-darkness and maximum Earth line-of-sight blackout" in summary
    dark = msg(items, "constraint.max_continuous_darkness")
    assert ": 24 h; required at most 20 h, so it exceeds the limit by 4 h." in dark
    assert "already in progress at landing" in dark
    blackout = msg(items, "constraint.max_communication_blackout")
    assert "exceeds the limit by 28 h" in blackout and "spanning the whole mission" in blackout
    assert "negative margin -28 h (the measured value is 240 % of the limit)" in msg(
        items, "margin.max_communication_blackout"
    )
    # FAIL items come first and are CRITICAL.
    assert [d.key for d in items if d.explanation.category is ExplanationCategory.CONSTRAINT] == [
        "constraint.max_continuous_darkness",
        "constraint.max_communication_blackout",
    ]


def test_fail_dominates_unknown_and_both_are_named() -> None:
    # Earth blackout of 30 h fails a 20 h limit; darkness is undecidable (10 h unknown, 8 h dark, limit 12 h).
    sun = ["V"] * 10 + ["N"] * 8 + ["U"] * 10 + ["V"] * 20
    a = run(sun, ["V"] * 5 + ["N"] * 30 + ["V"] * 13, dark_h=12.0, blackout_h=20.0)
    assert a.eligibility is Eligibility.FAIL
    statuses = {c.constraint_id: c.status for c in a.constraints}
    assert statuses[ConstraintId.MAX_CONTINUOUS_DARKNESS] is ConstraintStatus.UNKNOWN
    items = explain(a)
    summary = msg(items, "summary.eligibility")
    assert "1 of 2 configured hard constraint(s) are violated" in summary
    assert "1 more cannot be decided from the evidence." in summary


def test_unknown_from_incomplete_data_is_not_a_failure() -> None:
    sun = ["V"] * 10 + ["U"] * 20 + ["V"] * 18
    a = run(sun, dark_h=15.0)
    assert a.eligibility is Eligibility.UNKNOWN
    items = explain(a)
    summary = msg(items, "summary.eligibility")
    assert "but 1 of 2 cannot be decided: maximum power-darkness (incomplete data)" in summary
    assert "UNKNOWN is not a failure" in summary
    dark = msg(items, "constraint.max_continuous_darkness")
    assert "UNKNOWN (undecided, not a failure)" in dark
    assert "between 0 h and 20 h because the power-lit state is unknown for 20 h of the 48 h mission" in dark
    assert "The requirement of at most 15 h falls inside these bounds" in dark
    assert "margin uncertain, between -5 h and +15 h" in msg(items, "margin.max_continuous_darkness")
    assert "Not scored: eligibility is UNKNOWN" in msg(items, "summary.score")
    coverage = keyed(items)["data.coverage"]
    assert coverage.explanation.severity is Severity.WARNING
    assert "unknown for 20 h" in coverage.explanation.message


def test_unknown_without_any_data_uses_only_the_admissible_range() -> None:
    series = hourly(["V"] * 24)
    a = evaluate_scenario(scenario_for(series, 24.0, start_h=100.0, min_sunlight_percent=30.0), series)
    assert a.eligibility is Eligibility.UNKNOWN
    items = explain(a)
    sun = msg(items, "constraint.min_sunlight_percent")
    assert "No measurement is available" in sun and "physically possible values" in sun
    assert "include the requirement of at least 30 %" in sun
    margin = msg(items, "margin.min_sunlight_percent")
    assert "physically possible range, not from observations" in margin
    cov = msg(items, "data.coverage")
    assert "No sample represents any part of it" in cov
    assert "(no data)" in msg(items, "summary.eligibility")


def test_known_and_bounded_pass_and_fail() -> None:
    # PASS despite 5 unknown hours: at most 5 h dark against a 30 h limit.
    a = run(["V"] * 20 + ["U"] * 5 + ["V"] * 23, dark_h=30.0)
    items = explain(a)
    dark = msg(items, "constraint.max_continuous_darkness")
    assert "PASS despite incomplete data. The value lies between 0 h and 5 h" in dark
    assert "even the least favourable value meets the requirement of at most 30 h" in dark
    # FAIL despite 5 unknown hours: at least 25 h dark against a 20 h limit.
    b = run(["V"] * 10 + ["N"] * 25 + ["U"] * 5 + ["V"] * 8, dark_h=20.0)
    assert b.eligibility is Eligibility.FAIL
    items = explain(b)
    dark = msg(items, "constraint.max_continuous_darkness")
    assert "FAIL despite incomplete data" in dark
    assert "exceeds the limit by at least 5 h (up to 10 h)" in dark
    assert "negative margin between -10 h and -5 h" in msg(items, "margin.max_continuous_darkness")


def test_unsupported_clearance_is_never_described_as_evaluated() -> None:
    a = run(["V"] * 48, min_sun_clearance_deg=1.0)
    assert a.eligibility is Eligibility.UNKNOWN
    items = explain(a)
    item = keyed(items)["constraint.min_sun_clearance"]
    text = item.explanation.message
    assert "UNKNOWN, not evaluated" in text and "Required at least 1 deg is configured" in text
    assert "time-mean clearance" in text and "neither passed nor failed" in text
    assert item.risk_codes == ["unsupported_requirement.min_sun_clearance"]
    assert "margin.min_sun_clearance" not in keyed(items)  # no margin exists, none is invented
    assert "(not evaluable by this engine version)" in msg(items, "summary.eligibility")
    assert "Not scored: eligibility is UNKNOWN" in msg(items, "summary.score")


# --- margins and risk -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("required", "expected"),
    [
        (40.0, "headroom +10 pp (25 % of the requirement), above the 10 % narrow band."),
        (46.0, "narrow headroom, +4 pp (8.696 % of the requirement) (within the 10 % narrow band)."),
        (50.0, "exactly at the threshold, zero proven headroom. It passes because comparisons are inclusive"),
        (60.0, "negative margin -10 pp (16.67 % below the requirement): the requirement is not met."),
    ],
)
def test_positive_narrow_zero_and_negative_margins(required: float, expected: str) -> None:
    a = run(["V"] * 24 + ["N"] * 24, dark_h=None, blackout_h=None, min_sunlight_percent=required)
    items = explain(a)
    assert expected in msg(items, "margin.min_sunlight_percent")


def test_duration_margin_below_sample_spacing_is_narrow() -> None:
    a = run(["N"] * 4 + ["V"] * 20, dark_h=4.5, blackout_h=None)
    items = explain(a)
    text = msg(items, "margin.max_continuous_darkness")
    assert "narrow headroom, +0.5 h (11.11 % of the limit unused)" in text
    assert "smaller than the 1 h sample spacing, so the data cannot resolve it" in text
    assert "within the 10 % narrow band" not in text


def test_high_risk_despite_pass() -> None:
    a = run(["V"] * 24 + ["N"] * 24, dark_h=None, blackout_h=None, min_sunlight_percent=46.0)
    assert a.eligibility is Eligibility.PASS and a.overall_risk is RiskLevel.HIGH
    items = explain(a)
    risk = msg(items, "summary.risk")
    assert risk.startswith(f"{SYNTHETIC_PREFIX}Overall screening risk HIGH, driven by minimum direct sunlight headroom")
    assert "Every configured hard constraint still passes" in risk and "eligibility stays PASS" in risk
    assert "Screening risk HIGH (minimum direct sunlight headroom)." in msg(items, "margin.min_sunlight_percent")
    assert "It is rank-eligible because eligibility is PASS." in msg(items, "summary.score")


def test_landing_in_darkness_for_part_of_the_mission() -> None:
    a = run(["N"] * 10 + ["V"] * 38, dark_h=40.0)
    items = explain(a)
    item = keyed(items)["risk.landing_in_darkness"]
    assert item.explanation.category is ExplanationCategory.RISK
    assert item.explanation.related_constraint is ConstraintId.MAX_CONTINUOUS_DARKNESS
    text = item.explanation.message
    assert "Landing in power-darkness (screening risk MODERATE)" in text
    assert "stays so for 10 h from landing" in text and "stored energy, which is not modelled" in text
    assert "Mission starts power-dark" not in msg(items, "constraint.max_continuous_darkness")  # outage window only


def test_dark_for_the_whole_mission_is_high_risk_even_when_the_limit_passes() -> None:
    a = run(["N"] * 48, dark_h=100.0, blackout_h=None)
    assert a.eligibility is Eligibility.PASS
    items = explain(a)
    assert "(screening risk HIGH)" in msg(items, "risk.landing_in_darkness")
    assert "stays so for the whole mission" in msg(items, "risk.landing_in_darkness")
    assert "spanning the whole mission" in msg(items, "constraint.max_continuous_darkness")
    assert "eligibility stays PASS" in msg(items, "summary.risk")


def test_landing_without_earth_line_of_sight() -> None:
    a = run(["V"] * 48, ["N"] * 6 + ["V"] * 42, blackout_h=40.0)
    items = explain(a)
    text = msg(items, "risk.landing_without_earth_visibility")
    assert "Landing without Earth line of sight (screening risk MODERATE)" in text
    assert "Earth is obstructed at landing and stays so for 6 h from landing" in text
    assert "relays are not modelled" in text


def test_landing_state_unknown_is_not_assumed_to_be_an_outage() -> None:
    a = run(["X"] * 3 + ["V"] * 45, dark_h=40.0)
    items = explain(a)
    text = msg(items, "risk.landing_in_darkness")
    assert "unknown (screening risk UNKNOWN); it is not assumed to be an outage" in text


def test_no_landing_risk_for_radioisotope_relay_lander() -> None:
    a = run(
        ["N"] * 48,
        ["N"] * 48,
        dark_h=None,
        blackout_h=None,
        power=PowerSource.RADIOISOTOPE,
        comms=CommunicationMode.RELAY,
    )
    items = explain(a)
    assert not [d for d in items if d.key.startswith("risk.landing")]


def test_long_blackout_names_the_outage_window() -> None:
    a = run(["V"] * 48, ["V"] * 5 + ["N"] * 30 + ["V"] * 13, blackout_h=20.0)
    items = explain(a)
    text = msg(items, "constraint.max_communication_blackout")
    assert "Longest confirmed Earth line-of-sight blackout: 2027-01-01 05:00Z to 2027-01-02 11:00Z (30 h)." in text
    margin = keyed(items)["margin.max_communication_blackout"]
    assert margin.risk_codes == ["communication_exposure"]
    assert "Screening risk HIGH (Earth line-of-sight blackout exposure)." in margin.explanation.message


def test_initial_requirement_longer_than_the_mission() -> None:
    a = run(["V"] * 48, min_initial_sunlight_s=49 * H)
    assert a.eligibility is Eligibility.FAIL
    items = explain(a)
    text = msg(items, "constraint.min_initial_sunlight")
    assert "longer than the 48 h mission, so it cannot be met within this mission window" in text
    assert "Mission starts power-lit for the whole mission." in text


# --- data quality -----------------------------------------------------------------------------------------


def test_synthetic_data_is_labelled_as_simulation_everywhere() -> None:
    a = run(["V"] * 24)
    items = explain(a)
    syn = keyed(items)["data.synthetic"]
    assert syn.risk_codes == ["synthetic_data"]
    assert "SIMULATION" in syn.explanation.message and "not valid for mission decisions" in syn.explanation.message
    assert "data.provenance" not in keyed(items)
    assert all(d.explanation.message.startswith(SYNTHETIC_PREFIX) for d in items)


def test_geometric_only_data_states_that_terrain_is_ignored() -> None:
    series = make_series([float(h) for h in range(24)], ["V"] * 24, coverage_h=(0.0, 24.0), geometric=True)
    a = evaluate_scenario(scenario_for(series, 24.0), series)
    items = explain(a)
    geo = keyed(items)["data.geometric_only"]
    assert geo.risk_codes == ["geometric_only_data"]
    assert "Terrain is not modelled" in geo.explanation.message


def test_incomplete_coverage_separates_gaps_from_unknown_states() -> None:
    a = run(["V"] * 10 + ["X"] * 4 + ["V"] * 34, hours=60.0, dark_h=40.0)  # 12 h beyond coverage, 4 h no ephemeris
    items = explain(a)
    cov = keyed(items)["data.coverage"]
    text = cov.explanation.message
    assert "Data coverage is incomplete" in text
    assert "12 h in 1 interval(s) has no sample" in text
    assert "Up to 4 h is sampled with an unknown state" in text
    assert sorted(cov.risk_codes) == ["earth_data_coverage", "sun_data_coverage"]


def test_pipeline_warnings_are_echoed_in_full_in_details() -> None:
    a = run(["V"] * 10 + ["X"] * 4 + ["V"] * 34)
    assert a.data_quality.warnings
    item = keyed(explain(a))["data.warnings"]
    assert item.details == [f"warning: {w}" for w in a.data_quality.warnings]


# --- score ------------------------------------------------------------------------------------------------


def test_exact_score_breakdown() -> None:
    a = run(["V"] * 48)
    assert a.score.status is ScoreStatus.KNOWN and a.score.score == 100.0
    items = explain(a)
    assert "Desirability score 100.00 / 100 (exact)." in msg(items, "summary.score")
    parts = msg(items, "summary.score_components")
    for term in (
        "sunlight (mean solar-disk fraction) 25 % x 1 = 25",
        "Earth line of sight 25 % x 1 = 25",
        "darkness margin 25 % x 1 = 25",
        "blackout margin 25 % x 1 = 25",
    ):
        assert term in parts
    assert "declared weights (1:1:1:1)" in parts
    excluded = msg(items, "summary.score_excluded")
    assert "simultaneous power-lit and Earth line of sight: weight 0" in excluded
    assert "clearance margin: not evaluable by this engine version" in excluded


def test_uneven_weights_and_ignored_clearance_weight() -> None:
    prefs = RankingPreferences(sunlight_weight=3.0, earth_visibility_weight=1.0, clearance_margin_weight=2.0)
    a = run(["V"] * 24 + ["N"] * 24, dark_h=None, blackout_h=None, prefs=prefs)
    items = explain(a)
    parts = msg(items, "summary.score_components")
    assert "sunlight (mean solar-disk fraction) 75 % x 0.5 = 37.5" in parts
    assert "Earth line of sight 25 % x 1 = 25" in parts
    assert "declared weights (3:1)" in parts
    excluded = msg(items, "summary.score_excluded")
    assert "darkness margin: no darkness limit is configured" in excluded
    assert "clearance margin: not evaluable by this engine version; its weight 2 is ignored" in excluded
    assert "Desirability score 62.50 / 100 (exact)." in msg(items, "summary.score")


def test_bounded_score_is_an_interval_never_a_point() -> None:
    a = run(["V"] * 40 + ["U"] * 8, dark_h=40.0)
    assert a.eligibility is Eligibility.PASS and a.score.status is ScoreStatus.BOUNDED and a.score.score is None
    items = explain(a)
    text = msg(items, "summary.score")
    assert "sunlight (mean solar-disk fraction) and darkness margin are only partly known" in text
    assert "Rankings order it by its lower bound" in text and "that bound is not the score" in text
    parts = msg(items, "summary.score_components")
    assert "darkness margin 25 % x [0.8, 1] = [20, 25]" in parts


def test_fail_keeps_a_descriptive_score_that_never_overrides_the_verdict() -> None:
    a = run(["V"] * 48, min_initial_sunlight_s=49 * H)
    assert a.eligibility is Eligibility.FAIL and a.score.score == 100.0
    text = msg(explain(a), "summary.score")
    assert "Desirability score 100.00 / 100 (exact). Descriptive only" in text
    assert "a high score does not override FAIL" in text


def test_no_scorable_components() -> None:
    prefs = RankingPreferences(
        sunlight_weight=0.0, earth_visibility_weight=0.0, darkness_margin_weight=1.0, blackout_margin_weight=0.0
    )
    a = run(["V"] * 24, dark_h=None, blackout_h=None, prefs=prefs)
    assert a.score.status is ScoreStatus.NO_SCORABLE_COMPONENTS
    items = explain(a)
    text = msg(items, "summary.score")
    assert "Not scored: no score component is active" in text and "no darkness limit is configured" in text
    assert "summary.score_components" not in keyed(items)


def test_generate_without_score_keeps_the_phase1_signature() -> None:
    a = run(["V"] * 48)
    out = generate_explanations(a.eligibility, a.constraints, a.margins, a.risks, a.data_quality)
    keys = [d.key for d in build_explanation_details(a.eligibility, a.constraints, a.margins, a.risks, a.data_quality)]
    assert not [k for k in keys if k.startswith("summary.score")]
    assert all(isinstance(e, Explanation) for e in out)
    assert len(out) == len(keys)


# --- determinism, serialization, purity -------------------------------------------------------------------


def test_order_is_independent_of_input_list_order() -> None:
    a = run(["N"] * 10 + ["V"] * 30 + ["U"] * 8, ["V"] * 40 + ["N"] * 8, dark_h=20.0, blackout_h=5.0,
            min_sunlight_percent=20.0, min_earth_visibility_percent=10.0)  # fmt: skip
    expected = explain(a)
    rng = random.Random(6)
    for _ in range(5):
        c, m, r = list(a.constraints), list(a.margins), list(a.risks)
        rng.shuffle(c)
        rng.shuffle(m)
        rng.shuffle(r)
        got = build_explanation_details(
            a.eligibility, c, m, r, a.data_quality, score=a.score, overall_risk=a.overall_risk
        )
        assert got == expected


def test_margins_are_derived_when_not_supplied() -> None:
    a = run(["V"] * 24 + ["N"] * 24, dark_h=30.0, min_sunlight_percent=40.0)
    full = build_explanation_details(a.eligibility, a.constraints, a.margins, a.risks, a.data_quality)
    derived = build_explanation_details(a.eligibility, a.constraints, [], a.risks, a.data_quality)
    assert [d.explanation for d in derived] == [d.explanation for d in full]


def test_inputs_are_not_mutated() -> None:
    a = run(["N"] * 10 + ["V"] * 30 + ["U"] * 8, min_sunlight_percent=20.0)
    before = a.model_dump()
    lists = (list(a.constraints), list(a.margins), list(a.risks))
    snapshot = copy.deepcopy(lists)
    explain(a)
    assert a.model_dump() == before
    assert (list(a.constraints), list(a.margins), list(a.risks)) == snapshot


def test_structured_serialization_round_trip() -> None:
    a = run(["N"] * 10 + ["V"] * 38, min_sunlight_percent=20.0)
    items = explain(a)
    for d in items:
        assert ExplanationDetail.model_validate_json(d.model_dump_json()) == d
    dumped = [e.model_dump(mode="json") for e in explain_assessment(a)]
    assert {k for e in dumped for k in e} == {"category", "severity", "message", "related_constraint"}
    assert {e["category"] for e in dumped} <= {c.value for c in ExplanationCategory}
    # The list fits the existing ViabilityAssessment.explanations contract unchanged.
    filled = ViabilityAssessment.model_validate({**a.model_dump(), "explanations": dumped})
    assert ViabilityAssessment.model_validate_json(filled.model_dump_json()) == filled
    assert filled.explanations == explain_assessment(a)


def test_explanation_method_version_and_standard_limitations_unchanged() -> None:
    assert EXPLANATION_METHOD_VERSION == "explanations-v1"
    assert len(STANDARD_LIMITATIONS) == 5
    a = run(["V"] * 24)
    details = keyed(explain(a))
    assert STANDARD_LIMITATIONS[0] in details["limitation.illumination_power"].details
    assert STANDARD_LIMITATIONS[1] in details["limitation.line_of_sight"].details


# --- contradictions and edge inputs -----------------------------------------------------------------------


def test_contradictory_inputs_are_rejected() -> None:
    p = run(["V"] * 48, dark_h=40.0)
    f = run(["N"] * 48, dark_h=10.0)
    with pytest.raises(ValueError, match="contradicts the constraint verdicts"):
        generate_explanations(Eligibility.FAIL, p.constraints, p.margins, p.risks, p.data_quality)
    with pytest.raises(ValueError, match="overall_risk"):
        generate_explanations(
            p.eligibility, p.constraints, p.margins, p.risks, p.data_quality, overall_risk=RiskLevel.HIGH
        )
    with pytest.raises(ValueError, match="rank_eligible"):
        generate_explanations(f.eligibility, f.constraints, f.margins, f.risks, f.data_quality, score=p.score)
    with pytest.raises(ValueError, match="implies"):
        generate_explanations(p.eligibility, p.constraints, f.margins, p.risks, p.data_quality)
    with pytest.raises(ValueError, match="at most once"):
        generate_explanations(p.eligibility, [*p.constraints, p.constraints[0]], [], [], p.data_quality)


def test_no_risk_indicators_is_not_low_risk() -> None:
    a = run(["V"] * 24)
    items = build_explanation_details(a.eligibility, a.constraints, a.margins, [], a.data_quality)
    assert "overall risk is UNKNOWN: nothing assessed is not low risk" in msg(items, "summary.risk")
    assert "limitation.risk_bands" not in keyed(items)


def test_legacy_assessment_without_phase5_metadata() -> None:
    a = ViabilityAssessment(**assessment_kwargs())
    items = explain(a)
    assert "Not scored (legacy result without uncertainty metadata)" in msg(items, "summary.score")


def test_unrecognised_risk_code_still_gets_one_item() -> None:
    a = run(["V"] * 24)
    extra = RiskIndicator(code="future_rule", level=RiskLevel.MODERATE, rule="A future rule.", message="Something.")
    items = build_explanation_details(a.eligibility, a.constraints, a.margins, [*a.risks, extra], a.data_quality)
    item = keyed(items)["risk.future_rule"]
    assert item.risk_codes == ["future_rule"] and "screening risk MODERATE" in item.explanation.message


def test_long_external_reason_is_shortened_but_kept_in_details() -> None:
    reason = "missing ephemeris " * 200
    ev = ConstraintEvaluation(
        constraint_id=ConstraintId.MIN_SUNLIGHT_PERCENT,
        status=ConstraintStatus.UNKNOWN,
        threshold=50.0,
        unit=Unit.PERCENT,
        measured=Metric.unavailable(Unit.PERCENT, reason),
        message="synthetic",
        unknown_reason=UnknownReason.NO_DATA,
    )
    dq = data_quality()
    items = build_explanation_details(Eligibility.UNKNOWN, [ev], [], [], dq)
    item = keyed(items)["constraint.min_sunlight_percent"]
    assert len(item.explanation.message) <= 500 and "..." in item.explanation.message
    assert any(reason.strip() in d for d in item.details)
    assert item.explanation.related_constraint is ConstraintId.MIN_SUNLIGHT_PERCENT
    assert keyed(items)["margin.min_sunlight_percent"].explanation.message.count("margin uncertain") == 1
    assert dq.provenance.is_synthetic and item.explanation.message.startswith(SYNTHETIC_PREFIX)
    assert ev.measured.status is MetricStatus.UNAVAILABLE
