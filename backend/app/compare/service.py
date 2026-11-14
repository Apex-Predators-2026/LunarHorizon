"""Comparison statistics for one or more scenarios.

Inputs come from other members' modules and are only read here:
  - timelines: the data engine's site records (app/store.py) — JPL Horizons + LOLA
  - viability: app/rescue/viability.evaluate_timeline (the team's swap point for Brandon's evaluator)
  - PSR distances: app/rescue/catalog (approximate PSR centres/radii)
"""
from __future__ import annotations

import math
from datetime import timedelta

import numpy as np

from .. import store
from ..models import Scenario
from ..rescue.catalog import SITES_BY_ID, nearest_psr_edge_km
from ..rescue.timeline import SyntheticTimelineProvider, Timeline
from ..rescue.timeline.base import to_np_utc
from ..rescue.viability import evaluate_timeline
from .schemas import (CompareRequest, CompareResponse, CompareResult, CompareScenarioIn, EarthStats, MissionEvent,
                      PowerStats, ScienceContext, SiteContext, SolarStats, SpacecraftConfig, TimelineColumns, Window)

POWER_MODEL = ("Idealised direct-beam incidence: factor = visible solar-disk fraction × max(0, cos θ), θ = angle "
               "between the Sun direction and the panel normal. Ignores cell efficiency, temperature, degradation, "
               "dust, wiring and pointing losses, so it is an upper bound, not electrical output.")
NOTES = [
    "Real data = Sun/Earth azimuth-elevation from JPL Horizons and terrain horizons from Moon Trek LOLA DEMs, "
    "precomputed by the data engine (data/sites/). Statistics are hourly samples over the mission.",
    "Sunlit = any part of the solar disk above the local terrain horizon. Earth visible = Earth's centre above "
    "the terrain horizon. This is geometric line of sight only; it does not guarantee a working radio link "
    "(antenna pointing, ground-station schedules and link budget are not modelled).",
    "Viability (pass/fail, score, violations) comes from the team's viability evaluator; the comparison "
    "system only displays and sorts it.",
]
DEMO_NOTE = ("DEMONSTRATION DATA: scenarios marked 'demonstration' use the synthetic placeholder timeline (approximate "
             "Sun/Earth motion, invented terrain horizon). They are for illustrating the tool only and must not be "
             "used for planning or compared as if they were real.")

_synthetic = SyntheticTimelineProvider()


# ---------------------------------------------------------------- timelines

def _site_record(site_id: str):
    try:
        return store.get_site(site_id)
    except Exception:  # unreadable file: treat as missing data
        return None


def real_timeline(scenario: Scenario) -> Timeline | None:
    """Mission slice of the data engine's record, or None if the site/dates are not covered."""
    d = _site_record(scenario.site.id)
    if d is None or len(d.times) < 2:
        return None
    step_h = float((d.times[1] - d.times[0]).astype("timedelta64[s]").astype(np.int64)) / 3600.0
    n = max(1, int(round(scenario.duration_days * 24 / step_h)))
    i = int(np.searchsorted(d.times, to_np_utc(scenario.landing_utc)))
    if to_np_utc(scenario.landing_utc) < d.times[0] or i + n > len(d.times):
        return None
    c, s = d.cols, slice(i, i + n)
    return Timeline(
        site=scenario.site, times=d.times[s], step_hours=step_h,
        sun_az=np.asarray(c["sun_azimuth_deg"][s], float), sun_el=np.asarray(c["sun_elevation_deg"][s], float),
        sun_horizon=np.asarray(c["sun_horizon_deg"][s], float),
        sun_visible_fraction=np.asarray(c["sun_visible_fraction"][s], float),
        earth_az=np.asarray(c["earth_azimuth_deg"][s], float), earth_el=np.asarray(c["earth_elevation_deg"][s], float),
        earth_horizon=np.asarray(c["earth_horizon_deg"][s], float),
        earth_visible=np.asarray(c["earth_visible"][s], bool),
        source=f"precomputed:{scenario.site.id}.json",
    )


def demo_timeline(scenario: Scenario) -> Timeline:
    n = max(1, int(round(scenario.duration_days * 24)))
    start = scenario.landing_utc
    tl = _synthetic.timeline(scenario.site, start, start + timedelta(hours=n - 1), 1.0)
    return tl.slice(0, n)


def data_coverage(scenario: Scenario) -> str:
    d = _site_record(scenario.site.id)
    if d is None:
        return (f"No precomputed Horizons + LOLA data exists for '{scenario.site.name}'. Only the curated sites "
                "(and custom sites created through /api/sites/custom) have real data.")
    return (f"Real data for {scenario.site.name} covers {_iso(d.times[0])} to {_iso(d.times[-1])}; this mission "
            f"({_iso(to_np_utc(scenario.landing_utc))} + {scenario.duration_days:g} days) falls outside it.")


