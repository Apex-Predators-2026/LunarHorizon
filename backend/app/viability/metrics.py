"""Mission metrics and data-quality summary (Phase 2).

Every metric is computed from the three-valued condition runs of ``windows.RangeTimeline``
(met / not met / unknown) or from time-weighted sample values. Rules (docs section 5b):

* KNOWN: exact under the stated sampling policy (no unknown time affects the value).
* BOUNDED: unknown time could change the value; ``lower``/``upper`` are the extreme values
  over every possible state of the unknown time (for durations: unknown counted as not met /
  as met; for longest outages: unknown always breaks an outage for ``lower`` and never breaks
  it for ``upper``). When both extremes coincide the metric is KNOWN.
* UNAVAILABLE: the quantity is unknown over the whole evaluated range.
* NOT_APPLICABLE: the event or quantity does not exist in the range (e.g. no sunset occurs).

Percentages use the whole evaluated range as denominator. Means are time-weighted; for
unknown time the bounds use the physically admissible range of the quantity. Unknown is
never replaced by zero.
"""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from itertools import pairwise
from typing import Final

from .enums import (
    CalculationBasis,
    Condition,
    ConditionState,
    SamplingPolicy,
    Unit,
    VisibilityCriterion,
    VisibilityState,
)
from .inputs import ScientificTimeSeries
from .outputs import ConditionSummary, DataQualitySummary, Metric, MetricsSummary, VisibilityWindow
from .windows import (
    US_PER_S,
    WINDOW_KINDS,
    PreparedSeries,
    RangeTimeline,
    Run,
    Track,
    build_range_timeline,
    make_window,
)

__all__ = [
    "compute_condition_summaries",
    "compute_metrics",
    "data_quality_from_timeline",
    "metrics_from_timeline",
    "summarize_data_quality",
]

DAY_US: Final = 86_400 * US_PER_S
# Physically admissible ranges used to bound means over unknown time.
FRACTION_RANGE: Final = (0.0, 1.0)
ELEVATION_RANGE_DEG: Final = (-90.0, 90.0)
CLEARANCE_RANGE_DEG: Final = (-180.0, 180.0)  # elevation and horizon each in [-90, 90]

_LABEL: Final = {
    Condition.DIRECT_SUNLIGHT: "direct-sunlight",
    Condition.FULL_SUNLIGHT: "full-sunlight",
    Condition.PARTIAL_SUNLIGHT: "partial-sunlight",
    Condition.POWER_ELIGIBLE: "power-eligibility",
    Condition.EARTH_VISIBLE: "Earth-visibility",
    Condition.SIMULTANEOUS: "simultaneous Sun/Earth",
}


def _s(us: int) -> float:
    return us / US_PER_S


def _hours(us: int) -> str:
    return f"{us / (3600 * US_PER_S):.2f} h"


def _range_metric(lower: float, upper: float, unit: Unit, reason: str) -> Metric:
    return Metric.known(lower, unit) if lower == upper else Metric.bounded(lower, upper, unit, reason)


# --- run statistics -------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class RunStats:
    """Integer-microsecond statistics of one condition track over the evaluated range."""

    met_us: int
    not_met_us: int
    unknown_us: int

    @classmethod
    def of(cls, runs: Sequence[Run]) -> RunStats:
        met = sum(r.length_us for r in runs if r.value is True)
        not_met = sum(r.length_us for r in runs if r.value is False)
        unknown = sum(r.length_us for r in runs if r.value is None)
        return cls(met, not_met, unknown)

    @property
    def known_us(self) -> int:
        return self.met_us + self.not_met_us


def longest_run(runs: Sequence[Run], target: bool) -> tuple[int, int, Run | None]:
    """(lower, upper, longest confirmed run) for the longest continuous ``target`` period.

    lower: longest run confirmed as ``target`` (unknown breaks it).
    upper: longest stretch of ``target`` and unknown runs merged (unknown never breaks it).
    Ties resolve to the earliest run.
    """
    lower, upper, current = 0, 0, 0
    best: Run | None = None
    for r in runs:
        if r.value is target and r.length_us > lower:
            lower, best = r.length_us, r
        if r.value is target or r.value is None:
            current += r.length_us
            upper = max(upper, current)
        else:
            current = 0
    return lower, upper, best


