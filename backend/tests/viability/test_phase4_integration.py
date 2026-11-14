"""Phase 4 integration: Phase 2 analysis -> Phase 3 verdicts -> Phase 4A margins -> Phase 4B risks.

Every scenario runs the real pipeline (``analyze_scenario`` -> ``build_constraint_assessment`` ->
``compute_margins`` -> ``assess_risks``); nothing in the margin-to-risk handoff is mocked.
``pipeline`` additionally checks, for every run, that

* both Phase 4A entry points (``compute_margins``, ``margins_from_assessment``) agree,
* ``assess_risks`` with ``margins=None`` derives exactly the margins passed explicitly,
* Phase 4 never mutates the Phase 3 assessment (eligibility, verdicts, warnings), and
* ``check_contract``: identifiers, units, references and signs agree, and every margin class is
  compatible with the risk level of the indicator that consumes it.

Synthetic series come from ``helpers.hourly``: sample k holds [k h, k+1 h) under sample-and-hold
and coverage is [0, n] h, so expected values below are counts of hours, derived by hand. The real
section derives expected margins and levels independently from the raw site-file columns.
Default risk policy: headroom h = margin / reference; h <= 10 % HIGH, <= 25 % MODERATE, else LOW
(inclusive); a duration bound below the 1 h sample spacing is never LOW.
"""

from __future__ import annotations

import json
import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from pydantic import TypeAdapter

from app.viability import prepare_series
from app.viability.adapters import load_site_file
from app.viability.analysis import analyze_scenario
from app.viability.constraints import build_constraint_assessment
from app.viability.enums import (
    CommunicationMode,
    ConstraintId,
    ConstraintStatus,
    Eligibility,
    MetricStatus,
    PowerSource,
    RiskLevel,
    Unit,
    UnknownDataPolicy,
)
from app.viability.inputs import ScientificTimeSeries
from app.viability.margins import (
    NARROW_MARGIN_FRACTION,
    MarginAssessment,
    MarginBasis,
    MarginClass,
    assess_margins,
    compute_margins,
    margin_bounds,
    margins_from_assessment,
)
from app.viability.mission import MissionRequirements, MissionScenario, SpacecraftConfiguration
from app.viability.outputs import ConstraintAssessment, EnvironmentAnalysis, Metric, OperationalMargin, RiskIndicator
from app.viability.risk import (
    DEFAULT_RISK_POLICY,
    OUTAGE_RISK_CODES,
    SYNTHETIC_PREFIX,
    RiskPolicy,
    assess_risks,
    overall_risk,
)
from app.viability.windows import PreparedSeries

from .helpers import SunCode, at, hourly

H = 3600.0
C = ConstraintId
MC = MarginClass
LOW, MOD, HIGH, UNK = RiskLevel.LOW, RiskLevel.MODERATE, RiskLevel.HIGH, RiskLevel.UNKNOWN
PASS, FAIL, UNKNOWN, NA = (
    ConstraintStatus.PASS,
    ConstraintStatus.FAIL,
    ConstraintStatus.UNKNOWN,
    ConstraintStatus.NOT_APPLICABLE,
)
DATA_BASIS_CODES = {"synthetic_data", "geometric_only_data"}

# Risk levels each margin class may produce at the default policy (high band == narrow band).
ALLOWED_LEVELS: dict[MarginClass, set[RiskLevel]] = {
    MC.NEGATIVE: {HIGH},  # a confirmed violation is never below HIGH
    MC.AT_THRESHOLD: {HIGH, UNK},
    MC.NARROW: {HIGH, MOD, UNK},  # never LOW
    MC.UNCERTAIN: {HIGH, UNK},  # never LOW or MODERATE
    MC.COMFORTABLE: {LOW, MOD, UNK},  # never HIGH
}


# --- pipeline ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class Run:
    scenario: MissionScenario
    env: EnvironmentAnalysis
    assessment: ConstraintAssessment
    margins: list[OperationalMargin]
    assessed: dict[ConstraintId, MarginAssessment]
    risks: dict[str, RiskIndicator]
    risk_list: list[RiskIndicator]

    def margin(self, cid: ConstraintId) -> MarginAssessment:
        return self.assessed[cid]

    def indicator(self, cid: ConstraintId) -> RiskIndicator | None:
        return self.risks.get(OUTAGE_RISK_CODES.get(cid, f"margin_headroom.{cid.value}"))

    @property
    def overall(self) -> RiskLevel:
        return overall_risk(self.risk_list)

    @property
    def overall_without_data_basis(self) -> RiskLevel:
        return overall_risk([r for r in self.risk_list if r.code not in DATA_BASIS_CODES])


def scenario(
    series: ScientificTimeSeries | PreparedSeries,
    start: datetime,
    end: datetime,
    *,
    dark_h: float | None = None,
    blackout_h: float | None = None,
    threshold: float | None = None,
    power: PowerSource = PowerSource.SOLAR,
    comms: CommunicationMode = CommunicationMode.DIRECT_TO_EARTH,
    sid: str = "phase4-integration",
    **req: Any,
) -> MissionScenario:
    site = series.series.site if isinstance(series, PreparedSeries) else series.site
    return MissionScenario(
        scenario_id=sid,
        site=site,
        mission_start_utc=start,
        mission_end_utc=end,
        spacecraft=SpacecraftConfiguration(
            name="Integration lander",
            power_source=power,
            communication_mode=comms,
            max_continuous_darkness_s=None if dark_h is None else dark_h * H,
            max_communication_blackout_s=None if blackout_h is None else blackout_h * H,
            solar_power_min_disk_fraction=threshold,
        ),
        requirements=MissionRequirements(**req),
    )


