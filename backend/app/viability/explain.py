"""Evidence-based explanations (Phase 6A) and the standing limitations of every assessment.

Explanations turn an assessment that already exists (Phase 3 verdicts, Phase 4 margins and risk
indicators, the Phase 5 score, Phase 2 data quality) into short, specific text. They are a
**presentation layer only**. Normative properties:

* **No second algorithm.** Nothing here decides a verdict, a margin, a risk level or a score. Verdicts
  and levels are read from their fields. Margin classes reuse ``margins.classify_margin`` and missing
  margins are derived with ``margins.operational_margin``, which is the same Phase 4A arithmetic.
  Inputs that contradict each other raise ``ValueError`` rather than being explained: eligibility
  versus the constraint verdicts, ``overall_risk`` versus the risk indicators, or the score versus
  eligibility.
* **Consistent wording.** A constraint is called PASS, FAIL or UNKNOWN exactly as its ``status``
  says. Text for an UNKNOWN constraint never claims a violation, and text for an unsupported
  requirement never claims that it was evaluated. Advice to weaken a requirement is never given.
* **No invented quantities.** No probability of mission failure, no power or link estimate and no
  point value for a bounded quantity. Bounded scores are shown as intervals, rounded outward.
* **Deterministic order** (stable ``ExplanationDetail.key`` values; synthetic data prefixes every
  message with ``[SYNTHETIC DATA]``):

  1. ``SUMMARY``: eligibility verdict, overall screening risk, desirability score, and the score
     breakdown and excluded components when present.
  2. ``CONSTRAINT``: one item per configured constraint, ordered FAIL, then UNKNOWN, then PASS, and
     ``ConstraintId`` order within each group.
  3. ``MARGIN``: one item per configured constraint with a numeric margin, in the same order. It
     carries the risk indicator that bands that margin (``darkness_exposure``,
     ``communication_exposure``, ``margin_headroom.*``).
  4. ``RISK``: the landing-state indicators and any indicator not explained elsewhere, ordered
     HIGH, UNKNOWN, MODERATE, LOW, keeping the risk engine's order within a level.
  5. ``DATA_QUALITY``: data basis and provenance, coverage, and pipeline warnings.
  6. ``LIMITATION``: sampling resolution, illumination versus power, line of sight versus
     communication, unverified spacecraft capabilities, and the risk screening bands.

``generate_explanations`` returns the frontend ``Explanation`` list. ``build_explanation_details``
returns the same items in the same order, each with a stable ``key``, the risk codes it accounts for,
and technical evidence lines (rule text, formulas, raw fields) for inspection. Every risk indicator is
explained by exactly one item.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from datetime import datetime
from typing import Final

from pydantic import Field

from .constraints import CONSTRAINT_SPECS, meets
from .conventions import ContractModel, Identifier
from .enums import (
    CalculationBasis,
    Comparison,
    Condition,
    ConstraintId,
    ConstraintStatus,
    Eligibility,
    ExplanationCategory,
    MetricStatus,
    RiskLevel,
    ScoreComponent,
    ScoreComponentStatus,
    ScoreStatus,
    Severity,
    Unit,
    UnknownReason,
    WindowKind,
)
from .margins import (
    NARROW_MARGIN_FRACTION,
    MarginClass,
    classify_margin,
    margin_bounds,
    operational_margin,
    relative_margin,
)
from .outputs import (
    ConstraintEvaluation,
    DataQualitySummary,
    Explanation,
    Metric,
    OperationalMargin,
    RiskIndicator,
    ScoreBreakdown,
    ScoreComponentResult,
    ViabilityAssessment,
    VisibilityWindow,
    derive_eligibility,
)
from .risk import DEFAULT_RISK_POLICY, OUTAGE_RISK_CODES, SYNTHETIC_PREFIX
from .risk import overall_risk as derive_overall_risk

__all__ = [
    "EXPLANATION_METHOD_VERSION",
    "STANDARD_LIMITATIONS",
    "ExplanationDetail",
    "build_explanation_details",
    "explain_assessment",
    "explain_assessment_details",
    "generate_explanations",
]

# Included in every assessment's ``limitations``; reviewed with Member 6.
STANDARD_LIMITATIONS: tuple[str, ...] = (
    (
        "Solar illumination is not electrical power generation; array orientation, efficiency, "
        "temperature, dust and power-system design are not modelled."
    ),
    (
        "Earth line of sight is not guaranteed radio connectivity; antenna pointing, link budget, "
        "ground-station availability and interference are not modelled."
    ),
    (
        "Viability covers illumination and direct-to-Earth line of sight under the stated "
        "constraints only; it is not an assessment of landing safety (slopes, hazards, terrain)."
    ),
    (
        "Terrain-aware results inherit the resolution and accuracy of the elevation model and "
        "horizon calculation; geometric-only results ignore terrain entirely."
    ),
    "Sampled time series can miss events shorter than the sampling interval.",
)

# Bump when wording rules or item structure change (frontends may key translations on it).
EXPLANATION_METHOD_VERSION: Final = "explanations-v1"

_MAX_MESSAGE: Final = 500  # Explanation.message limit (NonEmptyStr)
_MAX_ECHO: Final = 160  # external free text (metric reasons, warnings) quoted in a message
_DURATION_TOL_S: Final = 1e-3  # the output contract's duration tolerance

_SHORT: Final[dict[ConstraintId, str]] = {
    ConstraintId.MAX_CONTINUOUS_DARKNESS: "maximum power-darkness",
    ConstraintId.MAX_COMMUNICATION_BLACKOUT: "maximum Earth line-of-sight blackout",
    ConstraintId.MIN_SUNLIGHT_PERCENT: "minimum direct sunlight",
    ConstraintId.MIN_EARTH_VISIBILITY_PERCENT: "minimum Earth line of sight",
    ConstraintId.MIN_SIMULTANEOUS_PERCENT: "minimum simultaneous power-lit and Earth line of sight",
    ConstraintId.MIN_SUN_CLEARANCE: "minimum Sun clearance",
    ConstraintId.MIN_EARTH_CLEARANCE: "minimum Earth clearance",
    ConstraintId.MIN_MEAN_SOLAR_DISK_FRACTION: "minimum mean solar-disk fraction",
    ConstraintId.MIN_INITIAL_SUNLIGHT: "minimum initial power-lit time",
    ConstraintId.MIN_INITIAL_EARTH_VISIBILITY: "minimum initial Earth line of sight",
}

_CONDITION_STATE: Final[dict[Condition, str]] = {
    Condition.DIRECT_SUNLIGHT: "Sun",
    Condition.FULL_SUNLIGHT: "Sun",
    Condition.PARTIAL_SUNLIGHT: "Sun",
    Condition.POWER_ELIGIBLE: "power-lit",
    Condition.EARTH_VISIBLE: "Earth line-of-sight",
    Condition.SIMULTANEOUS: "simultaneous power-lit and Earth line-of-sight",
}

_WINDOW_NOUN: Final[dict[WindowKind, str]] = {
    WindowKind.SUNLIGHT: "direct-sunlight period",
    WindowKind.DARKNESS: "period without direct sunlight",
    WindowKind.FULL_SUNLIGHT: "full-sunlight period",
    WindowKind.PARTIAL_SUNLIGHT: "partial-sunlight period",
    WindowKind.POWER_LIT: "power-lit period",
    WindowKind.POWER_DARK: "power-dark period",
    WindowKind.EARTH_VISIBLE: "Earth line-of-sight period",
    WindowKind.COMMUNICATION_BLACKOUT: "Earth line-of-sight blackout",
    WindowKind.SIMULTANEOUS_SUN_EARTH: "simultaneous power-lit and Earth line-of-sight period",
    WindowKind.SUN_UNKNOWN: "period of unknown Sun state",
    WindowKind.POWER_UNKNOWN: "period of unknown power-lit state",
    WindowKind.EARTH_UNKNOWN: "period of unknown Earth state",
    WindowKind.SIMULTANEOUS_UNKNOWN: "period of unknown simultaneous state",
    WindowKind.UNKNOWN_DATA: "period with no data",
}

_START_STATE: Final[dict[WindowKind, str]] = {
    WindowKind.POWER_LIT: "Mission starts power-lit",
    WindowKind.POWER_DARK: "Mission starts power-dark",
    WindowKind.POWER_UNKNOWN: "Power-lit state at mission start is unknown",
    WindowKind.EARTH_VISIBLE: "Mission starts in Earth line of sight",
    WindowKind.COMMUNICATION_BLACKOUT: "Mission starts without Earth line of sight",
    WindowKind.EARTH_UNKNOWN: "Earth state at mission start is unknown",
}

_COMPONENT_LABEL: Final[dict[ScoreComponent, str]] = {
    ScoreComponent.SUNLIGHT: "sunlight (mean solar-disk fraction)",
    ScoreComponent.EARTH_VISIBILITY: "Earth line of sight",
    ScoreComponent.SIMULTANEOUS: "simultaneous power-lit and Earth line of sight",
    ScoreComponent.DARKNESS_MARGIN: "darkness margin",
    ScoreComponent.BLACKOUT_MARGIN: "blackout margin",
    ScoreComponent.CLEARANCE_MARGIN: "clearance margin",
}
_COMPONENT_LIMIT: Final[dict[ScoreComponent, str]] = {
    ScoreComponent.DARKNESS_MARGIN: "no darkness limit is configured",
    ScoreComponent.BLACKOUT_MARGIN: "no blackout limit is configured",
}

_RISK_LABEL: Final[dict[str, str]] = {
    "synthetic_data": "synthetic data",
    "geometric_only_data": "terrain not modelled",
    "sun_data_coverage": "Sun data coverage",
    "earth_data_coverage": "Earth data coverage",
    "landing_in_darkness": "landing in power-darkness",
    "landing_without_earth_visibility": "landing without Earth line of sight",
    "darkness_exposure": "power-darkness exposure",
    "communication_exposure": "Earth line-of-sight blackout exposure",
}
_LANDING_CODES: Final = ("landing_in_darkness", "landing_without_earth_visibility")
_DATA_BASIS_CODES: Final = ("synthetic_data", "geometric_only_data")
_COVERAGE_CODES: Final = ("sun_data_coverage", "earth_data_coverage")
# The risk engine's emission order (risk.py module docstring); unknown families sort last, by code.
_RISK_FAMILIES: Final = (
    *_DATA_BASIS_CODES,
    *_COVERAGE_CODES,
    *_LANDING_CODES,
    "darkness_exposure",
    "communication_exposure",
    "margin_headroom",
    "unsupported_requirement",
)
_CONSTRAINT_INDEX: Final = {cid.value: i for i, cid in enumerate(ConstraintId)}


def _risk_order(r: RiskIndicator) -> tuple[int, int, str]:
    family, _, rest = r.code.partition(".")
    rank = _RISK_FAMILIES.index(family) if family in _RISK_FAMILIES else len(_RISK_FAMILIES)
    return rank, _CONSTRAINT_INDEX.get(rest, len(_CONSTRAINT_INDEX)), r.code


_STATUS_ORDER: Final = {ConstraintStatus.FAIL: 0, ConstraintStatus.UNKNOWN: 1, ConstraintStatus.PASS: 2}
_LEVEL_ORDER: Final = {RiskLevel.HIGH: 0, RiskLevel.UNKNOWN: 1, RiskLevel.MODERATE: 2, RiskLevel.LOW: 3}
_STATUS_SEVERITY: Final = {
    ConstraintStatus.FAIL: Severity.CRITICAL,
    ConstraintStatus.UNKNOWN: Severity.WARNING,
    ConstraintStatus.PASS: Severity.INFO,
}

_NOT_PROBABILITY: Final = "Risk levels are rule-based screening categories, not probabilities; LOW does not mean safe."
_SCORE_MEANING: Final = (
    "The score is a relative index of illumination and Earth line-of-sight geometry under the chosen weights, "
    "not a probability of mission success, a power or link estimate, or a safety rating."
)


class ExplanationDetail(ContractModel):
    """One explanation with its technical evidence (inspection view; not part of ``ViabilityAssessment``).

    ``explanation`` is exactly the item ``generate_explanations`` returns at the same position.
    ``key`` is stable and unique within one result (for example ``constraint.max_continuous_darkness``).
    ``risk_codes`` lists the ``RiskIndicator.code`` values this item accounts for. ``details`` holds
    raw evidence: field names, values, rule text and formulas.
    """

    key: Identifier
    explanation: Explanation
    risk_codes: list[Identifier] = Field(default_factory=list)
    details: list[str] = Field(default_factory=list)


# --- formatting ---------------------------------------------------------------------------------


def _hours(seconds: float) -> str:
    return f"{seconds / 3600.0:.6g} h"


def _value(value: float, unit: Unit) -> str:
    if unit is Unit.SECONDS:
        return _hours(value)
    if unit is Unit.PERCENT:
        return f"{value:.6g} %"
    if unit is Unit.DEGREES:
        return f"{value:.6g} deg"
    return f"{value:.6g}"


def _amount(value: float, unit: Unit) -> str:
    """Size of a margin (unsigned); percentages of time are percentage points."""
    return f"{value:.6g} pp" if unit is Unit.PERCENT else _value(value, unit)


def _signed(value: float, unit: Unit) -> str:
    sign = "+" if value > 0.0 else ""
    return sign + _amount(value, unit)


def _pct(fraction: float) -> str:
    return f"{fraction * 100.0:.4g} %"


def _span(lo: str, hi: str) -> str:
    return lo if lo == hi else f"between {lo} and {hi}"


def _floor2(x: float) -> str:
    return f"{math.floor(x * 100.0 + 1e-9) / 100.0:.2f}"


def _ceil2(x: float) -> str:
    return f"{math.ceil(x * 100.0 - 1e-9) / 100.0:.2f}"


def _when(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%MZ")


def _echo(text: str | None) -> str:
    """External free text quoted in a message, shortened deterministically (full text goes in details)."""
    if not text:
        return "no reason given"
    text = " ".join(text.split())
    return text if len(text) <= _MAX_ECHO else text[: _MAX_ECHO - 3].rstrip() + "..."


def _metric_raw(m: Metric) -> str:
    if m.status is MetricStatus.KNOWN:
        return f"known {m.value!r} {m.unit.value}"
    if m.status is MetricStatus.BOUNDED:
        return f"bounded [{m.lower!r}, {m.upper!r}] {m.unit.value}" + (f" ({m.reason})" if m.reason else "")
    if m.status is MetricStatus.UNAVAILABLE:
        return f"unavailable {m.unit.value} ({m.reason})"
    return f"not_applicable {m.unit.value}"


def _metric_text(m: Metric) -> str | None:
    if m.status is MetricStatus.KNOWN:
        assert m.value is not None
        return _value(m.value, m.unit)
    if m.status is MetricStatus.BOUNDED:
        assert m.lower is not None and m.upper is not None
        return _span(_value(m.lower, m.unit), _value(m.upper, m.unit))
    return None


def _window_raw(w: VisibilityWindow) -> str:
    return (
        f"window {w.kind.value} {w.start_utc.isoformat()} -> {w.end_utc.isoformat()} ({w.duration_s!r} s, "
        f"clipped_at_start={w.clipped_at_start}, clipped_at_end={w.clipped_at_end})"
    )


def _join(items: Sequence[str], limit: int = 4) -> str:
    shown = list(items[:limit])
    if len(items) > limit:
        shown.append(f"{len(items) - limit} more")
    if len(shown) <= 2:
        return " and ".join(shown)
    return ", ".join(shown[:-1]) + " and " + shown[-1]


def _risk_label(code: str) -> str:
    if code in _RISK_LABEL:
        return _RISK_LABEL[code]
    family, _, rest = code.partition(".")
    try:
        cid = ConstraintId(rest)
    except ValueError:
        return code.replace("_", " ")
    if family == "margin_headroom":
        return f"{_SHORT[cid]} headroom"
    if family == "unsupported_requirement":
        return f"{_SHORT[cid]} (not evaluated)"
    return code.replace("_", " ")


# --- assembling items ---------------------------------------------------------------------------


class _Builder:
    """Collects items in order; enforces the message limit without dropping evidence."""

    def __init__(self, synthetic: bool) -> None:
        self._prefix = SYNTHETIC_PREFIX if synthetic else ""
        self.items: list[ExplanationDetail] = []

    def add(
        self,
        key: str,
        category: ExplanationCategory,
        severity: Severity,
        sentences: Sequence[str],
        *,
        optional: Sequence[str] = (),
        related: ConstraintId | None = None,
        risk_codes: Sequence[str] = (),
        details: Sequence[str] = (),
    ) -> None:
        """``sentences`` always appear; ``optional`` ones are appended while the message fits and are
        otherwise moved, in order, to ``details`` (so nothing is lost)."""
        message = self._prefix + " ".join(s for s in sentences if s)
        extra: list[str] = []
        if len(message) > _MAX_MESSAGE:  # last resort, not reached by the texts below
            extra.append(f"full message: {message}")
            message = message[: _MAX_MESSAGE - 3].rstrip() + "..."
        for s in optional:
            if not s:
                continue
            if not extra and len(message) + 1 + len(s) <= _MAX_MESSAGE:
                message = f"{message} {s}"
            else:
                extra.append(s)
        self.items.append(
            ExplanationDetail(
                key=key,
                explanation=Explanation(
                    category=category, severity=severity, message=message, related_constraint=related
                ),
                risk_codes=list(risk_codes),
                details=[*details, *extra],
            )
        )


# --- input checks -------------------------------------------------------------------------------


def _check_inputs(
    eligibility: Eligibility,
    constraints: Sequence[ConstraintEvaluation],
    risks: Sequence[RiskIndicator],
    score: ScoreBreakdown | None,
    overall: RiskLevel | None,
) -> None:
    ids = [c.constraint_id for c in constraints]
    if len(ids) != len(set(ids)):
        raise ValueError("each constraint_id may appear at most once")
    derived = derive_eligibility(c.status for c in constraints)
    if eligibility is not derived:
        raise ValueError(f"eligibility {eligibility.value!r} contradicts the constraint verdicts ({derived.value!r})")
    if overall is not None and overall is not derive_overall_risk(risks):
        raise ValueError(
            f"overall_risk {overall.value!r} contradicts the risk indicators ({derive_overall_risk(risks).value!r})"
        )
    codes = [r.code for r in risks]
    if len(codes) != len(set(codes)):
        raise ValueError("each risk indicator code may appear at most once")
    if score is not None:
        if score.rank_eligible != (eligibility is Eligibility.PASS):
            raise ValueError("score.rank_eligible must be True exactly when eligibility is PASS")
        if eligibility is Eligibility.UNKNOWN and (score.score is not None or score.score_bounds is not None):
            raise ValueError("an UNKNOWN eligibility must not carry a score")
        if score.status is not None and (score.status is ScoreStatus.ELIGIBILITY_UNKNOWN) != (
            eligibility is Eligibility.UNKNOWN
        ):
            raise ValueError("score.status 'eligibility_unknown' must be used exactly when eligibility is UNKNOWN")


def _index_margins(
    constraints: Sequence[ConstraintEvaluation], margins: Sequence[OperationalMargin], duration_s: float
) -> dict[ConstraintId, OperationalMargin]:
    """The margin of each configured constraint: the supplied one, else the Phase 4A derivation."""
    supplied: dict[ConstraintId, OperationalMargin] = {}
    for m in margins:
        if m.related_constraint is None:
            continue
        if m.related_constraint in supplied:
            raise ValueError(f"more than one operational margin relates to {m.related_constraint.value!r}")
        supplied[m.related_constraint] = m
    out: dict[ConstraintId, OperationalMargin] = {}
    for ev in constraints:
        if ev.status is ConstraintStatus.NOT_APPLICABLE:
            continue
        found = supplied.get(ev.constraint_id)
        out[ev.constraint_id] = found if found is not None else operational_margin(ev, duration_s)
    return out


def _check_margin(ev: ConstraintEvaluation, m: OperationalMargin) -> None:
    """A margin must have the constraint's unit and imply its verdict (it is never re-decided)."""
    if m.value.unit is not ev.unit:
        raise ValueError(f"margin {m.margin_id!r} unit {m.value.unit.value!r} != constraint unit {ev.unit.value!r}")
    bounds = margin_bounds(m)
    if bounds is None:
        if ev.status is not ConstraintStatus.UNKNOWN:
            raise ValueError(f"margin {m.margin_id!r} has no numeric value but the verdict is {ev.status.value!r}")
        return
    lo, hi = bounds
    implied = ConstraintStatus.PASS if lo >= 0.0 else ConstraintStatus.FAIL if hi < 0.0 else ConstraintStatus.UNKNOWN
    if implied is not ev.status:
        raise ValueError(
            f"margin {m.margin_id!r} implies {implied.value!r} but constraint {ev.constraint_id.value!r} is "
            f"{ev.status.value!r}"
        )


