"""Science vs engineering compromise.

Science wants to be close to a target (usually an icy permanently shadowed region, which
is dark and often out of sight of Earth). Engineering wants sunlight and Earth contact.
We score every candidate on both, find the Pareto front (options where you cannot improve
one side without hurting the other), pick the best weighted option, and when no option
satisfies both sides we say what each side would have to give up.
"""
from __future__ import annotations

from .geo import destination, distance_km
from ..models import Site
from .catalog import PSRS, PSRS_BY_ID, custom_site, nearest_psr_edge_km
from .engine import Candidate, Evaluator, candidate_sites, candidate_times, resolve_simulation, search_grid
from .explain import fmt_time
from .loosen import loosening_suggestions
from .schemas import CompromiseOption, CompromiseRequest, CompromiseResponse, SearchStats
from .search import ASSUMPTIONS, REAL_DATA_NOTE, SYNTHETIC_WARNING


def _target(req: CompromiseRequest) -> tuple[Site | None, float, str]:
    """(target site or None, target radius km, label)."""
    g = req.science
    if g.target_psr_id:
        p = PSRS_BY_ID[g.target_psr_id]
        return Site(id=p.id, name=p.name, lat=p.lat, lon=p.lon), p.radius_km, p.name
    if g.target is not None:
        return g.target, 0.0, g.target.name
    return None, 0.0, "nearest PSR"


def _science_distance(site: Site, target: Site | None, radius: float) -> float:
    if target is None:
        return nearest_psr_edge_km(site.lat, site.lon)[1]
    return max(0.0, distance_km(site.lat, site.lon, target.lat, target.lon) - radius)


def _science_score(d: float, req: CompromiseRequest) -> float:
    return max(0.0, 1.0 - d / req.science.max_traverse_km)