def pipeline(sc: MissionScenario, series: ScientificTimeSeries | PreparedSeries, **risk_kw: Any) -> Run:
    raw = series.series if isinstance(series, PreparedSeries) else series
    env = analyze_scenario(sc, series)  # Phase 2
    assessment = build_constraint_assessment(sc, env)  # Phase 3
    snapshot = assessment.model_dump_json()
    margins = compute_margins(sc, env.metrics, raw)  # Phase 4A (Phase 1 signature)
    assert margins == margins_from_assessment(assessment)  # both Phase 4A entry points agree
    assessed = {m.constraint_id: m for m in assess_margins(assessment)}
    assert [m.margin for m in assessed.values()] == margins
    risk_list = assess_risks(sc, assessment, margins, **risk_kw)  # Phase 4B
    assert assess_risks(sc, assessment, **risk_kw) == risk_list  # default derives the same margins
    assert assessment.model_dump_json() == snapshot  # Phase 4 never mutates Phase 3
    codes = [r.code for r in risk_list]
    assert len(codes) == len(set(codes))
    run = Run(sc, env, assessment, margins, assessed, {r.code: r for r in risk_list}, risk_list)
    check_contract(run, default_policy=risk_kw.get("policy", DEFAULT_RISK_POLICY) == DEFAULT_RISK_POLICY)
    return run


def expected_level(margin: OperationalMargin, resolution_s: float | None) -> RiskLevel:
    """Independent re-derivation of the default-policy level of a margin with a positive reference."""
    assert margin.reference is not None and margin.reference > 0.0
    bounds = margin_bounds(margin)
    assert bounds is not None

    def band(x: float) -> RiskLevel:
        h = x / margin.reference  # type: ignore[operator]
        level = HIGH if h <= 0.10 + 1e-12 else MOD if h <= 0.25 + 1e-12 else LOW
        if level is LOW and margin.value.unit is Unit.SECONDS and resolution_s is not None and x < resolution_s:
            return MOD
        return level

    lo, hi = band(bounds[0]), band(bounds[1])
    return lo if lo is hi else UNK


def check_contract(run: Run, *, default_policy: bool = True) -> None:
    """Margins and risk indicators describe the same constraints consistently."""
    a = run.assessment
    resolution = a.environment.data_quality.largest_sample_gap_s
    assert [m.related_constraint for m in run.margins] == list(ConstraintId)
    for cid in ConstraintId:
        ev, ma = a.constraint(cid), run.margin(cid)
        m = ma.margin
        # Identity, units, references and verdicts.
        assert m.margin_id == cid.value and m.related_constraint is cid
        assert m.value.unit is ev.unit
        assert m.reference == ev.threshold
        assert ma.constraint_status is ev.status
        ind = run.indicator(cid)
        unsupported = run.risks.get(f"unsupported_requirement.{cid.value}")
        if ev.status is NA:
            # Unconfigured constraints create neither a numeric margin nor a risk.
            assert ma.classification is MC.NOT_APPLICABLE and m.value.status is MetricStatus.NOT_APPLICABLE
            assert ind is None and unsupported is None
            continue
        if ma.classification is MC.UNSUPPORTED:
            # Unsupported stays unsupported: no number, no interpretation.
            assert m.value.status is MetricStatus.UNAVAILABLE and margin_bounds(m) is None
            assert ind is None and unsupported is not None and unsupported.level is UNK
            assert ev.status is UNKNOWN
            continue
        assert unsupported is None and ind is not None
        # Sign convention: the margin's bounds imply the Phase 3 verdict.
        bounds = margin_bounds(m)
        assert bounds is not None
        implied = PASS if bounds[0] >= 0.0 else FAIL if bounds[1] < 0.0 else UNKNOWN
        assert implied is ev.status
        # Margin rules consume the Phase 4A margin itself (no recomputation).
        if cid not in OUTAGE_RISK_CODES:
            assert ind.evidence == m.value
        # Verdict safeguards hold under every policy.
        if ev.status is FAIL:
            assert ind.level is HIGH
        if ev.status is UNKNOWN:
            assert ind.level in (HIGH, UNK)
        if not default_policy:
            continue
        assert m.reference is not None
        if m.reference == 0.0:  # vacuous minimum requirement: relative headroom undefined
            assert ind.level is {PASS: LOW, FAIL: HIGH}.get(ev.status, UNK)
            continue
        assert ind.level in ALLOWED_LEVELS[ma.classification], (cid, ma.classification, ind.level)
        assert ind.level is expected_level(m, resolution), (cid, bounds, ind.level)


# --- synthetic series ---------------------------------------------------------------------------

# 30 h lit then 10 h dark; Earth always visible.
LIT_30_DARK_10: Sequence[SunCode] = ["V"] * 30 + ["N"] * 10
# 11 h lit then 9 h dark.
LIGHT_DARK: Sequence[SunCode] = ["V"] * 11 + ["N"] * 9
# 10 h lit, 4 h unknown, 6 h dark: sunlight in [50, 70] %, longest dark in [6, 10] h.
WITH_UNKNOWN: Sequence[SunCode] = ["V"] * 10 + ["X"] * 4 + ["N"] * 6
# 5 h lit, 45 h dark, 5 h lit.
NIGHT_45: Sequence[SunCode] = ["V"] * 5 + ["N"] * 45 + ["V"] * 5
# 8 h dark, then 14 h lit.
DARK_START: Sequence[SunCode] = ["N"] * 8 + ["V"] * 14

COMFORTABLE_CFG: dict[str, Any] = {
    "dark_h": 50.0,
    "blackout_h": 24.0,
    "min_sunlight_percent": 50.0,
    "min_earth_visibility_percent": 50.0,
    "min_initial_sunlight_s": 12 * H,
    "min_initial_earth_visibility_s": 12 * H,
}


def run_hours(
    sun: Sequence[SunCode], start_h: float, hours: float, earth: Sequence[str] | None = None, **kw: Any
) -> Run:
    series = hourly(sun, earth)
    return pipeline(scenario(series, at(start_h), at(start_h + hours), **kw), series)


def known(ma: MarginAssessment) -> float:
    assert ma.margin.value.status is MetricStatus.KNOWN and ma.margin.value.value is not None
    return ma.margin.value.value


def bounded(ma: MarginAssessment) -> tuple[float, float]:
    v = ma.margin.value
    assert v.status is MetricStatus.BOUNDED and v.lower is not None and v.upper is not None
    return v.lower, v.upper


# --- 1. clearly passing mission with comfortable margins -----------------------------------------


