"""Comparison statistics for one or more scenarios.

Inputs come from other members' modules and are only read here:
  - timelines: the data engine's site records (app/store.py) - JPL Horizons + LOLA
  - viability: app/viability/compat/rescue.evaluate_timeline_detailed (Member 2's canonical engine, the same
    adapter Rescue uses) for the shared ViabilityResult plus the full canonical assessment
  - ranking: app/viability/ranking via compare/ranking.py (only eligible PASS scenarios are ranked)
  - PSR distances: app/rescue/catalog (approximate PSR centres/radii)
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime
from itertools import pairwise

import numpy as np

from .. import store
from ..mission_time import covers, iso_z, mission_bounds, np_us, sample_range
from ..models import Scenario
from ..timegrid import POLICY as TIME_POLICY
from ..timegrid import snap_duration_days, snap_time, time_note
from ..rescue.catalog import SITES_BY_ID, nearest_psr_edge_km
from ..rescue.timeline import SyntheticTimelineProvider, Timeline
from ..viability.compat.rescue import RescueCompatError, evaluate_timeline_detailed, timeline_to_series
from ..viability.outputs import ViabilityAssessment
from ..viability.windows import build_range_timeline, prepare_series
from .evidence import assessment_info, unassessed_ranking
from .ranking import Assessed, pairwise_evidence, rank_comparison
from .schemas import (
    CompareRequest,
    CompareResponse,
    CompareResult,
    CompareScenarioIn,
    EarthStats,
    MissionEvent,
    PowerStats,
    ScienceContext,
    SiteContext,
    SolarStats,
    SpacecraftConfig,
    TimelineColumns,
    Window,
)

POWER_MODEL = ("Idealised direct-beam incidence: factor = visible solar-disk fraction × max(0, cos θ), θ = angle "
               "between the Sun direction and the panel normal. Ignores cell efficiency, temperature, degradation, "
               "dust, wiring and pointing losses, so it is an upper bound, not electrical output.")
NOTES = [
    "Real data = Sun/Earth azimuth-elevation from JPL Horizons and terrain horizons from Moon Trek LOLA DEMs, "
    "precomputed by the data engine (data/sites/). Every tool evaluates a mission on the hourly data grid (landing "
    "rounded to the nearest whole UTC hour, length to whole hours; each result says when that moved the request). Each "
    "hourly sample holds until the next one (sample-and-hold), and durations, shares and means are weighted by the "
    "time each sample represents. Shares are of the whole mission unless marked "
    "as over known time.",
    "Sunlit = any part of the solar disk above the local terrain horizon. Earth visible = Earth's centre above "
    "the terrain horizon. This is geometric line of sight only; it does not guarantee a working radio link "
    "(antenna pointing, ground-station schedules and link budget are not modelled).",
    "Viability (PASS / FAIL / UNKNOWN, score, violations) and the ranking come from the team's canonical viability "
    "engine. Only PASS scenarios are ranked, and only against scenarios with the same data basis, requirements and "
    "mission duration. A missing score is never treated as 0.",
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
    """The samples of the data engine's record that represent the (grid-placed) mission interval: from the sample at
    or before landing to the last one before the end. None if the site has no data or the mission starts outside it.

    A mission that starts inside the data but runs past its end gets the samples that exist (one policy with Rescue
    and the Atlas, app.timegrid): the canonical engine judges it on those real hours and bounds the missing ones. It
    gives a verdict only where that evidence proves it (usually a fail; a pass only when even the worst case for the
    missing hours still passes) and otherwise reports unknown."""
    d = _site_record(scenario.site.id)
    if d is None or len(d.times) < 2:
        return None
    step_h = float((d.times[1] - d.times[0]).astype("timedelta64[s]").astype(np.int64)) / 3600.0
    start, end = mission_bounds(scenario.landing_utc, scenario.duration_days)
    if np_us(start) < d.times[0] or np_us(start) >= d.times[-1]:
        return None
    if covers(d.times, start, end):
        i, j = sample_range(d.times, start, end)
    else:  # runs past the end of the data: every real sample from landing on
        i, j = sample_range(d.times, start, end=_utc_of(d.times[-1]))[0], len(d.times)
    c, s = d.cols, slice(i, j)
    sun_frac = np.asarray(c["sun_visible_fraction"][s], float).copy()
    earth_horizon = np.asarray(c["earth_horizon_deg"][s], float).copy()
    # Unknown flags (null in the file) must stay unknown: rescue's Timeline encodes that as NaN, which the
    # canonical adapter reads as "unknown", never as dark or blocked.
    known = getattr(d, "known", {})
    sun_flag = None
    if "sun_visible" in known:
        sun_known = np.asarray(known["sun_visible"][s], bool)
        sun_frac[~sun_known] = np.nan
        # The file's authoritative any-disk flag: a sliver written as fraction 0.0 is still visible.
        sun_flag = np.where(sun_known, np.asarray(c["sun_visible"][s], bool).astype(float), np.nan)
    if "earth_visible" in known:
        earth_horizon[~np.asarray(known["earth_visible"][s], bool)] = np.nan
    return Timeline(
        site=scenario.site, times=d.times[s], step_hours=step_h,
        sun_az=np.asarray(c["sun_azimuth_deg"][s], float), sun_el=np.asarray(c["sun_elevation_deg"][s], float),
        sun_horizon=np.asarray(c["sun_horizon_deg"][s], float),
        sun_visible_fraction=sun_frac,
        earth_az=np.asarray(c["earth_azimuth_deg"][s], float), earth_el=np.asarray(c["earth_elevation_deg"][s], float),
        earth_horizon=earth_horizon,
        earth_visible=np.asarray(c["earth_visible"][s], bool),
        source=f"precomputed:{_source_path(scenario.site.id)}", sun_visible=sun_flag,
    )


def _utc_of(t: np.datetime64) -> datetime:
    return datetime.fromisoformat(str(np.datetime64(t, "us"))).replace(tzinfo=UTC)


def _dataset_identity(site_id: str) -> tuple[str | None, str | None]:
    """The real site file a result was computed from and its SHA-256 (cached by size and mtime, so a changed file is
    hashed again). (None, None) when there is no file."""
    from ..viability.api.service import _file_sha256

    path = store._site_files().get(site_id)
    if path is None or not path.is_file():
        return None, None
    st = path.stat()
    return _source_path(site_id), _file_sha256(str(path), st.st_size, st.st_mtime_ns)


def _source_path(site_id: str) -> str:
    """File path relative to data/sites, so the canonical adapter can read the file's coverage and precision
    (custom sites are stored under data/sites/custom/)."""
    path = store._site_files().get(site_id)
    if path is None:
        return f"{site_id}.json"
    try:
        return path.relative_to(store.SITES_DIR).as_posix()
    except ValueError:
        return path.name


def unknown_masks(tl: Timeline) -> tuple[np.ndarray, np.ndarray]:
    """Samples whose Sun / Earth state is unknown (NaN), as the canonical adapter reads them."""
    sun = np.isnan(tl.sun_visible_fraction) | np.isnan(tl.sun_el)
    earth = np.isnan(tl.earth_el - tl.earth_horizon)
    return sun, earth


def demo_timeline(scenario: Scenario) -> Timeline:
    """Synthetic samples every hour from landing up to the last one before the mission end (a fractional final hour
    is represented by the last sample, clipped at the end; nothing is rounded away)."""
    start, end = mission_bounds(scenario.landing_utc, scenario.duration_days)
    tl = _synthetic.timeline(scenario.site, start, end, 1.0)
    i, j = sample_range(tl.times, start, end)
    return tl.slice(i, j)


def data_coverage(scenario: Scenario) -> str:
    d = _site_record(scenario.site.id)
    if d is None:
        return (f"No precomputed Horizons + LOLA data exists for '{scenario.site.name}'. Only the curated sites "
                "(and custom sites created through /api/sites/custom) have real data.")
    return (f"Real data for {scenario.site.name} covers {_iso(d.times[0])} to {_iso(d.times[-1])}; this mission "
            f"({iso_z(scenario.landing_utc)} + {scenario.duration_days:g} days) does not start inside it.")


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


# ---------------------------------------------------------------- time support (app/mission_time.py)

@dataclass
class Support:
    """How the canonical engine reads a timeline slice over the mission: the seconds of the mission each sample
    represents (sample-and-hold supports clipped to [start, end)), and each sample's canonical state."""

    start: datetime
    end: datetime
    weights: np.ndarray  # seconds per sample (0 = represents no mission time)
    uncovered_s: float  # mission time no sample represents (never happens for a covered mission)
    sun_lit: np.ndarray  # object array: True / False / None (unknown), the engine's any-disk state
    sun_fraction: np.ndarray  # float, NaN = unknown
    earth_visible: np.ndarray  # object array: True / False / None

    @property
    def total_s(self) -> float:
        return float(self.weights.sum()) + self.uncovered_s


