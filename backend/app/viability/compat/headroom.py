"""Canonical operational headroom serializer consuming Phase 4A viability outputs."""
from __future__ import annotations

from ..margins import NARROW_MARGIN_FRACTION, MarginClass, classify_margin, margin_bounds, relative_margin
from ..outputs import (
    Comparison,
    ConstraintEvaluation,
    Eligibility,
    Metric,
    MetricStatus,
    OperationalMargin,
    Unit,
    ViabilityAssessment,
)
from ...models import (
    CanonicalMarginItem,
    ClosestRequirementInfo,
    HeadroomStatus,
    InitialWindowSummary,
    MarginMetricValue,
    MarginStatus,
    OperationalHeadroom,
)

SCREENING_NOTE = (
    "Model screening result based on solar illumination and geometric Earth line-of-sight only; "
    "not a guarantee of spacecraft survival."
)

_CONSTRAINT_META: dict[str, tuple[str | None, str, str]] = {
    "max_continuous_darkness": ("battery_hours", "Max continuous darkness", "darkness"),
    "max_communication_blackout": ("max_comms_gap_hours", "Max communication blackout", "communication blackout"),
    "min_sunlight_percent": ("min_sunlight_fraction", "Min sunlight share", "sunlight share"),
    "min_earth_visibility_percent": ("min_earth_visibility_fraction", "Min Earth visibility", "Earth visibility"),
    "min_simultaneous_percent": ("min_simultaneous_percent", "Min simultaneous Sun & Earth", "simultaneous visibility"),
    "min_sun_clearance": ("min_sun_clearance_deg", "Min Sun clearance", "Sun clearance"),
    "min_earth_clearance": ("min_earth_clearance_deg", "Min Earth clearance", "Earth clearance"),
    "min_mean_solar_disk_fraction": ("min_sunlight_fraction", "Min solar disk fraction", "solar disk fraction"),
    "min_initial_sunlight": ("min_initial_sun_hours", "Min initial sunlight", "initial sunlight"),
    "min_initial_earth_visibility": ("min_initial_comms_hours", "Min initial Earth contact", "initial Earth contact"),
}

_SEVERITY_RANK: dict[MarginStatus, int] = {
    "negative": 0,
    "at_threshold": 1,
    "uncertain": 2,
    "narrow": 3,
    "comfortable": 4,
    "unsupported": 5,
    "not_applicable": 6,
}


def _display_scale_and_unit(unit: Unit) -> tuple[float, str]:
    if unit is Unit.SECONDS:
        return 1.0 / 3600.0, "h"
    if unit is Unit.PERCENT:
        return 1.0, "%"
    if unit is Unit.FRACTION:
        return 1.0, "fraction"
    return 1.0, unit.value


def _to_margin_metric(metric: Metric, *, force_unit: Unit | None = None) -> MarginMetricValue:
    unit = force_unit or metric.unit
    scale, unit_label = _display_scale_and_unit(unit)
    return MarginMetricValue(
        status=metric.status.value,
        unit=unit_label,
        value=round(metric.value * scale, 4) if metric.value is not None else None,
        lower=round(metric.lower * scale, 4) if metric.lower is not None else None,
        upper=round(metric.upper * scale, 4) if metric.upper is not None else None,
        reason=metric.reason,
    )


def _fmt_num(val: float, unit: str) -> str:
    if unit == "fraction":
        return f"{val * 100:.1f}%"
    if unit == "%":
        return f"{val:.1f}%"
    if abs(val - round(val)) < 0.05:
        return f"{round(val):.0f} {unit}".strip()
    return f"{val:.1f} {unit}".strip()


def _fmt_signed_margin(m: MarginMetricValue) -> str:
    if m.status == "known" and m.value is not None:
        sign = "+" if m.value > 0 else ""
        return f"{sign}{_fmt_num(m.value, m.unit)}"
    if m.status == "bounded" and m.lower is not None and m.upper is not None:
        return f"between {_fmt_num(m.lower, m.unit)} and {_fmt_num(m.upper, m.unit)}"
    if m.status == "not_applicable":
        return "not applicable"
    return "uncertain"


