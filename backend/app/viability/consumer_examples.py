"""Reproducible consumer examples of the viability engine's outputs (Member 2, Part 2A).

Every example is produced by the real pipeline, never written by hand:

* real cases go through Rescue's production path (``PrecomputedTimelineProvider`` ->
  ``compat.rescue.evaluate_timeline_detailed`` -> ``engine.evaluate_scenario``) on Member 1's committed
  site files, or through ``adapters.load_site_file`` -> ``evaluate_scenario`` where Rescue has no
  equivalent (custom weights; a mission past the end of the dataset, which Rescue answers itself);
* the synthetic case uses a committed SYNTHETIC fixture (``fixtures.load_fixture``) and is labelled so.

Each example keeps the canonical ``ViabilityAssessment`` (full, validated), the legacy Rescue
``ViabilityResult`` where Rescue's path produced it, and, where relevant, the ``RankingResult``,
``ranking_explanations``, comparability groups and pairwise ``ranking_evidence``.

Nothing here is pinned: values depend on the committed site files (Member 1 may regenerate them). The
examples are deterministic for a given checkout. Regenerate the JSON with::

    cd backend && python -m app.viability.consumer_examples [OUTPUT.json]
"""

from __future__ import annotations

import json
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Final

from ..models import MissionRequirements as RescueRequirements
from ..models import Scenario, ViabilityResult
from ..rescue.catalog import get_site
from ..rescue.timeline import PrecomputedTimelineProvider, SyntheticTimelineProvider
from .adapters import load_site_file
from .compat.rescue import COMPAT_VERSION, evaluate_timeline_detailed, scenario_to_mission
from .engine import ENGINE_VERSION, evaluate_scenario
from .enums import ComparabilityPolicy, DataBasis
from .explain import EXPLANATION_METHOD_VERSION
from .fixtures import example_scenario, load_fixture
from .mission import MissionScenario, RankingPreferences
from .outputs import RankingResult, ViabilityAssessment
from .ranking import RankingComparabilityError, partition_comparable, rank_assessments, ranking_explanations
from .ranking_evidence import EVIDENCE_METHOD_VERSION, PairwiseEvidence, compare_scenarios, explain_adjacent, score_text
from .scoring import SCORING_METHOD_VERSION

__all__ = [
    "CONSUMER_EXAMPLES_VERSION",
    "EXAMPLE_KEYS",
    "SITES_DIR",
    "ConsumerExample",
    "build_examples",
    "consumer_summary",
    "examples_json",
    "examples_payload",
]

CONSUMER_EXAMPLES_VERSION: Final = "consumer-examples-v1"
SITES_DIR: Final = Path(__file__).resolve().parents[3] / "data" / "sites"
_H: Final = 3600.0

# Rescue defaults throughout (shared MissionRequirements()): 50 h battery, 0.25 panel threshold,
# >= 0.5 mean disk fraction, >= 40 % Earth, <= 96 h blackout, >= 24 h / 12 h initial sun / comms.
_DATASET_END: Final = datetime(2029, 1, 1, tzinfo=UTC)  # last sample instant of the committed files
_PASS_EXACT = ("malapert-massif", datetime(2028, 6, 15, tzinfo=UTC), 7.0)
_FAIL = ("connecting-ridge", datetime(2027, 3, 1, tzinfo=UTC), 7.0)
_PAIR_EXACT = ("connecting-ridge", _DATASET_END - timedelta(hours=72), 3.0)  # fully covered: exact score
_PAIR_BOUNDED = ("connecting-ridge", _DATASET_END - timedelta(hours=71), 3.0)  # last hour uncovered: bounded
_UNKNOWN = ("malapert-massif", _DATASET_END - timedelta(hours=12), 3.0)  # 60 of 72 h beyond the dataset
_SYNTHETIC_FIXTURE: Final = "intermittent_sunlight"

EXAMPLE_KEYS: Final = (
    "pass_exact",
    "fail_confirmed",
    "unknown_inadequate_data",
    "pass_bounded",
    "score_unavailable",
    "synthetic_input",
    "comparable_pair",
    "separate_leaderboards",
)