def support(tl: Timeline, scenario: Scenario) -> Support:
    """Canonical supports and states for ``tl`` over the scenario's exact mission interval (same conversion, same
    sampling policy as the viability engine; nothing re-derived)."""
    start, end = mission_bounds(scenario.landing_utc, scenario.duration_days)
    prepared = prepare_series(timeline_to_series(tl, mission_end_utc=end))
    rt = build_range_timeline(prepared, start, end)
    w = np.zeros(len(tl))
    uncovered = 0
    for sp in rt.spans:
        if sp.index < 0:
            uncovered += sp.length_us
        else:
            w[sp.index] += sp.length_us
    frac = np.array([np.nan if f is None else f for f in prepared.sun_fraction], float)
    return Support(start=start, end=end, weights=w / 1e6, uncovered_s=uncovered / 1e6,
                   sun_lit=np.array(prepared.sun_any, dtype=object), sun_fraction=frac,
                   earth_visible=np.array(prepared.earth_visible, dtype=object))


def unknown_time(sup: Support) -> tuple[float, float]:
    """Mission seconds whose Sun / Earth state is unknown (including time no sample represents)."""
    sun = float(sup.weights[np.array([v is None for v in sup.sun_lit], bool)].sum()) + sup.uncovered_s
    earth = float(sup.weights[np.array([v is None for v in sup.earth_visible], bool)].sum()) + sup.uncovered_s
    return sun, earth