def initial_run(runs: Sequence[Run]) -> tuple[int, int]:
    """(lower, upper) of continuous met time from the range start."""
    lower = runs[0].length_us if runs[0].value is True else 0
    upper = 0
    for r in runs:
        if r.value is False:
            break
        upper += r.length_us
    return lower, upper


def _first_transition(runs: Sequence[Run], start: int, total: int, cond: Condition) -> Metric:
    """Time from the range start to the first change of state."""
    v0 = runs[0].value
    if v0 is None:
        return Metric.unavailable(Unit.SECONDS, f"{_LABEL[cond]} state at the evaluated start is unknown")
    if len(runs) == 1:
        return Metric.not_applicable(Unit.SECONDS)
    lower = runs[0].end_us - start
    if runs[1].value is not None:  # adjacent runs differ, so this is the opposite state
        return Metric.known(_s(lower), Unit.SECONDS)
    opposite = next((r for r in runs[2:] if r.value is (not v0)), None)
    if opposite is None:
        return Metric.bounded(
            _s(lower),
            _s(total),
            Unit.SECONDS,
            f"state becomes unknown after {_s(lower):.0f} s; a transition may not occur within the evaluated range",
        )
    return Metric.bounded(
        _s(lower), _s(opposite.start_us - start), Unit.SECONDS, "the transition occurs during unknown data"
    )


def _first_loss(runs: Sequence[Run], start: int, total: int, cond: Condition) -> Metric:
    """Time from the range start to the first met -> not-met transition (e.g. first sunset).

    Earliest possible: the first confirmed met->not-met edge or the start of the first
    unknown run, whichever is earlier (a state change can hide anywhere in unknown data).
    Latest possible: the start of the first not-met run after the first met run; every
    possible state of the unknown data has a met->not-met edge by then.
    """
    first_unknown = next((r.start_us for r in runs if r.value is None), None)
    edge = next((b.start_us for a, b in pairwise(runs) if a.value is True and b.value is False), None)
    candidates = [t for t in (first_unknown, edge) if t is not None]
    if not candidates:
        return Metric.not_applicable(Unit.SECONDS)
    if first_unknown is None:
        assert edge is not None
        return Metric.known(_s(edge - start), Unit.SECONDS)
    lower = min(candidates) - start
    first_met = next((k for k, r in enumerate(runs) if r.value is True), None)
    guaranteed = (
        next((r.start_us for r in runs[first_met + 1 :] if r.value is False), None) if first_met is not None else None
    )
    if guaranteed is None:
        return Metric.bounded(
            _s(lower),
            _s(total),
            Unit.SECONDS,
            "unknown data may hide a transition; one may not occur within the evaluated range",
        )
    return _range_metric(
        _s(lower), _s(guaranteed - start), Unit.SECONDS, "the first transition may occur during unknown data"
    )


def _initial_state(runs: Sequence[Run]) -> ConditionState:
    v = runs[0].value
    return ConditionState.UNKNOWN if v is None else ConditionState.MET if v else ConditionState.NOT_MET


# --- definitions ----------------------------------------------------------------------------


def condition_definition(cond: Condition, series: ScientificTimeSeries, threshold: float | None) -> str:
    centre_sun = series.sun_criterion is VisibilityCriterion.CENTER
    horizon = (
        "the local horizontal plane (geometric_only: terrain ignored)"
        if series.calculation_basis is CalculationBasis.GEOMETRIC_ONLY
        else "the terrain horizon"
    )
    if cond is Condition.DIRECT_SUNLIGHT:
        if centre_sun:
            return f"Solar centre above {horizon} (Sun criterion 'center'; partial-disk light is not resolved)."
        return f"Any part of the solar disk above {horizon} (visible_fraction > 0)."
    if cond is Condition.FULL_SUNLIGHT:
        return f"Entire solar disk above {horizon} (visible_fraction = 1)."
    if cond is Condition.PARTIAL_SUNLIGHT:
        return f"Part of the solar disk above {horizon} (0 < visible_fraction < 1)."
    if cond is Condition.POWER_ELIGIBLE:
        if threshold is None:
            return "No solar_power_min_disk_fraction set: power-eligible equals direct sunlight."
        return (
            f"visible_fraction > 0 and visible_fraction >= {threshold:g} (simplified visibility threshold; "
            "not a model of solar-array power output)."
        )
    if cond is Condition.EARTH_VISIBLE:
        rule = (
            "Earth centre strictly above"
            if series.earth_criterion is VisibilityCriterion.CENTER
            else "Entire Earth disk above (partially obstructed counts as not met)"
        )
        return f"{rule} {horizon}: a geometric direct-to-Earth line-of-sight opportunity, not a guaranteed radio link."
    return (
        "Power-eligible and Earth visible at the same time (not met if either is known not met; "
        "unknown if either is unknown and neither is known not met)."
    )