def _narrow_reason(
    raw_margin: OperationalMargin,
    margin_class: MarginClass,
    rel: Metric | None,
    gap_s: float | None,
) -> str | None:
    if margin_class is MarginClass.AT_THRESHOLD:
        return "Zero proven margin left at the declared requirement boundary."
    if margin_class is not MarginClass.NARROW:
        return None
    reasons: list[str] = []
    if rel is not None:
        rel_bounds = margin_bounds(OperationalMargin(
            margin_id=raw_margin.margin_id,
            related_constraint=raw_margin.related_constraint,
            reference=1.0,
            value=rel,
            description="relative",
        ))
        if rel_bounds is not None and rel_bounds[0] <= NARROW_MARGIN_FRACTION:
            reasons.append(f"Headroom is {rel_bounds[0] * 100:.1f}% of the limit (<= {NARROW_MARGIN_FRACTION * 100:.0f}%).")
    bounds = margin_bounds(raw_margin)
    if bounds is not None and raw_margin.value.unit is Unit.SECONDS and gap_s is not None and bounds[0] < gap_s:
        gap_h = gap_s / 3600.0
        reasons.append(f"Remaining margin is smaller than the {gap_h:g} h sampling interval.")
    if not reasons:
        reasons.append("Remaining margin falls within the engine's narrow safety band.")
    return " ".join(reasons)


def _join_words(items: list[str]) -> str:
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    if len(items) == 2:
        return f"{items[0]} and {items[1]}"
    return ", ".join(items[:-1]) + f", and {items[-1]}"


def _build_initial_window(
    *,
    kind: str,
    duration_m: Metric,
    first_end_m: Metric,
    margin_item: CanonicalMarginItem | None,
) -> InitialWindowSummary:
    dur = _to_margin_metric(duration_m)
    end = _to_margin_metric(first_end_m)
    req_h = margin_item.threshold if margin_item and margin_item.threshold is not None else None
    attached = margin_item if margin_item and margin_item.margin_class != "not_applicable" else None

    noun = "sunlight" if kind == "sunlight" else "Earth contact"
    event = "first sunset" if kind == "sunlight" else "first Earthset"
    stays = "stays lit all mission" if kind == "sunlight" else "stays in contact all mission"

    if dur.status == "known" and dur.value is not None:
        if dur.value <= 0:
            dur_str = f"Starts without {noun} (0 h at landing)"
        elif end.status == "not_applicable":
            dur_str = f"{_fmt_num(dur.value, 'h')} from landing ({stays})"
        elif end.status == "known" and end.value is not None:
            dur_str = f"{_fmt_num(dur.value, 'h')} continuous from landing ({event} T+{_fmt_num(end.value, 'h')})"
        elif end.status == "bounded" and end.lower is not None and end.upper is not None:
            dur_str = f"{_fmt_num(dur.value, 'h')} from landing ({event} between T+{_fmt_num(end.lower, 'h')} and T+{_fmt_num(end.upper, 'h')})"
        else:
            dur_str = f"{_fmt_num(dur.value, 'h')} initial {noun}"
    elif dur.status == "bounded" and dur.lower is not None and dur.upper is not None:
        dur_str = f"between {_fmt_num(dur.lower, 'h')} and {_fmt_num(dur.upper, 'h')} initial {noun}"
    else:
        dur_str = f"Initial {noun} window unavailable from timeline gaps"

    if attached is not None and req_h is not None and req_h > 0:
        dur_str = f"{dur_str} (headroom {_fmt_signed_margin(attached.margin)} vs {_fmt_num(req_h, 'h')} min)"

    return InitialWindowSummary(
        kind=kind,  # type: ignore[arg-type]
        duration=dur,
        first_end_hours=end,
        requirement_hours=req_h,
        headroom=attached,
        summary_text=dur_str,
    )


