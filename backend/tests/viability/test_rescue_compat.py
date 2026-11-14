"""Compatibility between Mission Rescue (Member 5) and the canonical viability contract.

Inputs use rescue's own types and providers (synthetic placeholder + real precomputed files).
Outputs are hand-built canonical assessments: the full canonical engine (Phases 3-6) does not exist
yet, so end-to-end tests use a TEST DOUBLE engine, clearly labelled, to exercise the plumbing.
Phase 2 metrics and Phase 3 constraint verdicts are compared directly against rescue's placeholder
on the same real timelines.
"""

from __future__ import annotations

import json
import math
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np
import pytest

from app.models import MissionRequirements as RescueRequirements
from app.models import Scenario, Site, ViabilityResult
from app.rescue.catalog import custom_site, get_site
from app.rescue.engine import Evaluator
from app.rescue.explain import why_fails
from app.rescue.timeline import PrecomputedTimelineProvider, SyntheticTimelineProvider, Timeline
from app.rescue.viability import CHECK_BY_CONSTRAINT
from app.rescue.viability import evaluate_timeline as rescue_default_evaluate
from app.rescue.viability.placeholder import compute_metrics as placeholder_compute_metrics
from app.rescue.viability.placeholder import evaluate_timeline as placeholder_evaluate
from app.viability.adapters import load_site_file
from app.viability.analysis import analyze_scenario
from app.viability.compat.rescue import (
    CONSTRAINT_TO_RESCUE,
    SOURCE,
    RescueCompatError,
    assessment_to_result,
    constraint_to_violation,
    evaluate_timeline,
    internal_site_id,
    make_evaluate_fn,
    precomputed_dataset_end,
    scenario_to_mission,
    timeline_to_series,
)
from app.viability.constraints import assess_constraints
from app.viability.enums import (
    AngleType,
    CommunicationMode,
    ConstraintId,
    ConstraintStatus,
    Eligibility,
    MetricStatus,
    PowerSource,
    RiskLevel,
    Unit,
    VisibilityState,
)
from app.viability.explain import STANDARD_LIMITATIONS
from app.viability.inputs import ScientificTimeSeries
from app.viability.mission import MissionScenario
from app.viability.outputs import (
    ConstraintEvaluation,
    DataQualitySummary,
    EnvironmentAnalysis,
    Metric,
    ScoreBreakdown,
    ViabilityAssessment,
    derive_eligibility,
)

from .helpers import full_coverage_quality_fields, unavailable_metrics

V, P, NV, U = VisibilityState.VISIBLE, VisibilityState.PARTIAL, VisibilityState.NOT_VISIBLE, VisibilityState.UNKNOWN
H = 3600.0
SITES_DIR = Path(__file__).resolve().parents[3] / "data" / "sites"
LANDING = datetime(2027, 1, 7, tzinfo=UTC)


def _scenario(site: Site | None = None, **req: float) -> Scenario:
    return Scenario(
        site=site or get_site("peak-near-shackleton").to_site(),
        landing_utc=LANDING,
        duration_days=7,
        requirements=RescueRequirements(**req),
    )


def _synthetic_timeline(scenario: Scenario) -> Timeline:
    """Exactly what rescue's Evaluator passes: duration*24 hourly samples from landing."""
    n = round(scenario.duration_days * 24)
    tl = SyntheticTimelineProvider().timeline(
        scenario.site, scenario.landing_utc, scenario.landing_utc + timedelta(hours=n - 1), 1.0
    )
    return tl.slice(0, n)


# --- builders for canonical assessments ---------------------------------------------------


def _constraint(
    cid: ConstraintId, status: ConstraintStatus, threshold: float, unit: Unit, measured: Metric
) -> ConstraintEvaluation:
    return ConstraintEvaluation(
        constraint_id=cid,
        status=status,
        threshold=threshold,
        unit=unit,
        measured=measured,
        message=f"{cid.value} (test)",
    )


def _assessment(
    mission: MissionScenario,
    series: ScientificTimeSeries,
    constraints: list[ConstraintEvaluation],
    *,
    score: float | None = 70.0,
    metrics: dict[str, Metric] | None = None,
) -> ViabilityAssessment:
    eligibility = derive_eligibility(c.status for c in constraints)
    return ViabilityAssessment(
        engine_version="test-double",
        scenario_id=mission.scenario_id,
        site=mission.site,
        evaluated_start_utc=mission.mission_start_utc,
        evaluated_end_utc=mission.mission_end_utc,
        eligibility=eligibility,
        constraints=constraints,
        metrics=unavailable_metrics(**(metrics or {})),
        windows=[],
        margins=[],
        risks=[],
        overall_risk=RiskLevel.UNKNOWN,
        score=ScoreBreakdown(method_version="test", score=score, rank_eligible=eligibility is Eligibility.PASS),
        explanations=[],
        data_quality=DataQualitySummary(
            dataset_id=series.dataset_id,
            provenance=series.provenance,
            calculation_basis=series.calculation_basis,
            angle_type=series.angle_type,
            sun_criterion=series.sun_criterion,
            earth_criterion=series.earth_criterion,
            **full_coverage_quality_fields(len(series.samples), mission.duration_s),
        ),
        limitations=list(STANDARD_LIMITATIONS),
    )


