"""Phase 6 integration: explanations inside ``evaluate_scenario`` and on rescue's compatibility path.

Everything runs through the real engine; nothing is mocked except where a test replaces
``generate_explanations`` to prove that explanations never feed back into any other field.

* REAL, terrain-aware: Member 1's precomputed site files (``data/sites``), via the canonical site-file
  adapter and via rescue's own ``PrecomputedTimelineProvider`` + ``Evaluator``.
* SYNTHETIC: rescue's synthetic provider (simulation mode) and the hand-checkable ``helpers.hourly`` series.

Rescue findings that need Member 5 (score ``None`` ranked as zero, real and synthetic candidates in one
ranking, the dataset's last instant) are documented in docs/viability-engine.md section 5g. The tests here
pin only what the canonical side guarantees for them, never rescue's own behaviour.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from app.models import Scenario
from app.rescue.catalog import get_site
from app.rescue.engine import Evaluator, is_real
from app.rescue.timeline import SyntheticTimelineProvider
from app.viability import ENGINE_VERSION, explain_assessment, explain_assessment_details, rank_assessments
from app.viability import engine as engine_module
from app.viability.adapters import load_site_file
from app.viability.compat.rescue import (
    SOURCE,
    assessment_to_result,
    evaluate_timeline_detailed,
    make_evaluate_fn,
)
from app.viability.engine import evaluate_scenario
from app.viability.enums import (
    ConstraintStatus,
    DataBasis,
    Eligibility,
    ExplanationCategory,
    ScoreStatus,
)
from app.viability.inputs import ScientificTimeSeries
from app.viability.outputs import Explanation, ViabilityAssessment
from app.viability.risk import SYNTHETIC_PREFIX

from .test_explain_phase6 import assert_consistent
from .test_phase5_integration import GOOD, HALF, UNKNOWN_TAIL, real_scenario, run

REPO = Path(__file__).resolve().parents[3]
SITES_DIR = REPO / "data" / "sites"
DOCS = REPO / "docs" / "viability-engine.md"
SITES = ("connecting-ridge", "malapert-massif", "peak-near-shackleton", "shackleton-floor")
RESCUE_SITES = ("peak-near-shackleton", "connecting-ridge", "malapert-massif")
DATA_END = datetime(2029, 1, 1, tzinfo=UTC)  # last sample instant of every committed site file

pytestmark = pytest.mark.skipif(
    not all((SITES_DIR / f"{s}.json").exists() for s in SITES), reason="precomputed site files not present"
)


def scenario(site_id: str, landing: datetime, days: float = 14.0) -> Scenario:
    return Scenario.model_validate({"site": get_site(site_id).to_site(), "landing_utc": landing, "duration_days": days})


def rescue_timeline(ev: Evaluator, sc: Scenario) -> Any:
    n = max(1, round(sc.duration_days * 24))
    return ev.provider.timeline(sc.site, sc.landing_utc, sc.landing_utc + timedelta(hours=n - 1), 1.0)


@pytest.fixture(scope="module")
def series() -> dict[str, ScientificTimeSeries]:
    return {s: load_site_file(SITES_DIR / f"{s}.json") for s in SITES}


@pytest.fixture(scope="module")
def real_assessments(series: dict[str, ScientificTimeSeries]) -> dict[str, ViabilityAssessment]:
    from app.viability.windows import prepare_series

    out = {}
    for s in SITES:
        p = prepare_series(series[s])
        out[s] = evaluate_scenario(real_scenario(p, f"p6-{s}"), p.series)
    return out


# --- 1. evaluate_scenario fills explanations from the finished assessment ------------------------------------


@pytest.mark.parametrize("site", SITES)
def test_real_site_explanations_match_the_assessment(
    site: str, real_assessments: dict[str, ViabilityAssessment]
) -> None:
    a = real_assessments[site]
    assert a.engine_version == ENGINE_VERSION == "0.6.0-phase6"
    assert a.explanations, "Phase 6: an assessment always carries explanations"
    assert a.explanations == explain_assessment(a)
    items = explain_assessment_details(a)
    assert_consistent(a, items)  # Phase 6A's full consistency check, on the integrated output
    claimed = [code for d in items for code in d.risk_codes]
    assert sorted(claimed) == sorted(r.code for r in a.risks), "every risk indicator explained exactly once"
    assert not any(e.message.startswith(SYNTHETIC_PREFIX) for e in a.explanations)


@pytest.mark.parametrize(
    ("sun", "eligibility", "score_status"),
    [
        (GOOD, Eligibility.PASS, ScoreStatus.KNOWN),
        (HALF, Eligibility.PASS, ScoreStatus.KNOWN),
        (UNKNOWN_TAIL, Eligibility.PASS, ScoreStatus.BOUNDED),
        (["V"] * 2 + ["N"] * 46, Eligibility.FAIL, ScoreStatus.KNOWN),
        (["V"] * 4 + ["U"] * 44, Eligibility.UNKNOWN, ScoreStatus.ELIGIBILITY_UNKNOWN),
    ],
)
def test_synthetic_pipeline_explanations_for_every_verdict(
    sun: list[str], eligibility: Eligibility, score_status: ScoreStatus
) -> None:
    a = run(sun, "p6-syn")
    assert a.eligibility is eligibility and a.score.status is score_status
    assert_consistent(a, explain_assessment_details(a))
    assert all(e.message.startswith(SYNTHETIC_PREFIX) for e in a.explanations)
    if eligibility is Eligibility.UNKNOWN:
        unknown = [c for c in a.constraints if c.status is ConstraintStatus.UNKNOWN]
        assert unknown and not any(c.status is ConstraintStatus.FAIL for c in a.constraints)
        assert not any(": FAIL" in e.message for e in a.explanations)  # UNKNOWN is never called a failure


def test_explanations_never_feed_back_into_the_assessment(
    series: dict[str, ScientificTimeSeries], monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.viability.windows import prepare_series

    p = prepare_series(series["malapert-massif"])
    sc = real_scenario(p, "p6-feedback")
    with_text = evaluate_scenario(sc, p.series)
    monkeypatch.setattr(engine_module, "generate_explanations", lambda *a, **k: [])
    without = engine_module.evaluate_scenario(sc, p.series)
    assert without.explanations == [] and with_text.explanations
    assert with_text.model_dump(exclude={"explanations"}) == without.model_dump(exclude={"explanations"})


def test_ranking_is_unchanged_by_explanations(real_assessments: dict[str, ViabilityAssessment]) -> None:
    items = list(real_assessments.values())
    stripped = [a.model_copy(update={"explanations": []}) for a in items]
    assert rank_assessments(items) == rank_assessments(stripped)


def test_assessment_with_explanations_round_trips_json(real_assessments: dict[str, ViabilityAssessment]) -> None:
    for a in real_assessments.values():
        back = ViabilityAssessment.model_validate_json(a.model_dump_json())
        assert back == a and back.explanations == a.explanations
        assert all(isinstance(e, Explanation) for e in back.explanations)


# --- 2. rescue compatibility path ------------------------------------------------------------------------------


@pytest.mark.parametrize("site_id", RESCUE_SITES)
def test_rescue_results_are_unchanged_by_explanations(site_id: str) -> None:
    ev = Evaluator()
    for landing in (datetime(2027, 3, 1, tzinfo=UTC), datetime(2028, 6, 15, tzinfo=UTC)):
        sc = scenario(site_id, landing)
        tl = rescue_timeline(ev, sc)
        result, a = evaluate_timeline_detailed(sc, tl)
        assert tl.source.startswith("precomputed") and is_real(result) and result.source == SOURCE
        assert a.explanations == explain_assessment(a)
        assert assessment_to_result(a.model_copy(update={"explanations": []}), sc, tl.source) == result
        assert result.verdict == a.eligibility.value


def test_simulation_path_labels_every_explanation_synthetic() -> None:
    ev = Evaluator(provider=SyntheticTimelineProvider(), evaluate=make_evaluate_fn(), simulation=True)
    sc = scenario("malapert-massif", datetime(2030, 3, 1, tzinfo=UTC), 7)
    result, a = evaluate_timeline_detailed(sc, rescue_timeline(ev, sc))
    assert a.data_quality.provenance.is_synthetic and a.data_basis is DataBasis.SYNTHETIC
    assert not is_real(result)
    assert a.explanations and all(e.message.startswith(SYNTHETIC_PREFIX) for e in a.explanations)
    data = [e for e in a.explanations if e.category is ExplanationCategory.DATA_QUALITY]
    assert any("SIMULATION" in e.message for e in data)


@pytest.mark.parametrize(("site_id", "days"), [("connecting-ridge", 3), ("malapert-massif", 3), ("malapert-massif", 7)])
def test_bounded_pass_at_dataset_end_carries_proven_bounds_for_rescue(site_id: str, days: int) -> None:
    """Known rescue issue (docs 5g, finding 3): the latest landing rescue accepts ends one hour after the file's last
    sample. The canonical engine does not invent that hour: the score is BOUNDED, rescue's ``score`` is None
    and rescue currently ranks it as 0. The interval needed for a conservative ordering is always there."""
    ev = Evaluator()
    landing = DATA_END - timedelta(hours=days * 24 - 1)
    sc = scenario(site_id, landing, days)
    result, a = evaluate_timeline_detailed(sc, rescue_timeline(ev, sc))
    assert is_real(result) and result.verdict == "pass" and result.score is None
    assert a.eligibility is Eligibility.PASS and a.score.status is ScoreStatus.BOUNDED and a.score.score is None
    b = a.score.score_bounds
    assert b is not None and b.lower is not None and b.upper is not None and 0.0 < b.lower <= b.upper <= 100.0
    one_hour_earlier = evaluate_timeline_detailed(
        scenario(site_id, landing - timedelta(hours=1), days),
        rescue_timeline(ev, scenario(site_id, landing - timedelta(hours=1), days)),
    )[0]
    assert one_hour_earlier.score is not None  # fully covered: exact score
    text = " ".join(e.message for e in a.explanations if e.category is ExplanationCategory.SUMMARY)
    assert "lower bound" in text and "that bound is not the score" in text  # an interval, never a point


# --- 3. documentation --------------------------------------------------------------------------------------------


def test_docs_have_a_phase6_section() -> None:
    text = DOCS.read_text(encoding="utf-8")
    for needle in (
        "## 5g. Phase 6: explanations and Rescue integration",
        "### Phase 6A: evidence-based explanations",
        "### Phase 6B: Rescue compatibility validation",
        "### Rescue integration findings (for Member 5)",
        "**Required change for Arush (not made here).**",
        "0.6.0-phase6",
        "explanations-v1",
        "score_or_zero",
        "app/rescue/viability/__init__.py",
    ):
        assert needle in text, needle