# --- SUMMARY ------------------------------------------------------------------------------------


def _verdict(b: _Builder, eligibility: Eligibility, configured: list[ConstraintEvaluation]) -> None:
    n = len(configured)
    failed = [c for c in configured if c.status is ConstraintStatus.FAIL]
    unknown = [c for c in configured if c.status is ConstraintStatus.UNKNOWN]
    bounded = [
        c for c in configured if c.status is ConstraintStatus.PASS and c.measured.status is not MetricStatus.KNOWN
    ]
    details = [f"{c.constraint_id.value}: {c.status.value}" for c in configured] or ["no configured constraint"]
    scope = "It covers illumination and Earth line-of-sight requirements only, not landing safety or mission success."
    if eligibility is Eligibility.PASS and n == 0:
        b.add(
            "summary.eligibility",
            ExplanationCategory.SUMMARY,
            Severity.INFO,
            [
                "Eligibility PASS (vacuous): no hard constraints are configured, so nothing was required.",
                "This says nothing about conditions at the site; see the risk and data-quality items.",
            ],
            details=details,
        )
        return
    if eligibility is Eligibility.PASS:
        bounded_note = f" ({len(bounded)} proven from bounds despite incomplete data)" if bounded else ""
        b.add(
            "summary.eligibility",
            ExplanationCategory.SUMMARY,
            Severity.INFO,
            [f"Eligibility PASS: all {n} configured hard constraint(s) are met{bounded_note}.", scope],
            details=details,
        )
        return
    if eligibility is Eligibility.FAIL:
        sentences = [
            (
                f"Eligibility FAIL: {len(failed)} of {n} configured hard constraint(s) are violated: "
                f"{_join([_SHORT[c.constraint_id] for c in failed])}."
            )
        ]
        if unknown:
            sentences.append(f"{len(unknown)} more cannot be decided from the evidence.")
        sentences.append("A confirmed violation makes the scenario ineligible whatever its score or risk level.")
        b.add("summary.eligibility", ExplanationCategory.SUMMARY, Severity.CRITICAL, sentences, details=details)
        return
    reasons = sorted({_reason_phrase(c.unknown_reason) for c in unknown})
    b.add(
        "summary.eligibility",
        ExplanationCategory.SUMMARY,
        Severity.WARNING,
        [
            (
                f"Eligibility UNKNOWN: no configured hard constraint is violated, but {len(unknown)} of {n} cannot be "
                f"decided: {_join([_SHORT[c.constraint_id] for c in unknown])} ({', '.join(reasons)})."
            ),
            "UNKNOWN is not a failure. The scenario is not scored or ranked until these are decided.",
        ],
        details=details,
    )