def _wmean(values: np.ndarray, w: np.ndarray) -> float | None:
    ok = w > 0
    return float((values[ok] * w[ok]).sum() / w[ok].sum()) if ok.any() else None


def _canonical_hours(a: ViabilityAssessment | None, field: str) -> float | None:
    m = None if a is None else getattr(a.metrics, field)
    return m.value / 3600.0 if m is not None and m.status.value == "known" and m.value is not None else None


def _count(a: ViabilityAssessment | None, kind: str) -> int | None:
    return None if a is None else sum(1 for w in a.windows if w.kind.value == kind)


def solar_stats(tl: Timeline, sup: Support, a: ViabilityAssessment | None) -> SolarStats:
    """Whole-mission solar statistics, time-weighted. Only called when the Sun's state is known throughout."""
    w, total = sup.weights, sup.total_s
    lit = np.array([v is True for v in sup.sun_lit], bool)
    frac = np.nan_to_num(sup.sun_fraction)  # known throughout here; a visible sliver keeps its 0.0 fraction
    el, clear = tl.sun_el, tl.sun_el - tl.sun_horizon
    used = w > 0
    lit_w = np.where(lit, w, 0.0)
    return SolarStats(
        sunlit_hours=float(lit_w.sum()) / 3600.0, sunlit_fraction=float(lit_w.sum()) / total,
        mean_visible_fraction=float((frac * w).sum()) / total,
        equivalent_full_sun_hours=float((frac * w).sum()) / 3600.0,
        mean_elevation_deg=float((el * w).sum()) / total, mean_elevation_lit_deg=_wmean(el, lit_w),
        max_elevation_deg=float(el[used].max()),
        min_elevation_lit_deg=float(el[used & lit].min()) if (used & lit).any() else None,
        mean_clearance_lit_deg=_wmean(clear, lit_w),
        longest_dark_hours=_canonical_hours(a, "longest_without_direct_sunlight"),
        windows_count=_count(a, "sunlight"),
    )


def earth_stats(tl: Timeline, sup: Support, a: ViabilityAssessment | None) -> EarthStats:
    """Whole-mission Earth statistics, time-weighted. Only called when Earth's state is known throughout."""
    w, total = sup.weights, sup.total_s
    vis = np.array([v is True for v in sup.earth_visible], bool)
    vis_w = np.where(vis, w, 0.0)
    used = (w > 0) & vis
    margin = tl.earth_el - tl.earth_horizon
    return EarthStats(
        visible_hours=float(vis_w.sum()) / 3600.0, visible_fraction=float(vis_w.sum()) / total,
        longest_blackout_hours=_canonical_hours(a, "longest_communication_blackout"),
        windows_count=_count(a, "earth_visible"),
        mean_elevation_visible_deg=_wmean(tl.earth_el, vis_w),
        min_elevation_visible_deg=float(tl.earth_el[used].min()) if used.any() else None,
        mean_margin_visible_deg=_wmean(margin, vis_w),
        min_margin_visible_deg=float(margin[used].min()) if used.any() else None,
    )