def _closest_sort_key(item: CanonicalMarginItem) -> tuple[int, float, float, str]:
    rank = _SEVERITY_RANK.get(item.margin_class, 99)
    rel_val = 999.0
    if item.relative_margin is not None:
        if item.relative_margin.status == "known" and item.relative_margin.value is not None:
            rel_val = item.relative_margin.value
        elif item.relative_margin.status == "bounded" and item.relative_margin.lower is not None:
            rel_val = item.relative_margin.lower
    abs_val = 999999.0
    if item.margin.status == "known" and item.margin.value is not None:
        abs_val = item.margin.value
    elif item.margin.status == "bounded" and item.margin.lower is not None:
        abs_val = item.margin.lower
    return (rank, rel_val, abs_val, item.id)


def _build_closest(items: list[CanonicalMarginItem]) -> ClosestRequirementInfo | None:
    active = [i for i in items if i.margin_class not in ("not_applicable", "unsupported")]
    if not active:
        return None
    closest = min(active, key=_closest_sort_key)
    headroom_str = _fmt_signed_margin(closest.margin)
    rel_pct: float | None = None
    if closest.relative_margin is not None:
        if closest.relative_margin.status == "known" and closest.relative_margin.value is not None:
            rel_pct = round(closest.relative_margin.value * 100.0, 2)
        elif closest.relative_margin.status == "bounded" and closest.relative_margin.lower is not None:
            rel_pct = round(closest.relative_margin.lower * 100.0, 2)

    if closest.threshold is not None:
        limit_str = _fmt_num(closest.threshold, closest.unit)
        pct_suffix = f" ({rel_pct:.1f}%)" if rel_pct is not None else ""
        if closest.comparison == "at_most":
            summary = f"{closest.name}: {headroom_str} remaining of {limit_str} limit{pct_suffix}"
        else:
            summary = f"{closest.name}: {headroom_str} vs {limit_str} minimum{pct_suffix}"
    else:
        summary = f"{closest.name}: {headroom_str}"

    return ClosestRequirementInfo(
        constraint_id=closest.id,
        requirement_field=closest.requirement_field,
        label=closest.name,
        margin_class=closest.margin_class,
        unit=closest.unit,
        headroom_text=headroom_str,
        relative_pct=rel_pct,
        summary_text=summary,
    )


