"""Feasibility Atlas: which landing dates work for a mission of a given length, and why.

Every cell of the grid (tested landing date x tested mission duration) is one mission evaluated by the
canonical viability engine (`app.viability.evaluate_scenario`), with the same conversion from a plan
(`compat.rescue.scenario_to_mission`) the Planner, Rescue and Comparison use, on the site's precomputed
JPL Horizons + LOLA file. Nothing is interpolated between cells: the grid shows only the tested dates and
durations, at the stated sampling interval.

Cell states:
  pass / fail / unknown  the engine's own eligibility for that exact mission
  not_evaluated          no data at all for that landing (before the site file starts or after it ends):
                         the mission was not run, as opposed to run and found undecidable (unknown)

Speed: the 5-year site series is sliced to the searched window before evaluating (about 7 ms instead of
~95 ms per mission). The slice covers every tested mission completely, or ends where the data ends, so the
engine sees exactly the samples it would otherwise; tests check the verdicts are identical.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from functools import lru_cache

from fastapi import HTTPException

from ..compare.evidence import canonical_metric
from ..engine.sites import ALL_SITES
from ..models import Scenario, Site
from ..store import SITES_DIR
from ..viability.adapters import load_site_file
from ..viability.compat.rescue import scenario_to_mission
from ..viability.conventions import ENGINE_VERSION
from ..viability.engine import evaluate_scenario
from ..viability.enums import Unit
from ..viability.inputs import ScientificTimeSeries
from .schemas import AtlasCell, AtlasRequest, AtlasResponse, CellConstraint, RequirementInfo

_HOUR = 3600.0
_UNIT = {Unit.SECONDS: "h", Unit.PERCENT: "%", Unit.FRACTION: "fraction", Unit.DEGREES: "deg"}


def _iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


@lru_cache(maxsize=8)
def _series(site_id: str) -> ScientificTimeSeries:
    path = SITES_DIR / f"{site_id}.json"
    if not path.exists():
        raise HTTPException(404, f"No precomputed data for site '{site_id}': the Atlas uses curated sites only")
    return load_site_file(path)


def slice_series(series: ScientificTimeSeries, start: datetime, end: datetime) -> ScientificTimeSeries:
    """The samples from `start` to `end` (inclusive, with one day of margin), as the same series."""
    lo, hi = start - timedelta(days=1), end + timedelta(days=1)
    samples = [s for s in series.samples if lo <= s.time_utc <= hi]
    if not samples:
        return series
    return series.model_copy(update={
        "samples": samples,
        "coverage_start_utc": max(series.coverage_start_utc, samples[0].time_utc),
        "coverage_end_utc": min(series.coverage_end_utc, samples[-1].time_utc),
    })


def _display(v: float | None, unit: Unit) -> float | None:
    return None if v is None else v / _HOUR if unit is Unit.SECONDS else v


def _margin(comparison: str | None, threshold: float | None, measured: float | None) -> float | None:
    if comparison is None or threshold is None or measured is None:
        return None
    return measured - threshold if comparison == "at_least" else threshold - measured


def _relative(margin: float | None, threshold: float | None) -> float:
    """Margin as a fraction of the threshold, to compare requirements with different units."""
    if margin is None:
        return float("inf")
    return margin / max(abs(threshold or 0.0), 1e-9 if threshold else 1.0)


def _cell(req: AtlasRequest, series: ScientificTimeSeries, site, landing: datetime, days: float,
          data_start: datetime, data_end: datetime, info: dict[str, RequirementInfo]) -> AtlasCell:
    if landing < data_start or landing >= data_end:
        return AtlasCell(landing_utc=_iso(landing), duration_days=days, status="not_evaluated", limiting=None,
                         reason=f"No data for this landing (the site's data covers {_iso(data_start)} to {_iso(data_end)}): not evaluated")
    scenario = Scenario(site=site, landing_utc=landing, duration_days=days, requirements=req.requirements)
    a = evaluate_scenario(scenario_to_mission(scenario), series)
    constraints: list[CellConstraint] = []
    messages: dict[str, str] = {}
    for c in a.constraints:
        threshold = _display(c.threshold, c.unit)
        comparison = c.comparison.value if c.comparison else None
        if c.constraint_id.value not in info:
            info[c.constraint_id.value] = RequirementInfo(
                id=c.constraint_id.value, name=c.name, comparison=comparison, threshold=threshold,
                unit=_UNIT.get(c.unit, c.unit.value), requirement_field=c.requirement_field)
        m = canonical_metric(c.measured)
        messages[c.constraint_id.value] = c.message
        constraints.append(CellConstraint(
            id=c.constraint_id.value, status=c.status.value, measured=m.status, value=m.value, lower=m.lower,
            upper=m.upper, margin=_margin(comparison, threshold, m.value),
            note=(m.reason or (c.unknown_reason.value if c.unknown_reason else None)) if c.status.value == "unknown" else None))

    status = a.eligibility.value
    by_margin = lambda cs: sorted(cs, key=lambda c: _relative(c.margin, info[c.id].threshold))  # noqa: E731
    if status == "fail":
        limiting = by_margin([c for c in constraints if c.status == "fail"])[0]
        others = sum(1 for c in constraints if c.status == "fail") - 1
        reason = f"Fails: {messages[limiting.id]}" + (f" (and {others} other requirement{'s' if others > 1 else ''})" if others else "")
    elif status == "unknown":
        undecided = [c for c in constraints if c.status == "unknown"]
        limiting = undecided[0] if undecided else None
        reason = "Can't be decided: " + (messages[limiting.id] if limiting else "the data doesn't cover this mission")
    else:
        passing = [c for c in constraints if c.status == "pass" and c.margin is not None]
        limiting = by_margin(passing)[0] if passing else None
        reason = "Meets every requirement" + (f"; closest to its limit: {messages[limiting.id]}" if limiting else "")
    return AtlasCell(landing_utc=_iso(landing), duration_days=days, status=status,
                     limiting=limiting.id if limiting else None, reason=reason, constraints=constraints)


def atlas(req: AtlasRequest) -> AtlasResponse:
    known = next((s for s in ALL_SITES if s["id"] == req.site_id), None)
    if known is None:
        raise HTTPException(404, f"Unknown site '{req.site_id}'")
    site = Site(id=known["id"], name=known["name"], lat=known["lat"], lon=known["lon"])
    full = _series(req.site_id)
    data_start, data_end = full.coverage_start_utc, full.coverage_end_utc
    landings = [req.start_utc + timedelta(hours=req.step_hours * i) for i in range(req.count)]
    window_end = landings[-1] + timedelta(days=max(req.durations_days))
    series = slice_series(full, max(landings[0], data_start), min(window_end, data_end))

    info: dict[str, RequirementInfo] = {}
    cells = [[_cell(req, series, site, t, d, data_start, data_end, info) for t in landings] for d in req.durations_days]
    counts = {k: 0 for k in ("pass", "fail", "unknown", "not_evaluated")}
    for row in cells:
        for c in row:
            counts[c.status] += 1
    return AtlasResponse(
        site_id=req.site_id, site_name=site.name,
        data_start_utc=_iso(data_start), data_stop_utc=_iso(data_end),
        start_utc=_iso(req.start_utc), step_hours=req.step_hours,
        landing_utc=[_iso(t) for t in landings], durations_days=req.durations_days,
        requirements_input=req.requirements, requirements=list(info.values()), cells=cells, counts=counts,
        engine_version=ENGINE_VERSION,
        method=("Each cell is one mission (that landing time, that duration) evaluated by the canonical viability "
                "engine on the site's precomputed JPL Horizons + LOLA data. Only the tested dates and durations are "
                f"shown, every {req.step_hours:g} h from {_iso(req.start_utc)}; nothing is interpolated between them."),
        limitations=[
            "A landing between two tested dates may differ from both: re-run with a smaller interval to look closer.",
            "Curated sites with precomputed data only (no custom pins).",
            "Requirements are hard limits; there is no partial credit or score in this view.",
        ],
    )