KNOWN_GOOD = {
    "mean_solar_disk_fraction": Metric.known(0.8, Unit.FRACTION),
    "longest_continuous_darkness": Metric.known(10 * H, Unit.SECONDS),
    "earth_visible_percent": Metric.known(60.0, Unit.PERCENT),
    "longest_communication_blackout": Metric.known(30 * H, Unit.SECONDS),
    "initial_sunlight_duration": Metric.known(48 * H, Unit.SECONDS),
    "initial_earth_visibility_duration": Metric.known(20 * H, Unit.SECONDS),
    "time_to_first_sunset": Metric.known(48 * H, Unit.SECONDS),
    "time_to_first_earthset": Metric.not_applicable(Unit.SECONDS),
    "mean_sun_clearance": Metric.known(1.2, Unit.DEGREES),
    "mean_earth_clearance": Metric.known(2.5, Unit.DEGREES),
    "mean_solar_elevation": Metric.known(1.1, Unit.DEGREES),
}


def _all_constraints(
    status: dict[ConstraintId, ConstraintStatus] | None = None, **measured: Metric
) -> list[ConstraintEvaluation]:
    """The six constraints a rescue scenario maps to, with default thresholds."""
    status = status or {}
    spec = {
        ConstraintId.MIN_MEAN_SOLAR_DISK_FRACTION: (0.5, Unit.FRACTION, "mean_solar_disk_fraction"),
        ConstraintId.MAX_CONTINUOUS_DARKNESS: (50 * H, Unit.SECONDS, "longest_continuous_darkness"),
        ConstraintId.MIN_EARTH_VISIBILITY_PERCENT: (40.0, Unit.PERCENT, "earth_visible_percent"),
        ConstraintId.MAX_COMMUNICATION_BLACKOUT: (96 * H, Unit.SECONDS, "longest_communication_blackout"),
        ConstraintId.MIN_INITIAL_SUNLIGHT: (24 * H, Unit.SECONDS, "initial_sunlight_duration"),
        ConstraintId.MIN_INITIAL_EARTH_VISIBILITY: (12 * H, Unit.SECONDS, "initial_earth_visibility_duration"),
    }
    out = []
    for cid, (threshold, unit, metric_name) in spec.items():
        m = measured.get(metric_name, KNOWN_GOOD[metric_name])
        out.append(_constraint(cid, status.get(cid, ConstraintStatus.PASS), threshold, unit, m))
    return out


@pytest.fixture
def pns() -> Scenario:
    return _scenario()


@pytest.fixture
def pns_series(pns: Scenario) -> ScientificTimeSeries:
    return timeline_to_series(_synthetic_timeline(pns))


# --- Scenario -> MissionScenario ----------------------------------------------------------


def test_default_rescue_requirements_map_to_canonical(pns: Scenario) -> None:
    m = scenario_to_mission(pns)
    sc, req = m.spacecraft, m.requirements
    assert sc.power_source is PowerSource.SOLAR and sc.communication_mode is CommunicationMode.DIRECT_TO_EARTH
    assert sc.max_continuous_darkness_s == 50 * H and sc.max_communication_blackout_s == 96 * H
    assert sc.solar_power_min_disk_fraction == 0.25  # configurable, not hard-coded
    assert req.min_mean_solar_disk_fraction == 0.5
    assert req.min_earth_visibility_percent == pytest.approx(40.0)
    assert req.min_initial_sunlight_s == 24 * H and req.min_initial_earth_visibility_s == 12 * H
    assert req.min_sunlight_percent is None  # different quantity; not conflated
    assert m.mission_start_utc == LANDING and m.mission_end_utc == LANDING + timedelta(days=7)


@pytest.mark.parametrize("threshold", [0.0, 0.4, 1.0])
def test_panel_threshold_is_carried_through(threshold: float) -> None:
    assert (
        scenario_to_mission(_scenario(panel_threshold=threshold)).spacecraft.solar_power_min_disk_fraction == threshold
    )


def test_east_longitude_and_custom_ids_converted() -> None:
    ridge = scenario_to_mission(_scenario(get_site("connecting-ridge").to_site()))
    assert ridge.site.lon == pytest.approx(209.94767 - 360.0)
    point = custom_site("Nearby point", -89.46012, 221.98)
    m = scenario_to_mission(_scenario(point))
    assert point.id == "custom:-89.46012,221.98000"
    assert m.site.id == internal_site_id(point.id) == "custom_-89.46012_221.98000"
    assert m.site.lon == pytest.approx(221.98 - 360.0)