# ---------------------------------------------------------------- statistics

def runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """[start, stop) index pairs of every run of True values."""
    if mask.size == 0:
        return []
    m = np.concatenate(([False], mask.astype(bool), [False])).astype(np.int8)
    d = np.diff(m)
    return list(zip(np.flatnonzero(d == 1).tolist(), np.flatnonzero(d == -1).tolist()))


def _iso(t: np.datetime64) -> str:
    return str(np.datetime64(t, "m")) + "Z"


def windows(mask: np.ndarray, tl: Timeline) -> list[Window]:
    step, n = tl.step_hours, len(tl)
    out = []
    for a, b in runs(mask):
        end_t = tl.times[a] + np.timedelta64(int(round((b - a) * step * 3600)), "s")
        out.append(Window(start_hour=a * step, end_hour=b * step, duration_hours=(b - a) * step,
                          start_utc=_iso(tl.times[a]), end_utc=_iso(end_t), open_start=a == 0, open_end=b == n))
    return out


def events(tl: Timeline) -> list[MissionEvent]:
    out: list[MissionEvent] = []
    for mask, up, down in ((tl.sun_visible_fraction > 0, "sunrise", "sunset"),
                           (tl.earth_visible.astype(bool), "earthrise", "earthset")):
        for k in np.flatnonzero(mask[1:] != mask[:-1]) + 1:
            out.append(MissionEvent(type=up if mask[k] else down, hour=float(k * tl.step_hours),
                                    time_utc=_iso(tl.times[k])))
    return sorted(out, key=lambda e: e.hour)


def incidence_factor(tl: Timeline, cfg: SpacecraftConfig) -> np.ndarray:
    el, az = np.radians(tl.sun_el), np.radians(tl.sun_az)
    if cfg.panel_mode == "two_axis":
        cos = np.ones_like(el)
    elif cfg.panel_mode == "horizontal":
        cos = np.sin(el)
    elif cfg.panel_mode == "vertical_fixed":
        cos = np.cos(el) * np.cos(az - math.radians(cfg.panel_azimuth_deg))
    else:  # vertical_sun_tracking
        cos = np.cos(el)
    return np.clip(tl.sun_visible_fraction, 0, 1) * np.clip(cos, 0, None)


def _mean(a: np.ndarray) -> float | None:
    return float(a.mean()) if a.size else None


def _min(a: np.ndarray) -> float | None:
    return float(a.min()) if a.size else None


def solar_stats(tl: Timeline, sun_w: list[Window], dark_w: list[Window]) -> SolarStats:
    lit = tl.sun_visible_fraction > 0
    return SolarStats(
        sunlit_hours=float(lit.sum() * tl.step_hours), sunlit_fraction=float(lit.mean()),
        mean_visible_fraction=float(tl.sun_visible_fraction.mean()),
        equivalent_full_sun_hours=float(tl.sun_visible_fraction.sum() * tl.step_hours),
        mean_elevation_deg=float(tl.sun_el.mean()), mean_elevation_lit_deg=_mean(tl.sun_el[lit]),
        max_elevation_deg=float(tl.sun_el.max()), min_elevation_lit_deg=_min(tl.sun_el[lit]),
        mean_clearance_lit_deg=_mean((tl.sun_el - tl.sun_horizon)[lit]),
        longest_dark_hours=max((w.duration_hours for w in dark_w), default=0.0), windows_count=len(sun_w),
    )


def earth_stats(tl: Timeline, vis_w: list[Window], black_w: list[Window]) -> EarthStats:
    vis = tl.earth_visible.astype(bool)
    margin = tl.earth_el - tl.earth_horizon
    return EarthStats(
        visible_hours=float(vis.sum() * tl.step_hours), visible_fraction=float(vis.mean()),
        longest_blackout_hours=max((w.duration_hours for w in black_w), default=0.0), windows_count=len(vis_w),
        mean_elevation_visible_deg=_mean(tl.earth_el[vis]), min_elevation_visible_deg=_min(tl.earth_el[vis]),
        mean_margin_visible_deg=_mean(margin[vis]), min_margin_visible_deg=_min(margin[vis]),
    )


def power_stats(tl: Timeline, f: np.ndarray, cfg: SpacecraftConfig) -> PowerStats:
    hours = len(tl) * tl.step_hours
    eq_hours = float(f.sum() * tl.step_hours)
    rated, load = cfg.panel_rated_power_w, cfg.average_load_w
    energy = rated * eq_hours if rated else None
    load_e = load * hours if load else None
    return PowerStats(
        panel_mode=cfg.panel_mode, mean_incidence_factor=float(f.mean()), max_incidence_factor=float(f.max()),
        equivalent_full_power_hours=eq_hours,
        idealized_mean_power_w=rated * float(f.mean()) if rated else None,
        idealized_energy_wh=energy, load_energy_wh=load_e,
        idealized_energy_to_load_ratio=energy / load_e if energy is not None and load_e else None,
        battery_endurance_hours=cfg.battery_capacity_wh / load if cfg.battery_capacity_wh and load else None,
        model=POWER_MODEL,
    )