# --- condition summaries --------------------------------------------------------------------


def _window(tl: RangeTimeline, track: Track, run: Run | None, met: bool) -> VisibilityWindow | None:
    if run is None:
        return None
    met_kind, not_met_kind, _ = WINDOW_KINDS[track.condition]
    kind = met_kind if met else not_met_kind
    if kind is None:  # no window kind for this state (e.g. "not full sunlight"); keep the duration only
        return None
    return make_window(kind, run, tl, track.before, track.after)


def _summary(tl: RangeTimeline, track: Track, definition: str) -> ConditionSummary:
    cond, runs, start, total = track.condition, track.runs, tl.start_us, tl.total_us
    st = RunStats.of(runs)
    days = total / DAY_US
    met_count = sum(1 for r in runs if r.value is True)
    not_met_count = sum(1 for r in runs if r.value is False)
    reason = f"{_hours(st.unknown_us)} of the evaluated range has an unknown {_LABEL[cond]} state"

    if st.known_us == 0:
        gone = f"{_LABEL[cond]} state is unknown over the whole evaluated range"
        u_s, u_p = Metric.unavailable(Unit.SECONDS, gone), Metric.unavailable(Unit.PERCENT, gone)
        return ConditionSummary(
            condition=cond,
            definition=definition,
            met_duration=u_s,
            not_met_duration=u_s,
            unknown_duration_s=_s(st.unknown_us),
            met_percent=u_p,
            initial_state=ConditionState.UNKNOWN,
            initial_met_duration=u_s,
            time_to_first_transition=u_s,
            time_to_first_loss=u_s,
            longest_met=u_s,
            longest_met_window=None,
            longest_not_met=u_s,
            longest_not_met_window=None,
            met_window_count=0,
            not_met_window_count=0,
            not_met_windows_per_day=0.0,
        )

    met_lo, met_hi, met_best = longest_run(runs, True)
    off_lo, off_hi, off_best = longest_run(runs, False)
    init_lo, init_hi = initial_run(runs)
    return ConditionSummary(
        condition=cond,
        definition=definition,
        met_duration=_range_metric(_s(st.met_us), _s(st.met_us + st.unknown_us), Unit.SECONDS, reason),
        not_met_duration=_range_metric(_s(st.not_met_us), _s(st.not_met_us + st.unknown_us), Unit.SECONDS, reason),
        unknown_duration_s=_s(st.unknown_us),
        met_percent=_range_metric(
            100.0 * st.met_us / total, 100.0 * (st.met_us + st.unknown_us) / total, Unit.PERCENT, reason
        ),
        initial_state=_initial_state(runs),
        initial_met_duration=_range_metric(_s(init_lo), _s(init_hi), Unit.SECONDS, reason),
        time_to_first_transition=_first_transition(runs, start, total, cond),
        time_to_first_loss=_first_loss(runs, start, total, cond),
        longest_met=_range_metric(_s(met_lo), _s(met_hi), Unit.SECONDS, reason),
        longest_met_window=_window(tl, track, met_best, True),
        longest_not_met=_range_metric(_s(off_lo), _s(off_hi), Unit.SECONDS, reason),
        longest_not_met_window=_window(tl, track, off_best, False),
        met_window_count=met_count,
        not_met_window_count=not_met_count,
        not_met_windows_per_day=not_met_count / days,
    )


def compute_condition_summaries(tl: RangeTimeline) -> list[ConditionSummary]:
    series = tl.prepared.series
    return [_summary(tl, tl.tracks[c], condition_definition(c, series, tl.threshold)) for c in Condition]