def _reason_phrase(reason: UnknownReason | None) -> str:
    if reason is UnknownReason.UNSUPPORTED:
        return "not evaluable by this engine version"
    if reason is UnknownReason.NO_DATA:
        return "no data"
    return "incomplete data"


def _risk_overview(b: _Builder, eligibility: Eligibility, risks: Sequence[RiskIndicator], overall: RiskLevel) -> None:
    details = [f"{r.code}: {r.level.value}" for r in risks] or ["no risk indicators"]
    by_level = {lvl: [_risk_label(r.code) for r in risks if r.level is lvl] for lvl in RiskLevel}
    if not risks:
        b.add(
            "summary.risk",
            ExplanationCategory.SUMMARY,
            Severity.WARNING,
            ["No risk indicators were produced, so overall risk is UNKNOWN: nothing assessed is not low risk."],
            details=details,
        )
        return
    sentences: list[str]
    if overall is RiskLevel.HIGH:
        sentences = [f"Overall screening risk HIGH, driven by {_join(by_level[RiskLevel.HIGH])}."]
        if eligibility is Eligibility.PASS:
            sentences.append(
                "Every configured hard constraint still passes: HIGH risk flags thin or zero headroom or an outage "
                "at landing, not a violation, and eligibility stays PASS."
            )
        if by_level[RiskLevel.UNKNOWN]:
            sentences.append(f"{len(by_level[RiskLevel.UNKNOWN])} indicator(s) are UNKNOWN and stay listed.")
    elif overall is RiskLevel.UNKNOWN:
        sentences = [
            (
                f"Overall screening risk UNKNOWN: {_join(by_level[RiskLevel.UNKNOWN])} cannot be assessed from the "
                "evidence; no indicator is HIGH."
            )
        ]
    elif overall is RiskLevel.MODERATE:
        sentences = [
            (
                f"Overall screening risk MODERATE, from {_join(by_level[RiskLevel.MODERATE])}; no indicator is HIGH "
                "or UNKNOWN."
            )
        ]
    else:
        sentences = ["Overall screening risk LOW: every indicator is LOW."]
    sentences.append(_NOT_PROBABILITY)
    severity = Severity.INFO if overall is RiskLevel.LOW else Severity.WARNING
    b.add("summary.risk", ExplanationCategory.SUMMARY, severity, sentences, details=details)


