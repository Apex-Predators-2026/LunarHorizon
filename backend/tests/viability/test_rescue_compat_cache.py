"""Validated-sample cache of the Rescue compatibility layer (``compat/rescue.py``, rescue-compat 0.4.0).

The cache must be invisible except for speed. Every test compares the cached path with the uncached reference
path (forced by treating the timeline as non-float, which the layer converts without the cache) and requires
identical series, identical canonical assessments and identical Rescue results, byte for byte as JSON. Covered:
real and synthetic (simulation) data, the final-sample coverage boundary, fractional durations, single-sample
missions, missing values, in-place mutation, signed zero, errors, non-float arrays, the LRU bound and threads.
"""

from __future__ import annotations

from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from app.models import MissionRequirements as RescueRequirements
from app.models import Scenario, Site
from app.rescue.catalog import get_site
from app.rescue.timeline import PrecomputedTimelineProvider, SyntheticTimelineProvider, Timeline
from app.viability.compat import rescue as compat
from app.viability.compat.rescue import (
    RescueCompatError,
    clear_sample_cache,
    evaluate_timeline_detailed,
    precomputed_file_info,
    sample_cache_info,
    scenario_to_mission,
    timeline_to_series,
)
from app.viability.inputs import ScientificTimeSeries

from .real_data import DATA_END

SITES_DIR = Path(__file__).resolve().parents[3] / "data" / "sites"
REAL = ("malapert-massif", "connecting-ridge", "peak-near-shackleton")
needs_real = pytest.mark.skipif(
    not all((SITES_DIR / f"{s}.json").exists() for s in REAL), reason="committed site files not present"
)


@pytest.fixture(autouse=True)
def _fresh_cache() -> Iterator[None]:
    clear_sample_cache()
    yield
    clear_sample_cache()


