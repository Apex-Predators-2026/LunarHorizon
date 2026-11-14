"""Member 2 Part 2, Work Package E: the validation suite and the decision-evidence demonstration, as tests.

One module-scoped run of ``app.viability.validation.suite.run_validation`` (all committed site files; quick timing
workload) backs every test, so each smoke, case and invariant check appears as its own assertion with the suite's
detail message. The demonstration is rebuilt from the same loaded datasets and compared with the committed snapshot
``docs/member2-part2-demo.json`` while the site files it records (sha256) are unchanged.
"""

from __future__ import annotations

import hashlib
import json
from datetime import timedelta
from fractions import Fraction
from pathlib import Path
from typing import Any

import pytest

from app import viability
from app.viability import SamplingPolicy, evaluate_scenario, prepare_series
from app.viability.sampling_sensitivity import prepare_policy_series, sampling_sensitivity_report
from app.viability.validation import demo as demo_mod
from app.viability.validation.suite import (
    SITES_DIR,
    Dataset,
    case_names,
    load_datasets,
    mission,
    run_validation,
    summarize,
)

from .real_data import REGRESSION_START

REPO = Path(__file__).resolve().parents[3]
SNAPSHOT = REPO / "docs" / "member2-part2-demo.json"
COMMITTED_SITE_FILES = len(list(SITES_DIR.glob("*.json")))

pytestmark = pytest.mark.skipif(COMMITTED_SITE_FILES == 0, reason="precomputed site files not present")


@pytest.fixture(scope="module")
def datasets() -> dict[str, Dataset]:
    return load_datasets()


@pytest.fixture(scope="module")
def report(datasets: dict[str, Dataset]) -> dict[str, Any]:
    return run_validation(quick=True, datasets=datasets)


# --- smoke coverage of every committed dataset ------------------------------------------------------------------


def test_every_committed_dataset_is_covered(report: dict[str, Any]) -> None:
    assert COMMITTED_SITE_FILES >= 24
    assert report["smoke"]["datasets"] == COMMITTED_SITE_FILES == len(report["datasets"])
    assert {d["site_id"] for d in report["datasets"]} == {p.stem for p in SITES_DIR.glob("*.json")}
    assert report["smoke"]["failed"] == [], report["smoke"]["failed"][:5]
    # Three evaluations per dataset, each with at least the consistency checks.
    assert report["smoke"]["checks"] >= COMMITTED_SITE_FILES * (6 + 3 * 10)


def test_dataset_identities_are_recorded(report: dict[str, Any]) -> None:
    for d in report["datasets"]:
        path = SITES_DIR / Path(d["file"]).name
        assert d["sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()
        assert d["is_synthetic"] is False and d["calculation_basis"] == "terrain_aware"
        assert d["sample_count"] >= 2 and d["nominal_interval_s"] == 3600.0
        assert d["generator"] and d["ephemeris_source"] and d["terrain_source"]


# --- deep cases -------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("name", case_names())
def test_deep_case(report: dict[str, Any], name: str) -> None:
    case = next(c for c in report["cases"] if c["name"] == name)
    failed = [f"{k['name']}: {k['detail']}" for k in case["checks"] if not k["passed"]]
    assert case["checks"] and not failed, failed


def test_cases_cover_every_required_condition(report: dict[str, Any]) -> None:
    categories = " | ".join(c["category"] for c in report["cases"])
    for needed in (
        "PASS",
        "confirmed FAIL",
        "high screening risk",
        "UNKNOWN from missing data",
        "bounded score",
        "overlapping candidate score intervals",
        "exact ranking",
        "incompatible configurations",
        "synthetic data kept separate",
        "dataset boundary",
        "sampling-policy agreement and disagreement",
    ):
        assert needed in categories, needed
    synthetic = [c["name"] for c in report["cases"] if c["synthetic"]]
    assert synthetic == ["synthetic_kept_separate"]  # every other case is real data


# --- invariants -------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "fragment",
    [
        "stricter operational limits",
        "missing data never creates certainty",
        "preference-weight changes never alter eligibility",
        "explanation generation never changes",
        "ranking is deterministic regardless of input order",
    ],
)
def test_invariant(report: dict[str, Any], fragment: str) -> None:
    inv = next(i for i in report["invariants"] if fragment in i["name"])
    assert inv["passed"], inv["detail"]


# --- versions, timing, machine ----------------------------------------------------------------------------------