def _score_items(b: _Builder, eligibility: Eligibility, score: ScoreBreakdown) -> None:
    details = [f"method_version: {score.method_version}", f"status: {score.status.value if score.status else None}"]
    if score.configuration_key:
        details.append(f"configuration_key: {score.configuration_key}")
    if score.score_bounds is not None:
        details.append(f"score_bounds: {_metric_raw(score.score_bounds)}")
    if score.note:
        details.append(f"note: {score.note}")
    fail_note = (
        "Descriptive only: the scenario fails its hard constraints, so it is never ranked; a high score does not "
        "override FAIL."
        if eligibility is Eligibility.FAIL
        else ""
    )
    status = score.status
    if status is ScoreStatus.KNOWN:
        assert score.score is not None
        rank = "It is rank-eligible because eligibility is PASS." if eligibility is Eligibility.PASS else ""
        b.add(
            "summary.score",
            ExplanationCategory.SUMMARY,
            Severity.INFO,
            [f"Desirability score {score.score:.2f} / 100 (exact).", fail_note or rank],
            optional=[_SCORE_MEANING],
            details=details,
        )
    elif status is ScoreStatus.BOUNDED:
        assert score.score_bounds is not None
        assert score.score_bounds.lower is not None and score.score_bounds.upper is not None
        lo, hi = score.score_bounds.lower, score.score_bounds.upper
        partial = [
            _COMPONENT_LABEL[c.component]
            for c in score.components
            if c.normalized is not None and c.normalized.status is MetricStatus.BOUNDED
        ]
        b.add(
            "summary.score",
            ExplanationCategory.SUMMARY,
            Severity.INFO,
            [
                (
                    f"Desirability score between {_floor2(lo)} and {_ceil2(hi)} / 100 (bounded; no exact value exists): "
                    f"{_join(partial)} {'is' if len(partial) == 1 else 'are'} only partly known from the evidence."
                ),
                fail_note
                or f"Rankings order it by its lower bound {_floor2(lo)} as a conservative policy; that bound is not "
                "the score.",
            ],
            optional=[
                "The interval treats components as independent, so it can be wider than necessary.",
                _SCORE_MEANING,
            ],
            details=details,
        )
    elif status is ScoreStatus.ELIGIBILITY_UNKNOWN:
        b.add(
            "summary.score",
            ExplanationCategory.SUMMARY,
            Severity.INFO,
            [
                "Not scored: eligibility is UNKNOWN, and scores are withheld until every hard constraint is decided.",
                "This is not a score of 0.",
            ],
            details=details,
        )
        return
    elif status is ScoreStatus.NO_SCORABLE_COMPONENTS:
        b.add(
            "summary.score",
            ExplanationCategory.SUMMARY,
            Severity.INFO,
            [
                (
                    f"Not scored: no score component is active under this configuration "
                    f"({_join(_excluded(score.components), limit=6)})."
                ),
                "This is not a score of 0.",
            ],
            details=details,
        )
        return
    else:  # legacy breakdown without Phase 5 metadata
        text = (
            f"Desirability score {score.score:.2f} / 100 (legacy result without uncertainty metadata)."
            if score.score is not None
            else "Not scored (legacy result without uncertainty metadata). This is not a score of 0."
        )
        b.add("summary.score", ExplanationCategory.SUMMARY, Severity.INFO, [text, fail_note], details=details)
        return
    _score_breakdown(b, score)


def _excluded(components: Sequence[ScoreComponentResult]) -> list[str]:
    out: list[str] = []
    for c in components:
        label = _COMPONENT_LABEL[c.component]
        declared = c.declared_weight or 0.0
        if c.status is ScoreComponentStatus.UNSUPPORTED:
            ignored = f"; its weight {declared:.6g} is ignored" if declared > 0.0 else ""
            out.append(f"{label}: not evaluable by this engine version{ignored}")
        elif c.status is ScoreComponentStatus.NOT_CONFIGURED:
            why = _COMPONENT_LIMIT.get(c.component, "its reference limit is not configured")
            out.append(f"{label}: {why}")
        elif c.status is ScoreComponentStatus.ZERO_WEIGHT:
            out.append(f"{label}: weight 0")
    return out