@contextmanager
def reference_path(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Force the uncached reference conversion (the pre-0.4.0 behaviour)."""
    with monkeypatch.context() as m:
        m.setattr(compat, "_float_columns", lambda timeline: False)
        yield


def scenario(site_id: str, landing: datetime, days: float, **req: float) -> Scenario:
    return Scenario(
        site=get_site(site_id).to_site(),
        landing_utc=landing,
        duration_days=days,
        requirements=RescueRequirements(**req),
    )


def rescue_timeline(sc: Scenario, provider: Any) -> Timeline:
    """Exactly what rescue's Evaluator passes: max(1, round(duration * 24)) hourly samples from landing."""
    n = max(1, round(sc.duration_days * 24))
    tl: Timeline = provider.timeline(sc.site, sc.landing_utc, sc.landing_utc + timedelta(hours=n - 1), 1.0)
    return tl.slice(0, n)


def both_paths(
    sc: Scenario, tl: Timeline, monkeypatch: pytest.MonkeyPatch
) -> tuple[ScientificTimeSeries, ScientificTimeSeries]:
    end = scenario_to_mission(sc).mission_end_utc
    with reference_path(monkeypatch):
        ref = timeline_to_series(tl, mission_end_utc=end)
    cold = timeline_to_series(tl, mission_end_utc=end)  # fills the cache
    warm = timeline_to_series(tl, mission_end_utc=end)  # served from it
    assert cold == warm == ref
    assert cold.model_dump_json() == warm.model_dump_json() == ref.model_dump_json()
    return warm, ref


def assert_same_evaluation(sc: Scenario, tl: Timeline, monkeypatch: pytest.MonkeyPatch) -> None:
    with reference_path(monkeypatch):
        ref_result, ref_assessment = evaluate_timeline_detailed(sc, tl)
    for _ in range(2):  # cold, then warm
        result, assessment = evaluate_timeline_detailed(sc, tl)
        assert result.model_dump_json() == ref_result.model_dump_json()
        assert assessment.model_dump_json() == ref_assessment.model_dump_json()


SYNTHETIC_CASES = [
    ("peak-near-shackleton", datetime(2027, 1, 7, tzinfo=UTC), 7.0),
    ("malapert-massif", datetime(2027, 3, 1, 5, tzinfo=UTC), 1.0),
    ("connecting-ridge", datetime(2027, 6, 1, tzinfo=UTC), 1.2),  # fractional: final half step stays unknown
    ("connecting-ridge", datetime(2027, 6, 1, tzinfo=UTC), 0.5),
    ("connecting-ridge", datetime(2027, 6, 1, tzinfo=UTC), 0.04),  # one sample, one held bin
]


@pytest.mark.parametrize(("site", "landing", "days"), SYNTHETIC_CASES)
def test_synthetic_simulation_data_identical(
    site: str, landing: datetime, days: float, monkeypatch: pytest.MonkeyPatch
) -> None:
    sc = scenario(site, landing, days)
    tl = rescue_timeline(sc, SyntheticTimelineProvider())
    series, _ = both_paths(sc, tl, monkeypatch)
    assert series.provenance.is_synthetic is True  # simulation semantics are series-level and unchanged
    assert_same_evaluation(sc, tl, monkeypatch)


def _real_cases() -> list[tuple[str, datetime, float]]:
    end = DATA_END
    return [
        ("malapert-massif", datetime(2027, 7, 20, tzinfo=UTC), 14.0),  # PASS
        ("connecting-ridge", datetime(2027, 3, 1, tzinfo=UTC), 14.0),  # FAIL
        ("peak-near-shackleton", datetime(2027, 10, 13, tzinfo=UTC), 14.0),
        ("connecting-ridge", end - timedelta(hours=72), 3.0),  # final bin covered by the file: held one step
        ("connecting-ridge", end - timedelta(hours=71), 3.0),  # final bin past the data: NOT extended (bounded)
        ("malapert-massif", end - timedelta(hours=23), 1.0),  # 1-day mission whose last hour is past the data
        ("malapert-massif", datetime(2028, 6, 15, 7, tzinfo=UTC), 2.3),  # fractional duration on real data
    ]


@needs_real
@pytest.mark.parametrize(("site", "landing", "days"), _real_cases())
def test_real_data_identical_including_final_sample_boundary(
    site: str, landing: datetime, days: float, monkeypatch: pytest.MonkeyPatch
) -> None:
    sc = scenario(site, landing, days)
    provider = PrecomputedTimelineProvider(fallback=SyntheticTimelineProvider())
    tl = rescue_timeline(sc, provider)
    assert tl.source.startswith("precomputed:")
    series, ref = both_paths(sc, tl, monkeypatch)
    assert series.coverage_end_utc == ref.coverage_end_utc  # the final-sample rule is untouched
    assert series.provenance.is_synthetic is False
    assert_same_evaluation(sc, tl, monkeypatch)


@needs_real
def test_final_bin_extension_still_depends_on_the_file() -> None:
    provider = PrecomputedTimelineProvider(fallback=SyntheticTimelineProvider())
    covered = scenario("connecting-ridge", DATA_END - timedelta(hours=72), 3.0)
    past = scenario("connecting-ridge", DATA_END - timedelta(hours=71), 3.0)
    for _ in range(2):  # with an empty and a filled cache
        s1 = timeline_to_series(rescue_timeline(covered, provider), mission_end_utc=DATA_END)
        assert s1.coverage_end_utc == DATA_END  # held for one step, inside the file
        end = DATA_END + timedelta(hours=1)
        s2 = timeline_to_series(rescue_timeline(past, provider), mission_end_utc=end)
        assert s2.coverage_end_utc == DATA_END  # last sample is at DATA_END; never extended past the file


@needs_real
def test_overlapping_rescue_slices_reuse_samples(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = PrecomputedTimelineProvider(fallback=SyntheticTimelineProvider())
    site = get_site("malapert-massif").to_site()
    start = datetime(2027, 7, 1, tzinfo=UTC)
    parent = provider.timeline(site, start, start + timedelta(days=10), 1.0)
    for k in range(0, 72, 12):  # landings every 12 h, 7-day missions, as in a rescue date search
        sc = Scenario(site=site, landing_utc=start + timedelta(hours=k), duration_days=7)
        tl = parent.slice(k, k + 168)
        both_paths(sc, tl, monkeypatch)
    info = sample_cache_info()
    assert info.size == 168 + 60  # every distinct sample converted once
    assert info.hits > info.misses


def test_missing_values_and_in_place_mutation(monkeypatch: pytest.MonkeyPatch) -> None:
    sc = scenario("peak-near-shackleton", datetime(2027, 1, 7, tzinfo=UTC), 2.0)
    tl = rescue_timeline(sc, SyntheticTimelineProvider())
    before, _ = both_paths(sc, tl, monkeypatch)
    # Rescue's arrays are mutable: change samples in place after they were cached.
    tl.sun_horizon[3] = np.nan
    tl.sun_visible_fraction[3] = np.nan
    tl.earth_el[5] = np.nan
    after, _ = both_paths(sc, tl, monkeypatch)
    assert before.samples[3] != after.samples[3]
    assert after.samples[3].sun.state.value == "unknown" and after.samples[5].earth.state.value == "unknown"
    assert before.samples[4] is after.samples[4]  # untouched samples are shared, immutable objects


def test_signed_zero_is_not_conflated(monkeypatch: pytest.MonkeyPatch) -> None:
    sc = scenario("peak-near-shackleton", datetime(2027, 1, 7, tzinfo=UTC), 1.0)
    tl = rescue_timeline(sc, SyntheticTimelineProvider())
    tl.earth_horizon[2] = 0.0
    a, _ = both_paths(sc, tl, monkeypatch)
    tl.earth_horizon[2] = -0.0
    b, ref = both_paths(sc, tl, monkeypatch)
    assert b.model_dump_json() == ref.model_dump_json()
    assert a.samples[2] is not b.samples[2]


def test_conversion_errors_are_identical_and_never_cached(monkeypatch: pytest.MonkeyPatch) -> None:
    sc = scenario("peak-near-shackleton", datetime(2027, 1, 7, tzinfo=UTC), 2.0)
    tl = rescue_timeline(sc, SyntheticTimelineProvider())
    timeline_to_series(tl)  # cache every valid sample first
    size = sample_cache_info().size
    bad = [
        ("sun_horizon", 3, np.nan),  # fraction without the horizon it depends on: inconsistent
        ("sun_az", 4, 400.0),  # azimuth outside [0, 360]
        ("sun_visible_fraction", 6, 1.5),  # fraction outside [0, 1]
        ("sun_el", 7, 95.0),  # elevation outside the contract range (series validation)
    ]
    for name, i, value in bad:
        broken = tl.slice(0, len(tl))
        column = getattr(broken, name).copy()
        column[i] = value
        setattr(broken, name, column)
        with reference_path(monkeypatch), pytest.raises(RescueCompatError) as ref:
            timeline_to_series(broken)
        with pytest.raises(RescueCompatError) as fast:
            timeline_to_series(broken)
        assert str(fast.value) == str(ref.value), name
        assert sample_cache_info().size == size  # the invalid sample was not cached


def test_non_float_arrays_take_the_reference_path(monkeypatch: pytest.MonkeyPatch) -> None:
    sc = scenario("peak-near-shackleton", datetime(2027, 1, 7, tzinfo=UTC), 1.0)
    tl = rescue_timeline(sc, SyntheticTimelineProvider())
    as_int = tl.slice(0, len(tl))
    as_int.sun_horizon = np.round(tl.sun_horizon).astype(np.int64)  # integer column: never keyed as doubles
    with reference_path(monkeypatch):
        ref = timeline_to_series(as_int)
    misses = sample_cache_info().misses
    assert timeline_to_series(as_int).model_dump_json() == ref.model_dump_json()
    assert sample_cache_info().misses == misses  # cache not consulted


def test_same_values_real_and_synthetic_keep_their_own_provenance() -> None:
    sc = scenario("malapert-massif", datetime(2027, 7, 20, tzinfo=UTC), 1.0)
    synthetic = rescue_timeline(sc, SyntheticTimelineProvider())
    relabelled = synthetic.slice(0, len(synthetic))
    relabelled.source = "precomputed:not-a-file.json"  # same values, claimed real (file not found)
    a = timeline_to_series(synthetic)
    b = timeline_to_series(relabelled)
    assert a.samples == b.samples
    assert a.provenance.is_synthetic is True and b.provenance.is_synthetic is False
    assert a.angle_type != b.angle_type


def test_lru_bound_and_eviction() -> None:
    cache = compat._SampleCache(maxsize=3)
    sc = scenario("peak-near-shackleton", datetime(2027, 1, 7, tzinfo=UTC), 1.0)
    samples = timeline_to_series(rescue_timeline(sc, SyntheticTimelineProvider())).samples
    cache.put_many([(b"a", samples[0]), (b"b", samples[1]), (b"c", samples[2])])
    assert cache.get_many([b"a"]) == [samples[0]]  # "a" becomes most recently used
    cache.put_many([(b"d", samples[3])])  # evicts "b", the least recently used
    assert cache.get_many([b"a", b"b", b"c", b"d"]) == [samples[0], None, samples[2], samples[3]]
    assert cache.info().size == 3 and cache.info().maxsize == 3
    assert compat.SAMPLE_CACHE_SIZE == sample_cache_info().maxsize


def test_concurrent_evaluations_are_identical(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = SyntheticTimelineProvider()
    cases = [
        scenario("peak-near-shackleton", datetime(2027, 1, 7, tzinfo=UTC) + timedelta(hours=6 * k), 3.0)
        for k in range(8)
    ]
    timelines = [rescue_timeline(sc, provider) for sc in cases]
    with reference_path(monkeypatch):
        expected = [evaluate_timeline_detailed(sc, tl)[1].model_dump_json() for sc, tl in zip(cases, timelines)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        got = list(pool.map(lambda p: evaluate_timeline_detailed(*p)[1].model_dump_json(), zip(cases, timelines)))
    assert got == expected


def test_source_path_resolution_cache_still_checks_the_file(tmp_path: Path) -> None:
    (tmp_path / "x.json").write_text('{"timeline": {"time_utc": ["2027-01-01T00:00Z"]}}', encoding="utf-8")
    info = precomputed_file_info("precomputed:x.json", tmp_path)
    assert info is not None and info.last_sample_utc == datetime(2027, 1, 1, tzinfo=UTC)
    (tmp_path / "x.json").unlink()
    assert precomputed_file_info("precomputed:x.json", tmp_path) is None  # resolution cached, existence not
    assert precomputed_file_info("precomputed:../outside.json", tmp_path / "sub") is None


def test_site_objects_are_not_part_of_sample_identity() -> None:
    sc = scenario("peak-near-shackleton", datetime(2027, 1, 7, tzinfo=UTC), 1.0)
    tl = rescue_timeline(sc, SyntheticTimelineProvider())
    moved = tl.slice(0, len(tl))
    moved.site = Site(id="other-site", name="Other", lat=-89.0, lon=10.0)
    a, b = timeline_to_series(tl), timeline_to_series(moved)
    assert a.samples == b.samples and a.site != b.site and a.dataset_id != b.dataset_id