# --- time-weighted means --------------------------------------------------------------------


def _mean_over_range(
    tl: RangeTimeline, values: Sequence[float | None], limits: tuple[float, float], unit: Unit, what: str
) -> Metric:
    """Time-weighted mean over the whole range; unknown time bounded by ``limits``."""
    weighted, known = 0.0, 0
    for sp in tl.spans:
        v = values[sp.index] if sp.index >= 0 else None
        if v is not None:
            weighted += v * sp.length_us
            known += sp.length_us
    if known == 0:
        return Metric.unavailable(unit, f"{what} is unknown over the whole evaluated range")
    unknown = tl.total_us - known
    if unknown == 0:
        return Metric.known(weighted / tl.total_us, unit)
    return Metric.bounded(
        (weighted + unknown * limits[0]) / tl.total_us,
        (weighted + unknown * limits[1]) / tl.total_us,
        unit,
        f"{what} unknown for {_hours(unknown)}; bounds use its admissible range {limits}",
    )


def _mean_while(
    tl: RangeTimeline,
    condition: Condition,
    values: Sequence[float | None],
    limits: tuple[float, float],
    what: str,
) -> Metric:
    """Time-weighted mean of ``values`` over the time ``condition`` is met.

    Unknown condition time may or may not belong to the averaging set, with any admissible
    value; the bounds are the extreme means over those possibilities.
    """
    p = tl.prepared
    weighted, inside, unknown = 0.0, 0, 0
    for sp in tl.spans:
        state = _state_for_mean(p, sp.index, condition)
        v = values[sp.index] if sp.index >= 0 else None
        if state is True and v is not None:
            weighted += v * sp.length_us
            inside += sp.length_us
        elif state is None or (state is True and v is None):
            unknown += sp.length_us
    if inside == 0 and unknown == 0:
        return Metric.not_applicable(Unit.DEGREES)  # condition never met: no time to average over
    if inside == 0:
        return Metric.unavailable(Unit.DEGREES, f"{what}: no time in the range is known to qualify")
    mean = weighted / inside
    if unknown == 0:
        return Metric.known(mean, Unit.DEGREES)
    lo = min(mean, (weighted + unknown * limits[0]) / (inside + unknown))
    hi = max(mean, (weighted + unknown * limits[1]) / (inside + unknown))
    return Metric.bounded(
        lo, hi, Unit.DEGREES, f"{what}: {_hours(unknown)} of unknown data; bounds use the admissible range {limits}"
    )


def _state_for_mean(p: PreparedSeries, i: int, condition: Condition) -> bool | None:
    if i < 0:
        return None
    if condition is Condition.DIRECT_SUNLIGHT:
        return p.sun_any[i]
    if condition is Condition.EARTH_VISIBLE:
        return p.earth_visible[i]
    raise ValueError(f"unsupported condition for conditional means: {condition}")


# --- assembly -------------------------------------------------------------------------------


def metrics_from_timeline(tl: RangeTimeline, summaries: Sequence[ConditionSummary] | None = None) -> MetricsSummary:
    by = {s.condition: s for s in (summaries if summaries is not None else compute_condition_summaries(tl))}
    p = tl.prepared
    sun, full, partial = by[Condition.DIRECT_SUNLIGHT], by[Condition.FULL_SUNLIGHT], by[Condition.PARTIAL_SUNLIGHT]
    power, earth, both = by[Condition.POWER_ELIGIBLE], by[Condition.EARTH_VISIBLE], by[Condition.SIMULTANEOUS]
    return MetricsSummary(
        sunlight_duration=sun.met_duration,
        sunlight_percent=sun.met_percent,
        full_sunlight_duration=full.met_duration,
        full_sunlight_percent=full.met_percent,
        partial_sunlight_duration=partial.met_duration,
        partial_sunlight_percent=partial.met_percent,
        power_lit_duration=power.met_duration,
        power_lit_percent=power.met_percent,
        earth_visible_duration=earth.met_duration,
        earth_visible_percent=earth.met_percent,
        simultaneous_duration=both.met_duration,
        simultaneous_percent=both.met_percent,
        longest_simultaneous_window=both.longest_met,
        longest_continuous_darkness=power.longest_not_met,
        longest_without_direct_sunlight=sun.longest_not_met,
        longest_communication_blackout=earth.longest_not_met,
        mean_solar_disk_fraction=_mean_over_range(
            tl, p.sun_fraction, FRACTION_RANGE, Unit.FRACTION, "visible solar-disk fraction"
        ),
        initial_sunlight_duration=power.initial_met_duration,
        initial_earth_visibility_duration=earth.initial_met_duration,
        time_to_first_sunset=power.time_to_first_loss,
        time_to_first_earthset=earth.time_to_first_loss,
        mean_sun_clearance=_mean_while(
            tl, Condition.DIRECT_SUNLIGHT, p.sun_clearance, CLEARANCE_RANGE_DEG, "Sun horizon clearance"
        ),
        mean_earth_clearance=_mean_while(
            tl, Condition.EARTH_VISIBLE, p.earth_clearance, CLEARANCE_RANGE_DEG, "Earth horizon clearance"
        ),
        mean_solar_elevation=_mean_over_range(
            tl, p.sun_elevation, ELEVATION_RANGE_DEG, Unit.DEGREES, "solar elevation"
        ),
    )