def test_1_clearly_passing_mission_with_comfortable_margins() -> None:
    r = run_hours(LIT_30_DARK_10, 0, 40, **COMFORTABLE_CFG)
    assert r.assessment.eligibility is Eligibility.PASS
    expected = {
        C.MAX_CONTINUOUS_DARKNESS: 40 * H,  # 50 h - 10 h
        C.MAX_COMMUNICATION_BLACKOUT: 24 * H,  # 24 h - 0 h
        C.MIN_SUNLIGHT_PERCENT: 25.0,  # 75 % - 50 %
        C.MIN_EARTH_VISIBILITY_PERCENT: 50.0,  # 100 % - 50 %
        C.MIN_INITIAL_SUNLIGHT: 18 * H,  # 30 h - 12 h
        C.MIN_INITIAL_EARTH_VISIBILITY: 28 * H,  # 40 h - 12 h
    }
    for cid, value in expected.items():
        assert known(r.margin(cid)) == pytest.approx(value)
        assert r.margin(cid).classification is MC.COMFORTABLE
        ind = r.indicator(cid)
        assert ind is not None and ind.level is LOW
    assert r.risks["landing_in_darkness"].level is LOW
    assert r.risks["landing_without_earth_visibility"].level is LOW
    assert r.risks["sun_data_coverage"].level is LOW and r.risks["earth_data_coverage"].level is LOW
    # Everything assessed is LOW, but the series is synthetic: the overall level is not LOW.
    assert r.overall_without_data_basis is LOW
    assert r.overall is UNK and r.risks["synthetic_data"].level is UNK


# --- 2. passing mission with narrow headroom and elevated risk -----------------------------------


def test_2_passing_mission_with_narrow_headroom_carries_high_risk() -> None:
    r = run_hours(LIT_30_DARK_10, 0, 40, dark_h=11.0, min_sunlight_percent=70.0, min_initial_sunlight_s=25 * H)
    assert r.assessment.eligibility is Eligibility.PASS  # risk never changes eligibility
    dark = r.margin(C.MAX_CONTINUOUS_DARKNESS)
    assert known(dark) == pytest.approx(1 * H) and dark.classification is MC.NARROW  # 9.1 % of 11 h
    sun = r.margin(C.MIN_SUNLIGHT_PERCENT)
    assert known(sun) == pytest.approx(5.0) and sun.classification is MC.NARROW  # 7.1 % of 70 %
    init = r.margin(C.MIN_INITIAL_SUNLIGHT)
    assert known(init) == pytest.approx(5 * H) and init.classification is MC.COMFORTABLE  # 20 % of 25 h
    assert r.risks["darkness_exposure"].level is HIGH
    assert r.risks["margin_headroom.min_sunlight_percent"].level is HIGH
    assert r.risks["margin_headroom.min_initial_sunlight"].level is MOD
    assert r.overall is HIGH


def test_2b_exactly_ten_percent_headroom_is_narrow_and_high() -> None:
    # 45 h night against a 50 h limit: margin 5 h = exactly 10 % (inclusive band on both sides).
    r = run_hours(NIGHT_45, 0, 55, dark_h=50.0)
    dark = r.margin(C.MAX_CONTINUOUS_DARKNESS)
    assert known(dark) == pytest.approx(5 * H)
    assert dark.classification is MC.NARROW and r.risks["darkness_exposure"].level is HIGH
    assert NARROW_MARGIN_FRACTION == DEFAULT_RISK_POLICY.high_headroom_fraction


def test_2c_sub_resolution_duration_margin_is_never_low_risk() -> None:
    # Landing at 9.5 h: lit until 11 h, so 1.5 h of initial sunlight against 1 h required. The 0.5 h
    # margin is 50 % of the requirement but below the 1 h sample spacing, so the data cannot resolve it.
    r = run_hours(LIGHT_DARK, 9.5, 10, min_initial_sunlight_s=1 * H)
    init = r.margin(C.MIN_INITIAL_SUNLIGHT)
    assert known(init) == pytest.approx(0.5 * H)
    assert init.classification is MC.NARROW and init.constraint_status is PASS
    ind = r.risks["margin_headroom.min_initial_sunlight"]
    assert ind.level is MOD and "sample spacing" in ind.rule


# --- 3. confirmed failure with negative margin ---------------------------------------------------


def test_3_confirmed_failure_has_negative_margin_and_high_risk() -> None:
    r = run_hours(LIT_30_DARK_10, 0, 40, dark_h=8.0, min_sunlight_percent=80.0)
    assert r.assessment.eligibility is Eligibility.FAIL
    dark = r.margin(C.MAX_CONTINUOUS_DARKNESS)
    assert known(dark) == pytest.approx(-2 * H) and dark.classification is MC.NEGATIVE
    sun = r.margin(C.MIN_SUNLIGHT_PERCENT)
    assert known(sun) == pytest.approx(-5.0) and sun.classification is MC.NEGATIVE
    assert r.risks["darkness_exposure"].level is HIGH
    assert r.risks["margin_headroom.min_sunlight_percent"].level is HIGH
    # Even the most lenient admissible policy cannot present a confirmed FAIL as low risk.
    lenient = pipeline(r.scenario, hourly(LIT_30_DARK_10), policy=RiskPolicy(0.0, 0.0))
    assert lenient.risks["darkness_exposure"].level is HIGH
    assert lenient.risks["margin_headroom.min_sunlight_percent"].level is HIGH
    assert lenient.assessment.eligibility is Eligibility.FAIL


# --- 4. completely unknown data ------------------------------------------------------------------