def test_naive_landing_follows_shared_model_policy() -> None:
    # The shared Scenario treats naive datetimes as UTC before we ever see them.
    s = Scenario(site=get_site("peak-near-shackleton").to_site(), landing_utc=datetime(2027, 1, 7), duration_days=7)
    assert scenario_to_mission(s).mission_start_utc == LANDING


# --- Timeline -> ScientificTimeSeries -----------------------------------------------------


def test_synthetic_timeline_converts(pns: Scenario) -> None:
    tl = _synthetic_timeline(pns)
    s = timeline_to_series(tl)
    assert len(s.samples) == 168
    assert s.provenance.is_synthetic is True and "SYNTHETIC" in s.provenance.ephemeris_source
    assert s.angle_type is AngleType.GEOMETRIC
    assert [x.sun.visible_fraction for x in s.samples] == pytest.approx(tl.sun_visible_fraction.tolist())
    for x, f, ev in zip(s.samples, tl.sun_visible_fraction, tl.earth_visible, strict=True):
        assert x.sun.state is (NV if f == 0 else V if f == 1 else P)
        assert x.earth.state is (V if ev else NV)
    assert s.samples[0].time_utc == LANDING
    assert s.samples[-1].time_utc == LANDING + timedelta(hours=167)  # hourly bins: last = end - 1 step


def test_synthetic_custom_point_converts() -> None:
    sc = _scenario(custom_site("Nearby point", -89.3, 200.0))
    s = timeline_to_series(_synthetic_timeline(sc))
    assert s.site.id == "custom_-89.30000_200.00000" and s.site.lon == pytest.approx(-160.0)


def test_real_precomputed_timeline_matches_site_file_adapter() -> None:
    site = get_site("peak-near-shackleton").to_site()
    start = datetime(2027, 3, 1, tzinfo=UTC)
    provider = PrecomputedTimelineProvider(fallback=SyntheticTimelineProvider(), data_dir=SITES_DIR)
    tl = provider.timeline(site, start, start + timedelta(hours=167), 1.0)
    assert tl.source.startswith("precomputed:")
    via_rescue = timeline_to_series(tl)
    assert via_rescue.provenance.is_synthetic is False and via_rescue.angle_type is AngleType.APPARENT

    via_file = load_site_file(SITES_DIR / "peak-near-shackleton.json")
    i0 = next(i for i, x in enumerate(via_file.samples) if x.time_utc == start)
    for a, b in zip(via_rescue.samples, via_file.samples[i0 : i0 + 168], strict=True):
        assert a.time_utc == b.time_utc
        assert (a.sun.state, a.sun.visible_fraction, a.sun.elevation_deg) == (
            b.sun.state,
            b.sun.visible_fraction,
            b.sun.elevation_deg,
        )
        assert (a.earth.state, a.earth.azimuth_deg, a.earth.horizon_deg) == (
            b.earth.state,
            b.earth.azimuth_deg,
            b.earth.horizon_deg,
        )


def test_missing_values_become_unknown_not_clear(pns: Scenario) -> None:
    tl = _synthetic_timeline(pns)
    tl.sun_horizon[3] = np.nan
    tl.sun_visible_fraction[3] = np.nan
    obs = timeline_to_series(tl).samples[3].sun
    assert obs.state is U and obs.horizon_deg is None and obs.visible_fraction is None


def test_fraction_without_horizon_rejected(pns: Scenario) -> None:
    tl = _synthetic_timeline(pns)
    tl.sun_horizon[3] = np.nan  # fraction still present -> inconsistent
    with pytest.raises(RescueCompatError, match="inconsistent"):
        timeline_to_series(tl)


def test_unrecognised_source_rejected(pns: Scenario) -> None:
    tl = _synthetic_timeline(pns)
    tl.source = "mystery"
    with pytest.raises(RescueCompatError, match="real from synthetic"):
        timeline_to_series(tl)


def test_single_sample_timeline_rejected(pns: Scenario) -> None:
    with pytest.raises(RescueCompatError, match="at least 2 samples"):
        timeline_to_series(_synthetic_timeline(pns).slice(0, 1))


# --- ViabilityAssessment -> ViabilityResult -----------------------------------------------


def test_passing_assessment_maps_cleanly(pns: Scenario, pns_series: ScientificTimeSeries) -> None:
    mission = scenario_to_mission(pns)
    a = _assessment(mission, pns_series, _all_constraints(), score=82.5, metrics=KNOWN_GOOD)
    r = assessment_to_result(a, pns, "synthetic-placeholder")
    assert r.passes and r.eligibility == "pass" and r.verdict == "pass"
    assert r.violations == [] and r.score == 82.5
    assert r.source == SOURCE and r.data_source == "synthetic-placeholder" and r.scenario == pns
    m = r.metrics
    assert m.sunlight_fraction == 0.8 and m.equivalent_sun_hours == pytest.approx(0.8 * 168)
    assert m.longest_dark_gap_hours == 10 and m.longest_comms_gap_hours == 30
    assert m.earth_visibility_fraction == pytest.approx(0.6)
    assert m.initial_sun_hours == 48 and m.initial_comms_hours == 20
    assert m.hours_to_first_sunset == 48 and m.hours_to_first_earthset is None  # never sets
    assert ViabilityResult.model_validate_json(r.model_dump_json()) == r


