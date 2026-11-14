"""Evaluates many (site, landing time) candidates quickly.

For each location we fetch ONE timeline that covers every candidate landing time plus the
mission duration, then slice it per candidate. That keeps a 30-day x 20-location search
well under a second with the synthetic provider.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable

import numpy as np

from .geo import destination, distance_km
from ..models import MissionRequirements, Scenario, Site, ViabilityMetrics, ViabilityResult, Violation
from .catalog import SITES, custom_site, get_site, is_catalog, nearest_catalog_site
from .timeline import Timeline, TimelineProvider, default_provider
from .viability import evaluate_timeline as default_evaluate
from .schemas import AltKind, SearchOptions

TIMELINE_STEP_HOURS = 1.0

EvaluateFn = Callable[[Scenario, Timeline], ViabilityResult]


@dataclass
class Candidate:
    scenario: Scenario
    result: ViabilityResult
    date_shift_hours: float  # vs the reference (changed) landing time
    distance_km: float  # vs the reference site
    kind: AltKind
    is_catalog_site: bool
    group: str = ""  # nearest catalog site id; candidates in the same group are near-duplicates

    @property
    def key(self) -> tuple[float, float]:
        s = self.scenario.site
        return round(s.lat, 4), round(s.lon, 4)


NO_DATA_SOURCE = "no-real-data"
SIMULATION_HINT = "Turn on simulation mode to use synthetic placeholder data instead (not real)."


def is_real(res: ViabilityResult) -> bool:
    """True if the result was computed from real (precomputed Horizons + LOLA) data."""
    return res.data_source.startswith("precomputed")


def resolve_simulation(include_synthetic: bool | None, ev: "Evaluator") -> bool:
    """Simulation mode (synthetic placeholder data allowed) only when deliberately selected:
    the request's include_synthetic, or the evaluator's own default when the request leaves it unset."""
    return ev.simulation if include_synthetic is None else include_synthetic


def _np(t: datetime) -> np.datetime64:
    return np.datetime64(_utc(t).replace(tzinfo=None), "s")


def _fmt_day(t: np.datetime64) -> str:
    return str(t.astype("datetime64[D]"))


def no_data_result(site: Site, t: datetime, duration_days: float, req: MissionRequirements,
                   coverage: tuple[np.datetime64, np.datetime64] | None) -> ViabilityResult:
    """UNKNOWN result for a mission that real data does not fully cover.

    Metrics are reported at their worst-case bounds (no sunlight or Earth contact proven, outages
    as long as the mission), the same convention as the canonical engine's compatibility layer.
    """
    hours = duration_days * 24.0
    start, end = _np(t), _np(t) + np.timedelta64(int(round(hours * 3600)), "s")
    if coverage is None:
        covered = 0.0
        msg = (f"UNKNOWN: no real Horizons + LOLA data exists for {site.name}, so this plan can't be checked. "
               + SIMULATION_HINT)
    else:
        first, last_end = coverage  # real data ends at the last sample (no extra hour after it)
        lo, hi = max(start, first), min(end, last_end)
        covered = max(0.0, float((hi - lo).astype("timedelta64[s]").astype(np.int64)) / 3600.0)
        msg = (f"UNKNOWN: real data for {site.name} covers {_fmt_day(first)} to {_fmt_day(last_end)}, but this "
               f"mission runs {_fmt_day(start)} to {_fmt_day(end)}, so it can't be fully checked. " + SIMULATION_HINT)
    short = max(0.0, hours - covered)
    metrics = ViabilityMetrics(
        sunlight_fraction=0.0, equivalent_sun_hours=0.0, longest_dark_gap_hours=hours,
        earth_visibility_fraction=0.0, longest_comms_gap_hours=hours, initial_sun_hours=0.0,
        initial_comms_hours=0.0, hours_to_first_sunset=None, hours_to_first_earthset=None,
        mean_sun_clearance_deg=None, mean_earth_clearance_deg=None, mean_solar_elevation_deg=0.0,
    )
    return ViabilityResult(
        scenario=Scenario(site=site, landing_utc=t, duration_days=duration_days, requirements=req),
        passes=False, eligibility="unknown", score=None, metrics=metrics,
        violations=[Violation(constraint="data_coverage", required=hours, actual=covered, unit="h", shortfall=short,
                              relative_shortfall=short / hours if hours else 1.0, message=msg, is_unknown=True)],
        source="rescue-coverage-check", data_source=NO_DATA_SOURCE,
    )


class Evaluator:
    """Evaluates scenarios on real data. `simulation=True` makes synthetic placeholder data the
    default fallback (used by unit tests); each call can still override it."""

    def __init__(self, provider: TimelineProvider | None = None, evaluate: EvaluateFn | None = None,
                 simulation: bool = False):
        self.provider = provider or default_provider()
        self.evaluate_fn = evaluate or default_evaluate
        self.simulation = simulation
        self.evaluations = 0

    def coverage(self, site: Site) -> tuple[np.datetime64, np.datetime64] | None:
        cov = getattr(self.provider, "coverage", None)
        return cov(site) if cov else None

    def has_real_data(self, site: Site, start: datetime | None = None, end: datetime | None = None) -> bool:
        check = getattr(self.provider, "has_data", None)
        return bool(check and check(site, start, end))

    def evaluate(self, scenario: Scenario, simulation: bool | None = None) -> ViabilityResult:
        return self.evaluate_many(scenario.site, [scenario.landing_utc], scenario.duration_days,
                                  scenario.requirements, simulation=simulation)[0]

    def evaluate_many(self, site: Site, starts: list[datetime], duration_days: float,
                      req: MissionRequirements, simulation: bool | None = None) -> list[ViabilityResult]:
        if not starts:
            return []
        sim = self.simulation if simulation is None else simulation
        step = TIMELINE_STEP_HOURS
        n = max(1, int(round(duration_days * 24 / step)))
        span = timedelta(hours=(n - 1) * step)  # first to last sample of the mission
        end = timedelta(hours=n * step)  # the mission's end

        # Covered = the whole mission lies inside the real data: it starts at or after the first
        # sample and ends by the last one. The last sample is an instant, not one more hour of data
        # (same rule as the canonical engine).
        cov = self.coverage(site)
        covered = [] if cov is None else [k for k, t in enumerate(starts)
                                          if cov[0] <= _np(t) and _np(t + end) <= cov[1]]
        groups = [covered]
        if sim:  # simulation mode: the rest goes to the synthetic fallback, in its own fetch so it
            in_cov = set(covered)  # can't turn the covered starts synthetic too
            groups.append([k for k in range(len(starts)) if k not in in_cov])

        results: dict[int, ViabilityResult] = {}
        for group in groups:
            if not group:
                continue
            tl = self.provider.timeline(site, min(starts[k] for k in group), max(starts[k] for k in group) + span, step)
            for k in group:
                t = starts[k]
                i = tl.index_of(t)
                scen = Scenario(site=site, landing_utc=t, duration_days=duration_days, requirements=req)
                results[k] = self.evaluate_fn(scen, tl.slice(i, i + n))
                self.evaluations += 1
        return [results[k] if k in results else no_data_result(site, t, duration_days, req, cov)
                for k, t in enumerate(starts)]


def _utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def candidate_times(earliest: datetime, opts: SearchOptions) -> list[datetime]:
    earliest = _utc(earliest)
    lo = -opts.earlier_window_days * 24 if opts.allow_earlier_dates else 0.0
    hi = opts.date_window_days * 24
    offsets = np.arange(lo, hi + 1e-9, opts.date_step_hours)
    if 0.0 not in offsets:
        offsets = np.sort(np.append(offsets, 0.0))
    return [earliest + timedelta(hours=float(h)) for h in offsets]


def candidate_sites(origin: Site, opts: SearchOptions) -> list[tuple[Site, bool]]:
    """(site, is_catalog_site) pairs to search, always starting with the origin itself."""
    out: list[tuple[Site, bool]] = [(origin, is_catalog(origin))]
    seen = {(round(origin.lat, 4), round(origin.lon, 4))}
    ids = opts.candidate_site_ids if opts.candidate_site_ids is not None else [s.id for s in SITES]
    for sid in ids:
        cs = get_site(sid)
        k = (round(cs.lat, 4), round(cs.lon, 4))
        if k in seen:
            continue
        if opts.max_site_distance_km is not None and \
                distance_km(origin.lat, origin.lon, cs.lat, cs.lon) > opts.max_site_distance_km:
            continue
        seen.add(k)
        out.append((cs.to_site(), True))
    if opts.include_nearby_points:
        for r in opts.nearby_radii_km:
            for j in range(opts.nearby_bearings):
                b = 360.0 * j / opts.nearby_bearings
                lat, lon = destination(origin.lat, origin.lon, b, r)
                k = (round(lat, 4), round(lon, 4))
                if k in seen:
                    continue
                seen.add(k)
                out.append((custom_site(f"{origin.name} +{r:g} km @ {b:.0f}°", lat, lon), False))
    return out


def classify(shift_h: float, dist_km: float) -> AltKind:
    moved, shifted = dist_km > 0.01, abs(shift_h) >= 0.5
    if moved and shifted:
        return "site_and_date"
    if moved:
        return "site_change"
    if shifted:
        return "date_shift"
    return "unchanged"


def search_grid(ev: Evaluator, ref_site: Site, ref_time: datetime, duration_days: float,
                req: MissionRequirements, sites: list[tuple[Site, bool]],
                times: list[datetime], simulation: bool | None = None) -> list[Candidate]:
    ref_time = _utc(ref_time)
    out = []
    for site, is_catalog in sites:
        dist = distance_km(ref_site.lat, ref_site.lon, site.lat, site.lon)
        group = site_group(site)
        for t, res in zip(times, ev.evaluate_many(site, times, duration_days, req, simulation=simulation)):
            shift = (t - ref_time).total_seconds() / 3600.0
            out.append(Candidate(res.scenario, res, shift, dist, classify(shift, dist), is_catalog, group))
    return out


def site_group(site: Site) -> str:
    """Catalog site id, or the nearest catalog site for custom points (so they group together)."""
    return site.id if is_catalog(site) else nearest_catalog_site(site.lat, site.lon)[0].id


def diverse_top(cands: list[Candidate], key: Callable[[Candidate], float], n: int,
                min_separation_hours: float) -> list[Candidate]:
    """Best-first selection that skips near-duplicates: same site group and close in time."""
    chosen: list[Candidate] = []
    for c in sorted(cands, key=key, reverse=True):
        if any(c.group == o.group and abs(c.date_shift_hours - o.date_shift_hours) < min_separation_hours
               for o in chosen):
            continue
        chosen.append(c)
        if len(chosen) >= n:
            break
    return chosen
