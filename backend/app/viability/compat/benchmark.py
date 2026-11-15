"""Benchmark of Rescue requests through the canonical-engine compatibility layer (Member 2).

Runs fixed, realistic Rescue / Compromise / Sensitivity requests on Member 1's committed site files through
Rescue's production path (``Evaluator`` -> ``compat.rescue.evaluate_timeline`` -> ``evaluate_scenario``) and
reports wall time, evaluation counts and a SHA-256 of every full JSON response. The fingerprints let a run before
and a run after a change prove that the responses are byte-identical.

``cold`` clears the layer's sample cache before each timed run (what the first request after a restart sees, apart
from file loading); ``warm`` repeats the request with the cache kept (later requests in the same server process).
Rescue's own timeline files are loaded once by a warm-up run before anything is timed, in both modes.

    cd backend && python -m app.viability.compat.benchmark [--repeats N] [--out FILE.json]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import statistics
import time
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final

from pydantic import BaseModel

from ...rescue.catalog import get_site
from ...rescue.compromise import compromise
from ...rescue.engine import Evaluator
from ...rescue.schemas import CompromiseRequest, RescueRequest, SensitivityRequest
from ...rescue.search import rescue
from ...rescue.sensitivity import analyse
from . import rescue as compat

BENCHMARK_VERSION: Final = "rescue-compat-benchmark-v1"


def _scenario(site_id: str, landing: datetime, days: float) -> dict[str, Any]:
    return {
        "site": get_site(site_id).to_site().model_dump(mode="json"),
        "landing_utc": landing.isoformat().replace("+00:00", "Z"),
        "duration_days": days,
    }


def requests() -> list[tuple[str, Callable[[Any, Evaluator], BaseModel], BaseModel]]:
    """The fixed workload: default search options throughout (30-day window, 12 h steps, all catalog sites)."""
    pass_plan = _scenario("malapert-massif", datetime(2027, 7, 20, tzinfo=UTC), 14)
    fail_plan = _scenario("connecting-ridge", datetime(2027, 3, 1, tzinfo=UTC), 14)
    return [
        (
            "rescue: Malapert Massif 14 d, launch slips 21 d",
            rescue,
            RescueRequest.model_validate({"original": pass_plan, "change": {"launch_delay_days": 21}}),
        ),
        (
            "rescue: Connecting Ridge 14 d (fails), no delay",
            rescue,
            RescueRequest.model_validate({"original": fail_plan}),
        ),
        (
            "rescue (simulation mode): Malapert Massif, slips 21 d",
            rescue,
            RescueRequest.model_validate(
                {"original": pass_plan, "change": {"launch_delay_days": 21}, "search": {"include_synthetic": True}}
            ),
        ),
        (
            "compromise: Malapert Massif 14 d vs Haworth PSR",
            compromise,
            CompromiseRequest.model_validate({"scenario": pass_plan, "science": {"target_psr_id": "haworth-psr"}}),
        ),
        (
            "sensitivity: Malapert Massif 14 d",
            analyse,
            SensitivityRequest.model_validate({"scenario": pass_plan}),
        ),
    ]


def _clear() -> None:
    clear = getattr(compat, "clear_sample_cache", None)  # absent before the cache existed
    if clear is not None:
        clear()


def run(repeats: int = 3) -> dict[str, Any]:
    ev = Evaluator()
    workload = requests()
    for _, fn, req in workload:  # warm-up: loads Rescue's timeline files (not part of the layer)
        fn(req, ev)
    results = []
    for name, fn, req in workload:
        cold, warm, digests = [], [], set()
        evaluations = 0
        for _ in range(repeats):
            _clear()
            e0 = ev.evaluations
            t0 = time.perf_counter()
            out = fn(req, ev)
            cold.append(time.perf_counter() - t0)
            evaluations = ev.evaluations - e0
            digests.add(hashlib.sha256(out.model_dump_json().encode()).hexdigest())
            t0 = time.perf_counter()
            out = fn(req, ev)
            warm.append(time.perf_counter() - t0)
            digests.add(hashlib.sha256(out.model_dump_json().encode()).hexdigest())
        if len(digests) != 1:
            raise RuntimeError(f"{name}: responses differ between runs: {sorted(digests)}")
        results.append(
            {
                "request": name,
                "evaluations": evaluations,
                "cold_median_s": statistics.median(cold),
                "warm_median_s": statistics.median(warm),
                "cold_s": cold,
                "warm_s": warm,
                "response_sha256": digests.pop(),
            }
        )
    info = getattr(compat, "sample_cache_info", None)
    return {
        "benchmark_version": BENCHMARK_VERSION,
        "compat_version": compat.COMPAT_VERSION,
        "repeats": repeats,
        "machine": {"platform": platform.platform(), "python": platform.python_version()},
        "sample_cache": None if info is None else info()._asdict(),
        "results": results,
    }


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m app.viability.compat.benchmark", description=__doc__.splitlines()[0])
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--out", type=Path, help="write the JSON result here")
    args = ap.parse_args(argv)
    report = run(args.repeats)
    for r in report["results"]:
        print(
            f"{r['request']:<55} {r['evaluations']:>5} evals  cold {r['cold_median_s']:6.2f} s  "
            f"warm {r['warm_median_s']:6.2f} s  sha256 {r['response_sha256'][:16]}"
        )
    if args.out:
        args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
