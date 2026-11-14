"""Phase 2 entry points: sunlight and Earth-visibility analysis of one site over one range.

``analyze_environment`` builds the evaluated-range timeline once and derives windows,
condition statistics, mission metrics and data quality from it. It produces no pass/fail,
risk or score (Phases 3-5); ``engine.evaluate_scenario`` will call it in Phase 6.

For many ranges on the same dataset (Member 5), prepare the series once::

    prepared = prepare_series(series)                 # supports + classifications, ~O(n)
    a = analyze_environment(prepared, start, end, solar_power_min_disk_fraction=0.25)
"""

from __future__ import annotations

from datetime import datetime

from .conventions import ENGINE_VERSION
from .enums import SamplingPolicy
from .inputs import ScientificTimeSeries
from .metrics import compute_condition_summaries, data_quality_from_timeline, metrics_from_timeline
from .mission import MissionScenario
from .outputs import EnvironmentAnalysis
from .windows import PreparedSeries, build_range_timeline, windows_from_timeline

__all__ = ["analyze_environment", "analyze_scenario"]


def analyze_environment(
    series: ScientificTimeSeries | PreparedSeries,
    start_utc: datetime,
    end_utc: datetime,
    *,
    solar_power_min_disk_fraction: float | None = None,
    policy: SamplingPolicy | None = None,
) -> EnvironmentAnalysis:
    """Full Phase 2 analysis of ``[start_utc, end_utc)`` (UTC, start < end).

    The range may extend beyond the dataset: the excess is reported as unknown, never
    extrapolated. ``policy`` defaults to sample-and-hold (or the policy a ``PreparedSeries``
    was built with).
    """
    tl = build_range_timeline(
        series, start_utc, end_utc, solar_power_min_disk_fraction=solar_power_min_disk_fraction, policy=policy
    )
    summaries = compute_condition_summaries(tl)
    s = tl.prepared.series
    return EnvironmentAnalysis(
        engine_version=ENGINE_VERSION,
        site=s.site,
        evaluated_start_utc=start_utc,
        evaluated_end_utc=end_utc,
        solar_power_min_disk_fraction=tl.threshold,
        metrics=metrics_from_timeline(tl, summaries),
        conditions=summaries,
        windows=windows_from_timeline(tl),
        data_quality=data_quality_from_timeline(tl),
    )


def analyze_scenario(
    scenario: MissionScenario,
    series: ScientificTimeSeries | PreparedSeries,
    *,
    policy: SamplingPolicy | None = None,
) -> EnvironmentAnalysis:
    """Phase 2 analysis over the scenario's mission window with its solar-power threshold.

    Raises ``ValueError`` if the series is for a different site (by ``site.id``).
    """
    site_id = series.series.site.id if isinstance(series, PreparedSeries) else series.site.id
    if site_id != scenario.site.id:
        raise ValueError(f"series is for site {site_id!r} but the scenario is for site {scenario.site.id!r}")
    return analyze_environment(
        series,
        scenario.mission_start_utc,
        scenario.mission_end_utc,
        solar_power_min_disk_fraction=scenario.spacecraft.solar_power_min_disk_fraction,
        policy=policy,
    )