def test_failed_constraint_becomes_rescue_violation(pns: Scenario, pns_series: ScientificTimeSeries) -> None:
    dark = Metric.known(60 * H, Unit.SECONDS)
    cons = _all_constraints(
        {ConstraintId.MAX_CONTINUOUS_DARKNESS: ConstraintStatus.FAIL}, longest_continuous_darkness=dark
    )
    a = _assessment(
        scenario_to_mission(pns), pns_series, cons, metrics={**KNOWN_GOOD, "longest_continuous_darkness": dark}
    )
    r = assessment_to_result(a, pns, "synthetic-placeholder")
    assert not r.passes and r.eligibility == "fail" and len(r.violations) == 1
    v = r.violations[0]
    assert v.is_unknown is False  # a decided failure: rescue may suggest relaxing it
    assert (v.constraint, v.required, v.actual, v.unit) == ("battery_hours", 50, 60, "h")
    assert v.shortfall == pytest.approx(10) and v.relative_shortfall == pytest.approx(0.2)
    assert v.constraint in CHECK_BY_CONSTRAINT  # rescue's loosening table understands it


def test_unknown_constraint_is_not_passing_and_worst_case(pns: Scenario, pns_series: ScientificTimeSeries) -> None:
    earth = Metric.bounded(35.0, 55.0, Unit.PERCENT)
    cons = _all_constraints(
        {ConstraintId.MIN_EARTH_VISIBILITY_PERCENT: ConstraintStatus.UNKNOWN}, earth_visible_percent=earth
    )
    a = _assessment(scenario_to_mission(pns), pns_series, cons, metrics={**KNOWN_GOOD, "earth_visible_percent": earth})
    assert a.eligibility is Eligibility.UNKNOWN
    r = assessment_to_result(a, pns, "synthetic-placeholder")
    assert not r.passes and r.eligibility == "unknown" and r.verdict == "unknown"  # not a failure
    (v,) = r.violations
    assert v.constraint == "min_earth_visibility_fraction" and v.actual == pytest.approx(0.35)  # unfavourable bound
    assert v.message.startswith("UNKNOWN") and v.is_unknown is True
    assert r.metrics.earth_visibility_fraction == pytest.approx(0.35)


def test_unavailable_metrics_reported_at_worst_case(pns: Scenario, pns_series: ScientificTimeSeries) -> None:
    gone = {cid: ConstraintStatus.UNKNOWN for cid in CONSTRAINT_TO_RESCUE}
    unavailable = {
        name: Metric.unavailable(unit, "no data")
        for name, unit in [
            ("mean_solar_disk_fraction", Unit.FRACTION),
            ("longest_continuous_darkness", Unit.SECONDS),
            ("earth_visible_percent", Unit.PERCENT),
            ("longest_communication_blackout", Unit.SECONDS),
            ("initial_sunlight_duration", Unit.SECONDS),
            ("initial_earth_visibility_duration", Unit.SECONDS),
        ]
    }
    cons = _all_constraints(gone, **unavailable)
    a = _assessment(
        scenario_to_mission(pns),
        pns_series,
        cons,
        score=None,
        metrics={"mean_solar_elevation": Metric.known(0.9, Unit.DEGREES)},
    )
    r = assessment_to_result(a, pns, "synthetic-placeholder")
    assert not r.passes and r.eligibility == "unknown" and r.score is None and len(r.violations) == 6
    assert all(v.is_unknown for v in r.violations)
    m = r.metrics
    assert m.sunlight_fraction == 0 and m.earth_visibility_fraction == 0
    assert m.longest_dark_gap_hours == pytest.approx(168) and m.longest_comms_gap_hours == pytest.approx(168)
    assert m.initial_sun_hours == 0 and m.hours_to_first_sunset == 0  # assume immediate, never "never"
    assert m.mean_sun_clearance_deg is None
    by = {v.constraint: v for v in r.violations}
    assert by["battery_hours"].actual == pytest.approx(168) and by["min_sunlight_fraction"].actual == 0
    assert all(v.message.startswith("UNKNOWN") for v in r.violations)
    assert all(not math.isinf(v.relative_shortfall) for v in r.violations)