def _score_breakdown(b: _Builder, score: ScoreBreakdown) -> None:
    active = [c for c in score.components if c.status is ScoreComponentStatus.ACTIVE]
    terms: list[str] = []
    details: list[str] = []
    for c in active:
        n = c.normalized
        label = _COMPONENT_LABEL[c.component]
        w = _pct(c.weight)
        if n is not None and n.status is MetricStatus.KNOWN and c.contribution is not None:
            terms.append(f"{label} {w} x {c.normalized_value:.4g} = {c.contribution:.4g}")
        elif n is not None and n.lower is not None and n.upper is not None:
            terms.append(
                f"{label} {w} x [{n.lower:.4g}, {n.upper:.4g}] = [{c.weight * n.lower * 100.0:.4g}, "
                f"{c.weight * n.upper * 100.0:.4g}]"
            )
        details.append(
            f"{c.component.value}: declared_weight={c.declared_weight!r}, weight={c.weight!r}, "
            f"normalized={_metric_raw(n) if n is not None else None}, contribution={c.contribution!r}"
            + (f"; {c.note}" if c.note else "")
        )
    declared = ":".join(f"{c.declared_weight:.6g}" for c in active if c.declared_weight is not None)
    b.add(
        "summary.score_components",
        ExplanationCategory.SUMMARY,
        Severity.INFO,
        ["Score = 100 x sum of effective weight x component value (0-1): " + "; ".join(terms) + "."],
        optional=[
            (
                f"Effective weights are the declared weights ({declared}) divided by their sum over active components; "
                "they depend on configuration only, never on measurements."
            )
        ],
        details=details,
    )
    excluded = _excluded(score.components)
    if excluded:
        b.add(
            "summary.score_excluded",
            ExplanationCategory.SUMMARY,
            Severity.INFO,
            [f"Not part of the score: {'; '.join(excluded)}."],
            details=[f"{c.component.value}: {c.status.value if c.status else None}" for c in score.components],
        )


# --- CONSTRAINT ---------------------------------------------------------------------------------


def _requirement(ev: ConstraintEvaluation, comparison: Comparison) -> str:
    assert ev.threshold is not None
    word = "at least" if comparison is Comparison.AT_LEAST else "at most"
    return f"{word} {_value(ev.threshold, ev.unit)}"


def _shortfall(comparison: Comparison, lo: float, hi: float, unit: Unit) -> str:
    """Size of a confirmed violation from a margin interval with ``hi < 0``."""
    verb = "falls short by" if comparison is Comparison.AT_LEAST else "exceeds the limit by"
    if lo == hi:
        return f"{verb} {_amount(-lo, unit)}"
    return f"{verb} at least {_amount(-hi, unit)} (up to {_amount(-lo, unit)})"


def _evidence_sentences(ev: ConstraintEvaluation, duration_s: float) -> list[str]:
    out: list[str] = []
    for w in ev.evidence_windows:
        noun = _WINDOW_NOUN.get(w.kind, w.kind.value.replace("_", " "))
        if ev.constraint_id in OUTAGE_RISK_CODES:
            if w.clipped_at_start and w.clipped_at_end:
                where = ", spanning the whole mission"
            elif w.clipped_at_start:
                where = ", already in progress at landing (measured from landing only)"
            elif w.clipped_at_end:
                where = ", continuing past mission end (measured to mission end only)"
            else:
                where = ""
            out.append(
                f"Longest confirmed {noun}: {_when(w.start_utc)} to {_when(w.end_utc)} ({_hours(w.duration_s)}){where}."
            )
        else:
            head = _START_STATE.get(w.kind, f"Mission starts in a {noun}")
            full = abs(w.duration_s - duration_s) <= _DURATION_TOL_S
            until = " for the whole mission" if full else f" until {_when(w.end_utc)} ({_hours(w.duration_s)})"
            out.append(f"{head}{until}.")
    return out


def _constraint_item(
    b: _Builder,
    ev: ConstraintEvaluation,
    margin: OperationalMargin,
    duration_s: float,
    unsupported_code: str | None,
) -> None:
    spec = CONSTRAINT_SPECS[ev.constraint_id]
    comparison = ev.comparison or spec.comparison
    name = ev.name or spec.name
    required = _requirement(ev, comparison)
    m = ev.measured
    status = ev.status
    sentences: list[str]
    details = [
        f"constraint_id: {ev.constraint_id.value}",
        (
            f"requirement_field: {ev.requirement_field or spec.requirement_field} = {ev.threshold!r} {ev.unit.value} "
            f"({comparison.value}, inclusive)"
        ),
        f"metric_field: {ev.metric_field}; measured: {_metric_raw(m)}",
        (
            f"condition: {ev.condition.value if ev.condition else None}; unknown time in range: "
            f"{ev.condition_unknown_duration_s!r} s"
        ),
        f"unknown_reason: {ev.unknown_reason.value if ev.unknown_reason else None}",
        f"engine message: {ev.message}",
        *(_window_raw(w) for w in ev.evidence_windows),
    ]
    optional = _evidence_sentences(ev, duration_s)

    if ev.unknown_reason is UnknownReason.UNSUPPORTED:
        sentences = [
            (
                f"{name}: UNKNOWN, not evaluated. Required {required} is configured, but this engine version cannot "
                "evaluate it: only the time-mean clearance is available, and a mean cannot prove a per-instant minimum."
            ),
            "It has been neither passed nor failed, and its risk is not assessed.",
        ]
        b.add(
            f"constraint.{ev.constraint_id.value}",
            ExplanationCategory.CONSTRAINT,
            Severity.WARNING,
            sentences,
            related=ev.constraint_id,
            risk_codes=[unsupported_code] if unsupported_code else [],
            details=details,
        )
        return

    bounds = margin_bounds(margin)
    assert bounds is not None  # numeric for every supported, configured constraint
    m_lo, m_hi = bounds
    measured = _metric_text(m)
    quantity = spec.quantity[:1].upper() + spec.quantity[1:]
    if status is ConstraintStatus.PASS:
        if m.status is MetricStatus.KNOWN:
            sentences = [f"{name}: PASS. {quantity}: {measured}; required {required}."]
        elif m.status is MetricStatus.BOUNDED:
            sentences = [
                (
                    f"{name}: PASS despite incomplete data. The value lies {measured}; even the least favourable value "
                    f"meets the requirement of {required}."
                )
            ]
        else:
            sentences = [
                (
                    f"{name}: PASS without a measurement ({_echo(m.reason)}): every physically possible value meets the "
                    f"requirement of {required}."
                )
            ]
    elif status is ConstraintStatus.FAIL:
        by = _shortfall(comparison, m_lo, m_hi, ev.unit)
        if m.status is MetricStatus.KNOWN:
            sentences = [f"{name}: FAIL. {quantity}: {measured}; required {required}, so it {by}."]
        else:
            sentences = [
                (
                    f"{name}: FAIL despite incomplete data. The value lies {measured or 'within its admissible range'}; "
                    f"even the most favourable value misses the requirement of {required}, so it {by}."
                )
            ]
        if comparison is Comparison.AT_LEAST and ev.unit is Unit.SECONDS and (ev.threshold or 0.0) > duration_s:
            sentences.append(
                f"The requirement is longer than the {_hours(duration_s)} mission, so it cannot be met within this "
                "mission window."
            )
    else:
        unknown_s = ev.condition_unknown_duration_s
        if ev.unknown_reason is UnknownReason.NO_DATA:
            sentences = [
                (
                    f"{name}: UNKNOWN (undecided, not a failure). No measurement is available ({_echo(m.reason)}); the "
                    f"only bounds are the physically possible values, which include the requirement of {required}."
                )
            ]
        else:
            because = ""
            if unknown_s and ev.condition is not None:
                because = (
                    f" because the {_CONDITION_STATE[ev.condition]} state is unknown for {_hours(unknown_s)} of the "
                    f"{_hours(duration_s)} mission"
                )
            elif m.reason:
                because = f" ({_echo(m.reason)})"
            sentences = [
                f"{name}: UNKNOWN (undecided, not a failure). The value is only known to lie {measured}{because}.",
                f"The requirement of {required} falls inside these bounds, so the evidence cannot decide.",
            ]
    b.add(
        f"constraint.{ev.constraint_id.value}",
        ExplanationCategory.CONSTRAINT,
        _STATUS_SEVERITY[status],
        sentences,
        optional=optional,
        related=ev.constraint_id,
        details=details,
    )


