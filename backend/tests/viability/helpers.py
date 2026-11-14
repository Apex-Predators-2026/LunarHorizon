"""Shared builders for viability contract tests. All data here is SYNTHETIC."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

from app.viability.enums import (
    AngleType,
    CalculationBasis,
    ConstraintId,
    ConstraintStatus,
    Eligibility,
    RiskLevel,
    SamplingPolicy,
    Unit,
    VisibilityCriterion,
    VisibilityState,
)
from app.viability.explain import STANDARD_LIMITATIONS
from app.viability.fixtures import build_fixture
from app.viability.inputs import ScientificTimeSeries
from app.viability.outputs import (
    ConstraintEvaluation,
    DataQualitySummary,
    Metric,
    MetricsSummary,
    ScoreBreakdown,
)

START = datetime(2027, 1, 1, tzinfo=UTC)
END = datetime(2027, 1, 2, tzinfo=UTC)


METRIC_UNITS: dict[str, Unit] = {
    "sunlight_duration": Unit.SECONDS,
    "sunlight_percent": Unit.PERCENT,
    "full_sunlight_duration": Unit.SECONDS,
    "full_sunlight_percent": Unit.PERCENT,
    "partial_sunlight_duration": Unit.SECONDS,
    "partial_sunlight_percent": Unit.PERCENT,
    "power_lit_duration": Unit.SECONDS,
    "power_lit_percent": Unit.PERCENT,
    "earth_visible_duration": Unit.SECONDS,
    "earth_visible_percent": Unit.PERCENT,
    "simultaneous_duration": Unit.SECONDS,
    "simultaneous_percent": Unit.PERCENT,
    "longest_simultaneous_window": Unit.SECONDS,
    "longest_continuous_darkness": Unit.SECONDS,
    "longest_without_direct_sunlight": Unit.SECONDS,
    "longest_communication_blackout": Unit.SECONDS,
    "mean_solar_disk_fraction": Unit.FRACTION,
    "initial_sunlight_duration": Unit.SECONDS,
    "initial_earth_visibility_duration": Unit.SECONDS,
    "time_to_first_sunset": Unit.SECONDS,
    "time_to_first_earthset": Unit.SECONDS,
    "mean_sun_clearance": Unit.DEGREES,
    "mean_earth_clearance": Unit.DEGREES,
    "mean_solar_elevation": Unit.DEGREES,
}


def unavailable_metrics(**overrides: Metric) -> MetricsSummary:
    """Every metric UNAVAILABLE (placeholder), except the given overrides."""
    fields = {name: Metric.unavailable(unit, "phase 1 placeholder") for name, unit in METRIC_UNITS.items()}
    fields.update(overrides)
    return MetricsSummary(**fields)


def constraint(cid: ConstraintId, status: ConstraintStatus) -> ConstraintEvaluation:
    if status is ConstraintStatus.NOT_APPLICABLE:
        return ConstraintEvaluation(
            constraint_id=cid,
            status=status,
            threshold=None,
            unit=Unit.SECONDS,
            measured=Metric.not_applicable(Unit.SECONDS),
            message="not configured",
        )
    measured = (
        Metric.bounded(10.0, 30.0, Unit.SECONDS)
        if status is ConstraintStatus.UNKNOWN
        else Metric.known(10.0, Unit.SECONDS)
    )
    return ConstraintEvaluation(
        constraint_id=cid, status=status, threshold=20.0, unit=Unit.SECONDS, measured=measured, message="synthetic"
    )


def data_quality() -> DataQualitySummary:
    s = build_fixture("intermittent_sunlight")
    return DataQualitySummary(
        dataset_id=s.dataset_id,
        provenance=s.provenance,
        calculation_basis=s.calculation_basis,
        angle_type=s.angle_type,
        sun_criterion=s.sun_criterion,
        earth_criterion=s.earth_criterion,
        **full_coverage_quality_fields(len(s.samples)),
    )


def full_coverage_quality_fields(sample_count: int, duration_s: float = 86400.0) -> dict[str, Any]:
    """Phase 2 DataQualitySummary fields for a fully covered hourly range."""
    return {
        "sampling_policy": SamplingPolicy.SAMPLE_HOLD,
        "evaluated_duration_s": duration_s,
        "sample_count": sample_count,
        "largest_sample_gap_s": 3600.0,
        "uncovered_duration_s": 0.0,
        "coverage_gap_count": 0,
        "sun_unknown_duration_s": 0.0,
        "earth_unknown_duration_s": 0.0,
        "sun_coverage_percent": 100.0,
        "earth_coverage_percent": 100.0,
    }


def assessment_kwargs(
    eligibility: Eligibility = Eligibility.PASS,
    statuses: tuple[ConstraintStatus, ...] = (ConstraintStatus.PASS, ConstraintStatus.NOT_APPLICABLE),
) -> dict[str, Any]:
    ids = list(ConstraintId)
    return {
        "engine_version": "test",
        "scenario_id": "test-scenario-1",
        "site": {"id": "site-1", "name": "Test site", "lat": -89.5, "lon": 45.0},
        "evaluated_start_utc": START,
        "evaluated_end_utc": END,
        "eligibility": eligibility,
        "constraints": [constraint(ids[i], s) for i, s in enumerate(statuses)],
        "metrics": unavailable_metrics(),
        "windows": [],
        "margins": [],
        "risks": [],
        "overall_risk": RiskLevel.UNKNOWN,
        "score": ScoreBreakdown(method_version="test", score=None, rank_eligible=eligibility is Eligibility.PASS),
        "explanations": [],
        "data_quality": data_quality(),
        "limitations": list(STANDARD_LIMITATIONS),
    }


# --- Phase 2: compact SYNTHETIC series from per-sample states --------------------------------

T0 = START
SunCode = str | float  # "V" visible, "N" not visible, "U" unknown terrain, "X" no ephemeris, float = partial


def at(hours: float) -> datetime:
    return T0 + timedelta(hours=hours)


def _sun(code: SunCode, geometric: bool, center: bool) -> dict[str, Any]:
    """Angles chosen so clearance is V: +1.0, partial: 0.0, N: -1.0 deg (elevation 2 / 1 / 0)."""
    if code == "X":
        return {"azimuth_deg": None, "elevation_deg": None, "horizon_deg": None, "state": VisibilityState.UNKNOWN}
    if code == "U":
        return {"azimuth_deg": 100.0, "elevation_deg": 1.5, "horizon_deg": None, "state": VisibilityState.UNKNOWN}
    if isinstance(code, float):
        if not 0.0 < code < 1.0:
            raise ValueError("partial fraction must be in (0, 1)")
        el, frac, state = 1.0, code, VisibilityState.PARTIAL
    elif code == "V":
        el, frac, state = 2.0, 1.0, VisibilityState.VISIBLE
    elif code == "N":
        el, frac, state = 0.0, 0.0, VisibilityState.NOT_VISIBLE
    else:
        raise ValueError(f"unknown sun code {code!r}")
    obs: dict[str, Any] = {"azimuth_deg": 100.0, "elevation_deg": el, "horizon_deg": 1.0, "state": state}
    if geometric:
        obs.update(elevation_deg=el - 1.0, horizon_deg=None)
    if center:
        if state is VisibilityState.PARTIAL:
            raise ValueError("partial is not allowed with the centre criterion")
    else:
        obs["visible_fraction"] = frac
    return obs


def _earth(code: str, geometric: bool) -> dict[str, Any]:
    """Earth clearance V: +2.0 deg, N: -1.0 deg; "U" = ephemeris missing."""
    if code == "U":
        return {"azimuth_deg": None, "elevation_deg": None, "horizon_deg": None, "state": VisibilityState.UNKNOWN}
    if code not in ("V", "N"):
        raise ValueError(f"unknown earth code {code!r}")
    el = 3.0 if code == "V" else 0.0
    state = VisibilityState.VISIBLE if code == "V" else VisibilityState.NOT_VISIBLE
    if geometric:
        return {"azimuth_deg": 20.0, "elevation_deg": el - 1.0, "horizon_deg": None, "state": state}
    return {"azimuth_deg": 20.0, "elevation_deg": el, "horizon_deg": 1.0, "state": state}


def make_series(
    hours: Sequence[float],
    sun: Sequence[SunCode],
    earth: Sequence[str] | None = None,
    *,
    nominal_h: float | None = 1.0,
    max_gap_h: float = 1.5,
    coverage_h: tuple[float, float] | None = None,
    geometric: bool = False,
    sun_center: bool = False,
) -> ScientificTimeSeries:
    """SYNTHETIC series with the given per-sample states (Earth visible throughout by default)."""
    earth = earth if earth is not None else ["V"] * len(hours)
    if not len(hours) == len(sun) == len(earth):
        raise ValueError("hours, sun and earth must have equal length")
    start_h, end_h = coverage_h if coverage_h is not None else (hours[0], hours[-1])
    return ScientificTimeSeries.model_validate(
        {
            "dataset_id": "synthetic-phase2-test",
            "site": {"id": "synthetic-site-a", "name": "Synthetic Site A", "lat": -89.5, "lon": 0.0},
            "observer_height_m": 2.0,
            "coverage_start_utc": at(start_h),
            "coverage_end_utc": at(end_h),
            "calculation_basis": CalculationBasis.GEOMETRIC_ONLY if geometric else CalculationBasis.TERRAIN_AWARE,
            "angle_type": AngleType.APPARENT,
            "sun_criterion": VisibilityCriterion.CENTER if sun_center else VisibilityCriterion.APPARENT_DISK,
            "earth_criterion": VisibilityCriterion.CENTER,
            "sampling": {
                "nominal_interval_s": None if nominal_h is None else nominal_h * 3600.0,
                "max_gap_s": max_gap_h * 3600.0,
            },
            "provenance": {
                "is_synthetic": True,
                "ephemeris_source": "SYNTHETIC test values",
                "terrain_source": None if geometric else "SYNTHETIC test horizon",
                "generated_at_utc": None,
                "generator": "tests.viability.helpers.make_series",
                "notes": "SYNTHETIC FIXTURE - NOT REAL DATA.",
            },
            "samples": [
                {"time_utc": at(h), "sun": _sun(s, geometric, sun_center), "earth": _earth(e, geometric)}
                for h, s, e in zip(hours, sun, earth, strict=True)
            ],
        }
    )


def hourly(sun: Sequence[SunCode], earth: Sequence[str] | None = None, **kw: Any) -> ScientificTimeSeries:
    """Samples at 0, 1, ..., n-1 h with coverage [0, n] h, so every sample holds one full hour."""
    n = len(sun)
    kw.setdefault("coverage_h", (0.0, float(n)))
    return make_series([float(h) for h in range(n)], sun, earth, **kw)


# --- independent run-length derivation from raw precomputed site files ------------------------


def longest_true_run(flags: Sequence[bool]) -> tuple[int, int]:
    """(length, start index) of the first longest run of True; (0, -1) if none. Pure Python on purpose."""
    best, best_start, run, start = 0, -1, 0, 0
    for i, f in enumerate(flags):
        if f:
            if run == 0:
                start = i
            run += 1
            if run > best:
                best, best_start = run, start
        else:
            run = 0
    return best, best_start


def raw_longest_outages(timeline: dict[str, Any], power_min_fraction: float = 0.25) -> dict[str, tuple[int, int]]:
    """Longest outage runs in hours (sample-and-hold, 1 h samples; the final instantaneous sample holds 0 s).

    Derived only from the raw columns, with no engine code, so tests need no pinned per-site numbers that
    would go stale whenever Member 1 regenerates the terrain. Requires fully known columns and 1 h steps.
    """
    tl = timeline  # the "timeline" object of a precomputed site file
    t0, t1 = (datetime.fromisoformat(t.replace("Z", "+00:00")) for t in tl["time_utc"][:2])
    assert t1 - t0 == timedelta(hours=1), "hourly samples required"
    n = len(tl["time_utc"]) - 1
    sun, frac, earth = tl["sun_visible"][:n], tl["sun_visible_fraction"][:n], tl["earth_visible"][:n]
    assert None not in sun and None not in frac and None not in earth, "unknown samples: runs would be ambiguous"
    return {
        "no_direct_sunlight": longest_true_run([not s for s in sun]),
        "power_dark": longest_true_run([(not s) or f < power_min_fraction for s, f in zip(sun, frac, strict=True)]),
        "earth_blackout": longest_true_run([not e for e in earth]),
        # simultaneous = power-eligible sunlight (fraction >= threshold) AND Earth visible
        "simultaneous": longest_true_run(
            [bool(s) and f >= power_min_fraction and bool(e) for s, f, e in zip(sun, frac, earth, strict=True)]
        ),
    }