def test_missing_solar_elevation_cannot_be_invented(pns: Scenario, pns_series: ScientificTimeSeries) -> None:
    a = _assessment(
        scenario_to_mission(pns),
        pns_series,
        _all_constraints(),
        metrics={**KNOWN_GOOD, "mean_solar_elevation": Metric.unavailable(Unit.DEGREES, "x")},
    )
    with pytest.raises(RescueCompatError, match="mean_solar_elevation"):
        assessment_to_result(a, pns, "synthetic-placeholder")


@pytest.mark.parametrize(
    "statuses",
    [{}, {ConstraintId.MAX_CONTINUOUS_DARKNESS: ConstraintStatus.FAIL}],
    ids=["pass", "fail"],
)
def test_missing_score_stays_none(
    pns: Scenario, pns_series: ScientificTimeSeries, statuses: dict[ConstraintId, ConstraintStatus]
) -> None:
    a = _assessment(scenario_to_mission(pns), pns_series, _all_constraints(statuses), score=None, metrics=KNOWN_GOOD)
    r = assessment_to_result(a, pns, "synthetic-placeholder")
    assert r.score is None and r.score_or_zero == 0.0  # "not scored", never a fabricated number
    assert ViabilityResult.model_validate_json(r.model_dump_json()) == r


def test_failure_mixed_with_unknown_keeps_both_flags(pns: Scenario, pns_series: ScientificTimeSeries) -> None:
    dark = Metric.known(60 * H, Unit.SECONDS)
    earth = Metric.bounded(35.0, 55.0, Unit.PERCENT)
    cons = _all_constraints(
        {
            ConstraintId.MAX_CONTINUOUS_DARKNESS: ConstraintStatus.FAIL,
            ConstraintId.MIN_EARTH_VISIBILITY_PERCENT: ConstraintStatus.UNKNOWN,
        },
        longest_continuous_darkness=dark,
        earth_visible_percent=earth,
    )
    metrics = {**KNOWN_GOOD, "longest_continuous_darkness": dark, "earth_visible_percent": earth}
    r = assessment_to_result(_assessment(scenario_to_mission(pns), pns_series, cons, metrics=metrics), pns, "x")
    assert r.eligibility == "fail" and not r.passes  # any FAIL dominates
    flags = {v.constraint: v.is_unknown for v in r.violations}
    assert flags == {"battery_hours": False, "min_earth_visibility_fraction": True}


def test_shared_result_fields_serialize(pns: Scenario, pns_series: ScientificTimeSeries) -> None:
    earth = Metric.bounded(35.0, 55.0, Unit.PERCENT)
    cons = _all_constraints({ConstraintId.MIN_EARTH_VISIBILITY_PERCENT: ConstraintStatus.UNKNOWN})
    a = _assessment(
        scenario_to_mission(pns), pns_series, cons, score=None, metrics={**KNOWN_GOOD, "earth_visible_percent": earth}
    )
    data = json.loads(assessment_to_result(a, pns, "synthetic-placeholder").model_dump_json())
    assert data["eligibility"] == "unknown" and data["passes"] is False and data["score"] is None
    assert data["violations"][0]["is_unknown"] is True


def test_failing_constraint_without_rescue_field_rejected(pns: Scenario, pns_series: ScientificTimeSeries) -> None:
    extra = _constraint(
        ConstraintId.MIN_SUNLIGHT_PERCENT, ConstraintStatus.FAIL, 50.0, Unit.PERCENT, Metric.known(10.0, Unit.PERCENT)
    )
    a = _assessment(scenario_to_mission(pns), pns_series, [*_all_constraints(), extra], metrics=KNOWN_GOOD)
    with pytest.raises(RescueCompatError, match="no rescue requirement field"):
        assessment_to_result(a, pns, "synthetic-placeholder")


def test_every_mapped_constraint_is_known_to_rescue() -> None:
    assert {field for field, _, _ in CONSTRAINT_TO_RESCUE.values()} == set(CHECK_BY_CONSTRAINT)


# --- integration with rescue's own code ---------------------------------------------------


def test_real_engine_not_available_yet(pns: Scenario) -> None:
    with pytest.raises(NotImplementedError, match="Phases 3-6"):
        evaluate_timeline(pns, _synthetic_timeline(pns))


def test_rescue_still_uses_its_placeholder() -> None:
    assert rescue_default_evaluate is placeholder_evaluate  # we did not swap Member 5's import