def test_4_completely_unknown_data_never_becomes_favourable_or_failing() -> None:
    r = run_hours(
        ["X"] * 20,
        0,
        20,
        ["U"] * 20,
        dark_h=50.0,
        blackout_h=10.0,
        min_sunlight_percent=10.0,
        min_initial_sunlight_s=1 * H,
    )
    assert r.assessment.eligibility is Eligibility.UNKNOWN
    configured = [ma for ma in r.assessed.values() if ma.constraint_status is not NA]
    assert all(ma.margin.value.status is MetricStatus.BOUNDED for ma in configured)  # never a point value
    assert all(ma.classification is not MC.NEGATIVE for ma in configured)  # no failure by assumption
    # The darkness outage cannot exceed the 20 h mission: margin [30, 50] h proves PASS and LOW.
    dark = r.margin(C.MAX_CONTINUOUS_DARKNESS)
    assert bounded(dark) == pytest.approx((30 * H, 50 * H)) and dark.constraint_status is PASS
    assert r.risks["darkness_exposure"].level is LOW
    # Everything else is undecided by the data.
    assert bounded(r.margin(C.MAX_COMMUNICATION_BLACKOUT)) == pytest.approx((-10 * H, 10 * H))
    assert bounded(r.margin(C.MIN_SUNLIGHT_PERCENT)) == pytest.approx((-10.0, 90.0))
    assert bounded(r.margin(C.MIN_INITIAL_SUNLIGHT)) == pytest.approx((-1 * H, 19 * H))
    for code in (
        "communication_exposure",
        "margin_headroom.min_sunlight_percent",
        "margin_headroom.min_initial_sunlight",
        "landing_in_darkness",
        "landing_without_earth_visibility",
        "sun_data_coverage",
        "earth_data_coverage",
    ):
        assert r.risks[code].level is UNK, code
    assert "sampled with an unknown state" in r.risks["sun_data_coverage"].message
    assert r.overall is UNK


# --- 5. partially bounded metrics ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("kw", "cid", "margin", "status", "cls", "level"),
    [
        # Sunlight in [50, 70] %.
        ({"min_sunlight_percent": 30.0}, C.MIN_SUNLIGHT_PERCENT, (20.0, 40.0), PASS, MC.COMFORTABLE, LOW),
        # [2, 22] pp = [4 %, 46 %] headroom: HIGH vs LOW band -> UNKNOWN, although PASS and NARROW.
        ({"min_sunlight_percent": 48.0}, C.MIN_SUNLIGHT_PERCENT, (2.0, 22.0), PASS, MC.NARROW, UNK),
        # [-15, 5] pp: the verdict is UNKNOWN, but both bounds are within the HIGH band.
        ({"min_sunlight_percent": 65.0}, C.MIN_SUNLIGHT_PERCENT, (-15.0, 5.0), UNKNOWN, MC.UNCERTAIN, HIGH),
        # Longest dark in [6, 10] h vs 10.5 h: margin [0.5, 4.5] h -> HIGH vs LOW -> UNKNOWN.
        ({"dark_h": 10.5}, C.MAX_CONTINUOUS_DARKNESS, (0.5 * H, 4.5 * H), PASS, MC.NARROW, UNK),
        # vs 30 h: margin [20, 24] h, both bounds LOW: decided despite unknown data.
        ({"dark_h": 30.0}, C.MAX_CONTINUOUS_DARKNESS, (20 * H, 24 * H), PASS, MC.COMFORTABLE, LOW),
    ],
)
def test_5_partially_bounded_metrics(
    kw: dict[str, Any],
    cid: ConstraintId,
    margin: tuple[float, float],
    status: ConstraintStatus,
    cls: MarginClass,
    level: RiskLevel,
) -> None:
    r = run_hours(WITH_UNKNOWN, 0, 20, **kw)
    ma = r.margin(cid)
    assert bounded(ma) == pytest.approx(margin)
    assert (ma.constraint_status, ma.classification, ma.basis) == (status, cls, MarginBasis.BOUNDED)
    ind = r.indicator(cid)
    assert ind is not None and ind.level is level
    assert r.risks["sun_data_coverage"].level is MOD  # 4 h unknown: a confirmed data-quality concern


# --- 6. missing or unsupported constraints -------------------------------------------------------


def test_6a_unsupported_clearance_stays_unsupported() -> None:
    r = run_hours(LIT_30_DARK_10, 0, 40, min_sun_clearance_deg=1.0, min_earth_clearance_deg=2.0)
    assert r.assessment.eligibility is Eligibility.UNKNOWN
    for cid, threshold in ((C.MIN_SUN_CLEARANCE, 1.0), (C.MIN_EARTH_CLEARANCE, 2.0)):
        ma = r.margin(cid)
        assert ma.classification is MC.UNSUPPORTED and ma.basis is MarginBasis.NONE
        assert ma.margin.reference == threshold and ma.margin.value.value is None
        assert (ma.margin.value.reason or "").startswith("unsupported")
        assert r.risks[f"unsupported_requirement.{cid.value}"].level is UNK
        assert f"margin_headroom.{cid.value}" not in r.risks


def test_6b_unconfigured_constraints_create_no_margins_or_risks() -> None:
    r = run_hours(LIT_30_DARK_10, 0, 40)
    assert r.assessment.eligibility is Eligibility.PASS  # vacuous
    assert all(ma.classification is MC.NOT_APPLICABLE and ma.margin.reference is None for ma in r.assessed.values())
    assert sorted(r.risks) == sorted(
        [
            "synthetic_data",
            "sun_data_coverage",
            "earth_data_coverage",
            "landing_in_darkness",
            "landing_without_earth_visibility",
        ]
    )


@pytest.mark.parametrize(("required", "level"), [(50.0, UNK), (80.0, HIGH)])
def test_6c_margin_omitted_from_an_explicit_list(required: float, level: RiskLevel) -> None:
    series = hourly(LIT_30_DARK_10)
    sc = scenario(series, at(0), at(40), dark_h=11.0, min_sunlight_percent=required)
    full = pipeline(sc, series)
    omitted = {r.code: r for r in assess_risks(sc, full.assessment, [])}
    # A minimum requirement without a margin is not assessed (UNKNOWN), or HIGH when Phase 3 proved FAIL.
    assert omitted["margin_headroom.min_sunlight_percent"].level is level
    # Outage exposure is still derived through Phase 4A from the same evidence, identically.
    assert omitted["darkness_exposure"] == full.risks["darkness_exposure"]