# --- MARGIN -------------------------------------------------------------------------------------


def _margin_item(
    b: _Builder,
    ev: ConstraintEvaluation,
    margin: OperationalMargin,
    risk: RiskIndicator | None,
    resolution_s: float | None,
) -> None:
    spec = CONSTRAINT_SPECS[ev.constraint_id]
    name = ev.name or spec.name
    comparison = ev.comparison or spec.comparison
    cls = classify_margin(margin, time_resolution_s=resolution_s)
    bounds = margin_bounds(margin)
    assert bounds is not None
    lo, hi = bounds
    unit = ev.unit
    rel = relative_margin(margin)
    ref_word = "limit" if comparison is Comparison.AT_MOST else "requirement"
    band = _pct(NARROW_MARGIN_FRACTION)
    rel_text = ""
    if rel is not None:
        r_lo, r_hi = (rel.value, rel.value) if rel.value is not None else (rel.lower, rel.upper)
        assert r_lo is not None and r_hi is not None
        if cls is MarginClass.NEGATIVE and comparison is Comparison.AT_MOST:
            # 1 - relative = measured / limit; the least favourable margin is the largest outage.
            rel_text = f" (the measured value is {_span(_pct(1.0 - r_hi), _pct(1.0 - r_lo))} of the limit)"
        elif cls is MarginClass.NEGATIVE:
            rel_text = f" ({_span(_pct(-r_hi), _pct(-r_lo))} below the requirement)"
        elif comparison is Comparison.AT_MOST:
            rel_text = f" ({_span(_pct(r_lo), _pct(r_hi))} of the {ref_word} unused)"
        else:
            rel_text = f" ({_span(_pct(r_lo), _pct(r_hi))} of the {ref_word})"
    elif margin.reference == 0.0:
        rel_text = " (relative headroom undefined: the requirement is 0)"
    admissible = ev.measured.status is MetricStatus.UNAVAILABLE
    basis = " These bounds come from the physically possible range, not from observations." if admissible else ""

    if cls is MarginClass.COMFORTABLE:
        resolved = (
            f" and at least one {_hours(resolution_s)} sample spacing" if unit is Unit.SECONDS and resolution_s else ""
        )
        head = (
            f"{name}: headroom {_span(_signed(lo, unit), _signed(hi, unit))}{rel_text}, above the {band} narrow "
            f"band{resolved}."
        )
    elif cls is MarginClass.NARROW:
        why: list[str] = []
        ref = margin.reference
        if ref is not None and ref > 0.0 and meets(lo / ref, NARROW_MARGIN_FRACTION, Comparison.AT_MOST):
            why.append(f"within the {band} narrow band")
        if unit is Unit.SECONDS and resolution_s is not None and lo < resolution_s:
            why.append(f"smaller than the {_hours(resolution_s)} sample spacing, so the data cannot resolve it")
        reason = f" ({'; '.join(why)})" if why else ""
        head = f"{name}: narrow headroom, {_span(_signed(lo, unit), _signed(hi, unit))}{rel_text}{reason}."
    elif cls is MarginClass.AT_THRESHOLD:
        upto = f" (up to {_signed(hi, unit)} if the unknown data are favourable)" if hi > lo else ""
        head = (
            f"{name}: exactly at the threshold, zero proven headroom{upto}. It passes because comparisons are "
            "inclusive, but any adverse deviation would break the requirement."
        )
    elif cls is MarginClass.NEGATIVE:
        head = f"{name}: negative margin {_span(_signed(lo, unit), _signed(hi, unit))}{rel_text}: the {ref_word} is not met."
    else:  # UNCERTAIN (UNSUPPORTED / NOT_APPLICABLE never reach this function)
        head = (
            f"{name}: margin uncertain, between {_signed(lo, unit)} and {_signed(hi, unit)}. The evidence allows "
            "both headroom and a shortfall, so no headroom is established."
        )
    sentences = [head + basis]
    risk_codes: list[str] = []
    details = [f"margin: {margin.description}", f"class: {cls.value}", f"value: {_metric_raw(margin.value)}"]
    if rel is not None:
        details.append(f"relative: {_metric_raw(rel)}")
    if risk is not None:
        sentences.append(f"Screening risk {risk.level.value.upper()} ({_risk_label(risk.code)}).")
        risk_codes.append(risk.code)
        details.extend([f"risk rule: {risk.rule}", f"risk message: {risk.message}"])
    severity = {
        MarginClass.COMFORTABLE: Severity.INFO,
        MarginClass.NEGATIVE: Severity.CRITICAL,
    }.get(cls, Severity.WARNING)
    b.add(
        f"margin.{ev.constraint_id.value}",
        ExplanationCategory.MARGIN,
        severity,
        sentences,
        related=ev.constraint_id,
        risk_codes=risk_codes,
        details=details,
    )


# --- RISK ---------------------------------------------------------------------------------------


def _landing_item(b: _Builder, r: RiskIndicator, duration_s: float) -> None:
    power = r.code == "landing_in_darkness"
    related = ConstraintId.MAX_CONTINUOUS_DARKNESS if power else ConstraintId.MAX_COMMUNICATION_BLACKOUT
    evidence = _metric_text(r.evidence) if r.evidence is not None else None
    details = [f"rule: {r.rule}", f"risk message: {r.message}"]
    if r.evidence is not None:
        details.append(f"evidence: {_metric_raw(r.evidence)}")
    level = r.level.value.upper()
    if r.level is RiskLevel.LOW:
        state = "power-lit" if power else "in Earth line of sight"
        lasts = f" and stays so for {evidence}" if evidence else ""
        sentences = [f"Landing {state} (screening risk LOW): the mission starts {state}{lasts}."]
        severity = Severity.INFO
    elif r.level is RiskLevel.UNKNOWN:
        what = "power-lit" if power else "Earth line-of-sight"
        sentences = [
            f"The {what} state at landing is unknown (screening risk UNKNOWN); it is not assumed to be an outage."
        ]
        severity = Severity.WARNING
    else:
        whole = (
            r.evidence is not None
            and r.evidence.status is MetricStatus.KNOWN
            and r.evidence.value is not None
            and r.evidence.value >= duration_s - _DURATION_TOL_S
        )
        span = " for the whole mission" if whole else (f" for {evidence} from landing" if evidence else "")
        if power:
            sentences = [
                (
                    f"Landing in power-darkness (screening risk {level}): the visible solar disk is below the panel "
                    f"threshold at landing and stays so{span}."
                ),
                "The lander would depend on stored energy, which is not modelled.",
            ]
        else:
            sentences = [
                (
                    f"Landing without Earth line of sight (screening risk {level}): Earth is obstructed at landing and "
                    f"stays so{span}."
                ),
                "Direct-to-Earth contact is geometrically impossible until Earth reappears; relays are not modelled.",
            ]
        severity = Severity.WARNING
    b.add(
        f"risk.{r.code}",
        ExplanationCategory.RISK,
        severity,
        sentences,
        related=related,
        risk_codes=[r.code],
        details=details,
    )


