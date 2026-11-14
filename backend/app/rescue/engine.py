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
from ..models import MissionRequirements, Scenario, Site, ViabilityResult
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


def is_real(res: ViabilityResult) -> bool:
    """True if the result was computed from real (precomputed Horizons + LOLA) data."""
    return res.data_source.startswith("precomputed")


def use_real_only(include_synthetic: bool | None, base: ViabilityResult) -> bool:
    """Policy shared by rescue, sensitivity and compromise: never rank real against synthetic
    data unless asked to. None (auto) = real-only whenever the plan itself has real data."""
    return include_synthetic is False or (include_synthetic is None and is_real(base))


class Evaluator:
    def __init__(self, provider: TimelineProvider | None = None, evaluate: EvaluateFn | None = None):
        self.provider = provider or default_provider()
        self.evaluate_fn = evaluate or default_evaluate
        self.evaluations = 0

    def has_real_data(self, site: Site, start: datetime | None = None, end: datetime | None = None) -> bool:
        check = getattr(self.provider, "has_data", None)
        return bool(check and check(site, start, end))

    def evaluate(self, scenario: Scenario) -> ViabilityResult:
        return self.evaluate_many(scenario.site, [scenario.landing_utc], scenario.duration_days, scenario.requirements)[0]

    def evaluate_many(self, site: Site, starts: list[datetime], duration_days: float,
                      req: MissionRequirements) -> list[ViabilityResult]:
        if not starts:
            return []
        step = TIMELINE_STEP_HOURS
        n = max(1, int(round(duration_days * 24 / step)))
        first, last = min(starts), max(starts)
        tl = self.provider.timeline(site, first, last + timedelta(hours=(n - 1) * step), step)
        out = []
        for t in starts:
            i = tl.index_of(t)
            scen = Scenario(site=site, landing_utc=t, duration_days=duration_days, requirements=req)
            out.append(self.evaluate_fn(scen, tl.slice(i, i + n)))
            self.evaluations += 1
        return out


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
                times: list[datetime]) -> list[Candidate]:
    ref_time = _utc(ref_time)
    out = []
    for site, is_catalog in sites:
        dist = distance_km(ref_site.lat, ref_site.lon, site.lat, site.lon)
        group = site_group(site)
        for t, res in zip(times, ev.evaluate_many(site, times, duration_days, req)):
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