@dataclass(frozen=True)
class ConsumerExample:
    """One reproducible example. ``to_payload`` gives its JSON form."""

    key: str
    title: str
    purpose: str
    entry_point: str  # the function a consumer would call to get this output
    inputs: dict[str, Any]
    assessments: tuple[ViabilityAssessment, ...]
    legacy_results: tuple[ViabilityResult | None, ...]  # parallel to assessments; None = not via Rescue
    legacy_note: str
    ranking: RankingResult | None = None
    ranking_error: str | None = None  # RankingComparabilityError text when one ranking is refused
    groups: tuple[tuple[str, ...], ...] = ()  # partition_comparable (STRICT), by scenario id
    group_rankings: tuple[RankingResult, ...] = ()
    evidence: tuple[PairwiseEvidence, ...] = ()
    notes: tuple[str, ...] = field(default_factory=tuple)

    def to_payload(self) -> dict[str, Any]:
        explanations: dict[str, str] = {}
        if self.ranking is not None:
            explanations = ranking_explanations(self.assessments, self.ranking)
        return {
            "key": self.key,
            "title": self.title,
            "purpose": self.purpose,
            "entry_point": self.entry_point,
            "inputs": self.inputs,
            "summaries": [consumer_summary(a) for a in self.assessments],
            "legacy_note": self.legacy_note,
            "legacy_results": [None if r is None else r.model_dump(mode="json") for r in self.legacy_results],
            "ranking": None if self.ranking is None else self.ranking.model_dump(mode="json"),
            "ranking_explanations": explanations,
            "ranking_error": self.ranking_error,
            "comparability_groups": [list(g) for g in self.groups],
            "group_rankings": [r.model_dump(mode="json") for r in self.group_rankings],
            "evidence": [e.model_dump(mode="json") for e in self.evidence],
            "notes": list(self.notes),
            "assessments": [a.model_dump(mode="json") for a in self.assessments],
        }


# --- display summary -----------------------------------------------------------------------------


def consumer_summary(a: ViabilityAssessment) -> dict[str, Any]:
    """The fields a UI needs first, quoted from the canonical assessment (nothing recomputed)."""
    s, q = a.score, a.data_quality
    bounds = s.score_bounds
    return {
        "scenario_id": a.scenario_id,
        "site_id": a.site.id,
        "evaluated_start_utc": a.evaluated_start_utc.isoformat().replace("+00:00", "Z"),
        "evaluated_end_utc": a.evaluated_end_utc.isoformat().replace("+00:00", "Z"),
        "eligibility": a.eligibility.value,
        "rank_eligible": s.rank_eligible,
        "score": s.score,  # exact only; None = not scored OR only bounded
        "score_status": None if s.status is None else s.status.value,
        "score_bounds": None if bounds is None else bounds.model_dump(mode="json"),
        "score_text": score_text(a),
        "overall_risk": a.overall_risk.value,
        "data_basis": a.data_basis.value,
        "is_synthetic": q.provenance.is_synthetic,
        "dataset_id": q.dataset_id,
        "calculation_basis": q.calculation_basis.value,
        "provenance": q.provenance.model_dump(mode="json"),
        "sun_coverage_percent": q.sun_coverage_percent,
        "earth_coverage_percent": q.earth_coverage_percent,
        "engine_version": a.engine_version,
        "scoring_method_version": s.method_version,
        "configuration_key": s.configuration_key,
        "constraints": [
            {
                "constraint_id": c.constraint_id.value,
                "status": c.status.value,
                "threshold": c.threshold,
                "unit": c.unit.value,
                "measured": c.measured.model_dump(mode="json"),
                "message": c.message,
            }
            for c in a.constraints
        ],
        "explanations": [e.model_dump(mode="json") for e in a.explanations],
        "limitations": list(a.limitations),
    }


# --- builders ------------------------------------------------------------------------------------


def _rescue_scenario(site_id: str, landing: datetime, days: float) -> Scenario:
    return Scenario.model_validate(
        {
            "site": get_site(site_id).to_site(),
            "landing_utc": landing,
            "duration_days": days,
            "requirements": RescueRequirements.model_validate({}).model_dump(),
        }
    )


