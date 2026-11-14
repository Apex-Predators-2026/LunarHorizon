"""Part 2A: consumer examples are produced by the real pipeline and keep every contract a consumer relies on.

Real cases read Member 1's committed site files; expectations are structural (eligibility, score state, data
basis, agreement between the canonical assessment and Rescue's legacy result), never pinned numbers.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.models import ViabilityResult
from app.viability.consumer_examples import (
    CONSUMER_EXAMPLES_VERSION,
    EXAMPLE_KEYS,
    SITES_DIR,
    ConsumerExample,
    build_examples,
    consumer_summary,
    examples_json,
    examples_payload,
)
from app.viability.engine import ENGINE_VERSION
from app.viability.enums import ConstraintStatus, DataBasis, Eligibility, MetricStatus, ScoreStatus
from app.viability.outputs import RankingResult, ViabilityAssessment
from app.viability.ranking import partition_comparable, rank_assessments
from app.viability.ranking_evidence import SYNTHETIC_PREFIX, DifferenceStatus, compare_scenarios
from app.viability.scoring import SCORING_METHOD_VERSION

DOC = Path(__file__).resolve().parents[3] / "docs" / "member2-part2-consumer-handoff.md"
REQUIRED_SITES = ("connecting-ridge", "malapert-massif")

pytestmark = pytest.mark.skipif(
    not all((SITES_DIR / f"{s}.json").exists() for s in REQUIRED_SITES), reason="precomputed site files not present"
)


@pytest.fixture(scope="module")
def examples() -> dict[str, ConsumerExample]:
    return {e.key: e for e in build_examples()}


def only(e: ConsumerExample) -> tuple[ViabilityAssessment, ViabilityResult | None]:
    assert len(e.assessments) == 1 == len(e.legacy_results)
    return e.assessments[0], e.legacy_results[0]


# --- the eight required cases ------------------------------------------------------------------------


def test_all_eight_examples_exist_in_order(examples: dict[str, ConsumerExample]) -> None:
    assert tuple(examples) == EXAMPLE_KEYS and len(EXAMPLE_KEYS) == 8


def test_pass_exact(examples: dict[str, ConsumerExample]) -> None:
    a, legacy = only(examples["pass_exact"])
    assert a.eligibility is Eligibility.PASS and a.score.status is ScoreStatus.KNOWN and a.score.score is not None
    assert a.data_basis is DataBasis.REAL_TERRAIN_AWARE and not a.data_quality.provenance.is_synthetic
    assert legacy is not None and legacy.passes and legacy.eligibility == "pass" and legacy.violations == []
    assert legacy.score == a.score.score  # the exact score passes through unchanged


def test_fail_confirmed(examples: dict[str, ConsumerExample]) -> None:
    a, legacy = only(examples["fail_confirmed"])
    failed = [c for c in a.constraints if c.status is ConstraintStatus.FAIL]
    assert a.eligibility is Eligibility.FAIL and failed and not a.score.rank_eligible
    assert legacy is not None and not legacy.passes and legacy.eligibility == "fail"
    assert {v.is_unknown for v in legacy.violations} >= {False}
    assert len([v for v in legacy.violations if not v.is_unknown]) == len(failed)
    assert rank_assessments([a]).entries[0].rank is None  # never ranked, score descriptive only


def test_unknown_from_inadequate_data(examples: dict[str, ConsumerExample]) -> None:
    a, legacy = only(examples["unknown_inadequate_data"])
    assert a.eligibility is Eligibility.UNKNOWN and legacy is None
    assert not any(c.status is ConstraintStatus.FAIL for c in a.constraints)
    assert any(c.status is ConstraintStatus.UNKNOWN and c.unknown_reason is not None for c in a.constraints)
    assert a.score.status is ScoreStatus.ELIGIBILITY_UNKNOWN and a.score.score is None and a.score.score_bounds is None
    q = a.data_quality
    assert q.uncovered_duration_s > 0.0 and min(q.sun_coverage_percent, q.earth_coverage_percent) < 100.0
    assert a.data_basis is DataBasis.REAL_TERRAIN_AWARE  # real data, just not enough of it


def test_pass_bounded(examples: dict[str, ConsumerExample]) -> None:
    a, legacy = only(examples["pass_bounded"])
    b = a.score.score_bounds
    assert a.eligibility is Eligibility.PASS and a.score.status is ScoreStatus.BOUNDED and a.score.score is None
    assert b is not None and b.status is MetricStatus.BOUNDED and b.lower is not None and b.upper is not None
    assert b.lower < b.upper
    assert legacy is not None and legacy.eligibility == "pass" and legacy.score is None  # never the lower bound
    s = consumer_summary(a)
    assert s["score"] is None and s["score_bounds"]["lower"] == b.lower and "bounded" in s["score_text"]


def test_score_unavailable_is_not_zero(examples: dict[str, ConsumerExample]) -> None:
    a, legacy = only(examples["score_unavailable"])
    assert a.eligibility is Eligibility.PASS and legacy is None
    assert (
        a.score.status is ScoreStatus.NO_SCORABLE_COMPONENTS and a.score.score is None and a.score.score_bounds is None
    )
    s = consumer_summary(a)
    assert s["score"] is None and s["score_bounds"] is None and s["score_text"].startswith("not scored")
    entry = rank_assessments([a]).entries[0]
    assert entry.rank == 1 and entry.score is None and entry.lower_bound is None
    # Same mission as pass_exact, only the weights differ: same eligibility, different comparability group.
    exact = examples["pass_exact"].assessments[0]
    assert a.eligibility is exact.eligibility and len(partition_comparable([a, exact])) == 2


def test_synthetic_input_is_labelled_everywhere(examples: dict[str, ConsumerExample]) -> None:
    a, legacy = only(examples["synthetic_input"])
    assert a.data_basis is DataBasis.SYNTHETIC and a.data_quality.provenance.is_synthetic and legacy is None
    assert "SYNTHETIC" in (a.data_quality.provenance.notes or "")
    assert a.explanations and all(x.message.startswith(SYNTHETIC_PREFIX) for x in a.explanations)
    assert (a.score.note or "").startswith(SYNTHETIC_PREFIX)
    assert consumer_summary(a)["is_synthetic"] is True


def test_comparable_pair(examples: dict[str, ConsumerExample]) -> None:
    e = examples["comparable_pair"]
    assert len(e.assessments) == 2 and e.ranking is not None and e.groups and len(e.groups) == 1
    assert [x.rank for x in e.ranking.entries] == [1, 2]
    assert e.ranking == rank_assessments(reversed(e.assessments))  # input-order independent
    (ev,) = e.evidence
    assert ev.comparable and ev.higher_id == e.ranking.entries[0].scenario_id
    assert (ev.selected.rank, ev.competitor.rank) == (1, 2)
    first = next(a for a in e.assessments if a.scenario_id == ev.higher_id)
    second = next(a for a in e.assessments if a.scenario_id != ev.higher_id)
    lb1, lb2 = first.score.lower_bound, second.score.lower_bound
    assert lb1 is not None and lb2 is not None and lb1 >= lb2
    b1, b2 = first.score.score_bounds, second.score.score_bounds
    assert b1 is not None and b2 is not None
    hi1 = b1.value if b1.status is MetricStatus.KNOWN else b1.upper
    hi2 = b2.value if b2.status is MetricStatus.KNOWN else b2.upper
    assert hi1 is not None and hi2 is not None
    overlap = lb2 <= hi1 and lb1 <= hi2
    assert (ev.score_difference.status is DifferenceStatus.NOT_ESTABLISHED) == overlap
    for r, a in zip(e.legacy_results, e.assessments, strict=True):
        assert r is not None and r.eligibility == a.eligibility.value and r.score == a.score.score


def test_separate_leaderboards(examples: dict[str, ConsumerExample]) -> None:
    e = examples["separate_leaderboards"]
    assert e.ranking is None and e.ranking_error is not None
    assert "data basis" in e.ranking_error and "partition_comparable" in e.ranking_error
    bases = {a.data_basis for a in e.assessments}
    assert bases == {DataBasis.REAL_TERRAIN_AWARE, DataBasis.SYNTHETIC}
    assert len(e.groups) == len(e.group_rankings) >= 2
    for g, r in zip(e.groups, e.group_rankings, strict=True):
        assert [x.scenario_id for x in r.entries] and set(g) == {x.scenario_id for x in r.entries}
        assert len({a.data_basis for a in e.assessments if a.scenario_id in g}) == 1
    assert e.evidence and all(not x.comparable and x.higher_id is None for x in e.evidence)
    assert all(x.score_difference.status is DifferenceStatus.NOT_COMPARABLE for x in e.evidence)
    synthetic_pair = [x for x in e.evidence if x.selected.is_synthetic or x.competitor.is_synthetic]
    assert synthetic_pair and all(x.explanation.startswith(SYNTHETIC_PREFIX) for x in synthetic_pair)


# --- preserved fields, validation, serialization -----------------------------------------------------


def test_every_assessment_is_a_validated_engine_output(examples: dict[str, ConsumerExample]) -> None:
    for e in examples.values():
        for a in e.assessments:
            assert ViabilityAssessment.model_validate(a.model_dump()) == a
            assert a.engine_version == ENGINE_VERSION and a.score.method_version == SCORING_METHOD_VERSION
            assert a.explanations and a.limitations and a.constraints


def test_summaries_quote_the_assessment(examples: dict[str, ConsumerExample]) -> None:
    for e in examples.values():
        for a in e.assessments:
            s = consumer_summary(a)
            assert s["eligibility"] == a.eligibility.value and s["score"] == a.score.score
            assert s["score_status"] == (a.score.status.value if a.score.status else None)
            assert s["data_basis"] == a.data_basis.value and s["dataset_id"] == a.data_quality.dataset_id
            assert [c["constraint_id"] for c in s["constraints"]] == [c.constraint_id.value for c in a.constraints]
            assert [x["message"] for x in s["explanations"]] == [x.message for x in a.explanations]
            if a.score.status is not ScoreStatus.KNOWN:
                assert s["score"] is None  # a bound is never shown as the score


def test_serialization_is_reproducible_and_round_trips(examples: dict[str, ConsumerExample]) -> None:
    first = examples_json(list(examples.values()))
    again = examples_json(build_examples())
    assert first == again and first.endswith("\n")
    doc: dict[str, Any] = json.loads(first)
    assert doc["consumer_examples_version"] == CONSUMER_EXAMPLES_VERSION
    assert doc["engine_version"] == ENGINE_VERSION and doc["scoring_method_version"] == SCORING_METHOD_VERSION
    assert [x["key"] for x in doc["examples"]] == list(EXAMPLE_KEYS)
    for payload, ex in zip(doc["examples"], examples.values(), strict=True):
        restored = [ViabilityAssessment.model_validate(x) for x in payload["assessments"]]
        assert restored == list(ex.assessments)
        for raw, original in zip(payload["legacy_results"], ex.legacy_results, strict=True):
            assert (raw is None) == (original is None)
            if raw is not None:
                assert ViabilityResult.model_validate(raw) == original
        if payload["ranking"] is not None:
            assert RankingResult.model_validate(payload["ranking"]) == ex.ranking
        assert len(payload["evidence"]) == len(ex.evidence)


def test_payload_versions_and_subset_build() -> None:
    (e,) = build_examples(["synthetic_input"])
    payload = examples_payload([e])
    assert payload["default_comparability_policy"] == "strict" and payload["evidence_method_version"]
    with pytest.raises(KeyError, match="unknown example"):
        build_examples(["no-such-example"])


def test_evidence_in_examples_matches_a_fresh_comparison(examples: dict[str, ConsumerExample]) -> None:
    e = examples["comparable_pair"]
    assert e.ranking is not None
    a, b = (next(x for x in e.assessments if x.scenario_id == r.scenario_id) for r in e.ranking.entries)
    assert e.evidence[0] == compare_scenarios(a, b, ranking=e.ranking)


def test_handoff_doc_covers_the_examples_and_contracts() -> None:
    text = DOC.read_text(encoding="utf-8")
    for key in EXAMPLE_KEYS:
        assert f"`{key}`" in text, key
    for phrase in (
        "evaluate_timeline_detailed",
        "evaluate_scenario",
        "score = None",
        "score_bounds",
        "no_scorable_components",
        "partition_comparable",
        "compare_scenarios",
        "[SYNTHETIC DATA]",
        "app/rescue/search.py",
        "frontend/src/features/compare/analysis.ts",
    ):
        assert phrase in text, phrase