def columns(tl: Timeline, f: np.ndarray, max_points: int) -> TimelineColumns:
    stride = max(1, math.ceil(len(tl) / max_points))
    idx = np.arange(0, len(tl), stride)
    r = lambda a: [round(float(v), 3) for v in a[idx]]  # noqa: E731
    return TimelineColumns(
        step_hours=tl.step_hours * stride, hour=[float(i * tl.step_hours) for i in idx],
        time_utc=[_iso(tl.times[i]) for i in idx],
        sun_elevation_deg=r(tl.sun_el), sun_azimuth_deg=r(tl.sun_az), sun_horizon_deg=r(tl.sun_horizon),
        sun_visible_fraction=r(tl.sun_visible_fraction),
        earth_elevation_deg=r(tl.earth_el), earth_azimuth_deg=r(tl.earth_az), earth_horizon_deg=r(tl.earth_horizon),
        earth_visible=[bool(v) for v in tl.earth_visible[idx]], incidence_factor=r(f),
    )


def site_context(scenario: Scenario) -> SiteContext:
    d = _site_record(scenario.site.id)
    if d is not None:
        s, summ = d.site, d.record.get("summary", {})
        return SiteContext(ground_height_m=s.get("ground_height_m"), observer_height_m=s.get("observer_height_m"),
                           horizon_min_deg=summ.get("horizon_min_deg"), horizon_max_deg=summ.get("horizon_max_deg"),
                           coordinate_source=s.get("source", ""))
    cat = SITES_BY_ID.get(scenario.site.id)
    src = (cat.source or cat.description) + (" (approximate coordinates)" if cat.approximate else "") if cat else \
        "User-entered or generated coordinates"
    return SiteContext(ground_height_m=None, observer_height_m=None, horizon_min_deg=None, horizon_max_deg=None,
                       coordinate_source=src)


def science_context(scenario: Scenario) -> ScienceContext:
    psr, d = nearest_psr_edge_km(scenario.site.lat, scenario.site.lon)
    return ScienceContext(
        nearest_psr_id=psr.id, nearest_psr_name=psr.name, distance_to_psr_edge_km=round(d, 3),
        ice_interest=psr.ice_interest,
        source="Mission Rescue PSR catalog (app/rescue/catalog.py): approximate PSR centres and radii; "
               "ice_interest is a rough demonstration value, not a measurement.",
    )


# ---------------------------------------------------------------- entry points

def evaluate_one(item: CompareScenarioIn, allow_demo: bool, max_points: int) -> CompareResult:
    sc = item.scenario
    tl = real_timeline(sc)
    kind = "real"
    if tl is None:
        if not allow_demo:
            return CompareResult(key=item.key, status="unavailable", data_kind="unavailable", data_source="none",
                                 message=data_coverage(sc) + " Enable demonstration data to see a synthetic "
                                                             "illustration instead.",
                                 site_context=site_context(sc), science_context=science_context(sc))
        tl, kind = demo_timeline(sc), "demonstration"

    lit, vis = tl.sun_visible_fraction > 0, tl.earth_visible.astype(bool)
    sun_w, dark_w, earth_w, black_w = windows(lit, tl), windows(~lit, tl), windows(vis, tl), windows(~vis, tl)
    f = incidence_factor(tl, item.spacecraft)
    return CompareResult(
        key=item.key, status="ok", data_kind=kind, data_source=tl.source,
        message=DEMO_NOTE if kind == "demonstration" else None,
        site_context=site_context(sc), science_context=science_context(sc),
        viability=evaluate_timeline(sc, tl),
        solar=solar_stats(tl, sun_w, dark_w), earth=earth_stats(tl, earth_w, black_w),
        power=power_stats(tl, f, item.spacecraft),
        sun_windows=sun_w, dark_windows=dark_w, earth_windows=earth_w, blackout_windows=black_w,
        events=events(tl), timeline=columns(tl, f, max_points),
    )


def compare(req: CompareRequest) -> CompareResponse:
    results = [evaluate_one(s, req.allow_demo_data, req.max_points) for s in req.scenarios]
    sources = sorted({r.viability.source for r in results if r.viability})
    notes = list(NOTES)
    if any(r.data_kind == "demonstration" for r in results):
        notes.insert(0, DEMO_NOTE)
    return CompareResponse(results=results, viability_source=", ".join(sources) or "n/a", notes=notes)

