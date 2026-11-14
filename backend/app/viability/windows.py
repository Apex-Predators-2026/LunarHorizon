"""Visibility-window analysis (Phase 2): instantaneous samples -> time intervals -> windows.

Sampling semantics (normative; docs/viability-engine.md section 5b)
-------------------------------------------------------------------
Samples are instantaneous geometry. To integrate them over time, each sample is given a
*support*: the half-open interval of time it represents. Supports never overlap, are never
extended past ``coverage_end_utc`` (or before ``coverage_start_utc``), and never bridge a
coverage gap (consecutive samples more than ``sampling.max_gap_s`` apart).

``SamplingPolicy.SAMPLE_HOLD`` (default):
    sample i represents ``[t_i, t_{i+1})`` when ``t_{i+1} - t_i <= max_gap_s``. Before a
    coverage gap, and for the last sample, it represents one ``nominal_interval_s`` (none if
    the series is irregular), capped at ``coverage_end_utc``. This is the convention of
    Member 1's ``intervals()``/``next_transition_off()`` (a run ends at the first "off"
    sample) and of Member 5's hourly bins. Andrew's files end with a sample *at*
    ``coverage_end_utc``, so that sample represents zero time and no hour is lost or invented.

``SamplingPolicy.NEAREST_SAMPLE``:
    sample i represents the time closer to it than to its neighbours (boundaries at
    midpoints); next to a gap or a coverage bound it extends half a nominal interval.

Neither policy interpolates. A modeled transition is placed at a sample time (sample-hold)
or a midpoint (nearest), so true geometric events can be up to one spacing (sample-hold) or
half a spacing (nearest) away, and events shorter than the spacing can be missed entirely.

Time arithmetic is done in integer microseconds since the Unix epoch, which is exact for
``datetime`` values, so window edges cannot drift, overlap or collapse to zero length
through floating-point error. Durations become float seconds only at the output.

Conditions are three-valued per instant (``True`` met, ``False`` not met, ``None`` unknown)
and unknown is never folded into darkness or blackout.
"""

from __future__ import annotations

from bisect import bisect_right
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final

from pydantic import TypeAdapter, ValidationError

from .conventions import UTCDatetime
from .enums import (
    CalculationBasis,
    Condition,
    SamplingPolicy,
    VisibilityCriterion,
    VisibilityState,
    WindowKind,
)
from .inputs import BodyObservation, ScientificTimeSeries
from .outputs import VisibilityWindow

__all__ = [
    "DEFAULT_SAMPLING_POLICY",
    "WINDOW_KINDS",
    "PreparedSeries",
    "RangeTimeline",
    "Run",
    "build_range_timeline",
    "extract_windows",
    "prepare_series",
]

DEFAULT_SAMPLING_POLICY: Final = SamplingPolicy.SAMPLE_HOLD

US_PER_S: Final = 1_000_000
_EPOCH: Final = datetime(1970, 1, 1, tzinfo=UTC)
_ONE_US: Final = timedelta(microseconds=1)
_UTC: Final = TypeAdapter(UTCDatetime)

Tri = bool | None

# Condition -> window kinds for (met, not met, unknown). None = not reported as windows.
WINDOW_KINDS: Final[dict[Condition, tuple[WindowKind | None, WindowKind | None, WindowKind | None]]] = {
    Condition.DIRECT_SUNLIGHT: (WindowKind.SUNLIGHT, WindowKind.DARKNESS, WindowKind.SUN_UNKNOWN),
    Condition.FULL_SUNLIGHT: (WindowKind.FULL_SUNLIGHT, None, None),
    Condition.PARTIAL_SUNLIGHT: (WindowKind.PARTIAL_SUNLIGHT, None, None),
    Condition.POWER_ELIGIBLE: (WindowKind.POWER_LIT, WindowKind.POWER_DARK, WindowKind.POWER_UNKNOWN),
    Condition.EARTH_VISIBLE: (
        WindowKind.EARTH_VISIBLE,
        WindowKind.COMMUNICATION_BLACKOUT,
        WindowKind.EARTH_UNKNOWN,
    ),
    Condition.SIMULTANEOUS: (WindowKind.SIMULTANEOUS_SUN_EARTH, None, WindowKind.SIMULTANEOUS_UNKNOWN),
}
_KIND_ORDER: Final = {k: i for i, k in enumerate(WindowKind)}