def compute_metrics(
    series: ScientificTimeSeries | PreparedSeries,
    start_utc: datetime,
    end_utc: datetime,
    *,
    solar_power_min_disk_fraction: float | None = None,
    policy: SamplingPolicy | None = None,
) -> MetricsSummary:
    """Phase 2 metrics over ``[start_utc, end_utc)``. See module docstring for semantics."""
    tl = build_range_timeline(
        series, start_utc, end_utc, solar_power_min_disk_fraction=solar_power_min_disk_fraction, policy=policy
    )
    return metrics_from_timeline(tl)


# --- data quality ---------------------------------------------------------------------------


def _assumptions(tl: RangeTimeline) -> list[str]:
    s = tl.prepared.series
    nominal = s.sampling.nominal_interval_s
    step = f"one nominal interval ({nominal:g} s)" if nominal is not None else "no time (irregular series)"
    if tl.prepared.policy is SamplingPolicy.SAMPLE_HOLD:
        rule = (
            "Sample-and-hold: each instantaneous sample represents [t_i, t_(i+1)) when the next sample is within "
            f"sampling.max_gap_s ({s.sampling.max_gap_s:g} s); before a coverage gap and at the last sample it "
            f"represents {step}, never beyond coverage_end_utc. Modeled transitions fall on sample times and can "
            "be up to one sample spacing later than the true geometric event."
        )
    else:
        half = f"half a nominal interval ({nominal / 2:g} s)" if nominal is not None else "no time (irregular series)"
        rule = (
            "Nearest-sample: each instantaneous sample represents the time closer to it than to its neighbours "
            f"(boundaries at midpoints) when they are within sampling.max_gap_s ({s.sampling.max_gap_s:g} s); "
            f"next to a coverage gap or coverage bound it extends {half}. Modeled transitions fall on midpoints "
            "and can be up to half a sample spacing from the true geometric event."
        )
    return [
        rule,
        "No interpolation between samples; events shorter than the sample spacing can be missed.",
        (
            "Unknown states and time no sample represents are never treated as darkness or blackout; affected "
            "durations, percentages and outages are reported as bounds."
        ),
        "Percentages use the whole evaluated range as denominator; means are time-weighted.",
    ]