def build_operational_headroom(assessment: ViabilityAssessment) -> OperationalHeadroom:
    """Convert a Phase 4A/6 ``ViabilityAssessment`` into structured operational headroom."""
    constraints_by_id: dict[str, ConstraintEvaluation] = {
        c.constraint_id.value: c for c in assessment.constraints
    }
    gap_s = assessment.data_quality.largest_sample_gap_s
    items: list[CanonicalMarginItem] = []

    for m in assessment.margins:
        cid = m.margin_id
        c = constraints_by_id.get(cid)
        req_field, default_name, short_label = _CONSTRAINT_META.get(
            cid,
            (c.requirement_field if c else None, cid.replace("_", " ").title(), cid.replace("_", " ")),
        )
        scale, disp_unit = _display_scale_and_unit(m.value.unit)
        m_class = classify_margin(m, time_resolution_s=gap_s)
        rel = relative_margin(m)

        measured = (
            _to_margin_metric(c.measured, force_unit=m.value.unit)
            if c is not None
            else MarginMetricValue(status="unavailable", unit=disp_unit, reason="No constraint record")
        )
        threshold = round(m.reference * scale, 4) if m.reference is not None else None
        rel_val = _to_margin_metric(rel) if rel is not None else None

        items.append(
            CanonicalMarginItem(
                id=cid,
                requirement_field=req_field,
                name=c.name if c is not None else default_name,
                short_label=short_label,
                comparison=c.comparison.value if c is not None and c.comparison is not None else None,
                unit=disp_unit,
                threshold=threshold,
                measured=measured,
                margin=_to_margin_metric(m.value),
                relative_margin=rel_val,
                margin_class=m_class.value,  # type: ignore[arg-type]
                narrow_reason=_narrow_reason(m, m_class, rel, gap_s),
                description=m.description,
            )
        )

    by_id = {item.id: item for item in items}
    darkness = by_id.get("max_continuous_darkness")
    blackout = by_id.get("max_communication_blackout")
    init_sun = _build_initial_window(
        kind="sunlight",
        duration_m=assessment.metrics.initial_sunlight_duration,
        first_end_m=assessment.metrics.time_to_first_sunset,
        margin_item=by_id.get("min_initial_sunlight"),
    )
    init_earth = _build_initial_window(
        kind="earth",
        duration_m=assessment.metrics.initial_earth_visibility_duration,
        first_end_m=assessment.metrics.time_to_first_earthset,
        margin_item=by_id.get("min_initial_earth_visibility"),
    )
    closest = _build_closest(items)

    narrow_items = [i for i in items if i.margin_class in ("narrow", "at_threshold")]
    limited_constraints = [i.requirement_field or i.id for i in narrow_items]

    if assessment.eligibility is Eligibility.FAIL:
        status: HeadroomStatus = "failed"
        failed_labels = [i.short_label for i in items if i.margin_class == "negative"]
        qualified_verdict = (
            f"Fails requirements on {_join_words(failed_labels)}"
            if failed_labels
            else "Fails declared mission requirements"
        )
    elif assessment.eligibility is Eligibility.UNKNOWN:
        status = "uncertain"
        qualified_verdict = "Unknown eligibility — data coverage gaps leave headroom unresolved"
    else:
        classes = {i.margin_class for i in items}
        if "at_threshold" in classes:
            status = "at_threshold"
            labels = _join_words([i.short_label for i in narrow_items])
            lead = narrow_items[0]
            qualified_verdict = (
                f"Passes at the {labels} boundary "
                f"({_fmt_signed_margin(lead.margin)} of {_fmt_num(lead.threshold, lead.unit)} limit)"
                if lead.threshold is not None
                else f"Passes with zero margin on {labels}"
            )
        elif "narrow" in classes:
            status = "limited"
            labels = _join_words([i.short_label for i in narrow_items])
            lead = narrow_items[0]
            detail = (
                f" ({_fmt_signed_margin(lead.margin)} of {_fmt_num(lead.threshold, lead.unit)} limit)"
                if lead.threshold is not None
                else f" ({_fmt_signed_margin(lead.margin)})"
            )
            qualified_verdict = f"Passes with limited {labels} margin{detail}"
        elif "uncertain" in classes:
            status = "uncertain"
            qualified_verdict = (
                f"Passes with uncertain margin bounds ({closest.summary_text})"
                if closest is not None
                else "Passes with bounded headroom uncertainty"
            )
        elif "comfortable" in classes:
            status = "comfortable"
            parts: list[str] = []
            if darkness is not None and darkness.margin_class == "comfortable":
                parts.append(f"{_fmt_signed_margin(darkness.margin)} darkness")
            if blackout is not None and blackout.margin_class == "comfortable":
                parts.append(f"{_fmt_signed_margin(blackout.margin)} comms blackout")
            if not parts and closest is not None:
                parts.append(closest.summary_text)
            qualified_verdict = f"Passes with comfortable headroom ({', '.join(parts)})"
        else:
            status = "vacuous"
            qualified_verdict = "Passes (no active constraint margins configured)"

    return OperationalHeadroom(
        status=status,
        qualified_verdict=qualified_verdict,
        limited_constraints=limited_constraints,
        darkness=darkness,
        communication_blackout=blackout,
        initial_sunlight=init_sun,
        initial_earth=init_earth,
        closest_constraint=closest,
        constraints=items,
        screening_note=SCREENING_NOTE,
    )