def test_rescue_evaluator_runs_through_compat_layer_with_test_double(pns: Scenario) -> None:
    calls: list[tuple[MissionScenario, ScientificTimeSeries]] = []

    def test_double_engine(mission: MissionScenario, series: ScientificTimeSeries) -> ViabilityAssessment:
        """TEST DOUBLE, not the viability algorithm: reports every constraint UNKNOWN."""
        calls.append((mission, series))
        cons = _all_constraints({cid: ConstraintStatus.UNKNOWN for cid in CONSTRAINT_TO_RESCUE})
        return _assessment(mission, series, cons, score=None, metrics=KNOWN_GOOD)

    ev = Evaluator(provider=SyntheticTimelineProvider(), evaluate=make_evaluate_fn(test_double_engine))
    result = ev.evaluate(pns)

    ((mission, series),) = calls
    assert mission.mission_start_utc == LANDING and len(series.samples) == 168
    assert series.provenance.is_synthetic is True
    assert isinstance(result, ViabilityResult) and result.source == SOURCE
    assert not result.passes and result.eligibility == "unknown" and result.score is None
    assert all(v.is_unknown for v in result.violations)
    assert {v.constraint for v in result.violations} == set(CHECK_BY_CONSTRAINT)
    reasons = why_fails(result)  # rescue's own explanation code accepts the result
    assert len(reasons) == 6 and all(r.startswith("UNKNOWN") for r in reasons)
    json.loads(result.model_dump_json())


# --- Phase 2: sampling semantics through the compat layer ----------------------------------


def test_bin_layout_extends_coverage_by_exactly_one_step(pns: Scenario) -> None:
    tl = _synthetic_timeline(pns)
    end = LANDING + timedelta(days=7)
    assert timeline_to_series(tl).coverage_end_utc == end - timedelta(hours=1)  # default: faithful
    s = timeline_to_series(tl, mission_end_utc=end)
    assert s.coverage_end_utc == end
    assert "extended by one step" in (s.provenance.notes or "")
    # Any other layout is left alone (never extended by more than one step or on a guess).
    assert timeline_to_series(tl, mission_end_utc=end + timedelta(hours=1)).coverage_end_utc == end - timedelta(hours=1)
    with pytest.raises(RescueCompatError, match="timezone-aware"):
        timeline_to_series(tl, mission_end_utc=end.replace(tzinfo=None))


def test_rescue_mission_has_no_unknown_last_hour(pns: Scenario) -> None:
    tl = _synthetic_timeline(pns)
    mission = scenario_to_mission(pns)
    a = analyze_scenario(mission, timeline_to_series(tl, mission_end_utc=mission.mission_end_utc))
    assert a.data_quality.uncovered_duration_s == 0.0 and a.data_quality.sample_count == 168
    # Without the bin rule the final hour would be unknown and every metric merely bounded.
    b = analyze_scenario(mission, timeline_to_series(tl))
    assert b.data_quality.uncovered_duration_s == 3600.0


def test_engine_receives_bin_extended_series(pns: Scenario) -> None:
    seen: list[ScientificTimeSeries] = []

    class Captured(Exception):
        pass

    def spy(mission: MissionScenario, series: ScientificTimeSeries) -> ViabilityAssessment:
        seen.append(series)
        raise Captured

    with pytest.raises(Captured):
        evaluate_timeline(pns, _synthetic_timeline(pns), engine=spy)
    assert seen[0].coverage_end_utc == LANDING + timedelta(days=7)


def _canonical_as_placeholder(a: EnvironmentAnalysis) -> dict[str, float | None]:
    m = a.metrics

    def h(x: Metric) -> float | None:
        if x.status is MetricStatus.NOT_APPLICABLE:
            return None
        assert x.status is MetricStatus.KNOWN and x.value is not None
        return x.value / 3600.0

    def deg(x: Metric) -> float | None:
        return x.value if x.status is MetricStatus.KNOWN else None

    assert m.earth_visible_percent.value is not None
    return {
        "sunlight_fraction": m.mean_solar_disk_fraction.value,
        "longest_dark_gap_hours": h(m.longest_continuous_darkness),
        "earth_visibility_fraction": m.earth_visible_percent.value / 100.0,
        "longest_comms_gap_hours": h(m.longest_communication_blackout),
        "initial_sun_hours": h(m.initial_sunlight_duration),
        "initial_comms_hours": h(m.initial_earth_visibility_duration),
        "hours_to_first_sunset": h(m.time_to_first_sunset),
        "hours_to_first_earthset": h(m.time_to_first_earthset),
        "mean_sun_clearance_deg": deg(m.mean_sun_clearance),
        "mean_earth_clearance_deg": deg(m.mean_earth_clearance),
        "mean_solar_elevation_deg": m.mean_solar_elevation.value,
    }