def power_stats(f: np.ndarray, sup: Support, cfg: SpacecraftConfig) -> PowerStats:
    """Idealised incidence over the whole mission, time-weighted. Only called when the Sun is known throughout."""
    w, total = sup.weights, sup.total_s
    hours = total / 3600.0
    eq_hours = float((f * w).sum()) / 3600.0
    rated, load = cfg.panel_rated_power_w, cfg.average_load_w
    energy = rated * eq_hours if rated else None
    load_e = load * hours if load else None
    mean_f = float((f * w).sum()) / total
    return PowerStats(
        panel_mode=cfg.panel_mode, mean_incidence_factor=mean_f, max_incidence_factor=float(f[w > 0].max()),
        equivalent_full_power_hours=eq_hours,
        idealized_mean_power_w=rated * mean_f if rated else None,
        idealized_energy_wh=energy, load_energy_wh=load_e,
        idealized_energy_to_load_ratio=energy / load_e if energy is not None and load_e else None,
        battery_endurance_hours=cfg.battery_capacity_wh / load if cfg.battery_capacity_wh and load else None,
        model=POWER_MODEL,
    )


# ---------------------------------------------------------------- canonical windows and events

def canonical_windows(a: ViabilityAssessment, kinds: tuple[str, ...], landing: datetime) -> list[Window]:
    """The engine's windows of these kinds in the comparison's shape (hours after landing). Unknown time stays
    in its own windows: it is never bridged into darkness or a blackout."""
    out = []
    for w in a.windows:
        if w.kind.value not in kinds:
            continue
        out.append(Window(
            start_hour=(w.start_utc - landing).total_seconds() / 3600.0,
            end_hour=(w.end_utc - landing).total_seconds() / 3600.0, duration_hours=w.duration_s / 3600.0,
            start_utc=iso_z(w.start_utc), end_utc=iso_z(w.end_utc),
            open_start=w.clipped_at_start, open_end=w.clipped_at_end, kind=w.kind.value,
        ))
    return out


# (on kind, off kind, unknown kind, rise event, set event)
_EVENTS = (("sunlight", "darkness", "sun_unknown", "sunrise", "sunset"),
           ("earth_visible", "communication_blackout", "earth_unknown", "earthrise", "earthset"))


def canonical_events(a: ViabilityAssessment, landing: datetime) -> list[MissionEvent]:
    """Rises and sets observed in the data: a known "off" window followed directly by a known "on" window (or the
    reverse). A boundary with unknown data or the mission edge is not an event; none is invented there."""
    out: list[MissionEvent] = []
    for on, off, unknown, rise, set_ in _EVENTS:
        seq = sorted((w for w in a.windows if w.kind.value in (on, off, unknown)), key=lambda w: w.start_utc)
        for x, y in pairwise(seq):
            pair = (x.kind.value, y.kind.value)
            kind = rise if pair == (off, on) else set_ if pair == (on, off) else None
            if kind and x.end_utc == y.start_utc:
                out.append(MissionEvent(type=kind, hour=(y.start_utc - landing).total_seconds() / 3600.0,
                                        time_utc=iso_z(y.start_utc)))
    return sorted(out, key=lambda e: e.hour)


# ---------------------------------------------------------------- chart columns

