from __future__ import annotations

import json
from datetime import timedelta

import pytest
from pydantic import ValidationError

from app.viability.enums import ConstraintId, ConstraintStatus, Eligibility, MetricStatus, RiskLevel, Unit, WindowKind
from app.viability.outputs import (
    ConstraintEvaluation,
    Metric,
    RankedScenario,
    RankingResult,
    ScoreBreakdown,
    ViabilityAssessment,
    VisibilityWindow,
    derive_eligibility,
)

from .helpers import END, START, assessment_kwargs

P, F, U, NA = ConstraintStatus.PASS, ConstraintStatus.FAIL, ConstraintStatus.UNKNOWN, ConstraintStatus.NOT_APPLICABLE

# --- Metric ------------------------------------------------------------------------------


def test_metric_constructors() -> None:
    assert Metric.known(5.0, Unit.SECONDS).value == 5.0
    b = Metric.bounded(1.0, 2.0, Unit.PERCENT)
    assert (b.lower, b.upper, b.value) == (1.0, 2.0, None)
    assert Metric.unavailable(Unit.DEGREES, "no terrain").reason == "no terrain"
    assert Metric.not_applicable(Unit.SECONDS).status is MetricStatus.NOT_APPLICABLE


@pytest.mark.parametrize(
    "kwargs",
    [
        {"status": "known"},  # missing value
        {"status": "known", "value": 1.0, "lower": 0.0},
        {"status": "bounded", "lower": 2.0, "upper": 1.0},
        {"status": "bounded", "lower": 1.0},
        {"status": "bounded", "value": 1.0, "lower": 0.0, "upper": 2.0},
        {"status": "unavailable"},  # missing reason
        {"status": "unavailable", "value": 0.0, "reason": "x"},  # zero is not "unavailable"
        {"status": "not_applicable", "value": 0.0},
    ],
)
def test_metric_status_field_rules(kwargs: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        Metric.model_validate({"unit": "s", **kwargs})


def test_unavailable_metric_serializes_as_null_not_zero() -> None:
    data = json.loads(Metric.unavailable(Unit.SECONDS, "missing samples").model_dump_json())
    assert data["value"] is None and data["status"] == "unavailable"


# --- windows -----------------------------------------------------------------------------


def test_window_duration_must_match_times() -> None:
    with pytest.raises(ValidationError, match="does not match"):
        VisibilityWindow(
            kind=WindowKind.SUNLIGHT, start_utc=START, end_utc=START + timedelta(hours=1), duration_s=100.0
        )


def test_window_must_have_positive_length() -> None:
    with pytest.raises(ValidationError):
        VisibilityWindow(kind=WindowKind.DARKNESS, start_utc=START, end_utc=START, duration_s=0.0)


def test_valid_clipped_window() -> None:
    w = VisibilityWindow(
        kind=WindowKind.DARKNESS,
        start_utc=START,
        end_utc=START + timedelta(hours=2),
        duration_s=7200.0,
        clipped_at_start=True,
    )
    assert w.clipped_at_start and not w.clipped_at_end


# --- eligibility -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("statuses", "expected"),
    [
        ([], Eligibility.PASS),
        ([NA, NA], Eligibility.PASS),
        ([P, P], Eligibility.PASS),
        ([P, U], Eligibility.UNKNOWN),
        ([P, U, F], Eligibility.FAIL),
        ([F, NA], Eligibility.FAIL),
        ([U, NA], Eligibility.UNKNOWN),
    ],
)
def test_derive_eligibility(statuses: list[ConstraintStatus], expected: Eligibility) -> None:
    assert derive_eligibility(statuses) is expected


def test_constraint_threshold_only_absent_when_not_applicable() -> None:
    with pytest.raises(ValidationError, match="threshold"):
        ConstraintEvaluation(
            constraint_id=ConstraintId.MIN_SUNLIGHT_PERCENT,
            status=P,
            threshold=None,
            unit=Unit.PERCENT,
            measured=Metric.known(80.0, Unit.PERCENT),
            message="x",
        )


def test_constraint_unit_mismatch_rejected() -> None:
    with pytest.raises(ValidationError, match="unit"):
        ConstraintEvaluation(
            constraint_id=ConstraintId.MIN_SUNLIGHT_PERCENT,
            status=P,
            threshold=50.0,
            unit=Unit.PERCENT,
            measured=Metric.known(80.0, Unit.SECONDS),
            message="x",
        )


# --- assessment --------------------------------------------------------------------------


