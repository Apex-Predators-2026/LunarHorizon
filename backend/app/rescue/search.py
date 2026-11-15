"""Mission Rescue: when the plan changes, find and explain the best alternatives.

Steps
1. Evaluate the original plan and the changed plan (delay / new duration / new requirements).
2. Search a grid of candidate landing times x candidate locations (the original site, other
   catalog sites, custom points around the original site).
3. Keep the candidates that pass, rank them (viability score minus penalties for moving the
   date or the site, minus a penalty for being fragile), and pick a diverse top N.
4. Explain each one against the changed plan; list the closest failures and the smallest
   requirement relaxations that would make something pass.
"""
from __future__ import annotations

from datetime import timedelta

from ..models import Scenario
from .engine import (Candidate, Evaluator, candidate_sites, candidate_times, classify, diverse_top, is_real, snap_to_grid,
                     SIMULATION_HINT, resolve_simulation, search_grid, site_group)
from .catalog import is_catalog
from .explain import describe_violation, fmt_score, fmt_time, headline_for, metric_deltas, reasons_for, why_fails
from .loosen import loosening_suggestions
from .schemas import Alternative, NearMiss, RescueRequest, RescueResponse, SearchStats
from .sensitivity import quick_robustness

ROBUSTNESS_PENALTY = 15.0  # ranking points lost for an alternative that fails every robustness check

ASSUMPTIONS = [
    "Viability numbers come from the team's viability evaluator; rescue only searches and ranks.",
    "Only landing times inside the search window and the listed candidate locations are considered.",
    "Ranking = viability score + horizon-clearance bonus − date-shift penalty − distance penalty − fragility "
    "penalty (all configurable in SearchOptions).",
    "Requirement relaxations are exact for the evaluated metrics but are not engineering approvals.",
]
REAL_DATA_NOTE = ("Real data: Sun/Earth positions from JPL Horizons and terrain horizons from Moon Trek LOLA, "
                  "precomputed by the data engine (data/sites/).")
SYNTHETIC_WARNING = ("SYNTHETIC DATA: Sun/Earth geometry and terrain horizons are placeholders until the "
                     "Horizons + LOLA data engine is connected. Do not use these numbers for real planning.")


def changed_scenario(req: RescueRequest) -> Scenario:
    o, ch = req.original, req.change
    return Scenario(
        site=o.site,
        landing_utc=snap_to_grid(o.landing_utc + timedelta(days=ch.launch_delay_days)),
        duration_days=ch.new_duration_days or o.duration_days,
        requirements=ch.requirement_overrides.apply(o.requirements),
    )


def clearance_bonus(c: Candidate, per_deg: float) -> float:
    """Small bonus for keeping the Sun and Earth well above the terrain (bigger safety margin)."""
    m = c.result.metrics
    vals = [min(3.0, max(0.0, v)) for v in (m.mean_sun_clearance_deg, m.mean_earth_clearance_deg) if v is not None]
    return per_deg * (sum(vals) / 2 if vals else 0.0)


def _adjustments(c: Candidate, opts) -> float:
    return (clearance_bonus(c, opts.clearance_bonus_per_deg)
            - opts.date_penalty_per_day * abs(c.date_shift_hours) / 24
            - opts.distance_penalty_per_km * c.distance_km)


def _rank_score(c: Candidate, opts) -> float | None:
    """Score plus adjustments, or None for an unscored result (never treated as a score of 0)."""
    return None if c.result.score is None else c.result.score + _adjustments(c, opts)


def _rank_key(c: Candidate, opts, penalty: float = 0.0) -> tuple:
    """Tiers first, then value: real data before synthetic (never ranked together as equals),
    scored before unscored; within the unscored tier only the adjustments order them."""
    rs = _rank_score(c, opts)
    return (is_real(c.result), rs is not None, (rs if rs is not None else _adjustments(c, opts)) - penalty)


