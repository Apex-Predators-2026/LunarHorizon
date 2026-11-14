"""Constraint loosening: "what is the smallest requirement change that makes something pass?"

Relaxing a requirement never changes a scenario's metrics, so a failing candidate passes
exactly when each violated requirement is relaxed to the value the candidate achieves.
We rank candidates by how much total relaxation that needs.
"""
from __future__ import annotations

import math

from .viability import CHECK_BY_CONSTRAINT
from .engine import Candidate
from .explain import fmt_time, fmt_value
from .schemas import LooseningSuggestion, RequirementChange


def _relaxed(constraint: str, actual: float, unit: str) -> float:
    kind = CHECK_BY_CONSTRAINT[constraint][2]
    if unit == "fraction":
        # round to whole percent in the direction that still passes
        return math.floor(actual * 100) / 100 if kind == "min" else math.ceil(actual * 100) / 100
    return float(math.floor(actual)) if kind == "min" else float(math.ceil(actual))


def requirement_changes(c: Candidate) -> list[RequirementChange]:
    out = []
    for v in c.result.violations:
        label = CHECK_BY_CONSTRAINT[v.constraint][4]
        suggested = _relaxed(v.constraint, v.actual, v.unit)
        pct = 0.0 if v.required == 0 else (suggested - v.required) / v.required * 100
        out.append(RequirementChange(constraint=v.constraint, label=label, unit=v.unit, current=v.required,
                                     suggested=suggested, change_percent=round(pct, 1)))
    return out


def _describe(ch: RequirementChange) -> str:
    verb = "raise" if ch.suggested > ch.current else "lower"
    return (f"{verb} the {ch.label} requirement from {fmt_value(ch.current, ch.unit)} to "
            f"{fmt_value(ch.suggested, ch.unit)} ({ch.change_percent:+.0f}%)")


def suggestion_for(c: Candidate, keeps_original: bool) -> LooseningSuggestion:
    changes = requirement_changes(c)
    total = sum(abs(ch.change_percent) for ch in changes) / 100
    what = " and ".join(_describe(ch) for ch in changes)
    what = what[:1].upper() + what[1:]
    target = ("your delayed plan passes as-is" if keeps_original else
              f"{c.scenario.site.name} on {fmt_time(c.scenario.landing_utc)} passes")
    return LooseningSuggestion(changes=changes, total_relative_change=round(total, 4), keeps_original_plan=keeps_original,
                               unlocks=c.scenario, unlocks_score=c.result.score, message=f"{what} → {target}.")


def fixable_by_relaxing(c: Candidate) -> bool:
    r = c.result
    return r.verdict == "fail" and bool(r.violations) and not any(v.is_unknown for v in r.violations)


def loosening_suggestions(failing: list[Candidate], changed: Candidate | None, n: int = 3,
                          shift_weight_per_day: float = 0.01, distance_weight_per_km: float = 0.002
                          ) -> list[LooseningSuggestion]:
    """Smallest relaxations first. Always includes the 'keep the delayed plan' option if it fails.

    Only real failures get advice: a result that is undecided, or that fails partly because data is
    missing (violation.is_unknown), can't be fixed by relaxing a requirement, so it is skipped."""
    out: list[LooseningSuggestion] = []
    seen: set[tuple] = set()
    if changed is not None and fixable_by_relaxing(changed):
        out.append(suggestion_for(changed, keeps_original=True))
        seen.add((changed.group, frozenset(v.constraint for v in changed.result.violations)))

    def cost(c: Candidate) -> float:
        rel = sum(min(v.relative_shortfall, 10.0) for v in c.result.violations)
        return rel + shift_weight_per_day * abs(c.date_shift_hours) / 24 + distance_weight_per_km * c.distance_km

    for c in sorted((c for c in failing if fixable_by_relaxing(c)), key=cost):
        k = (c.group, frozenset(v.constraint for v in c.result.violations))
        if k in seen:
            continue
        seen.add(k)
        out.append(suggestion_for(c, keeps_original=False))
        if len(out) >= n + (1 if out and out[0].keeps_original_plan else 0):
            break
    return out