def test_valid_assessment_round_trips_through_json() -> None:
    a = ViabilityAssessment(**assessment_kwargs())
    raw = a.model_dump_json()
    again = ViabilityAssessment.model_validate_json(raw)
    assert again == a
    data = json.loads(raw)
    assert data["eligibility"] == "pass"
    assert data["evaluated_start_utc"] == "2027-01-01T00:00:00Z"
    assert data["metrics"]["sunlight_duration"]["value"] is None
    assert data["data_quality"]["provenance"]["is_synthetic"] is True


@pytest.mark.parametrize(
    ("claimed", "statuses"),
    [
        (Eligibility.PASS, (P, U)),  # unknown must never silently pass
        (Eligibility.PASS, (P, F)),
        (Eligibility.UNKNOWN, (P, F)),  # failure dominates
        (Eligibility.FAIL, (P, P)),
    ],
)
def test_eligibility_must_follow_constraints(claimed: Eligibility, statuses: tuple[ConstraintStatus, ...]) -> None:
    kwargs = assessment_kwargs(eligibility=claimed, statuses=statuses)
    with pytest.raises(ValidationError, match="contradicts constraint results"):
        ViabilityAssessment(**kwargs)


def test_failed_scenario_cannot_be_rank_eligible() -> None:
    kwargs = assessment_kwargs(eligibility=Eligibility.FAIL, statuses=(F,))
    kwargs["score"] = kwargs["score"].model_copy(update={"score": 99.0, "rank_eligible": True})
    with pytest.raises(ValidationError, match="rank_eligible"):
        ViabilityAssessment(**kwargs)


def test_failed_scenario_may_still_carry_a_score() -> None:
    kwargs = assessment_kwargs(eligibility=Eligibility.FAIL, statuses=(F,))
    kwargs["score"] = kwargs["score"].model_copy(update={"score": 99.0})
    a = ViabilityAssessment(**kwargs)
    assert a.eligibility is Eligibility.FAIL and not a.score.rank_eligible


def test_duplicate_constraints_rejected() -> None:
    kwargs = assessment_kwargs(statuses=(P,))
    kwargs["constraints"] = kwargs["constraints"] * 2
    with pytest.raises(ValidationError, match="at most once"):
        ViabilityAssessment(**kwargs)


def test_window_outside_evaluated_range_rejected() -> None:
    kwargs = assessment_kwargs()
    kwargs["windows"] = [
        VisibilityWindow(kind=WindowKind.SUNLIGHT, start_utc=END, end_utc=END + timedelta(hours=1), duration_s=3600.0)
    ]
    with pytest.raises(ValidationError, match="within the evaluated range"):
        ViabilityAssessment(**kwargs)


@pytest.mark.parametrize("value", [-1.0, 100.5])
def test_score_out_of_range_rejected(value: float) -> None:
    with pytest.raises(ValidationError):
        ScoreBreakdown(method_version="t", score=value, rank_eligible=True)


# --- ranking -----------------------------------------------------------------------------


def _entry(sid: str, elig: Eligibility, rank: int | None, score: float | None) -> RankedScenario:
    return RankedScenario(rank=rank, scenario_id=sid, eligibility=elig, score=score, overall_risk=RiskLevel.LOW)


def test_valid_ranking() -> None:
    r = RankingResult(
        method_version="t",
        entries=[
            _entry("a", Eligibility.PASS, 1, 70.0),
            _entry("b", Eligibility.PASS, 2, 60.0),
            _entry("c", Eligibility.UNKNOWN, None, 95.0),
            _entry("d", Eligibility.FAIL, None, 99.0),
        ],
    )
    assert [e.scenario_id for e in r.entries] == ["a", "b", "c", "d"]


def test_high_score_cannot_lift_failed_scenario_above_eligible() -> None:
    with pytest.raises(ValidationError, match="then UNKNOWN, then FAIL"):
        RankingResult(
            method_version="t",
            entries=[_entry("d", Eligibility.FAIL, None, 99.0), _entry("a", Eligibility.PASS, 1, 10.0)],
        )


def test_only_pass_scenarios_ranked() -> None:
    with pytest.raises(ValidationError, match="only PASS"):
        RankingResult(
            method_version="t",
            entries=[_entry("a", Eligibility.PASS, 1, 70.0), _entry("b", Eligibility.UNKNOWN, 2, 60.0)],
        )


def test_ranks_must_be_consecutive() -> None:
    with pytest.raises(ValidationError, match="consecutive"):
        RankingResult(
            method_version="t",
            entries=[_entry("a", Eligibility.PASS, 1, 70.0), _entry("b", Eligibility.PASS, 3, 60.0)],
        )