def to_us(dt: datetime) -> int:
    """Aware datetime -> integer microseconds since the Unix epoch (exact)."""
    return (dt - _EPOCH) // _ONE_US


def from_us(us: int) -> datetime:
    return _EPOCH + timedelta(microseconds=us)


def _seconds_to_us(seconds: float) -> int:
    return round(seconds * US_PER_S)


def validate_range(start_utc: datetime, end_utc: datetime) -> tuple[datetime, datetime]:
    """Both bounds must be timezone-aware UTC and ``start < end``."""
    try:
        start, end = _UTC.validate_python(start_utc), _UTC.validate_python(end_utc)
    except ValidationError as e:
        raise ValueError(f"evaluated range: {e.errors()[0]['msg']}") from e
    if end <= start:
        raise ValueError("evaluated range: end_utc must be after start_utc")
    return start, end


def validate_threshold(threshold: float | None) -> float | None:
    if threshold is None:
        return None
    if isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or not 0.0 <= threshold <= 1.0:
        raise ValueError(f"solar_power_min_disk_fraction must be in [0, 1], got {threshold!r}")
    return float(threshold)


# --- per-sample classification --------------------------------------------------------------


def _effective_fraction(obs: BodyObservation, criterion: VisibilityCriterion) -> float | None:
    """Visible disk fraction, stated or implied by an apparent-disk state; else None."""
    if obs.visible_fraction is not None:
        return obs.visible_fraction
    if criterion is VisibilityCriterion.APPARENT_DISK:
        if obs.state is VisibilityState.VISIBLE:
            return 1.0
        if obs.state is VisibilityState.NOT_VISIBLE:
            return 0.0
    return None


def _clearance(obs: BodyObservation, basis: CalculationBasis) -> float | None:
    if obs.elevation_deg is None:
        return None
    if basis is CalculationBasis.GEOMETRIC_ONLY:
        return obs.elevation_deg  # reference plane is the local horizontal by definition
    return None if obs.horizon_deg is None else obs.elevation_deg - obs.horizon_deg


def _sun_flags(obs: BodyObservation, criterion: VisibilityCriterion, frac: float | None) -> tuple[Tri, Tri, Tri]:
    """(direct sunlight, full disk, partial disk) for one Sun observation."""
    state = obs.state
    if state is VisibilityState.UNKNOWN:
        return None, None, None
    any_ = state is not VisibilityState.NOT_VISIBLE
    if criterion is VisibilityCriterion.APPARENT_DISK:
        return any_, state is VisibilityState.VISIBLE, state is VisibilityState.PARTIAL
    # Centre criterion: the state says where the centre is, not how much disk is visible.
    if frac is not None:
        return any_, frac == 1.0, 0.0 < frac < 1.0
    full: Tri = False if state is VisibilityState.NOT_VISIBLE else None
    return any_, full, None


def _earth_flag(obs: BodyObservation) -> Tri:
    if obs.state is VisibilityState.UNKNOWN:
        return None
    # Centre criterion: VISIBLE = centre above the horizon (Member 1's definition).
    # Apparent-disk criterion: only the whole disk counts; PARTIAL is conservatively not met.
    return obs.state is VisibilityState.VISIBLE


def power_flag(any_: Tri, frac: float | None, threshold: float | None) -> Tri:
    """Power-eligible: ``fraction > 0 and fraction >= threshold``; no threshold -> direct sunlight."""
    if threshold is None:
        return any_
    if frac is None:
        return None
    return frac > 0.0 and frac >= threshold