@pytest.mark.parametrize("site_id", ["connecting-ridge", "malapert-massif", "peak-near-shackleton"])
@pytest.mark.parametrize("day", [0, 61, 200, 333, 512, 700])
def test_phase2_metrics_match_rescue_placeholder_on_real_data(site_id: str, day: int) -> None:
    """Section 5a item 6: same timelines, same numbers (panel_threshold 0.25 > 0, see item 3)."""
    provider = PrecomputedTimelineProvider(fallback=SyntheticTimelineProvider(), data_dir=SITES_DIR)
    landing = datetime(2027, 1, 1, tzinfo=UTC) + timedelta(days=day)
    sc = Scenario(site=get_site(site_id).to_site(), landing_utc=landing, duration_days=14)
    n = 14 * 24
    tl = provider.timeline(sc.site, landing, landing + timedelta(hours=n - 1), 1.0).slice(0, n)
    assert tl.source.startswith("precomputed:")
    mission = scenario_to_mission(sc)
    ours = _canonical_as_placeholder(
        analyze_scenario(mission, timeline_to_series(tl, mission_end_utc=mission.mission_end_utc))
    )
    theirs = placeholder_compute_metrics(tl, sc.requirements).model_dump()
    for key, value in ours.items():
        expected = theirs[key]
        if expected is None or value is None:
            assert value is None and expected is None, key
        else:
            assert value == pytest.approx(expected, rel=1e-12, abs=1e-12), key


# --- Andrew's format 1.1 and dataset coverage through the compat layer ---------------------


def test_unknown_earth_kept_unknown_not_blackout(pns: Scenario) -> None:
    tl = _synthetic_timeline(pns)
    tl.earth_horizon[5] = np.nan  # rescue stores earth_visible=False where the margin is unknown
    tl.earth_visible[5] = False
    obs = timeline_to_series(tl).samples[5].earth
    assert obs.state is U and obs.horizon_deg is None


def _real_timeline(site_id: str, end: datetime, days: int = 2) -> tuple[Scenario, Timeline]:
    provider = PrecomputedTimelineProvider(fallback=SyntheticTimelineProvider(), data_dir=SITES_DIR)
    landing = end - timedelta(days=days)
    sc = Scenario(site=get_site(site_id).to_site(), landing_utc=landing, duration_days=days)
    n = days * 24
    return sc, provider.timeline(sc.site, landing, landing + timedelta(hours=n - 1), 1.0).slice(0, n)


def test_final_bin_inside_dataset_is_covered() -> None:
    sc, tl = _real_timeline("peak-near-shackleton", datetime(2029, 1, 1, tzinfo=UTC))
    mission = scenario_to_mission(sc)
    s = timeline_to_series(tl, mission_end_utc=mission.mission_end_utc, precomputed_data_dir=SITES_DIR)
    assert s.coverage_end_utc == datetime(2029, 1, 1, tzinfo=UTC)
    assert analyze_scenario(mission, s).data_quality.uncovered_duration_s == 0.0


def test_final_bin_beyond_dataset_end_is_not_fabricated() -> None:
    """Mission ending 2029-01-01T01:00Z: rescue serves a slice whose last bin starts at the file's final instant."""
    sc, tl = _real_timeline("peak-near-shackleton", datetime(2029, 1, 1, 1, tzinfo=UTC))
    assert tl.source.startswith("precomputed:")
    assert precomputed_dataset_end(tl.source, SITES_DIR) == datetime(2029, 1, 1, tzinfo=UTC)
    mission = scenario_to_mission(sc)
    s = timeline_to_series(tl, mission_end_utc=mission.mission_end_utc, precomputed_data_dir=SITES_DIR)
    assert s.coverage_end_utc == datetime(2029, 1, 1, tzinfo=UTC)  # not extended to 01:00
    assert "NOT extended" in (s.provenance.notes or "")
    a = analyze_scenario(mission, s)
    assert a.data_quality.uncovered_duration_s == 3600.0
    assert a.metrics.sunlight_duration.status is MetricStatus.BOUNDED  # the hour is unknown, not assumed


def test_mission_past_dataset_falls_back_to_flagged_synthetic_data() -> None:
    """Rescue's provider (Member 5) swaps to synthetic geometry; the compat layer keeps that visible."""
    sc, tl = _real_timeline("peak-near-shackleton", datetime(2029, 1, 1, 3, tzinfo=UTC))
    assert tl.source.startswith("synthetic")
    mission = scenario_to_mission(sc)
    a = analyze_scenario(mission, timeline_to_series(tl, mission_end_utc=mission.mission_end_utc))
    assert a.data_quality.provenance.is_synthetic is True
    assert any("SYNTHETIC" in w for w in a.data_quality.warnings)


def test_precomputed_dataset_end_is_conservative(tmp_path: Path) -> None:
    assert precomputed_dataset_end("synthetic-placeholder", SITES_DIR) is None
    assert precomputed_dataset_end("precomputed:missing.json", SITES_DIR) is None
    assert precomputed_dataset_end("precomputed:../sites/peak-near-shackleton.json", tmp_path) is None  # no escape
    (tmp_path / "broken.json").write_text("{not json", encoding="utf-8")
    assert precomputed_dataset_end("precomputed:broken.json", tmp_path) is None
    steps = [{"time_utc": "2027-01-01T00:00Z"}, {"time_utc": "2027-01-01T05:00Z"}]
    (tmp_path / "steps.json").write_text(json.dumps(steps), encoding="utf-8")
    assert precomputed_dataset_end("precomputed:steps.json", tmp_path) == datetime(2027, 1, 1, 5, tzinfo=UTC)