def rescue(req: RescueRequest, ev: Evaluator | None = None) -> RescueResponse:
    ev = ev or Evaluator()
    opts = req.search
    sim = resolve_simulation(opts.include_synthetic, ev)
    original = ev.evaluate(req.original, simulation=sim)
    changed_sc = changed_scenario(req)
    changed = ev.evaluate(changed_sc, simulation=sim)

    times = candidate_times(changed_sc.landing_utc, opts)
    sites = candidate_sites(changed_sc.site, opts)
    excluded = 0
    if not sim:  # places with no real data at all can only be UNKNOWN: don't search them
        keep = [(s, c) for s, c in sites if ev.has_real_data(s)]
        excluded = (len(sites) - len(keep)) * len(times)
        sites = keep
    # Without simulation mode, dates the real data doesn't cover come back UNKNOWN (counted as undecided).
    cands = search_grid(ev, changed_sc.site, changed_sc.landing_utc, changed_sc.duration_days,
                        changed_sc.requirements, sites, times, simulation=sim)
    passing = [c for c in cands if c.result.verdict == "pass"]
    failing = [c for c in cands if c.result.verdict == "fail"]
    undecided = [c for c in cands if c.result.verdict == "unknown"]  # missing data: not a real failure
    changed_cand = Candidate(changed_sc, changed, 0.0, 0.0, classify(0, 0), is_catalog(changed_sc.site),
                             site_group(changed_sc.site))

    # Rank: shortlist by score + penalties, then add a robustness penalty and re-rank.
    shortlist = diverse_top(passing, lambda c: _rank_key(c, opts), opts.top_n * 2, opts.min_separation_hours)
    scored = []
    for c in shortlist:
        rob = quick_robustness(c.scenario, ev, sim) if opts.robustness_check else None
        penalty = ROBUSTNESS_PENALTY * (1 - rob.pass_rate) if rob and rob.pass_rate is not None else 0.0
        rs = _rank_score(c, opts)
        scored.append((_rank_key(c, opts, penalty), None if rs is None else rs - penalty, c, rob))
    scored.sort(key=lambda x: x[0], reverse=True)

    alternatives = []
    for rank, (_key, rs, c, rob) in enumerate(scored[: opts.top_n], start=1):
        deltas = metric_deltas(changed, c.result)
        alternatives.append(Alternative(
            rank=rank, kind=c.kind, is_catalog_site=c.is_catalog_site, scenario=c.scenario, viability=c.result,
            rank_score=None if rs is None else round(rs, 2), date_shift_hours=c.date_shift_hours, distance_km=round(c.distance_km, 3),
            improvements=deltas, robustness=rob, headline=headline_for(c, changed), reasons=reasons_for(c, changed, deltas),
        ))

    closeness = lambda c: sum(min(v.relative_shortfall, 10.0) for v in c.result.violations  # noqa: E731
                              if not v.is_unknown)
    near = diverse_top(failing, lambda c: -closeness(c), 5, opts.min_separation_hours)
    near_misses = [NearMiss(kind=c.kind, scenario=c.scenario, viability=c.result, closeness=round(closeness(c), 4),
                            date_shift_hours=c.date_shift_hours, distance_km=round(c.distance_km, 3),
                            why_it_fails=why_fails(c.result)) for c in near]

    loosening = loosening_suggestions(failing, changed_cand)

    unknown_note = (f" {len(undecided)} option(s) could not be checked because data is missing."
                    if undecided else "")
    changed_rob = quick_robustness(changed_sc, ev, sim) if changed.passes and opts.robustness_check else None
    if changed.passes:
        status = "still_viable"
        hr = getattr(changed, "headroom", None)
        if hr is not None and hr.qualified_verdict:
            verdict_phrase = hr.qualified_verdict[0].lower() + hr.qualified_verdict[1:]
        else:
            verdict_phrase = "passes declared requirements"
        summary = (f"The changed plan stays within declared model limits: {changed_sc.site.name} on "
                   f"{fmt_time(changed_sc.landing_utc)} — {verdict_phrase}, score {fmt_score(changed.score)}.")
        if changed_rob and changed_rob.date_note:
            summary += f" {changed_rob.date_note}"
        summary += " Model screening only; not a survival guarantee."
        if (alternatives and alternatives[0].viability.score is not None and changed.score is not None
                and alternatives[0].viability.score > changed.score + 5):
            summary += f" Better option available: {alternatives[0].headline}"
    elif alternatives:
        status = "rescued"
        broken = "; ".join(describe_violation(v).rstrip(".") for v in changed.violations)
        verb = "can't be checked (missing data)" if changed.verdict == "unknown" else "fails"
        summary = f"The changed plan {verb}: {broken}. Best rescue: {alternatives[0].headline}"
    elif changed.verdict == "unknown" and not passing and not failing:
        status = "no_viable_alternative"
        reason = (changed.violations[0].message.removeprefix("UNKNOWN: ").replace(" " + SIMULATION_HINT, "")
                  if changed.violations else "")
        summary = (f"The changed plan can't be checked: {reason} None of the {len(cands)} options searched could be "
                   "checked either (missing data). Try other dates, or turn on simulation mode for a synthetic estimate.")
    else:
        status = "no_viable_alternative"
        summary = (f"No candidate in the search passes all requirements ({len(cands)} checked"
                   + (f"; {excluded} without real data left out" if excluded else "") + "). "
                   + (f"Smallest fix: {loosening[0].message}" if loosening else "Widen the search window or site list.")
                   + unknown_note)

    data_sources = sorted({c.result.data_source for c in cands} | {original.data_source, changed.data_source})
    assumptions = list(ASSUMPTIONS)
    if any(s.startswith("synthetic") for s in data_sources):
        assumptions.insert(0, SYNTHETIC_WARNING)
    else:
        assumptions.insert(0, REAL_DATA_NOTE)
    if excluded:
        assumptions.append(f"{excluded} candidates were left out because there is no real data for them (custom "
                           "nearby points, approximate sites). Simulation mode (include_synthetic=true) would use "
                           "synthetic placeholder data for them.")
    if undecided and not sim:
        assumptions.append(f"{len(undecided)} candidates are UNKNOWN because their mission runs outside the real "
                           "data's time range. They are not counted as failures.")
    if req.change.reason:
        assumptions.append(f"Change reason given: {req.change.reason}")

    return RescueResponse(
        status=status, summary=summary, original=original, changed=changed, changed_robustness=changed_rob,
        alternatives=alternatives, near_misses=near_misses, loosening=loosening,
        stats=SearchStats(candidates_evaluated=len(cands), locations_considered=len(sites), passing=len(passing), undecided=len(undecided),
                          synthetic_candidates_excluded=excluded, date_range_start=times[0], date_range_end=times[-1]),
        data_source=", ".join(data_sources), assumptions=assumptions,
    )