@dataclass
class _Context:
    provider: PrecomputedTimelineProvider
    sites_dir: Path
    series_cache: dict[str, Any] = field(default_factory=dict)

    def via_rescue(self, spec: tuple[str, datetime, float]) -> tuple[ViabilityResult, ViabilityAssessment]:
        """Rescue's production path: provider timeline (hourly, n samples) -> evaluate_timeline_detailed."""
        site_id, landing, days = spec
        sc = _rescue_scenario(site_id, landing, days)
        n = max(1, round(days * 24))
        tl = self.provider.timeline(sc.site, landing, landing + timedelta(hours=n - 1), 1.0)
        if not tl.source.startswith("precomputed"):
            raise RuntimeError(f"{site_id} {landing:%Y-%m-%dT%H:%MZ}: real site data not available ({tl.source})")
        return evaluate_timeline_detailed(sc, tl, precomputed_data_dir=self.sites_dir)

    def via_engine(self, mission: MissionScenario, site_id: str) -> ViabilityAssessment:
        if site_id not in self.series_cache:
            self.series_cache[site_id] = load_site_file(self.sites_dir / f"{site_id}.json")
        return evaluate_scenario(mission, self.series_cache[site_id])


def _inputs(spec: tuple[str, datetime, float], **extra: Any) -> dict[str, Any]:
    site_id, landing, days = spec
    return {
        "site_id": site_id,
        "landing_utc": landing.isoformat().replace("+00:00", "Z"),
        "duration_days": days,
        "requirements": "Rescue defaults (shared MissionRequirements())",
        **extra,
    }


_RESCUE_ENTRY: Final = "app.viability.compat.rescue.evaluate_timeline_detailed(scenario, timeline)"
_ENGINE_ENTRY: Final = "app.viability.engine.evaluate_scenario(mission, series)"
_VIA_RESCUE_NOTE: Final = (
    "legacy_results[i] is Rescue's shared ViabilityResult for assessments[i] (fractions 0-1, hours); "
    "assessments[i] is the full canonical result from the same call."
)


def _pass_exact(ctx: _Context) -> ConsumerExample:
    legacy, a = ctx.via_rescue(_PASS_EXACT)
    return ConsumerExample(
        key="pass_exact",
        title="PASS with an exact score (real terrain-aware data)",
        purpose="Every hard constraint is proven; every active score component is known, so `score` is exact.",
        entry_point=_RESCUE_ENTRY,
        inputs=_inputs(_PASS_EXACT),
        assessments=(a,),
        legacy_results=(legacy,),
        legacy_note=_VIA_RESCUE_NOTE,
    )


def _fail(ctx: _Context) -> ConsumerExample:
    legacy, a = ctx.via_rescue(_FAIL)
    return ConsumerExample(
        key="fail_confirmed",
        title="Confirmed FAIL (real terrain-aware data)",
        purpose="At least one hard constraint is proven violated. The score is descriptive only: a FAIL scenario "
        "is never ranked against viable ones.",
        entry_point=_RESCUE_ENTRY,
        inputs=_inputs(_FAIL),
        assessments=(a,),
        legacy_results=(legacy,),
        legacy_note=_VIA_RESCUE_NOTE,
    )


def _unknown(ctx: _Context) -> ConsumerExample:
    site_id, landing, days = _UNKNOWN
    mission = scenario_to_mission(_rescue_scenario(site_id, landing, days))
    a = ctx.via_engine(mission, site_id)
    return ConsumerExample(
        key="unknown_inadequate_data",
        title="UNKNOWN: the data cannot decide (mission runs past the end of the real dataset)",
        purpose="Most of the mission lies beyond the last real sample. Nothing is extrapolated: undecidable "
        "constraints are UNKNOWN, so eligibility is UNKNOWN and the scenario is neither scored nor ranked.",
        entry_point=_ENGINE_ENTRY + " with adapters.load_site_file and compat.rescue.scenario_to_mission",
        inputs=_inputs(_UNKNOWN, dataset_last_sample_utc="2029-01-01T00:00:00Z"),
        assessments=(a,),
        legacy_results=(None,),
        legacy_note="No legacy result: Rescue's own coverage check answers missions beyond the dataset itself "
        "(source 'rescue-coverage-check', eligibility 'unknown') before calling the engine.",
    )


def _pass_bounded(ctx: _Context) -> ConsumerExample:
    legacy, a = ctx.via_rescue(_PAIR_BOUNDED)
    return ConsumerExample(
        key="pass_bounded",
        title="PASS with a bounded score (real data, last hour uncovered)",
        purpose="Eligibility is proven despite one unknown hour, but one score component is only bounded, so "
        "`score` is null and `score_bounds` holds the proven interval. Rescue's ViabilityResult shows score null.",
        entry_point=_RESCUE_ENTRY,
        inputs=_inputs(_PAIR_BOUNDED),
        assessments=(a,),
        legacy_results=(legacy,),
        legacy_note=_VIA_RESCUE_NOTE + " The legacy contract has no interval field, so its score is null.",
    )