def test_6d_margins_contradicting_the_verdicts_are_rejected() -> None:
    series = hourly(LIT_30_DARK_10)

    def hand(cid: ConstraintId, ref: float, value: Metric) -> OperationalMargin:
        return OperationalMargin(
            margin_id=cid.value, related_constraint=cid, reference=ref, value=value, description="t"
        )

    fail = scenario(series, at(0), at(40), min_sunlight_percent=80.0)
    a_fail = pipeline(fail, series).assessment
    with pytest.raises(ValueError, match="may be non-negative"):
        assess_risks(fail, a_fail, [hand(C.MIN_SUNLIGHT_PERCENT, 80.0, Metric.bounded(-5.0, 10.0, Unit.PERCENT))])
    ok = scenario(series, at(0), at(40), min_sunlight_percent=50.0)
    a_ok = pipeline(ok, series).assessment
    with pytest.raises(ValueError, match="may be negative"):
        assess_risks(ok, a_ok, [hand(C.MIN_SUNLIGHT_PERCENT, 50.0, Metric.bounded(-1.0, 25.0, Unit.PERCENT))])
    # Margins of another scenario (different threshold) are refused, not reinterpreted.
    other = scenario(series, at(0), at(40), min_sunlight_percent=60.0)
    with pytest.raises(ValueError, match="reference"):
        assess_risks(ok, a_ok, margins_from_assessment(pipeline(other, series).assessment))


def test_6e_unknown_verdict_with_a_decisive_margin_is_rejected() -> None:
    series = hourly(WITH_UNKNOWN)
    sc = scenario(series, at(0), at(20), min_sunlight_percent=65.0)  # UNKNOWN: sunlight in [50, 70] %
    a = pipeline(sc, series).assessment
    decisive = OperationalMargin(
        margin_id="min_sunlight_percent",
        related_constraint=C.MIN_SUNLIGHT_PERCENT,
        reference=65.0,
        value=Metric.known(5.0, Unit.PERCENT),
        description="t",
    )
    with pytest.raises(ValueError, match="verdict is unknown"):
        assess_risks(sc, a, [decisive])


# --- 7. landing during darkness ------------------------------------------------------------------


def test_7_landing_during_darkness() -> None:
    # Landing at 2 h inside an 8 h night: 6 h of power-darkness from landing, already in progress.
    r = run_hours(DARK_START, 2, 20, dark_h=50.0, min_initial_sunlight_s=1 * H)
    landing = r.risks["landing_in_darkness"]
    assert landing.level is MOD  # 6 h of a 50 h limit: not met at landing, not in the HIGH band
    assert landing.evidence == Metric.known(6 * H, Unit.SECONDS)
    assert "already in progress at landing" in landing.message
    assert "stored energy and power-system state at landing are not modelled" in landing.message
    dark = r.margin(C.MAX_CONTINUOUS_DARKNESS)
    assert known(dark) == pytest.approx(44 * H) and dark.clipped_at_mission_start  # mission-scoped
    assert r.risks["darkness_exposure"].level is LOW
    init = r.margin(C.MIN_INITIAL_SUNLIGHT)
    assert known(init) == pytest.approx(-1 * H) and init.classification is MC.NEGATIVE
    assert r.risks["margin_headroom.min_initial_sunlight"].level is HIGH
    assert r.assessment.eligibility is Eligibility.FAIL


def test_7b_landing_darkness_consuming_the_limit_is_high_while_passing() -> None:
    r = run_hours(DARK_START, 2, 20, dark_h=6.5)
    assert r.assessment.eligibility is Eligibility.PASS
    assert r.risks["landing_in_darkness"].level is HIGH  # 6 h of 6.5 h: 7.7 % headroom
    assert r.margin(C.MAX_CONTINUOUS_DARKNESS).classification is MC.NARROW
    assert r.risks["darkness_exposure"].level is HIGH


@pytest.mark.parametrize(
    ("power", "dark_h", "present"),
    [
        (PowerSource.SOLAR, None, True),
        (PowerSource.HYBRID, None, True),
        (PowerSource.OTHER, None, True),
        (PowerSource.RADIOISOTOPE, None, False),
        (PowerSource.BATTERY_ONLY, None, False),
        (PowerSource.RADIOISOTOPE, 50.0, True),  # a configured limit makes darkness relevant
    ],
)
def test_7c_landing_darkness_only_for_spacecraft_it_can_affect(
    power: PowerSource, dark_h: float | None, present: bool
) -> None:
    r = run_hours(DARK_START, 2, 20, power=power, dark_h=dark_h)
    assert ("landing_in_darkness" in r.risks) is present
    assert r.env.conditions == run_hours(DARK_START, 2, 20).env.conditions  # data unchanged


# --- 8. landing without Earth visibility ---------------------------------------------------------


def test_8_landing_without_earth_visibility() -> None:
    earth = ["N"] * 5 + ["V"] * 15
    r = run_hours(["V"] * 20, 0, 20, earth, blackout_h=10.0, min_initial_earth_visibility_s=1 * H)
    landing = r.risks["landing_without_earth_visibility"]
    assert landing.level is MOD  # 5 h of a 10 h limit
    assert landing.evidence == Metric.known(5 * H, Unit.SECONDS)
    assert "radio-link availability" in landing.message and "not modelled" in landing.message
    assert known(r.margin(C.MAX_COMMUNICATION_BLACKOUT)) == pytest.approx(5 * H)
    exposure = r.risks["communication_exposure"]
    assert exposure.level is LOW and "not a radio link" in exposure.message  # 50 % headroom
    assert r.margin(C.MIN_INITIAL_EARTH_VISIBILITY).classification is MC.NEGATIVE
    assert r.risks["margin_headroom.min_initial_earth_visibility"].level is HIGH
    assert r.risks["landing_in_darkness"].level is LOW  # Sun visible: separate condition


@pytest.mark.parametrize(
    ("comms", "present"),
    [
        (CommunicationMode.DIRECT_TO_EARTH, True),
        (CommunicationMode.DIRECT_AND_RELAY, True),
        (CommunicationMode.RELAY, False),
        (CommunicationMode.NONE, False),
    ],
)
def test_8b_landing_earth_indicator_only_when_direct_to_earth_matters(comms: CommunicationMode, present: bool) -> None:
    r = run_hours(["V"] * 20, 0, 20, ["N"] * 5 + ["V"] * 15, comms=comms)
    assert ("landing_without_earth_visibility" in r.risks) is present


# --- 9. dataset-end boundary ---------------------------------------------------------------------