# --- Phase 3: canonical constraint verdicts vs rescue's placeholder -----------------------------


def _real_rescue_case(site_id: str, day: int, req: RescueRequirements) -> tuple[Scenario, Timeline]:
    provider = PrecomputedTimelineProvider(fallback=SyntheticTimelineProvider(), data_dir=SITES_DIR)
    landing = datetime(2027, 1, 1, tzinfo=UTC) + timedelta(days=day)
    sc = Scenario(site=get_site(site_id).to_site(), landing_utc=landing, duration_days=14, requirements=req)
    n = 14 * 24
    tl = provider.timeline(sc.site, landing, landing + timedelta(hours=n - 1), 1.0).slice(0, n)
    assert tl.source.startswith("precomputed:")
    return sc, tl


STRICT_RESCUE = RescueRequirements(
    min_sunlight_fraction=0.6,
    battery_hours=24,
    panel_threshold=0.5,
    min_earth_visibility_fraction=0.55,
    max_comms_gap_hours=24,
    min_initial_sun_hours=72,
    min_initial_comms_hours=48,
)


@pytest.mark.parametrize("site_id", ["connecting-ridge", "malapert-massif", "peak-near-shackleton"])
@pytest.mark.parametrize("day", [0, 61, 200, 333, 512, 700])
@pytest.mark.parametrize("req", [RescueRequirements.model_validate({}), STRICT_RESCUE], ids=["default", "strict"])
def test_phase3_verdicts_match_rescue_placeholder_on_real_data(site_id: str, day: int, req: RescueRequirements) -> None:
    """Same timelines: identical failing checks, eligibility and Violation numbers (no unknowns here)."""
    sc, tl = _real_rescue_case(site_id, day, req)
    mission = scenario_to_mission(sc)
    phase3 = assess_constraints(mission, timeline_to_series(tl, mission_end_utc=mission.mission_end_utc))
    old = placeholder_evaluate(sc, tl)
    assert phase3.with_status(ConstraintStatus.UNKNOWN) == []
    assert phase3.eligibility.value == old.verdict
    hours = mission.duration_s / H
    ours = {
        v.constraint: v for v in (constraint_to_violation(c, hours) for c in phase3.with_status(ConstraintStatus.FAIL))
    }
    theirs = {v.constraint: v for v in old.violations}
    assert set(ours) == set(theirs)
    for field, v in ours.items():
        assert not v.is_unknown
        assert v.required == pytest.approx(theirs[field].required, rel=1e-12)
        assert v.actual == pytest.approx(theirs[field].actual, rel=1e-12, abs=1e-12)
    # Only constraints rescue can express are ever applicable for a rescue scenario.
    applicable = {c.constraint_id for c in phase3.constraints if c.status is not ConstraintStatus.NOT_APPLICABLE}
    assert applicable == set(CONSTRAINT_TO_RESCUE)


def test_phase3_unknown_verdicts_map_to_unknown_violations() -> None:
    """Final rescue bin past the dataset end: canonical UNKNOWN -> is_unknown, never a loosening target."""
    sc, tl = _real_timeline("malapert-massif", datetime(2029, 1, 1, 1, tzinfo=UTC))
    mission = scenario_to_mission(sc)
    series = timeline_to_series(tl, mission_end_utc=mission.mission_end_utc)
    phase3 = assess_constraints(mission, series)
    assert phase3.environment.data_quality.uncovered_duration_s == H
    unknown = phase3.with_status(ConstraintStatus.UNKNOWN)
    for c in unknown:
        v = constraint_to_violation(c, mission.duration_s / H)
        assert v.is_unknown and v.message.startswith("UNKNOWN")
    for c in phase3.with_status(ConstraintStatus.FAIL):
        assert not constraint_to_violation(c, mission.duration_s / H).is_unknown


def test_phase3_on_rescue_synthetic_fallback_is_labelled_synthetic() -> None:
    """A rescue mission reaching past 2029-01-01 is evaluated on synthetic geometry by rescue's provider.

    Phase 3 then gives definite verdicts, but the assessment must say the data are synthetic.
    """
    sc, tl = _real_timeline("malapert-massif", datetime(2029, 1, 7, 22, tzinfo=UTC), days=7)
    assert tl.source.startswith("synthetic")
    mission = scenario_to_mission(sc)
    phase3 = assess_constraints(mission, timeline_to_series(tl, mission_end_utc=mission.mission_end_utc))
    dq = phase3.environment.data_quality
    assert dq.provenance.is_synthetic is True
    assert any(w.startswith("SYNTHETIC data") for w in dq.warnings)
    assert "SYNTHETIC" in dq.provenance.ephemeris_source and "SYNTHETIC" in (dq.provenance.terrain_source or "")
