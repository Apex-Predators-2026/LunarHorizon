"""Desirability scoring (Phase 5A; docs §5e, D1-D8). ``rank_assessments`` is re-exported from ``ranking``.

Score: 100 * sum(effective weight * normalised component value) over the ACTIVE components, with
each component value in [0, 1] known exactly or only as an interval:

* SUNLIGHT          ``mean_solar_disk_fraction`` (illumination proxy, not solar energy)
* EARTH_VISIBILITY  ``earth_visible_percent / 100``
* SIMULTANEOUS      ``simultaneous_percent / 100``
* DARKNESS_MARGIN   ``clamp(margin / max_continuous_darkness_s, 0, 1)``
* BLACKOUT_MARGIN   ``clamp(margin / max_communication_blackout_s, 0, 1)``
* CLEARANCE_MARGIN  unsupported: never estimated, never part of a score

Which components are ACTIVE and their weights come from the scenario configuration only
(``MissionScenario.effective_score_weights``), never from which measurements happen to be
available. A missing or partly known measurement widens the interval ([0, 1] when nothing is
known); it never removes the component or counts as zero. The score is exact (``score`` set) only
when every active component is exactly known; otherwise ``score`` stays ``None`` and
``score_bounds`` holds a valid interval, rounded outward. UNKNOWN eligibility is never scored.
Scoring reads eligibility only for that and for consistency checks; it never changes it.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Final

from .enums import (
    ConstraintId,
    DataBasis,
    Eligibility,
    MetricStatus,
    ScoreComponent,
    ScoreComponentStatus,
    ScoreStatus,
    Unit,
)
from .mission import MissionScenario
from .outputs import (
    Metric,
    MetricsSummary,
    OperationalMargin,
    ScoreBreakdown,
    ScoreComponentResult,
)
from .ranking import rank_assessments  # re-exported: the Phase 1 import path keeps working

__all__ = ["SCORING_METHOD_VERSION", "rank_assessments", "score_scenario"]

# Bump when the formula, rounding or component definitions change: scores of different method
# versions are never comparable (ViabilityAssessment.comparability_key).
SCORING_METHOD_VERSION: Final = "desirability-v1"

SYNTHETIC_PREFIX: Final = "[SYNTHETIC DATA] "  # same label as risk.SYNTHETIC_PREFIX
_DECIMALS: Final = 6
_SCALE: Final = 10.0**_DECIMALS
# Floating-point noise allowed when snapping to the 6-decimal grid before an outward rounding
# (in units of the 6th decimal, i.e. about 1e-12 of a score point).
_SNAP: Final = 1e-6
_REFERENCE_REL_TOL: Final = 1e-9

_MARGIN_CONSTRAINT: Final = {
    ScoreComponent.DARKNESS_MARGIN: ConstraintId.MAX_CONTINUOUS_DARKNESS,
    ScoreComponent.BLACKOUT_MARGIN: ConstraintId.MAX_COMMUNICATION_BLACKOUT,
}
_LIMIT_ATTR: Final = {
    ScoreComponent.DARKNESS_MARGIN: "max_continuous_darkness_s",
    ScoreComponent.BLACKOUT_MARGIN: "max_communication_blackout_s",
}
_METRIC_FIELD: Final = {
    ScoreComponent.SUNLIGHT: ("mean_solar_disk_fraction", 1.0),
    ScoreComponent.EARTH_VISIBILITY: ("earth_visible_percent", 100.0),
    ScoreComponent.SIMULTANEOUS: ("simultaneous_percent", 100.0),
}

_BASE_NOTE: Final = (
    "Relative desirability index (0-100) of illumination and line-of-sight geometry under the stated "
    "weights. The sunlight component is an illumination proxy (mean visible solar-disk fraction), not "
    "solar power or energy; the score is not a link, power or landing-safety estimate and never "
    "changes eligibility."
)
_ACTIVE_NOTES: Final = {
    ScoreComponent.SUNLIGHT: (
        "Sunlight is an illumination proxy: time-mean visible solar-disk fraction, not solar energy or power output."
    ),
    ScoreComponent.EARTH_VISIBILITY: "Share of mission time with direct-to-Earth line of sight (geometric).",
    ScoreComponent.SIMULTANEOUS: "Share of mission time that is both power-lit and Earth-visible.",
    ScoreComponent.DARKNESS_MARGIN: "Unused share of the darkness limit: clamp(margin / limit, 0, 1).",
    ScoreComponent.BLACKOUT_MARGIN: "Unused share of the blackout limit: clamp(margin / limit, 0, 1).",
}
_INACTIVE_NOTES: Final = {
    ScoreComponentStatus.UNSUPPORTED: (
        "Not scored: clearance requirements are unsupported and the mean clearance is never used as a stand-in."
    ),
    ScoreComponentStatus.NOT_CONFIGURED: "Not scored: the spacecraft sets no limit this margin is measured against.",
    ScoreComponentStatus.ZERO_WEIGHT: "Not scored: its preference weight is 0.",
}

Interval = tuple[float, float]


def _clamp01(x: float) -> float:
    return min(1.0, max(0.0, x))


def _round_nearest(x: float) -> float:
    return min(100.0, max(0.0, round(x, _DECIMALS)))


def _round_down(x: float) -> float:
    scaled = x * _SCALE
    nearest = round(scaled)
    grid = nearest if abs(scaled - nearest) <= _SNAP else math.floor(scaled)
    return min(100.0, max(0.0, grid / _SCALE))


def _round_up(x: float) -> float:
    scaled = x * _SCALE
    nearest = round(scaled)
    grid = nearest if abs(scaled - nearest) <= _SNAP else math.ceil(scaled)
    return min(100.0, max(0.0, grid / _SCALE))


def _metric_interval(metric: Metric, divisor: float) -> Interval:
    """Component interval from a metric: KNOWN exact, BOUNDED its bounds, otherwise [0, 1]."""
    if metric.status is MetricStatus.KNOWN and metric.value is not None:
        v = _clamp01(metric.value / divisor)
        return v, v
    if metric.status is MetricStatus.BOUNDED and metric.lower is not None and metric.upper is not None:
        return _clamp01(metric.lower / divisor), _clamp01(metric.upper / divisor)
    return 0.0, 1.0


def _limit(scenario: MissionScenario, component: ScoreComponent) -> float | None:
    limit = getattr(scenario.spacecraft, _LIMIT_ATTR[component])
    if limit is None:
        return None
    if not isinstance(limit, int | float) or not math.isfinite(limit) or limit <= 0.0:
        raise ValueError(f"invalid {_LIMIT_ATTR[component]} {limit!r}: the limit must be a finite number > 0")
    return float(limit)


def _find_margin(margins: Sequence[OperationalMargin], constraint: ConstraintId) -> OperationalMargin | None:
    found = [m for m in margins if m.related_constraint is constraint]
    if len(found) > 1:
        raise ValueError(f"duplicate margins for {constraint.value}")
    return found[0] if found else None


def _margin_interval(
    margin: OperationalMargin | None, limit: float, constraint: ConstraintId, eligibility: Eligibility
) -> Interval:
    """Normalised ``g(m) = clamp(m / limit, 0, 1)`` over the margin interval; [0, 1] if no number."""
    if margin is None:
        return 0.0, 1.0
    if margin.value.unit is not Unit.SECONDS:
        raise ValueError(f"{constraint.value} margin must be in seconds, got {margin.value.unit.value!r}")
    if margin.reference is not None and abs(margin.reference - limit) > _REFERENCE_REL_TOL * max(1.0, limit):
        raise ValueError(
            f"{constraint.value} margin reference {margin.reference} differs from the configured limit {limit}"
        )
    value = margin.value
    if value.status is MetricStatus.KNOWN and value.value is not None:
        lo = hi = value.value
    elif value.status is MetricStatus.BOUNDED and value.lower is not None and value.upper is not None:
        lo, hi = value.lower, value.upper
    else:
        return 0.0, 1.0
    # Same rule as margins.py: PASS <=> lower margin >= 0, FAIL <=> upper margin < 0.
    if eligibility is not Eligibility.FAIL and hi < 0.0:
        raise ValueError(f"eligibility {eligibility.value!r} contradicts the violated {constraint.value} margin")
    if eligibility is Eligibility.PASS and lo < 0.0:
        raise ValueError(f"eligibility 'pass' contradicts the uncertain or violated {constraint.value} margin")
    return _clamp01(lo / limit), _clamp01(hi / limit)


def _normalized(interval: Interval) -> Metric:
    lo, hi = interval
    return Metric.known(lo, Unit.FRACTION) if lo == hi else Metric.bounded(lo, hi, Unit.FRACTION)


def _score_note(basis: DataBasis | None, status: ScoreStatus) -> str:
    parts = [_BASE_NOTE]
    if status is ScoreStatus.BOUNDED:
        parts.append(
            "Uncertain: some measurements are partly or wholly unavailable, so the score is an interval "
            "(score_bounds) valid for every value consistent with the evidence; no exact score exists."
        )
    elif status is ScoreStatus.ELIGIBILITY_UNKNOWN:
        parts.append("Not scored: eligibility is UNKNOWN.")
    elif status is ScoreStatus.NO_SCORABLE_COMPONENTS:
        parts.append("Not scored: no component is active under this configuration.")
    if basis is DataBasis.SYNTHETIC:
        parts.append("Computed from synthetic geometry; not scientifically validated.")
        return SYNTHETIC_PREFIX + " ".join(parts)
    return " ".join(parts)


def score_scenario(
    scenario: MissionScenario,
    metrics: MetricsSummary,
    margins: list[OperationalMargin],
    eligibility: Eligibility,
    *,
    data_basis: DataBasis | None = None,
) -> ScoreBreakdown:
    """Explainable desirability score of one scenario (see the module docstring).

    ``margins`` are the Phase 4A margins; only the darkness and blackout margins are read.
    ``data_basis`` (``DataQualitySummary.data_basis``) only labels the note: ``SYNTHETIC`` gets the
    ``[SYNTHETIC DATA]`` prefix. Raises ``ValueError`` for a non-positive or non-finite outage
    limit, a duplicate, non-seconds or wrongly referenced outage margin, and a margin that
    contradicts ``eligibility``. Pure: no input is modified.
    """
    declared = scenario.preferences.weights()
    weights = scenario.effective_score_weights()
    statuses = {c: scenario.score_component_status(c) for c in ScoreComponent}
    active = [c for c in ScoreComponent if statuses[c] is ScoreComponentStatus.ACTIVE]

    intervals: dict[ScoreComponent, Interval] = {}
    for component in _MARGIN_CONSTRAINT:  # validated whenever a limit is set, whatever the weight
        limit = _limit(scenario, component)
        if limit is None:
            continue
        constraint = _MARGIN_CONSTRAINT[component]
        interval = _margin_interval(_find_margin(margins, constraint), limit, constraint, eligibility)
        if component in active:
            intervals[component] = interval
    for component, (field, divisor) in _METRIC_FIELD.items():
        if component in active:
            intervals[component] = _metric_interval(getattr(metrics, field), divisor)

    for c in active:
        if not weights[c] > 0.0:  # only for absurd declared-weight ratios (below ~1e-308)
            raise ValueError(f"effective weight of {c.value} underflows to 0: declared weight ratio is too extreme")

    withheld = eligibility is Eligibility.UNKNOWN
    results: list[ScoreComponentResult] = []
    for c in ScoreComponent:
        status_c, w, d = statuses[c], weights[c], declared[c]
        if status_c is not ScoreComponentStatus.ACTIVE:
            results.append(
                ScoreComponentResult(
                    component=c, weight=w, status=status_c, declared_weight=d,
                    normalized_value=None, contribution=None, note=_INACTIVE_NOTES[status_c],
                )
            )  # fmt: skip
        elif withheld:
            results.append(
                ScoreComponentResult(
                    component=c, weight=w, status=status_c, declared_weight=d, normalized_value=None,
                    contribution=None, note=_ACTIVE_NOTES[c] + " Not evaluated: eligibility is UNKNOWN.",
                )
            )  # fmt: skip
        else:
            lo, hi = intervals[c]
            exact = lo == hi
            results.append(
                ScoreComponentResult(
                    component=c,
                    weight=w,
                    status=status_c,
                    declared_weight=d,
                    normalized=_normalized((lo, hi)),
                    normalized_value=lo if exact else None,
                    contribution=w * lo * 100.0 if exact else None,
                    note=_ACTIVE_NOTES[c] + ("" if exact else " Only bounded by the available evidence."),
                )
            )

    score: float | None = None
    bounds: Metric | None = None
    if withheld:
        status = ScoreStatus.ELIGIBILITY_UNKNOWN
    elif not active:
        status = ScoreStatus.NO_SCORABLE_COMPONENTS
    else:
        low = 100.0 * math.fsum(weights[c] * intervals[c][0] for c in active)
        high = 100.0 * math.fsum(weights[c] * intervals[c][1] for c in active)
        if all(intervals[c][0] == intervals[c][1] for c in active):
            status = ScoreStatus.KNOWN
            score = _round_nearest(low)
            bounds = Metric.known(score, Unit.PERCENT)
        else:
            status = ScoreStatus.BOUNDED
            bounds = Metric.bounded(_round_down(low), _round_up(high), Unit.PERCENT)

    return ScoreBreakdown(
        method_version=SCORING_METHOD_VERSION,
        score=score,
        rank_eligible=eligibility is Eligibility.PASS,
        components=results,
        note=_score_note(data_basis, status),
        status=status,
        score_bounds=bounds,
        configuration_key=scenario.configuration_key(),
    )