def test_9_mission_ending_exactly_at_dataset_end_has_no_unknown_time() -> None:
    r = run_hours(LIT_30_DARK_10, 0, 40, dark_h=50.0)
    assert r.env.data_quality.sun_unknown_duration_s == 0.0
    assert r.risks["sun_data_coverage"].level is LOW
    assert r.margin(C.MAX_CONTINUOUS_DARKNESS).basis is MarginBasis.MEASURED


@pytest.mark.parametrize(
    ("required", "margin", "status", "level"),
    [
        (40.0, (10.0, 60.0), PASS, UNK),  # headroom [25 %, 150 %]: MODERATE vs LOW
        (60.0, (-10.0, 40.0), UNKNOWN, UNK),
    ],
)
def test_9b_mission_straddling_dataset_end(
    required: float, margin: tuple[float, float], status: ConstraintStatus, level: RiskLevel
) -> None:
    # Coverage [0, 20] h; mission [10, 30] h: 10 h lit and known, then 10 h with no sample.
    r = run_hours(["V"] * 20, 10, 20, dark_h=50.0, min_sunlight_percent=required)
    sun = r.margin(C.MIN_SUNLIGHT_PERCENT)
    assert bounded(sun) == pytest.approx(margin) and sun.constraint_status is status
    assert r.risks["margin_headroom.min_sunlight_percent"].level is level
    dark = r.margin(C.MAX_CONTINUOUS_DARKNESS)
    assert bounded(dark) == pytest.approx((40 * H, 50 * H))  # outage in [0, 10] h: proven PASS
    assert r.risks["darkness_exposure"].level is LOW
    coverage = r.risks["sun_data_coverage"]
    assert coverage.level is MOD and coverage.evidence == Metric.known(10 * H, Unit.SECONDS)
    assert "including at mission end" in coverage.message


# --- 10. out-of-range missions -------------------------------------------------------------------


@pytest.mark.parametrize("start_h", [100.0, -30.0], ids=["after-dataset", "before-dataset"])
def test_10_out_of_range_mission_uses_admissible_ranges_only(start_h: float) -> None:
    r = run_hours(["V"] * 20, start_h, 20, dark_h=1000.0, blackout_h=10.0, min_sunlight_percent=10.0)
    assert r.env.data_quality.sample_count == 0
    assert r.assessment.eligibility is Eligibility.UNKNOWN
    configured = [ma for ma in r.assessed.values() if ma.constraint_status is not NA]
    assert configured and all(ma.basis is MarginBasis.ADMISSIBLE_RANGE for ma in configured)
    assert all("admissible range" in (ma.margin.value.reason or "") for ma in configured)
    # A 1000 h limit leaves >= 98 % headroom whatever happens in a 20 h mission: proven, so LOW.
    assert bounded(r.margin(C.MAX_CONTINUOUS_DARKNESS)) == pytest.approx((980 * H, 1000 * H))
    assert r.risks["darkness_exposure"].level is LOW
    assert "admissible range" in r.risks["darkness_exposure"].message
    for code in ("communication_exposure", "margin_headroom.min_sunlight_percent", "landing_in_darkness"):
        assert r.risks[code].level is UNK, code
    assert "outside the dataset" in r.risks["sun_data_coverage"].message
    assert r.overall is UNK


# --- 11. synthetic provenance and warning preservation -------------------------------------------


def test_11_synthetic_provenance_and_warnings_survive_phase4() -> None:
    r = run_hours(WITH_UNKNOWN, 0, 20, dark_h=8.0, min_sunlight_percent=65.0)
    dq = r.assessment.environment.data_quality
    assert dq.provenance.is_synthetic
    assert any(w.startswith("SYNTHETIC data") for w in dq.warnings)  # Phase 2 warning preserved
    assert r.risks["synthetic_data"].level is UNK
    assert all(ind.message.startswith(SYNTHETIC_PREFIX) for ind in r.risk_list)
    assert r.overall in (HIGH, UNK)  # synthetic evidence is never summarised as LOW or MODERATE


def test_11b_geometric_only_basis_is_flagged() -> None:
    series = hourly(LIT_30_DARK_10, geometric=True)
    r = pipeline(scenario(series, at(0), at(40), dark_h=50.0), series)
    assert r.risks["geometric_only_data"].level is UNK
    assert any("geometric_only" in w for w in r.env.data_quality.warnings)


def test_11c_high_overall_risk_never_hides_unknown_indicators() -> None:
    r = run_hours(WITH_UNKNOWN, 0, 20, dark_h=5.0, min_sunlight_percent=65.0, min_earth_clearance_deg=1.0)
    assert r.overall is HIGH
    unknown = {code for code, ind in r.risks.items() if ind.level is UNK}
    assert {"synthetic_data", "unsupported_requirement.min_earth_clearance"} <= unknown
    assert r.risks["sun_data_coverage"].level is MOD
    assert len(r.risk_list) == len(r.risks)  # aggregation drops nothing


# --- 12. risk classification without changing eligibility ----------------------------------------


@pytest.mark.parametrize(
    "policy",
    [DEFAULT_RISK_POLICY, RiskPolicy(0.30, 0.50), RiskPolicy(0.0, 0.0), RiskPolicy(0.25, 1.0)],
    ids=["default", "strict", "zero", "wide"],
)
def test_12_policies_change_risk_levels_only(policy: RiskPolicy) -> None:
    series = hourly(WITH_UNKNOWN)
    cases: list[tuple[dict[str, Any], Eligibility]] = [
        ({"dark_h": 30.0, "min_sunlight_percent": 30.0}, Eligibility.PASS),
        ({"dark_h": 8.0, "min_sunlight_percent": 65.0}, Eligibility.UNKNOWN),
        ({"dark_h": 5.0, "min_sunlight_percent": 30.0}, Eligibility.FAIL),
    ]
    for kw, eligibility in cases:
        sc = scenario(series, at(0), at(20), **kw)
        base = pipeline(sc, series)
        r = pipeline(sc, series, policy=policy)
        assert r.assessment == base.assessment and r.assessment.eligibility is eligibility
        assert r.margins == base.margins and r.assessed == base.assessed
        assert [i.code for i in r.risk_list] == [i.code for i in base.risk_list]