def compromise(req: CompromiseRequest, ev: Evaluator | None = None) -> CompromiseResponse:
    ev = ev or Evaluator()
    sc, opts, g = req.scenario, req.search, req.science
    target, radius, label = _target(req)

    times = candidate_times(sc.landing_utc, opts)
    sites = candidate_sites(sc.site, opts)
    # Add rings of custom points just outside the science target so there are options near it.
    if target is not None:
        seen = {(round(s.lat, 4), round(s.lon, 4)) for s, _ in sites}
        for extra in (1.0, 3.0, 6.0, 10.0):
            for j in range(8):
                b = 45.0 * j
                lat, lon = destination(target.lat, target.lon, b, radius + extra)
                if (round(lat, 4), round(lon, 4)) not in seen:
                    sites.append((custom_site(f"{label} rim +{extra:g} km @ {b:.0f}°", lat, lon), False))

    sim = resolve_simulation(opts.include_synthetic, ev)
    excluded = 0
    if not sim:  # no real data there: could only ever be UNKNOWN
        keep = [(s, c) for s, c in sites if ev.has_real_data(s)]
        excluded = (len(sites) - len(keep)) * len(times)
        sites = keep
    cands = search_grid(ev, sc.site, sc.landing_utc, sc.duration_days, sc.requirements, sites, times, simulation=sim)
    # Undecided (missing data) options can't be weighed against decided ones; count them and leave them out.
    undecided = sum(c.result.verdict == "unknown" for c in cands)
    cands = [c for c in cands if c.result.verdict != "unknown"]

    wsum = req.engineering_weight + req.science_weight

    def option(c: Candidate) -> CompromiseOption:
        d = _science_distance(c.scenario.site, target, radius)
        sci = _science_score(d, req)
        eng = c.result.score_or_zero / 100.0
        meets_e, meets_s = c.result.passes, sci >= g.min_science_score
        combined = (req.engineering_weight * eng + req.science_weight * sci) / wsum
        bits = [f"{c.scenario.site.name} on {fmt_time(c.scenario.landing_utc)}",
                f"{d:.1f} km from {label}",
                "meets engineering" if meets_e else "fails engineering (" +
                ", ".join(v.constraint for v in c.result.violations) + ")",
                "meets science" if meets_s else f"science score {sci:.2f} < {g.min_science_score:.2f}"]
        return CompromiseOption(scenario=c.scenario, viability=c.result, engineering_score=round(eng, 4),
                                science_score=round(sci, 4), combined_score=round(combined, 4), meets_engineering=meets_e,
                                meets_science=meets_s, distance_to_science_km=round(d, 3), pareto_optimal=False,
                                explanation="; ".join(bits) + ".")

    # One option per location (its best date) keeps the front readable.
    by_loc: dict = {}
    for c in cands:
        k = c.key
        best = by_loc.get(k)
        rank = (c.result.passes, c.result.score_or_zero)
        if best is None or rank > (best.result.passes, best.result.score_or_zero):
            by_loc[k] = c
    opts_all = [option(c) for c in by_loc.values()]

    # Pareto front on (engineering, science); passing engineering counts as strictly better.
    def dominated(a: CompromiseOption) -> bool:
        ka = (a.meets_engineering, a.engineering_score, a.science_score)
        for b in opts_all:
            if b is a:
                continue
            kb = (b.meets_engineering, b.engineering_score, b.science_score)
            if all(x >= y for x, y in zip(kb, ka)) and kb != ka:
                return True
        return False

    front = []
    for o in opts_all:
        if not dominated(o):
            o.pareto_optimal = True
            front.append(o)
    front.sort(key=lambda o: -o.combined_score)

    both = [o for o in opts_all if o.meets_engineering and o.meets_science]
    eng_ok = [o for o in opts_all if o.meets_engineering]
    best_e = max(eng_ok or opts_all, key=lambda o: (o.engineering_score, o.science_score), default=None)
    best_s = max(opts_all, key=lambda o: (o.science_score, o.engineering_score), default=None)

    suggestions: list[str] = []
    loosening = []
    if both:
        status = "both_met"
        best = max(both, key=lambda o: o.combined_score)
        summary = (f"Both teams can be satisfied: {best.explanation} "
                   f"({len(both)} location(s) meet both goals.)")
    else:
        status = "tradeoff_required"
        best = max(opts_all, key=lambda o: o.combined_score, default=None)
        summary = "No option meets both the engineering requirements and the science goal."
        if eng_ok:
            closest = max(eng_ok, key=lambda o: o.science_score)
            suggestions.append(
                f"Science could accept {closest.scenario.site.name} ({closest.distance_to_science_km:.1f} km from "
                f"{label}): lower the science minimum to {closest.science_score:.2f} or allow a "
                f"{closest.distance_to_science_km:.0f} km traverse (currently {g.max_traverse_km:.0f} km).")
        else:
            suggestions.append("No location passes the engineering requirements at all in this window — "
                               "widen the date window or relax engineering requirements first.")
        sci_ok_keys = {k for k, c in by_loc.items()
                       if _science_score(_science_distance(c.scenario.site, target, radius), req) >= g.min_science_score}
        loosening = loosening_suggestions([c for c in cands if c.key in sci_ok_keys and not c.result.passes], None, n=3)
        if loosening:
            suggestions.append("Or engineering could relax: " + loosening[0].message)
        if not sci_ok_keys:
            suggestions.append(f"No candidate is within {g.max_traverse_km:.0f} km of {label}; add sites near it.")

    data_sources = sorted({c.result.data_source for c in cands})
    assumptions = ["Science score = 1 − distance to the target ÷ max traverse distance (0 beyond it).",
                   "Each location is shown at its best date in the window."] + ASSUMPTIONS[1:]
    if any(s.startswith("synthetic") for s in data_sources):
        assumptions.insert(0, SYNTHETIC_WARNING)
    elif data_sources:
        assumptions.insert(0, REAL_DATA_NOTE)
    if excluded:
        assumptions.append(f"{excluded} candidates were left out because there is no real data for them (e.g. points "
                           "around the science target). Simulation mode (include_synthetic=true) would use synthetic "
                           "placeholder data for them.")
    if undecided:
        assumptions.append(f"{undecided} candidates are UNKNOWN (mission outside the real data's time range) and "
                           "were left out of the trade-off.")
    if target is None:
        assumptions.append(f"No science target given; using distance to the nearest of {len(PSRS)} catalog PSRs.")

    return CompromiseResponse(
        status=status, summary=summary, best=best, best_for_engineering=best_e, best_for_science=best_s,
        pareto_front=front[:10], suggestions=suggestions, loosening=loosening,
        stats=SearchStats(candidates_evaluated=len(cands), locations_considered=len(sites),
                          passing=sum(c.result.passes for c in cands), synthetic_candidates_excluded=excluded,
                          undecided=undecided,
                          date_range_start=times[0], date_range_end=times[-1]),
        data_source=", ".join(data_sources), assumptions=assumptions,
    )

