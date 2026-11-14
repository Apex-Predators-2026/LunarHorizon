"""Shared builders for viability contract tests. All data here is SYNTHETIC."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from app.viability.enums import ConstraintId, ConstraintStatus, Eligibility, RiskLevel, Unit
from app.viability.explain import STANDARD_LIMITATIONS
from app.viability.fixtures import build_fixture
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
    "partial_sunlight_duration": Unit.SECONDS,
    "sunlight_percent": Unit.PERCENT,
    "earth_visible_duration": Unit.SECONDS,
    "earth_visible_percent": Unit.PERCENT,
    "simultaneous_duration": Unit.SECONDS,
    "simultaneous_percent": Unit.PERCENT,
    "longest_continuous_darkness": Unit.SECONDS,
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
        sample_count=len(s.samples),
        largest_sample_gap_s=3600.0,
        sun_coverage_percent=100.0,
        earth_coverage_percent=100.0,
    )


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