def test_12b_retired_worst_case_policy_changes_nothing() -> None:
    series = hourly(WITH_UNKNOWN)
    kw: dict[str, Any] = {"dark_h": 8.0, "min_sunlight_percent": 65.0}
    report = pipeline(scenario(series, at(0), at(20), **kw), series)
    worst = pipeline(scenario(series, at(0), at(20), unknown_data_policy=UnknownDataPolicy.WORST_CASE, **kw), series)
    assert worst.assessment.eligibility is report.assessment.eligibility is Eligibility.UNKNOWN
    # Identical verdicts and evidence; Phase 3 only appends a deprecation note to the message.
    for w, rep in zip(worst.assessment.constraints, report.assessment.constraints, strict=True):
        assert w.model_dump(exclude={"message"}) == rep.model_dump(exclude={"message"})
        if w.status is not NA:
            assert "deprecated and does not change verdicts" in w.message
    assert worst.margins == report.margins
    assert worst.risk_list == report.risk_list


# --- 13. compatibility between generated margins and risk indicators -----------------------------


@pytest.mark.parametrize(
    ("sun", "hours"),
    [(LIT_30_DARK_10, 40), (LIGHT_DARK, 20), (WITH_UNKNOWN, 20), (NIGHT_45, 55), (DARK_START, 22)],
    ids=["lit30-dark10", "light-dark", "with-unknown", "night45", "dark-start"],
)
def test_13_margin_classes_and_risk_levels_agree_across_a_threshold_sweep(sun: Sequence[SunCode], hours: int) -> None:
    series = hourly(sun)
    seen: set[tuple[MarginClass, RiskLevel]] = set()
    for k in range(25):
        sc = scenario(
            series,
            at(0),
            at(hours),
            dark_h=1.0 + 2.5 * k,  # 1 h .. 61 h
            min_sunlight_percent=4.0 * k,  # 0 % .. 96 %
            min_initial_sunlight_s=(0.5 + k) * H,
            min_mean_solar_disk_fraction=0.04 * k,
        )
        r = pipeline(sc, series)  # check_contract runs inside
        for cid in (C.MAX_CONTINUOUS_DARKNESS, C.MIN_SUNLIGHT_PERCENT, C.MIN_INITIAL_SUNLIGHT):
            ind = r.indicator(cid)
            assert ind is not None
            seen.add((r.margin(cid).classification, ind.level))
    # The sweep exercises several class/level pairs, not a single trivial case.
    assert len({cls for cls, _ in seen}) >= 3


def test_13b_outage_exposure_headroom_equals_one_minus_consumed_share() -> None:
    # Same quantity both ways: margin / limit == 1 - longest / limit.
    r = run_hours(NIGHT_45, 0, 55, dark_h=60.0)
    ev = r.assessment.constraint(C.MAX_CONTINUOUS_DARKNESS)
    assert ev.measured.value is not None and ev.threshold is not None
    m = known(r.margin(C.MAX_CONTINUOUS_DARKNESS))
    assert m / ev.threshold == pytest.approx(1.0 - ev.measured.value / ev.threshold)
    assert r.risks["darkness_exposure"].level is MOD  # 15 h / 60 h = exactly 25 %: inclusive MODERATE


# --- 14. deterministic output serialization -------------------------------------------------------


def test_14_phase4_output_is_deterministic_and_round_trips() -> None:
    def build() -> Run:
        return run_hours(WITH_UNKNOWN, 0, 20, dark_h=10.5, min_sunlight_percent=48.0, min_earth_clearance_deg=1.0)

    first, second = build(), build()

    def check(ta: TypeAdapter[Any], a: Any, b: Any) -> None:
        raw = ta.dump_json(a)
        assert raw == ta.dump_json(b)
        assert ta.validate_json(raw) == a
        text = raw.decode()
        assert "NaN" not in text and "Infinity" not in text
        json.loads(raw)

    check(TypeAdapter(list[OperationalMargin]), first.margins, second.margins)
    check(TypeAdapter(list[RiskIndicator]), first.risk_list, second.risk_list)
    check(TypeAdapter(list[MarginAssessment]), list(first.assessed.values()), list(second.assessed.values()))
    # Order of supplied margins does not matter.
    assert assess_risks(first.scenario, first.assessment, list(reversed(first.margins))) == first.risk_list


# --- 15. real NASA-derived site datasets ----------------------------------------------------------

SITES_DIR = Path(__file__).resolve().parents[3] / "data" / "sites"
SITES = ("connecting-ridge", "malapert-massif", "peak-near-shackleton", "shackleton-floor")
T0 = datetime(2027, 1, 1, tzinfo=UTC)
# Same lander as the Phase 3 / Phase 4 real-data tests.
TYPICAL: dict[str, Any] = {
    "dark_h": 50.0,
    "blackout_h": 96.0,
    "threshold": 0.25,
    "min_mean_solar_disk_fraction": 0.5,
    "min_earth_visibility_percent": 40.0,
    "min_initial_sunlight_s": 24 * H,
    "min_initial_earth_visibility_s": 12 * H,
    "min_sunlight_percent": 50.0,
}


@pytest.fixture(scope="module")
def raw_timelines() -> dict[str, dict[str, Any]]:
    return {s: json.loads((SITES_DIR / f"{s}.json").read_text(encoding="utf-8"))["timeline"] for s in SITES}


@pytest.fixture(scope="module")
def prepared() -> dict[str, PreparedSeries]:
    return {s: prepare_series(load_site_file(SITES_DIR / f"{s}.json")) for s in SITES}


def real_run(p: PreparedSeries, start: datetime, days: float, cfg: dict[str, Any] = TYPICAL) -> Run:
    return pipeline(scenario(p, start, start + timedelta(days=days), sid="real-phase4", **cfg), p)


def _longest(mask: np.ndarray, value: bool) -> int:
    best = cur = 0
    for x in mask:
        cur = cur + 1 if bool(x) is value else 0
        best = max(best, cur)
    return best


def _leading(mask: np.ndarray, value: bool) -> int:
    other = np.flatnonzero(mask != value)
    return int(other[0]) if other.size else int(mask.size)


