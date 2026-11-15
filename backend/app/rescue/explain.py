"""Turns metric differences into plain-English explanations."""
from __future__ import annotations

from datetime import datetime

from ..models import ViabilityResult, Violation
from .engine import Candidate
from .schemas import MetricDelta
from .viability import CHECK_BY_CONSTRAINT

# (metric field, label, unit, higher_is_better)
TRACKED = [
    ("sunlight_fraction", "Average sunlight", "fraction", True),
    ("longest_dark_gap_hours", "Longest power gap", "h", False),
    ("earth_visibility_fraction", "Earth visibility", "fraction", True),
    ("longest_comms_gap_hours", "Longest comms blackout", "h", False),
    ("initial_sun_hours", "Sunlight after landing", "h", True),
    ("initial_comms_hours", "Earth contact after landing", "h", True),
]

# Scale used to decide which improvements are "big": 10 percentage points or 10% of 100 h.
SCALE = {"fraction": 1.0, "h": 100.0}


def fmt_value(v: float | None, unit: str, digits: int = 0) -> str:
    if v is None:
        return "n/a"
    return f"{v * 100:.{digits}f}%" if unit == "fraction" else f"{v:.{digits}f} h"


def short_label(constraint: str) -> str:
    """Short plain-English name of a requirement; falls back to the field name if it is not in the table."""
    check = CHECK_BY_CONSTRAINT.get(constraint)
    return check[4] if check else constraint.replace("_", " ")


def describe_violation(v: Violation) -> str:
    """One sentence for a failed requirement, e.g. "Average sunlight 35% (needs at least 50%)"."""
    if v.is_unknown:
        return v.message
    check = CHECK_BY_CONSTRAINT.get(v.constraint)
    need = {"min": "needs at least ", "max": "allows at most "}.get(check[2] if check else "", "needs ")
    actual, required = fmt_value(v.actual, v.unit), fmt_value(v.required, v.unit)
    if actual == required and v.actual is not None and v.required is not None:  # "40% (needs at least 40%)" reads as a contradiction
        actual, required = fmt_value(v.actual, v.unit, 1), fmt_value(v.required, v.unit, 1)
    return f"{short_label(v.constraint).capitalize()} {actual} ({need}{required})"


def fmt_delta(d: float, unit: str) -> str:
    sign = "+" if d >= 0 else "−"
    return f"{sign}{abs(d) * 100:.0f} pts" if unit == "fraction" else f"{sign}{abs(d):.0f} h"


def fmt_score(score: float | None) -> str:
    return "n/a" if score is None else f"{score:.0f}"


def fmt_time(t: datetime) -> str:
    return t.strftime("%Y-%m-%d %H:%M UTC")


def fmt_shift(hours: float) -> str:
    if abs(hours) < 0.5:
        return "same time"
    days = hours / 24
    when = "later" if hours > 0 else "earlier"
    return f"{abs(days):.1f} days {when}" if abs(hours) >= 24 else f"{abs(hours):.0f} h {when}"


def metric_deltas(before: ViabilityResult, after: ViabilityResult) -> list[MetricDelta]:
    out = []
    for metric, label, unit, higher in TRACKED:
        b = getattr(before.metrics, metric)
        a = getattr(after.metrics, metric)
        d = None if a is None or b is None else a - b
        better = None if d is None or abs(d) < 1e-9 else (d > 0) == higher
        out.append(MetricDelta(metric=metric, label=label, unit=unit, before=b, after=a, delta=d, better=better))
    d = None if after.score is None or before.score is None else after.score - before.score
    out.append(MetricDelta(metric="score", label="Viability score", unit="points", before=before.score,
                           after=after.score, delta=d, better=None if d is None or abs(d) < 1e-9 else d > 0))
    return out


def _sentence(m: MetricDelta) -> str:
    return f"{m.label}: {fmt_value(m.before, m.unit)} → {fmt_value(m.after, m.unit)} ({fmt_delta(m.delta, m.unit)})"


def reasons_for(c: Candidate, changed: ViabilityResult, deltas: list[MetricDelta]) -> list[str]:
    reasons = []
    fixed = {v.constraint for v in changed.violations} - {v.constraint for v in c.result.violations}
    if fixed:
        labels = [short_label(v.constraint) for v in changed.violations if v.constraint in fixed]
        reasons.append("Fixes: " + ", ".join(labels) + ".")
    metric_only = [m for m in deltas if m.metric != "score" and m.delta is not None]
    gains = sorted((m for m in metric_only if m.better), key=lambda m: -abs(m.delta) / SCALE[m.unit])
    losses = sorted((m for m in metric_only if m.better is False), key=lambda m: -abs(m.delta) / SCALE[m.unit])
    reasons += [_sentence(m) for m in gains[:3]]
    if losses and abs(losses[0].delta) / SCALE[losses[0].unit] >= 0.05:
        reasons.append("Trade-off — " + _sentence(losses[0]))
    m = c.result.metrics
    hr = getattr(c.result, "headroom", None)
    if hr is not None:
        if hr.darkness and hr.darkness.margin.status == "known" and hr.darkness.margin.value is not None:
            reasons.append(f"Darkness headroom: {hr.darkness.margin.value:g} h of {hr.darkness.threshold:g} h battery limit.")
        if (
            hr.communication_blackout
            and hr.communication_blackout.margin.status == "known"
            and hr.communication_blackout.margin.value is not None
        ):
            reasons.append(
                f"Comms blackout headroom: {hr.communication_blackout.margin.value:g} h of "
                f"{hr.communication_blackout.threshold:g} h limit."
            )
        reasons.append(f"Initial illumination: {hr.initial_sunlight.summary_text}.")
        reasons.append(f"Initial Earth contact: {hr.initial_earth.summary_text}.")
        if hr.closest_constraint is not None:
            reasons.append(f"Closest limit — {hr.closest_constraint.summary_text}.")
    else:
        if m.hours_to_first_sunset is not None:
            reasons.append(f"First sunset {m.hours_to_first_sunset:.0f} h after landing.")
        else:
            reasons.append("Sun stays up for the whole mission.")
    return reasons


def headline_for(c: Candidate, changed: ViabilityResult) -> str:
    where = c.scenario.site.name
    parts = []
    if abs(c.date_shift_hours) >= 0.5:
        parts.append(fmt_shift(c.date_shift_hours) + " than the delayed date")
    if c.distance_km > 0.01:
        parts.append(f"{c.distance_km:.1f} km from the original site")
    if not parts:
        parts.append("no change from the delayed plan")
    hr = getattr(c.result, "headroom", None)
    if hr is not None and hr.qualified_verdict:
        verdict = hr.qualified_verdict[0].lower() + hr.qualified_verdict[1:]
    else:
        verdict = "passes declared requirements (screening only)"
    return (f"Land at {where} on {fmt_time(c.scenario.landing_utc)} ({'; '.join(parts)}) — "
            f"{verdict}, score {fmt_score(c.result.score)} (delayed plan: {fmt_score(changed.score)}).")


def why_fails(res: ViabilityResult) -> list[str]:
    return [describe_violation(v) for v in sorted(res.violations, key=lambda v: -v.relative_shortfall)]