def kleene_and(a: Tri, b: Tri) -> Tri:
    if a is False or b is False:
        return False
    if a is None or b is None:
        return None
    return True


# --- prepared series ------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PreparedSeries:
    """A validated series with sample supports and per-sample classifications precomputed.

    Build once with ``prepare_series`` and reuse for many evaluated ranges (Member 5 calls
    the engine many times per site). Immutable.
    """

    series: ScientificTimeSeries
    policy: SamplingPolicy
    times_us: tuple[int, ...]
    lo_us: tuple[int, ...]  # support start per sample
    hi_us: tuple[int, ...]  # support end per sample (== lo_us when it represents no time)
    sun_any: tuple[Tri, ...]
    sun_full: tuple[Tri, ...]
    sun_partial: tuple[Tri, ...]
    sun_fraction: tuple[float | None, ...]
    sun_elevation: tuple[float | None, ...]
    sun_clearance: tuple[float | None, ...]
    earth_visible: tuple[Tri, ...]
    earth_clearance: tuple[float | None, ...]
    coverage_start_us: int
    coverage_end_us: int

    def sample_at(self, us: int) -> int:
        """Index of the sample whose support contains instant ``us``; -1 if none."""
        i = bisect_right(self.hi_us, us)
        return i if i < len(self.hi_us) and self.lo_us[i] <= us else -1


def _supports(
    times: Sequence[int],
    policy: SamplingPolicy,
    nominal_us: int | None,
    max_gap_us: int,
    cov_start: int,
    cov_end: int,
) -> tuple[list[int], list[int]]:
    n = len(times)
    lo, hi = [0] * n, [0] * n
    step = nominal_us or 0  # irregular series: no documented interval beyond the next sample
    if policy is SamplingPolicy.SAMPLE_HOLD:
        for i in range(n):
            lo[i] = times[i]
            if i + 1 < n:
                d = times[i + 1] - times[i]
                hi[i] = times[i + 1] if d <= max_gap_us else times[i] + step  # step <= max_gap < d
            else:
                hi[i] = min(times[i] + step, cov_end)
        return lo, hi
    half = step // 2
    for i in range(n):
        if i == 0:
            lo[i] = max(times[0] - half, cov_start)
        else:
            d = times[i] - times[i - 1]
            lo[i] = (times[i - 1] + times[i]) // 2 if d <= max_gap_us else times[i] - half
        if i == n - 1:
            hi[i] = min(times[i] + half, cov_end)
        else:
            d = times[i + 1] - times[i]
            hi[i] = (times[i] + times[i + 1]) // 2 if d <= max_gap_us else times[i] + half
    return lo, hi


def prepare_series(series: ScientificTimeSeries, policy: SamplingPolicy = DEFAULT_SAMPLING_POLICY) -> PreparedSeries:
    times = [to_us(s.time_utc) for s in series.samples]
    nominal = series.sampling.nominal_interval_s
    lo, hi = _supports(
        times,
        policy,
        _seconds_to_us(nominal) if nominal is not None else None,
        _seconds_to_us(series.sampling.max_gap_s),
        to_us(series.coverage_start_utc),
        to_us(series.coverage_end_utc),
    )
    basis, sun_crit = series.calculation_basis, series.sun_criterion
    sun_any: list[Tri] = []
    sun_full: list[Tri] = []
    sun_partial: list[Tri] = []
    fracs: list[float | None] = []
    for s in series.samples:
        frac = _effective_fraction(s.sun, sun_crit)
        a, f, p = _sun_flags(s.sun, sun_crit, frac)
        sun_any.append(a)
        sun_full.append(f)
        sun_partial.append(p)
        fracs.append(frac)
    return PreparedSeries(
        series=series,
        policy=policy,
        times_us=tuple(times),
        lo_us=tuple(lo),
        hi_us=tuple(hi),
        sun_any=tuple(sun_any),
        sun_full=tuple(sun_full),
        sun_partial=tuple(sun_partial),
        sun_fraction=tuple(fracs),
        sun_elevation=tuple(s.sun.elevation_deg for s in series.samples),
        sun_clearance=tuple(_clearance(s.sun, basis) for s in series.samples),
        earth_visible=tuple(_earth_flag(s.earth) for s in series.samples),
        earth_clearance=tuple(_clearance(s.earth, basis) for s in series.samples),
        coverage_start_us=to_us(series.coverage_start_utc),
        coverage_end_us=to_us(series.coverage_end_utc),
    )