def independent_margins(tl: dict[str, Any], first: int, n: int) -> dict[ConstraintId, float]:
    """Hourly bins [first, first + n) from the raw columns; margin = observed - required / limit - observed."""
    sl = slice(first, first + n)
    frac = np.asarray(tl["sun_visible_fraction"][sl], dtype=float)
    sun = np.asarray(tl["sun_visible"][sl], dtype=bool)
    earth = np.asarray(tl["earth_visible"][sl], dtype=bool)
    lit = sun & (frac >= TYPICAL["threshold"])
    return {
        C.MAX_CONTINUOUS_DARKNESS: (TYPICAL["dark_h"] - _longest(lit, False)) * H,
        C.MAX_COMMUNICATION_BLACKOUT: (TYPICAL["blackout_h"] - _longest(earth, False)) * H,
        C.MIN_SUNLIGHT_PERCENT: 100.0 * sun.sum() / n - TYPICAL["min_sunlight_percent"],
        C.MIN_EARTH_VISIBILITY_PERCENT: 100.0 * earth.sum() / n - TYPICAL["min_earth_visibility_percent"],
        C.MIN_MEAN_SOLAR_DISK_FRACTION: float(frac.mean()) - TYPICAL["min_mean_solar_disk_fraction"],
        C.MIN_INITIAL_SUNLIGHT: _leading(lit, True) * H - TYPICAL["min_initial_sunlight_s"],
        C.MIN_INITIAL_EARTH_VISIBILITY: _leading(earth, True) * H - TYPICAL["min_initial_earth_visibility_s"],
    }


@pytest.mark.parametrize("site", SITES)
@pytest.mark.parametrize("day", [0, 61, 200, 333, 512, 700])
def test_15_real_sites_margins_feed_risks_consistently(
    site: str, day: int, raw_timelines: dict[str, dict[str, Any]], prepared: dict[str, PreparedSeries]
) -> None:
    start = T0 + timedelta(days=day)
    r = real_run(prepared[site], start, 14)  # check_contract runs inside
    expected = independent_margins(raw_timelines[site], day * 24, 14 * 24)
    for cid, value in expected.items():
        ma = r.margin(cid)
        assert ma.basis is MarginBasis.MEASURED
        assert known(ma) == pytest.approx(value, abs=1e-9 * max(1.0, abs(value)))
    # Real, fully covered, terrain-aware data: no synthetic or data-quality flags.
    assert "synthetic_data" not in r.risks and "geometric_only_data" not in r.risks
    assert not any(ind.message.startswith(SYNTHETIC_PREFIX) for ind in r.risk_list)
    assert r.risks["sun_data_coverage"].level is LOW and r.risks["earth_data_coverage"].level is LOW
    assert r.env.data_quality.largest_sample_gap_s == pytest.approx(H)


def test_15b_real_malapert_lit_season(prepared: dict[str, PreparedSeries]) -> None:
    r = real_run(prepared["malapert-massif"], datetime(2027, 7, 20, tzinfo=UTC), 14)
    assert r.assessment.eligibility is Eligibility.PASS
    dark = r.margin(C.MAX_CONTINUOUS_DARKNESS)
    assert known(dark) == pytest.approx(14 * H)  # 36 h longest of a 50 h limit
    assert dark.classification is MC.COMFORTABLE and r.risks["darkness_exposure"].level is LOW  # 28 %
    assert known(r.margin(C.MAX_COMMUNICATION_BLACKOUT)) == pytest.approx(96 * H)


def test_15c_real_peak_near_shackleton_night_landing(prepared: dict[str, PreparedSeries]) -> None:
    r = real_run(prepared["peak-near-shackleton"], datetime(2027, 4, 1, tzinfo=UTC), 14)
    assert r.assessment.eligibility is Eligibility.FAIL
    dark = r.margin(C.MAX_CONTINUOUS_DARKNESS)
    assert known(dark) == pytest.approx((50 - 336) * H) and dark.classification is MC.NEGATIVE
    assert dark.clipped_at_mission_start  # the night began before landing
    assert r.risks["landing_in_darkness"].level is HIGH and r.risks["darkness_exposure"].level is HIGH
    assert r.overall is HIGH


def test_15d_real_shackleton_floor_control(prepared: dict[str, PreparedSeries]) -> None:
    r = real_run(prepared["shackleton-floor"], datetime(2027, 3, 1, tzinfo=UTC), 30)
    assert r.assessment.eligibility is Eligibility.FAIL
    for cid in (C.MAX_CONTINUOUS_DARKNESS, C.MAX_COMMUNICATION_BLACKOUT):
        assert r.margin(cid).classification is MC.NEGATIVE
        ind = r.indicator(cid)
        assert ind is not None and ind.level is HIGH


def test_15e_real_malapert_straddling_dataset_end(prepared: dict[str, PreparedSeries]) -> None:
    r = real_run(prepared["malapert-massif"], datetime(2028, 12, 25, tzinfo=UTC), 14)
    assert r.assessment.eligibility is Eligibility.UNKNOWN
    assert r.margin(C.MAX_CONTINUOUS_DARKNESS).basis is MarginBasis.BOUNDED
    assert r.risks["sun_data_coverage"].level is MOD
    assert r.risks["darkness_exposure"].level is UNK


def test_15f_real_connecting_ridge_after_dataset(prepared: dict[str, PreparedSeries]) -> None:
    r = real_run(prepared["connecting-ridge"], datetime(2029, 2, 1, tzinfo=UTC), 14)
    assert r.assessment.eligibility is Eligibility.UNKNOWN
    configured = [ma for ma in r.assessed.values() if ma.constraint_status is not NA]
    assert all(ma.basis is MarginBasis.ADMISSIBLE_RANGE for ma in configured)
    assert {ind.level for ind in r.risk_list} == {UNK}


def test_15g_real_bounded_margins_never_exceed_physical_ranges(prepared: dict[str, PreparedSeries]) -> None:
    r = real_run(prepared["malapert-massif"], datetime(2028, 12, 25, tzinfo=UTC), 14)
    duration = r.scenario.duration_s
    for cid, ma in r.assessed.items():
        b = margin_bounds(ma.margin)
        if b is None or ma.margin.reference is None:
            continue
        lo, hi = b
        assert math.isfinite(lo) and math.isfinite(hi) and lo <= hi
        if ma.margin.value.unit is Unit.SECONDS:
            assert hi - lo <= duration + 1e-6, cid
