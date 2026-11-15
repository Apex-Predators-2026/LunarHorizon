"""Canonical evidence for the comparison: the viability engine's own metric states, constraint verdicts,
risk indicators, coverage and versions, converted to display units. Read-only: nothing is recomputed,
no unknown is filled, no bound is collapsed to a number.
"""
from __future__ import annotations

from datetime import UTC, datetime

from ..viability.enums import MetricStatus, Unit
from ..viability.outputs import Metric, ViabilityAssessment, VisibilityWindow
from .schemas import AssessmentInfo, CanonicalMetric, ConstraintItem, EvidenceWindow, RankingInfo, RiskItem

_HOUR = 3600.0

# MetricsSummary fields the comparison shows (display key -> canonical field).
METRIC_FIELDS: dict[str, str] = {
    "sunlight_percent": "sunlight_percent",
    "power_lit_percent": "power_lit_percent",
    "mean_solar_disk_fraction": "mean_solar_disk_fraction",
    "longest_power_darkness_h": "longest_continuous_darkness",
    "longest_without_sun_h": "longest_without_direct_sunlight",
    "earth_visible_percent": "earth_visible_percent",
    "longest_blackout_h": "longest_communication_blackout",
    "simultaneous_percent": "simultaneous_percent",
    "longest_simultaneous_h": "longest_simultaneous_window",
    "initial_sunlight_h": "initial_sunlight_duration",
    "initial_earth_h": "initial_earth_visibility_duration",
    "time_to_first_sunset_h": "time_to_first_sunset",
    "time_to_first_earthset_h": "time_to_first_earthset",
    "mean_sun_clearance_deg": "mean_sun_clearance",
    "mean_earth_clearance_deg": "mean_earth_clearance",
    "mean_solar_elevation_deg": "mean_solar_elevation",
}

_UNIT = {Unit.SECONDS: "h", Unit.PERCENT: "%", Unit.FRACTION: "fraction", Unit.DEGREES: "deg"}


def _conv(v: float | None, unit: Unit) -> float | None:
    if v is None:
        return None
    return v / _HOUR if unit is Unit.SECONDS else v


def canonical_metric(m: Metric) -> CanonicalMetric:
    return CanonicalMetric(
        status=m.status.value, unit=_UNIT[m.unit],
        value=_conv(m.value, m.unit) if m.status is MetricStatus.KNOWN else None,
        lower=_conv(m.lower, m.unit) if m.status is MetricStatus.BOUNDED else None,
        upper=_conv(m.upper, m.unit) if m.status is MetricStatus.BOUNDED else None,
        reason=m.reason,
    )


def iso_z(t: datetime) -> str:
    """UTC ISO 8601 with a Z suffix (seconds, plus microseconds only when present)."""
    return t.astimezone(UTC).isoformat().replace("+00:00", "Z")


def evidence_window(w: VisibilityWindow, start: datetime) -> EvidenceWindow:
    return EvidenceWindow(
        kind=w.kind.value, start_utc=iso_z(w.start_utc), end_utc=iso_z(w.end_utc), duration_s=w.duration_s,
        start_hour=(w.start_utc - start).total_seconds() / _HOUR,
        end_hour=(w.end_utc - start).total_seconds() / _HOUR,
        duration_hours=w.duration_s / _HOUR,
        clipped_at_start=w.clipped_at_start, clipped_at_end=w.clipped_at_end,
    )


# Older name kept for callers written against the evidence/time branch.
CanonicalWindow = EvidenceWindow


def assessment_info(a: ViabilityAssessment) -> AssessmentInfo:
    q = a.data_quality
    metrics = {key: canonical_metric(getattr(a.metrics, field)) for key, field in METRIC_FIELDS.items()}
    constraints = [
        ConstraintItem(
            id=c.constraint_id.value, name=c.name, status=c.status.value,
            comparison=c.comparison.value if c.comparison else None,
            threshold=_conv(c.threshold, c.unit), measured=canonical_metric(c.measured), message=c.message,
            requirement_field=c.requirement_field,
            unknown_reason=c.unknown_reason.value if c.unknown_reason else None,
            evidence_windows=[evidence_window(w, a.evaluated_start_utc) for w in c.evidence_windows],
        )
        for c in a.constraints
    ]
    from ..viability.compat.headroom import build_operational_headroom

    headroom = build_operational_headroom(a)
    return AssessmentInfo(
        margins=headroom.constraints,
        headroom=headroom,
        engine_version=a.engine_version,
        scoring_method_version=a.score.method_version or "",
        dataset_id=q.dataset_id,
        data_basis=a.data_basis.value,
        is_synthetic=q.provenance.is_synthetic,
        overall_risk=a.overall_risk.value,
        risks=[RiskItem(code=r.code, level=r.level.value, message=r.message) for r in a.risks],
        sun_coverage_percent=q.sun_coverage_percent,
        earth_coverage_percent=q.earth_coverage_percent,
        uncovered_hours=q.uncovered_duration_s / _HOUR,
        metrics=metrics,
        constraints=constraints,
        explanations=[e.message for e in a.explanations],
        limitations=list(a.limitations),
        evaluated_start_utc=iso_z(a.evaluated_start_utc),
        evaluated_end_utc=iso_z(a.evaluated_end_utc),
        windows=[evidence_window(w, a.evaluated_start_utc) for w in a.windows],
    )


def unassessed_ranking(reason: str) -> RankingInfo:
    """UNKNOWN for a scenario the engine never assessed (e.g. no data for the site/dates). Same verdict Rescue
    gives a mission outside the data: undecided, not failed, never ranked or scored."""
    return RankingInfo(
        eligibility="unknown", assessed=False, rank=None, group=None, group_size=0, ranked_in_group=0,
        explanation=f"Not ranked: cannot be decided. {reason}",
        score_status="eligibility_unknown", score=None, score_lower=None, score_upper=None,
        overall_risk="unknown", data_basis="none",
    )