def as_prepared(source: ScientificTimeSeries | PreparedSeries, policy: SamplingPolicy | None) -> PreparedSeries:
    if isinstance(source, PreparedSeries):
        if policy is not None and policy is not source.policy:
            raise ValueError(f"series was prepared with {source.policy.value!r}, not {policy.value!r}")
        return source
    return prepare_series(source, policy or DEFAULT_SAMPLING_POLICY)


# --- evaluated range ------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Run:
    """A maximal interval [start_us, end_us) of one condition value."""

    start_us: int
    end_us: int
    value: Tri

    @property
    def length_us(self) -> int:
        return self.end_us - self.start_us


@dataclass(frozen=True, slots=True)
class Span:
    """Part of the evaluated range represented by one sample (``index``) or by none (-1)."""

    start_us: int
    end_us: int
    index: int

    @property
    def length_us(self) -> int:
        return self.end_us - self.start_us


@dataclass(frozen=True, slots=True)
class Track:
    condition: Condition
    runs: tuple[Run, ...]  # partition of the evaluated range, adjacent runs differ in value
    before: Tri  # value just before the range start (None if unknown / not covered)
    after: Tri  # value at the range end


@dataclass(frozen=True, slots=True)
class RangeTimeline:
    """Everything Phase 2 derives for one evaluated range, before metrics are computed."""

    prepared: PreparedSeries
    start_us: int
    end_us: int
    threshold: float | None
    spans: tuple[Span, ...]  # partition of [start_us, end_us)
    tracks: dict[Condition, Track]

    @property
    def total_us(self) -> int:
        return self.end_us - self.start_us


def condition_values(p: PreparedSeries, i: int, threshold: float | None) -> dict[Condition, Tri]:
    if i < 0:
        return dict.fromkeys(Condition)
    power = power_flag(p.sun_any[i], p.sun_fraction[i], threshold)
    earth = p.earth_visible[i]
    return {
        Condition.DIRECT_SUNLIGHT: p.sun_any[i],
        Condition.FULL_SUNLIGHT: p.sun_full[i],
        Condition.PARTIAL_SUNLIGHT: p.sun_partial[i],
        Condition.POWER_ELIGIBLE: power,
        Condition.EARTH_VISIBLE: earth,
        Condition.SIMULTANEOUS: kleene_and(power, earth),
    }


def _spans(p: PreparedSeries, start: int, end: int) -> list[Span]:
    out: list[Span] = []
    cursor = start
    i = bisect_right(p.hi_us, start)  # first sample whose support ends after start
    n = len(p.times_us)
    while i < n and p.lo_us[i] < end:
        a, b = max(p.lo_us[i], start), min(p.hi_us[i], end)
        if a < b:
            if cursor < a:
                out.append(Span(cursor, a, -1))
            out.append(Span(a, b, i))
            cursor = b
        i += 1
    if cursor < end:
        out.append(Span(cursor, end, -1))
    return out


def _runs(spans: Sequence[Span], value_of: Callable[[int], Tri]) -> tuple[Run, ...]:
    runs: list[Run] = []
    cur_start, cur_value = spans[0].start_us, value_of(spans[0].index)
    for sp in spans[1:]:
        v = value_of(sp.index)
        if v is not cur_value:
            runs.append(Run(cur_start, sp.start_us, cur_value))
            cur_start, cur_value = sp.start_us, v
    runs.append(Run(cur_start, spans[-1].end_us, cur_value))
    return tuple(runs)