def test_versions_timing_and_machine_are_recorded(report: dict[str, Any]) -> None:
    v = report["versions"]
    assert v["engine"] == viability.ENGINE_VERSION and v["scoring_method"] == viability.SCORING_METHOD_VERSION
    assert v["default_sampling_policy"] == "sample_hold" and v["alternate_sampling_policy"] == "nearest_sample"
    t = report["timing"]
    prep = t["data_preparation"]
    assert len(prep["per_site"]) == COMMITTED_SITE_FILES
    assert prep["total_load_s"] > 0 and prep["total_prepare_s"] > 0  # measured separately from evaluation
    for key in ("evaluate_scenario", "sampling_sensitivity_report", "rank_assessments"):
        assert t[key]["n"] > 0 and t[key]["median_ms"] > 0 and t[key]["workload"]
    m = report["machine"]
    assert m["python"] and m["platform"] and m["cpu_count"]
    assert report["summary"]["failed"] == 0
    text = summarize(report)
    assert "failed: 0" in text and "data preparation" in text
    json.dumps(report)  # JSON-ready


# --- canonical wiring of the sampling policy (integration) ------------------------------------------------------


def test_evaluate_scenario_policy_keyword_is_backward_compatible(datasets: dict[str, Dataset]) -> None:
    ds = datasets["malapert-massif"]
    sc = mission(ds, REGRESSION_START + timedelta(days=200, hours=14), timedelta(days=14))
    canonical = evaluate_scenario(sc, ds.series)
    assert evaluate_scenario(sc, ds.prepared) == canonical
    assert evaluate_scenario(sc, ds.series, policy=SamplingPolicy.SAMPLE_HOLD) == canonical
    pair = prepare_policy_series(ds.series)
    report = sampling_sensitivity_report(sc, pair)
    assert report.baseline.assessment == canonical
    assert evaluate_scenario(sc, ds.series, policy=SamplingPolicy.NEAREST_SAMPLE) == report.alternate.assessment
    with pytest.raises(ValueError):
        evaluate_scenario(sc, prepare_series(ds.series), policy=SamplingPolicy.NEAREST_SAMPLE)


def test_part2_entry_points_are_exported() -> None:
    for name in (
        "compare_scenarios",
        "explain_adjacent",
        "PairwiseEvidence",
        "RankingCriterion",
        "EVIDENCE_METHOD_VERSION",
        "sampling_sensitivity_report",
        "prepare_policy_series",
        "SamplingSensitivityReport",
        "SensitivityVerdict",
        "CoverageAdequacy",
        "PolicySeriesPair",
        "SENSITIVITY_METHOD_VERSION",
    ):
        assert name in viability.__all__ and hasattr(viability, name), name


# --- demonstration ----------------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def demo(datasets: dict[str, Dataset]) -> dict[str, Any]:
    return demo_mod.build_demo(datasets)


def test_demo_claims_follow_from_the_assessments(demo: dict[str, Any], datasets: dict[str, Dataset]) -> None:
    cands = demo["candidates"]
    assert set(cands) == set(demo_mod.CANDIDATES)
    for sid, c in cands.items():
        direct = evaluate_scenario(
            mission(datasets[sid], demo_mod.LANDING, demo_mod.DURATION, scenario_id=sid), datasets[sid].prepared
        )
        assert c["eligibility"] == direct.eligibility.value
        assert c["score"]["score"] == direct.score.score
        assert c["overall_risk"] == direct.overall_risk.value
        assert c["data_basis"] == "real_terrain_aware" and c["coverage"]["uncovered_h"] == 0.0
    w = demo["why_first"]
    assert w["first"] == demo["ranking"][0]["scenario_id"]
    lo, hi = (Fraction(repr(x)) for x in w["score_difference_points"])
    first, second = (Fraction(repr(cands[e["scenario_id"]]["score"]["score"])) for e in demo["ranking"])
    diff = first - second  # exact on the stored 6-decimal scores, as the evidence computes it
    assert lo <= diff <= hi  # outward-rounded interval contains the exact difference
    assert w["clearly_established"] is (lo > 0)
    # The component contribution differences add up to the score difference (exact scores, active components).
    parts = [m["contribution_difference_points"] for m in demo["measurements"] if m["advantage"] != "inactive"]
    tol = Fraction(1, 10**5)
    assert (
        sum(Fraction(repr(q[0])) for q in parts) <= diff + tol
        and sum(Fraction(repr(q[1])) for q in parts) >= diff - tol
    )
    for sid, s in demo["sampling_sensitivity"].items():
        assert s["eligibility"][0] == cands[sid]["eligibility"]
    assert demo["limitations"] and any("not a probability" in x for x in demo["limitations"])
    assert "Decision evidence" in demo_mod.demo_text(demo)


def test_demo_snapshot_is_reproducible(demo: dict[str, Any]) -> None:
    assert SNAPSHOT.exists(), (
        "regenerate: python -m app.viability.validation.demo --out ../docs/member2-part2-demo.json"
    )
    committed = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    recorded = {d["site_id"]: d["sha256"] for d in committed["datasets"]}
    current = {d["site_id"]: d["sha256"] for d in demo["datasets"]}
    if recorded != current:
        pytest.skip("site files were regenerated since the snapshot; rerun the demo command and review the diff")
    assert demo_mod.demo_json(demo) == SNAPSHOT.read_text(encoding="utf-8")