def _generic_risk_item(b: _Builder, r: RiskIndicator) -> None:
    message = r.message.removeprefix(SYNTHETIC_PREFIX)
    b.add(
        f"risk.{r.code}"[:64],
        ExplanationCategory.RISK,
        Severity.INFO if r.level is RiskLevel.LOW else Severity.WARNING,
        [f"{_risk_label(r.code).capitalize()}: screening risk {r.level.value.upper()}. {_echo(message)}"],
        risk_codes=[r.code],
        details=[f"rule: {r.rule}", f"risk message: {r.message}"]
        + ([f"evidence: {_metric_raw(r.evidence)}"] if r.evidence is not None else []),
    )


# --- DATA_QUALITY -------------------------------------------------------------------------------


def _data_basis_items(b: _Builder, dq: DataQualitySummary, risks: dict[str, RiskIndicator]) -> None:
    p = dq.provenance
    details = [
        f"dataset_id: {dq.dataset_id}",
        f"generator: {p.generator}",
        f"generated_at_utc: {p.generated_at_utc.isoformat() if p.generated_at_utc else None}",
        f"ephemeris_source: {p.ephemeris_source}",
        (
            f"terrain_source: {p.terrain_source}; terrain_resolution_m: {p.terrain_resolution_m!r}; "
            f"horizon_azimuth_step_deg: {p.horizon_azimuth_step_deg!r}"
        ),
        (
            f"calculation_basis: {dq.calculation_basis.value}; angle_type: {dq.angle_type.value}; sun_criterion: "
            f"{dq.sun_criterion.value}; earth_criterion: {dq.earth_criterion.value}"
        ),
        f"coordinate_frame: {p.coordinate_frame}",
        *(f"reference: {ref}" for ref in p.references),
        *([f"notes: {p.notes}"] if p.notes else []),
    ]
    if p.is_synthetic:
        b.add(
            "data.synthetic",
            ExplanationCategory.DATA_QUALITY,
            Severity.WARNING,
            [
                f"SIMULATION: dataset '{dq.dataset_id}' is synthetic geometry, not NASA-derived data.",
                (
                    "Every verdict, margin, risk and score here describes the simulation only and is not valid for "
                    "mission decisions; synthetic results are never ranked with real ones."
                ),
            ],
            risk_codes=[c for c in ("synthetic_data",) if c in risks],
            details=details,
        )
    if dq.calculation_basis is CalculationBasis.GEOMETRIC_ONLY:
        b.add(
            "data.geometric_only",
            ExplanationCategory.DATA_QUALITY,
            Severity.WARNING,
            [
                "Terrain is not modelled: the horizon is taken as the local horizontal plane (0 deg).",
                (
                    "Terrain shadowing of the Sun and obstruction of Earth are ignored, so actual visibility at the site "
                    "can differ substantially from these results."
                ),
            ],
            risk_codes=[c for c in ("geometric_only_data",) if c in risks],
            details=[] if p.is_synthetic else details,
        )
    elif not p.is_synthetic:
        resolution = f" at {p.terrain_resolution_m:.6g} m" if p.terrain_resolution_m is not None else ""
        b.add(
            "data.provenance",
            ExplanationCategory.DATA_QUALITY,
            Severity.INFO,
            [
                (
                    f"Real NASA-derived geometry with terrain horizons{resolution}: dataset '{dq.dataset_id}', generator "
                    f"'{_echo(p.generator)}'."
                ),
                (
                    "Results inherit the accuracy and resolution of the ephemeris and elevation data and change when the "
                    "data are regenerated; keep the dataset id and generator with any stored result."
                ),
            ],
            details=details,
        )


def _coverage_item(b: _Builder, dq: DataQualitySummary, risks: dict[str, RiskIndicator]) -> None:
    duration = dq.evaluated_duration_s

    def unknown(code: str, fallback: float) -> float:
        r = risks.get(code)
        if r is not None and r.evidence is not None and r.evidence.value is not None:
            return r.evidence.value
        return fallback

    sun_s = unknown("sun_data_coverage", dq.sun_unknown_duration_s)
    earth_s = unknown("earth_data_coverage", dq.earth_unknown_duration_s)
    codes = [c for c in _COVERAGE_CODES if c in risks]
    details = [
        f"evaluated_duration_s: {duration!r}; sample_count: {dq.sample_count}",
        (
            f"sun_unknown_duration_s: {dq.sun_unknown_duration_s!r} (incl. power-lit state: {sun_s!r}); "
            f"earth_unknown_duration_s: {dq.earth_unknown_duration_s!r}"
        ),
        f"sun_coverage_percent: {dq.sun_coverage_percent!r}; earth_coverage_percent: {dq.earth_coverage_percent!r}",
        f"uncovered_duration_s: {dq.uncovered_duration_s!r} in {dq.coverage_gap_count} interval(s)",
        *(f"{risks[c].code} ({risks[c].level.value}): {risks[c].message}" for c in codes),
    ]
    if sun_s <= 0.0 and earth_s <= 0.0:
        b.add(
            "data.coverage",
            ExplanationCategory.DATA_QUALITY,
            Severity.INFO,
            [
                (
                    f"Sun and Earth states are known for the whole {_hours(duration)} evaluated range "
                    f"({dq.sample_count} samples); no result depends on missing data."
                )
            ],
            risk_codes=codes,
            details=details,
        )
        return
    sentences = [
        (
            f"Data coverage is incomplete: the Sun or power-lit state is unknown for {_hours(sun_s)} and the Earth state "
            f"for {_hours(earth_s)} of the {_hours(duration)} range."
        )
    ]
    if dq.sample_count == 0:
        sentences.append("No sample represents any part of it (outside the dataset), so nothing was measured.")
    else:
        if dq.uncovered_duration_s > 0.0:
            sentences.append(
                f"{_hours(dq.uncovered_duration_s)} in {dq.coverage_gap_count} interval(s) has no sample (outside "
                "dataset coverage or a gap)."
            )
        state_unknown = max(sun_s, earth_s) - dq.uncovered_duration_s
        if state_unknown > _DURATION_TOL_S:
            sentences.append(
                f"Up to {_hours(state_unknown)} is sampled with an unknown state (missing ephemeris, terrain or disk "
                "fraction)."
            )
    sentences.append(
        "Unknown time is never counted as darkness, blackout, sunlight or visibility; it only widens the bounds."
    )
    b.add(
        "data.coverage",
        ExplanationCategory.DATA_QUALITY,
        Severity.WARNING,
        sentences,
        risk_codes=codes,
        details=details,
    )


def _warnings_item(b: _Builder, dq: DataQualitySummary) -> None:
    if not dq.warnings:
        return
    first = _echo(dq.warnings[0].removeprefix(SYNTHETIC_PREFIX))
    more = f" (and {len(dq.warnings) - 1} more)" if len(dq.warnings) > 1 else ""
    b.add(
        "data.warnings",
        ExplanationCategory.DATA_QUALITY,
        Severity.WARNING,
        [f'The data pipeline reported {len(dq.warnings)} warning(s) for this range: "{first}"{more}.'],
        details=[f"warning: {w}" for w in dq.warnings],
    )