def build_range_timeline(
    source: ScientificTimeSeries | PreparedSeries,
    start_utc: datetime,
    end_utc: datetime,
    *,
    solar_power_min_disk_fraction: float | None = None,
    policy: SamplingPolicy | None = None,
) -> RangeTimeline:
    p = as_prepared(source, policy)
    start_dt, end_dt = validate_range(start_utc, end_utc)
    threshold = validate_threshold(solar_power_min_disk_fraction)
    start, end = to_us(start_dt), to_us(end_dt)
    spans = _spans(p, start, end)
    # Per-span condition values, computed once and shared by all tracks.
    values = [condition_values(p, sp.index, threshold) for sp in spans]
    before = condition_values(p, p.sample_at(start - 1), threshold)
    after = condition_values(p, p.sample_at(end), threshold)
    tracks: dict[Condition, Track] = {}
    for cond in Condition:
        runs: list[Run] = []
        cur_start, cur_value = spans[0].start_us, values[0][cond]
        for k in range(1, len(spans)):
            v = values[k][cond]
            if v is not cur_value:
                runs.append(Run(cur_start, spans[k].start_us, cur_value))
                cur_start, cur_value = spans[k].start_us, v
        runs.append(Run(cur_start, end, cur_value))
        tracks[cond] = Track(cond, tuple(runs), before[cond], after[cond])
    return RangeTimeline(p, start, end, threshold, tuple(spans), tracks)


# --- windows --------------------------------------------------------------------------------


def make_window(kind: WindowKind, run: Run, tl: RangeTimeline, before: Tri, after: Tri) -> VisibilityWindow:
    """Window for one run. Clipped when cut by the range and not known to change exactly there."""
    return VisibilityWindow(
        kind=kind,
        start_utc=from_us(run.start_us),
        end_utc=from_us(run.end_us),
        duration_s=run.length_us / US_PER_S,
        clipped_at_start=run.start_us == tl.start_us and (before is None or before is run.value),
        clipped_at_end=run.end_us == tl.end_us and (after is None or after is run.value),
    )


def windows_from_timeline(tl: RangeTimeline) -> list[VisibilityWindow]:
    out: list[VisibilityWindow] = []
    for cond, (met, not_met, unknown) in WINDOW_KINDS.items():
        track = tl.tracks[cond]
        for run in track.runs:
            kind = met if run.value is True else not_met if run.value is False else unknown
            if kind is not None:
                out.append(make_window(kind, run, tl, track.before, track.after))
    # UNKNOWN_DATA: time that no sample represents.
    p = tl.prepared
    uncovered = _runs(tl.spans, lambda i: i < 0)
    before_uncovered = p.sample_at(tl.start_us - 1) < 0
    after_uncovered = p.sample_at(tl.end_us) < 0
    for run in uncovered:
        if run.value:
            out.append(make_window(WindowKind.UNKNOWN_DATA, run, tl, before_uncovered, after_uncovered))
    out.sort(key=lambda w: (w.start_utc, _KIND_ORDER[w.kind]))
    return out


def extract_windows(
    series: ScientificTimeSeries | PreparedSeries,
    start_utc: datetime,
    end_utc: datetime,
    *,
    solar_power_min_disk_fraction: float | None = None,
    policy: SamplingPolicy | None = None,
) -> list[VisibilityWindow]:
    """All visibility windows in ``[start_utc, end_utc)``, sorted by start then kind.

    See ``WINDOW_KINDS`` for which condition states are reported. Windows of one kind never
    overlap or touch; windows of complementary kinds (e.g. SUNLIGHT, DARKNESS, SUN_UNKNOWN)
    partition the range.
    """
    tl = build_range_timeline(
        series, start_utc, end_utc, solar_power_min_disk_fraction=solar_power_min_disk_fraction, policy=policy
    )
    return windows_from_timeline(tl)