def _unavailable(ctx: _Context) -> ConsumerExample:
    site_id, landing, days = _PASS_EXACT
    base = scenario_to_mission(_rescue_scenario(site_id, landing, days))
    prefs = RankingPreferences(
        sunlight_weight=0.0,
        earth_visibility_weight=0.0,
        simultaneous_weight=0.0,
        darkness_margin_weight=0.0,
        blackout_margin_weight=0.0,
        clearance_margin_weight=1.0,  # accepted, but clearance scoring is unsupported
    )
    mission = MissionScenario.model_validate(
        {**base.model_dump(), "scenario_id": f"{base.scenario_id}_clearance_only", "preferences": prefs.model_dump()}
    )
    a = ctx.via_engine(mission, site_id)
    return ConsumerExample(
        key="score_unavailable",
        title="PASS but no score: no score component is active",
        purpose="Only the unsupported clearance weight is set, so no component is active and the score status is "
        "`no_scorable_components`: score and score_bounds are null, which is NOT a score of 0. It still gets a "
        "rank, after every scored PASS scenario.",
        entry_point=_ENGINE_ENTRY,
        inputs=_inputs(_PASS_EXACT, preferences=prefs.model_dump()),
        assessments=(a,),
        legacy_results=(None,),
        legacy_note="No legacy result: Rescue scenarios carry no ranking preferences.",
    )


def _synthetic(_ctx: _Context) -> ConsumerExample:
    series = load_fixture(_SYNTHETIC_FIXTURE)
    a = evaluate_scenario(example_scenario(series, "synthetic-intermittent-sunlight"), series)
    return ConsumerExample(
        key="synthetic_input",
        title="SYNTHETIC scientific input (test fixture, not NASA data)",
        purpose="Hand-constructed geometry at a fictional site. data_basis is 'synthetic', provenance.is_synthetic "
        "is true and every explanation starts with [SYNTHETIC DATA]. Never show it as a real result.",
        entry_point=_ENGINE_ENTRY + " with fixtures.load_fixture and fixtures.example_scenario",
        inputs={"fixture": _SYNTHETIC_FIXTURE, "scenario": "fixtures.example_scenario (6 h darkness / 10 h blackout)"},
        assessments=(a,),
        legacy_results=(None,),
        legacy_note="No legacy result: built from a canonical fixture, not a Rescue timeline.",
    )


def _comparable(ctx: _Context) -> ConsumerExample:
    legacy_x, x = ctx.via_rescue(_PAIR_EXACT)
    legacy_b, b = ctx.via_rescue(_PAIR_BOUNDED)
    pair = (x, b)
    ranking = rank_assessments(pair)
    return ConsumerExample(
        key="comparable_pair",
        title="Two comparable PASS scenarios in one ranking (exact vs bounded, overlapping ranges)",
        purpose="Same site, requirements and duration, landings one hour apart. The ranking orders the exact score "
        "first by its higher conservative lower bound, but the score ranges overlap, so the evidence does not "
        "prove it is more desirable.",
        entry_point=_RESCUE_ENTRY + "; ranking.rank_assessments; ranking_evidence.explain_adjacent",
        inputs={"scenarios": [_inputs(_PAIR_EXACT), _inputs(_PAIR_BOUNDED)]},
        assessments=pair,
        legacy_results=(legacy_x, legacy_b),
        legacy_note=_VIA_RESCUE_NOTE,
        ranking=ranking,
        groups=tuple(tuple(m.scenario_id for m in g) for g in partition_comparable(pair)),
        evidence=tuple(explain_adjacent(pair, ranking)),
    )