# --- LIMITATION ---------------------------------------------------------------------------------


def _limitation_items(b: _Builder, dq: DataQualitySummary, has_risks: bool) -> None:
    gap = dq.largest_sample_gap_s
    policy = dq.sampling_policy.value.replace("_", "-")
    if gap is None:
        sampling = (
            "Time resolution: fewer than two samples represent this range, so no sample spacing is defined and "
            "durations rest on single samples or none."
        )
    else:
        sampling = (
            f"Time resolution: samples are up to {_hours(gap)} apart ({policy}, no interpolation). Transition times "
            "are resolved only to that spacing, shorter events can be missed, and smaller duration margins are not "
            "resolved."
        )
    b.add(
        "limitation.sampling",
        ExplanationCategory.LIMITATION,
        Severity.INFO,
        [sampling],
        details=[f"sampling_policy: {dq.sampling_policy.value}; largest_sample_gap_s: {gap!r}"]
        + [f"assumption: {a}" for a in dq.assumptions],
    )
    b.add(
        "limitation.illumination_power",
        ExplanationCategory.LIMITATION,
        Severity.INFO,
        [
            (
                "Sunlight here is geometric visibility of the solar disk, not electrical power: array orientation, "
                "efficiency, temperature, dust, batteries and the power system are not modelled."
            ),
            "'Power-lit' only means the visible disk fraction meets the configured panel threshold.",
        ],
        details=[STANDARD_LIMITATIONS[0]],
    )
    b.add(
        "limitation.line_of_sight",
        ExplanationCategory.LIMITATION,
        Severity.INFO,
        [
            (
                "Earth line of sight is a geometric opportunity, not guaranteed communication: antenna pointing, link "
                "budget, ground-station availability, relays and interference are not modelled."
            )
        ],
        details=[STANDARD_LIMITATIONS[1]],
    )
    b.add(
        "limitation.spacecraft",
        ExplanationCategory.LIMITATION,
        Severity.INFO,
        [
            (
                "Spacecraft limits (maximum darkness and blackout durations, panel threshold) are used as configured and "
                "are not verified: battery capacity, thermal survival and radio hardware are not modelled."
            ),
            "Nothing here assesses landing safety (slopes, hazards).",
        ],
        details=[STANDARD_LIMITATIONS[2], STANDARD_LIMITATIONS[3], STANDARD_LIMITATIONS[4]],
    )
    if has_risks:
        b.add(
            "limitation.risk_bands",
            ExplanationCategory.LIMITATION,
            Severity.INFO,
            [
                (
                    f"Risk headroom bands ({_pct(DEFAULT_RISK_POLICY.high_headroom_fraction)} HIGH, "
                    f"{_pct(DEFAULT_RISK_POLICY.moderate_headroom_fraction)} MODERATE by default) are product-defined "
                    "screening heuristics, not NASA-certified safety thresholds, and no probability of mission failure "
                    "is computed."
                )
            ],
            details=["Bands apply to headroom = margin / reference; see each indicator's rule for the policy used."],
        )


# --- entry points -------------------------------------------------------------------------------


def build_explanation_details(
    eligibility: Eligibility,
    constraints: list[ConstraintEvaluation],
    margins: list[OperationalMargin],
    risks: list[RiskIndicator],
    data_quality: DataQualitySummary,
    *,
    score: ScoreBreakdown | None = None,
    overall_risk: RiskLevel | None = None,
) -> list[ExplanationDetail]:
    """Explanations with stable keys and technical evidence (order: module docstring).

    ``overall_risk`` defaults to ``risk.overall_risk(risks)``; ``score`` adds the score items. Inputs
    are only read. Raises ``ValueError`` when the inputs contradict each other (see module docstring).
    """
    _check_inputs(eligibility, constraints, risks, score, overall_risk)
    overall = overall_risk if overall_risk is not None else derive_overall_risk(risks)
    duration_s = data_quality.evaluated_duration_s
    configured = sorted(
        (c for c in constraints if c.status is not ConstraintStatus.NOT_APPLICABLE),
        key=lambda c: (_STATUS_ORDER[c.status], list(ConstraintId).index(c.constraint_id)),
    )
    by_margin = _index_margins(configured, margins, duration_s)
    for ev in configured:
        _check_margin(ev, by_margin[ev.constraint_id])
    risks = sorted(risks, key=_risk_order)  # canonical order: independent of the input list order
    by_code = {r.code: r for r in risks}

    b = _Builder(data_quality.provenance.is_synthetic)
    _verdict(b, eligibility, configured)
    _risk_overview(b, eligibility, risks, overall)
    if score is not None:
        _score_items(b, eligibility, score)

    for ev in configured:
        unsupported = f"unsupported_requirement.{ev.constraint_id.value}"
        _constraint_item(
            b, ev, by_margin[ev.constraint_id], duration_s, unsupported if unsupported in by_code else None
        )
    for ev in configured:
        if margin_bounds(by_margin[ev.constraint_id]) is None:
            continue  # unsupported requirement: no margin exists; the constraint item says so
        code = OUTAGE_RISK_CODES.get(ev.constraint_id, f"margin_headroom.{ev.constraint_id.value}")
        _margin_item(b, ev, by_margin[ev.constraint_id], by_code.get(code), data_quality.largest_sample_gap_s)

    claimed = {code for item in b.items for code in item.risk_codes}
    claimed.update(c for c in (*_DATA_BASIS_CODES, *_COVERAGE_CODES) if c in by_code)
    remaining = sorted((r for r in risks if r.code not in claimed), key=lambda r: _LEVEL_ORDER[r.level])
    for r in remaining:
        if r.code in _LANDING_CODES:
            _landing_item(b, r, duration_s)
        else:
            _generic_risk_item(b, r)

    _data_basis_items(b, data_quality, by_code)
    _coverage_item(b, data_quality, by_code)
    _warnings_item(b, data_quality)
    _limitation_items(b, data_quality, bool(risks))
    return b.items


def generate_explanations(
    eligibility: Eligibility,
    constraints: list[ConstraintEvaluation],
    margins: list[OperationalMargin],
    risks: list[RiskIndicator],
    data_quality: DataQualitySummary,
    *,
    score: ScoreBreakdown | None = None,
    overall_risk: RiskLevel | None = None,
) -> list[Explanation]:
    """Deterministic, evidence-based explanations of one assessment (Phase 1 signature, extended).

    The keyword-only ``score`` and ``overall_risk`` are additive: without ``score`` no score items are
    produced, and ``overall_risk`` defaults to the level derived from ``risks``. See
    ``build_explanation_details`` for the same items with technical evidence.
    """
    return [
        d.explanation
        for d in build_explanation_details(
            eligibility, constraints, margins, risks, data_quality, score=score, overall_risk=overall_risk
        )
    ]


def explain_assessment_details(assessment: ViabilityAssessment) -> list[ExplanationDetail]:
    """``build_explanation_details`` for a complete assessment (its own ``explanations`` are ignored)."""
    return build_explanation_details(
        assessment.eligibility,
        assessment.constraints,
        assessment.margins,
        assessment.risks,
        assessment.data_quality,
        score=assessment.score,
        overall_risk=assessment.overall_risk,
    )


def explain_assessment(assessment: ViabilityAssessment) -> list[Explanation]:
    """``generate_explanations`` for a complete assessment (its own ``explanations`` are ignored)."""
    return [d.explanation for d in explain_assessment_details(assessment)]