def _warnings(tl: RangeTimeline, uncovered: list[Run]) -> list[str]:
    p, s = tl.prepared, tl.prepared.series
    out: list[str] = []
    if s.provenance.is_synthetic:
        out.append("SYNTHETIC data: not NASA-derived; not valid for mission decisions.")
    if s.calculation_basis is CalculationBasis.GEOMETRIC_ONLY:
        out.append("Calculation basis is geometric_only: terrain obstruction is not modelled.")
    if s.sun_criterion is VisibilityCriterion.CENTER:
        out.append(
            "Sun criterion is 'center': direct sunlight means the solar centre is above the horizon; "
            "full/partial disk illumination is resolved only where visible_fraction is given."
        )
    if uncovered:
        total = sum(r.length_us for r in uncovered)
        out.append(
            f"{len(uncovered)} interval(s) totalling {_hours(total)} are not represented by any sample "
            "(coverage gaps or outside dataset coverage); treated as unknown."
        )
    if tl.start_us < p.coverage_start_us or tl.end_us > p.coverage_end_us:
        out.append(
            f"Evaluated range extends beyond dataset coverage [{s.coverage_start_utc.isoformat()}, "
            f"{s.coverage_end_utc.isoformat()}]; the excess is unknown, not extrapolated."
        )
    sampled = sorted({sp.index for sp in tl.spans if sp.index >= 0})
    sun_unknown = sum(1 for i in sampled if s.samples[i].sun.state is VisibilityState.UNKNOWN)
    earth_unknown = sum(1 for i in sampled if s.samples[i].earth.state is VisibilityState.UNKNOWN)
    if sun_unknown:
        out.append(f"{sun_unknown} sample(s) in range have an unknown Sun state (missing ephemeris or terrain).")
    if earth_unknown:
        out.append(f"{earth_unknown} sample(s) in range have an unknown Earth state (missing ephemeris or terrain).")
    if tl.threshold is not None:
        extra = (
            RunStats.of(tl.tracks[Condition.POWER_ELIGIBLE].runs).unknown_us
            - RunStats.of(tl.tracks[Condition.DIRECT_SUNLIGHT].runs).unknown_us
        )
        if extra > 0:
            out.append(
                f"Power threshold set but visible_fraction is unavailable for {_hours(extra)} with a known Sun "
                "state; power eligibility is unknown there."
            )
    return out


def _largest_gap(p: PreparedSeries, start: int, end: int) -> int | None:
    """Largest spacing between consecutive samples whose interval overlaps (start, end)."""
    times = p.times_us
    lo = max(bisect_right(times, start) - 1, 0)
    hi = min(bisect_left(times, end) + 1, len(times))
    gaps = [b - a for a, b in pairwise(times[lo:hi]) if a < end and b > start]
    return max(gaps) if gaps else None


def data_quality_from_timeline(tl: RangeTimeline) -> DataQualitySummary:
    p, s = tl.prepared, tl.prepared.series
    uncovered = _uncovered_runs(tl)
    sun_unknown = RunStats.of(tl.tracks[Condition.DIRECT_SUNLIGHT].runs).unknown_us
    earth_unknown = RunStats.of(tl.tracks[Condition.EARTH_VISIBLE].runs).unknown_us
    gap = _largest_gap(p, tl.start_us, tl.end_us)
    return DataQualitySummary(
        dataset_id=s.dataset_id,
        provenance=s.provenance,
        calculation_basis=s.calculation_basis,
        angle_type=s.angle_type,
        sun_criterion=s.sun_criterion,
        earth_criterion=s.earth_criterion,
        sampling_policy=p.policy,
        evaluated_duration_s=_s(tl.total_us),
        sample_count=len({sp.index for sp in tl.spans if sp.index >= 0}),
        largest_sample_gap_s=_s(gap) if gap is not None else None,
        uncovered_duration_s=_s(sum(r.length_us for r in uncovered)),
        coverage_gap_count=len(uncovered),
        sun_unknown_duration_s=_s(sun_unknown),
        earth_unknown_duration_s=_s(earth_unknown),
        sun_coverage_percent=100.0 * (tl.total_us - sun_unknown) / tl.total_us,
        earth_coverage_percent=100.0 * (tl.total_us - earth_unknown) / tl.total_us,
        assumptions=_assumptions(tl),
        warnings=_warnings(tl, uncovered),
    )


def _uncovered_runs(tl: RangeTimeline) -> list[Run]:
    out: list[Run] = []
    for sp in tl.spans:
        if sp.index >= 0:
            continue
        if out and out[-1].end_us == sp.start_us:
            out[-1] = Run(out[-1].start_us, sp.end_us, True)
        else:
            out.append(Run(sp.start_us, sp.end_us, True))
    return out


def summarize_data_quality(
    series: ScientificTimeSeries | PreparedSeries,
    start_utc: datetime,
    end_utc: datetime,
    *,
    policy: SamplingPolicy | None = None,
) -> DataQualitySummary:
    """Coverage, unknown time, sampling assumptions and warnings for ``[start_utc, end_utc)``."""
    return data_quality_from_timeline(build_range_timeline(series, start_utc, end_utc, policy=policy))