def columns(tl: Timeline, f: np.ndarray, sup: Support, max_points: int) -> TimelineColumns:
    """Decimated samples for charts. ``hour`` is time since the evaluated landing (the sample holding at landing can
    be slightly negative). With decimation, a point whose bucket contains any unknown sample is null for that body, so
    a short unknown interval can never be hidden behind a known neighbour; the engine's unknown windows give the exact
    extent."""
    n = len(tl)
    stride = max(1, math.ceil(n / max_points))
    idx = np.arange(0, n, stride)
    sun_unknown = np.array([v is None for v in sup.sun_lit], bool) | np.isnan(tl.sun_el)
    earth_unknown = np.array([v is None for v in sup.earth_visible], bool) | np.isnan(tl.earth_el - tl.earth_horizon)
    bucket_sun = np.array([sun_unknown[i:i + stride].any() for i in idx], bool)
    bucket_earth = np.array([earth_unknown[i:i + stride].any() for i in idx], bool)

    def r(a: np.ndarray, hide: np.ndarray | None = None) -> list[float | None]:
        return [None if (hide is not None and hide[k]) or not math.isfinite(float(v)) else round(float(v), 3)
                for k, v in enumerate(a[idx])]

    landing = np_us(sup.start)
    hours = (tl.times[idx].astype("datetime64[us]") - landing).astype(np.int64) / 3.6e9
    return TimelineColumns(
        step_hours=tl.step_hours * stride, source_step_hours=tl.step_hours, stride=stride,
        mission_start_utc=iso_z(sup.start), mission_end_utc=iso_z(sup.end),
        hour=[float(h) for h in hours], time_utc=[_iso(tl.times[i]) for i in idx],
        sun_elevation_deg=r(tl.sun_el), sun_azimuth_deg=r(tl.sun_az), sun_horizon_deg=r(tl.sun_horizon, bucket_sun),
        sun_visible_fraction=r(tl.sun_visible_fraction, bucket_sun),
        sun_visible=[None if bucket_sun[k] else bool(sup.sun_lit[i]) for k, i in enumerate(idx)],
        earth_elevation_deg=r(tl.earth_el), earth_azimuth_deg=r(tl.earth_az),
        earth_horizon_deg=r(tl.earth_horizon, bucket_earth),
        earth_visible=[None if bucket_earth[k] else bool(sup.earth_visible[i]) for k, i in enumerate(idx)],
        incidence_factor=r(f, bucket_sun),
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

def _viability(sc: Scenario, tl: Timeline):
    """Shared ViabilityResult + canonical assessment, or (None, None, reason) if the engine refuses the input."""
    try:
        result, assessment = evaluate_timeline_detailed(sc, tl)
        return result, assessment, None
    except RescueCompatError as exc:  # input the adapter cannot convert faithfully: report, never guess
        return None, None, f"The viability engine could not assess this scenario: {exc}"


def evaluate_one(item: CompareScenarioIn, allow_demo: bool, max_points: int) -> tuple[CompareResult, Assessed | None]:
    # One time policy on every screen (app.timegrid): evaluate on the hourly data grid and say so when it moves.
    asked = item.scenario
    sc = asked.model_copy(update={"landing_utc": snap_time(asked.landing_utc),
                                  "duration_days": snap_duration_days(asked.duration_days)})
    start, end = mission_bounds(sc.landing_utc, sc.duration_days)
    grid = dict(evaluated_landing_utc=_iso(np_us(sc.landing_utc)), evaluated_duration_days=sc.duration_days,
                time_note=time_note(asked.landing_utc, asked.duration_days, sc.landing_utc, sc.duration_days))
    tl = real_timeline(sc)
    kind = "real"
    if tl is None:
        if not allow_demo:
            reason = data_coverage(sc)
            return CompareResult(key=item.key, status="unavailable", data_kind="unavailable", data_source="none", **grid,
                                 message=reason + " Enable demonstration data to see a synthetic illustration instead.",
                                 ranking=unassessed_ranking(reason), evaluated_start_utc=iso_z(start),
                                 evaluated_end_utc=iso_z(end), evaluated_hours=(end - start).total_seconds() / 3600.0,
                                 site_context=site_context(sc), science_context=science_context(sc)), None
        tl, kind = demo_timeline(sc), "demonstration"

    viability, assessment, problem = _viability(sc, tl)
    notes = [DEMO_NOTE] if kind == "demonstration" else []
    if problem:
        notes.append(problem)
    f = incidence_factor(tl, item.spacecraft)
    sup = support(tl, sc)
    sun_unknown_s, earth_unknown_s = unknown_time(sup)
    total_h = sup.total_s / 3600.0
    stats: dict = {}
    withheld: dict[str, str] = {}
    # Each body is judged on its own data: missing Sun data does not erase valid Earth statistics, and vice versa.
    # A whole-mission statistic needs the body's state over the whole mission; otherwise it is withheld (never
    # computed as if unknown time were dark or blocked) and the engine's bounds in assessment.metrics stand in.
    if kind == "real" and sup.uncovered_s > 0:
        # The mission runs past the end of the real data: only part of it can be described. Whole-mission statistics
        # are withheld; the verdict comes from the hours that exist, the missing ones bounded: a verdict only where
        # that evidence proves it (usually a fail; a pass only if even the worst case for the missing hours passes).
        covered_h = total_h - sup.uncovered_s / 3600.0
        notes.append(f"Real data ends at {_iso(tl.times[-1])}: it covers {covered_h:g} h of this {total_h:g} h "
                     "mission. Window statistics are withheld; the viability verdict is judged on the covered hours, with "
                     "the uncovered hours bounded: it gives a verdict only where the covered hours prove it (usually a "
                     "fail) and otherwise cannot be decided.")
    if sun_unknown_s > 0:
        why = (f"The Sun's state is unknown for {sun_unknown_s / 3600:.1f} h of this {total_h:.1f} h mission; "
               "whole-mission solar and power statistics are withheld (the engine's metrics give bounds).")
        withheld["solar"] = withheld["power"] = why
        notes.append("Incomplete data: " + why)
    else:
        stats.update(solar=solar_stats(tl, sup, assessment), power=power_stats(f, sup, item.spacecraft))
    if earth_unknown_s > 0:
        why = (f"Earth's state is unknown for {earth_unknown_s / 3600:.1f} h of this {total_h:.1f} h mission; "
               "whole-mission Earth statistics are withheld (the engine's metrics give bounds).")
        withheld["earth"] = why
        notes.append("Incomplete data: " + why)
    else:
        stats.update(earth=earth_stats(tl, sup, assessment))
    if assessment is not None:  # windows and events are the engine's own; unknown time keeps its own windows
        stats.update(
            sun_windows=canonical_windows(assessment, ("sunlight",), start),
            dark_windows=canonical_windows(assessment, ("darkness",), start),
            earth_windows=canonical_windows(assessment, ("earth_visible",), start),
            blackout_windows=canonical_windows(assessment, ("communication_blackout",), start),
            unknown_windows=canonical_windows(assessment, ("sun_unknown", "earth_unknown"), start),
            events=canonical_events(assessment, start),
        )
    result = CompareResult(
        key=item.key, status="ok", data_kind=kind, data_source=tl.source, message=" ".join(notes) or None, **grid,
        site_context=site_context(sc), science_context=science_context(sc),
        viability=viability,
        assessment=assessment_info(assessment) if assessment is not None else None,
        ranking=unassessed_ranking(problem) if assessment is None and problem else None,
        evaluated_start_utc=iso_z(start), evaluated_end_utc=iso_z(end), evaluated_hours=total_h,
        **(dict(zip(("dataset_file", "dataset_sha256"), _dataset_identity(sc.site.id), strict=True)) if kind == "real" else {}),
        sun_known_hours=total_h - sun_unknown_s / 3600.0, earth_known_hours=total_h - earth_unknown_s / 3600.0,
        withheld=withheld, timeline=columns(tl, f, sup, max_points), **stats,
    )
    return result, (Assessed(item.key, assessment) if assessment is not None else None)


def compare(req: CompareRequest) -> CompareResponse:
    pairs = [evaluate_one(s, req.allow_demo_data, req.max_points) for s in req.scenarios]
    results = [r for r, _ in pairs]
    assessed = [a for _, a in pairs if a is not None]
    ranking, groups, method = rank_comparison(assessed)
    evidence = pairwise_evidence(assessed)
    for r in results:
        r.ranking = ranking.get(r.key, r.ranking)  # unassessed results keep their UNKNOWN entry
    sources = sorted({r.viability.source for r in results if r.viability})
    notes = list(NOTES)
    if any(r.data_kind == "demonstration" for r in results):
        notes.insert(0, DEMO_NOTE)
    if len(groups) > 1:
        notes.append(f"The scenarios form {len(groups)} separate ranking groups (different data basis, requirements "
                     "or mission duration). Ranks are only meaningful inside a group.")
    return CompareResponse(results=results, viability_source=", ".join(sources) or "n/a", notes=notes,
                           ranking_groups=groups, ranking_method=method, pairwise=evidence, time_policy=TIME_POLICY)