def _separate(ctx: _Context) -> ConsumerExample:
    _, real_7d = ctx.via_rescue(_PASS_EXACT)
    _, real_3d = ctx.via_rescue(_PAIR_EXACT)
    series = load_fixture(_SYNTHETIC_FIXTURE)
    synthetic = evaluate_scenario(example_scenario(series, "synthetic-intermittent-sunlight"), series)
    items = (real_7d, real_3d, synthetic)
    try:
        rank_assessments(items)
        error = None
    except RankingComparabilityError as exc:
        error = str(exc)
    groups = partition_comparable(items)
    return ConsumerExample(
        key="separate_leaderboards",
        title="Scenarios that must not share one leaderboard",
        purpose="A real 7-day mission, a real 3-day mission (different configuration fingerprint) and a synthetic "
        "fixture (different data basis). One combined ranking is refused; partition_comparable gives separate "
        "groups, each ranked on its own; pairwise evidence states no order across groups.",
        entry_point="ranking.partition_comparable; ranking.rank_assessments per group; "
        "ranking_evidence.compare_scenarios",
        inputs={
            "scenarios": [
                _inputs(_PASS_EXACT),
                _inputs(_PAIR_EXACT),
                {"fixture": _SYNTHETIC_FIXTURE, "scenario": "fixtures.example_scenario"},
            ]
        },
        assessments=items,
        legacy_results=(None, None, None),
        legacy_note="Legacy results omitted here; see pass_exact and comparable_pair.",
        ranking_error=error,
        groups=tuple(tuple(m.scenario_id for m in g) for g in groups),
        group_rankings=tuple(rank_assessments(g) for g in groups),
        evidence=(compare_scenarios(real_7d, real_3d), compare_scenarios(real_7d, synthetic)),
    )


_BUILDERS: Final[dict[str, Callable[[_Context], ConsumerExample]]] = {
    "pass_exact": _pass_exact,
    "fail_confirmed": _fail,
    "unknown_inadequate_data": _unknown,
    "pass_bounded": _pass_bounded,
    "score_unavailable": _unavailable,
    "synthetic_input": _synthetic,
    "comparable_pair": _comparable,
    "separate_leaderboards": _separate,
}
assert tuple(_BUILDERS) == EXAMPLE_KEYS


def build_examples(keys: Sequence[str] = EXAMPLE_KEYS, *, sites_dir: Path = SITES_DIR) -> list[ConsumerExample]:
    """Build the requested examples (default: all eight) through the real pipeline.

    Raises ``KeyError`` for an unknown key and ``RuntimeError`` if a required real site file is missing.
    """
    unknown = [k for k in keys if k not in _BUILDERS]
    if unknown:
        raise KeyError(f"unknown example(s) {unknown}; available: {', '.join(EXAMPLE_KEYS)}")
    ctx = _Context(
        provider=PrecomputedTimelineProvider(fallback=SyntheticTimelineProvider(), data_dir=sites_dir),
        sites_dir=sites_dir,
    )
    return [_BUILDERS[k](ctx) for k in keys]


def examples_payload(examples: Sequence[ConsumerExample]) -> dict[str, Any]:
    """JSON-ready document with the versions every consumer should record."""
    return {
        "consumer_examples_version": CONSUMER_EXAMPLES_VERSION,
        "engine_version": ENGINE_VERSION,
        "scoring_method_version": SCORING_METHOD_VERSION,
        "explanation_method_version": EXPLANATION_METHOD_VERSION,
        "evidence_method_version": EVIDENCE_METHOD_VERSION,
        "rescue_compat_version": COMPAT_VERSION,
        "default_comparability_policy": ComparabilityPolicy.STRICT.value,
        "examples": [e.to_payload() for e in examples],
    }


def examples_json(examples: Sequence[ConsumerExample]) -> str:
    """Canonical JSON (sorted keys, 2-space indent, trailing newline): byte-identical for identical inputs."""
    return json.dumps(examples_payload(examples), indent=2, sort_keys=True, ensure_ascii=False, allow_nan=False) + "\n"


def _describe(e: ConsumerExample) -> str:
    rows = [f"{e.key}: {e.title}"]
    for a in e.assessments:
        label = " [SYNTHETIC]" if a.data_basis is DataBasis.SYNTHETIC else ""
        rank = ""
        if e.ranking is not None:
            rank = next((f" rank={x.rank}" for x in e.ranking.entries if x.scenario_id == a.scenario_id), "")
        rows.append(f"  {a.scenario_id}: {a.eligibility.value.upper()}, {score_text(a)}{rank}{label}")
    return "\n".join(rows)


def main(argv: Sequence[str]) -> int:
    examples = build_examples()
    text = examples_json(examples)
    if argv:
        Path(argv[0]).write_text(text, encoding="utf-8", newline="\n")
    for e in examples:
        print(_describe(e))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
