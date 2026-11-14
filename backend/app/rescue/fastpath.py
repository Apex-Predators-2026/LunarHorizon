"""Faster evaluation of many overlapping mission windows on one fetched timeline.

A rescue search evaluates dozens of landing times at one site, and consecutive windows overlap
almost entirely (a 7-day mission every 12 h shares 93% of its samples). The canonical engine's
compat layer converts every window's samples from scratch, and that conversion is about 70% of an
evaluation. Here the whole fetched timeline is converted ONCE by the compat layer's own
``timeline_to_series``; each window then reuses the already-validated samples.

Nothing is computed differently: the window's series is the compat layer's own series for that
window (same samples, same coverage), and it goes through the same ``evaluate_scenario`` and
``assessment_to_result``. Tests assert the series and the results equal the canonical path's.
Any problem (an unconvertible sample, a window too short to shortcut) falls back to the canonical
per-window call, so the fast path can never change a result, only skip repeated work.
"""
from __future__ import annotations

from datetime import datetime

from ..models import Scenario, ViabilityResult
from ..viability.compat import rescue as compat
from ..viability.engine import evaluate_scenario
from .timeline import Timeline

MIN_WINDOW_SAMPLES = 3  # shorter windows are converted the canonical way


def window_series(full, tl: Timeline, mission_end: datetime, i: int, j: int):
    """The compat layer's series for samples [i, j) of ``tl``, built from the pre-converted ``full``."""
    window = tl.slice(i, j)
    m = len(window)
    # The tail sample decides coverage_end and the notes, so take them from the compat layer itself.
    tail = compat.timeline_to_series(window.slice(m - 2, m), mission_end_utc=mission_end)
    first = full.samples[i].time_utc
    sid = compat.internal_site_id(window.site.id)
    return tail.model_copy(update={
        "samples": full.samples[i:j],
        "coverage_start_utc": first,
        "dataset_id": compat.internal_site_id(f"rescue_{sid}_{first:%Y%m%dT%H%M}_{m}"),
    })


def evaluate_windows(tl: Timeline, jobs: list[tuple[Scenario, int, int]]) -> list[ViabilityResult]:
    """Evaluate each (scenario, i, j) window of ``tl`` with the canonical engine."""
    try:
        full = compat.timeline_to_series(tl)
    except Exception:  # noqa: BLE001 - anything odd in the wider range: do it the canonical way
        full = None
    out = []
    for scenario, i, j in jobs:
        res = None
        if full is not None and j - i >= MIN_WINDOW_SAMPLES and j <= len(tl):
            try:
                mission = compat.scenario_to_mission(scenario)
                series = window_series(full, tl, mission.mission_end_utc, i, j)
                res = compat.assessment_to_result(evaluate_scenario(mission, series), scenario, tl.source)
            except Exception:  # noqa: BLE001
                res = None
        out.append(res if res is not None else compat.evaluate_timeline(scenario, tl.slice(i, j)))
    return out
