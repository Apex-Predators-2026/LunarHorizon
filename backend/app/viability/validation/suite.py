"""Member 2 Part 2 validation suite (Work Package E).

Reproducible validation of the canonical viability engine on Member 1's committed curated lunar datasets:

1. **Smoke coverage** of every committed site file (24 at the time of writing): scientific-input checks
   (coverage, sampling, provenance, data basis) and an evaluation of the standard lander at three landings per
   site (start, middle and end of the data), each checked for internal consistency and JSON round-trip.
2. **Deep cases** on real data (or explicitly labelled SYNTHETIC fixtures where real data cannot show the case):
   PASS, confirmed FAIL, PASS with high screening risk, UNKNOWN from missing data, bounded score, overlapping
   score intervals, exact and uncertain rankings, incompatible configurations, synthetic separation, dataset
   boundaries, and sampling-policy agreement and disagreement.
3. **Invariants** checked on real missions: stricter limits never improve the corresponding constraint; missing
   data never creates certainty (every result decided with a data gap equals the full-data result, and every
   bound contains the full-data value); preference weights never change eligibility; explanations never change
   the calculations; the ranking is independent of input order.
4. **Timing**: data preparation (file load + step-function preparation) measured separately from repeated
   scenario evaluations, with the workload and the machine recorded.

Every check is a :class:`Check` (name, passed, detail); nothing raises on a failed check, so one report shows
all results. ``run_validation`` builds the full report; ``python -m app.viability.validation`` prints a summary,
optionally writes the JSON report, and exits non-zero if any check failed. Landing dates of the deep cases come
from an exploration of the committed files (generator 1.2, 2026-01-01 .. 2031-01-01); end-of-data cases are
placed relative to the files' last sample, so a regeneration moves them with the data. If a regeneration
changes a case's outcome, the corresponding check fails and says what was found instead.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import itertools
import json
import os
import platform
import random
import statistics
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Final

from ..analysis import analyze_scenario
from ..constraints import build_constraint_assessment
from ..engine import ENGINE_VERSION, evaluate_scenario
from ..enums import (
    CommunicationMode,
    ConstraintId,
    ConstraintStatus,
    DataBasis,
    Eligibility,
    MetricStatus,
    PowerSource,
    RiskLevel,
    SamplingPolicy,
    ScoreStatus,
    UnknownReason,
)
from ..explain import EXPLANATION_METHOD_VERSION, explain_assessment, generate_explanations
from ..fixtures import example_scenario, load_fixture
from ..inputs import ScientificTimeSeries
from ..margins import margins_from_assessment
from ..mission import MissionRequirements, MissionScenario, RankingPreferences, SpacecraftConfiguration
from ..outputs import Metric, ViabilityAssessment, derive_eligibility
from ..ranking import (
    RANKING_METHOD_VERSION,
    RankingComparabilityError,
    partition_comparable,
    rank_assessments,
    ranking_explanations,
)
from ..ranking_evidence import EVIDENCE_METHOD_VERSION, DifferenceStatus, RankingCriterion, compare_scenarios
from ..risk import SYNTHETIC_PREFIX, assess_risks, overall_risk
from ..sampling_sensitivity import (
    ALTERNATE_POLICY,
    BASELINE_POLICY,
    SENSITIVITY_METHOD_VERSION,
    PolicySeriesPair,
    SensitivityVerdict,
    prepare_policy_series,
    sampling_sensitivity_report,
)
from ..scoring import SCORING_METHOD_VERSION, score_scenario
from ..windows import PreparedSeries, prepare_series

__all__ = [
    "SITES_DIR",
    "STANDARD_LANDER",
    "VALIDATION_VERSION",
    "Case",
    "Check",
    "Dataset",
    "Lander",
    "case_names",
    "dataset_identity",
    "load_datasets",
    "machine_info",
    "mission",
    "run_cases",
    "run_invariants",
    "run_validation",
    "smoke_dataset",
    "summarize",
    "time_workload",
    "versions",
]

VALIDATION_VERSION: Final = "member2-part2-validation-v1"
SITES_DIR: Final = Path(__file__).resolve().parents[4] / "data" / "sites"
H: Final = 3600.0
DAY: Final = timedelta(days=1)


# --- result records ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Check:
    name: str
    passed: bool
    detail: str = ""

    def to_json(self) -> dict[str, Any]:
        return {"name": self.name, "passed": self.passed, "detail": self.detail}


@dataclass
class Case:
    """One deep case: what was evaluated, what came out, and the checks on it."""

    name: str
    category: str
    synthetic: bool
    inputs: dict[str, Any]
    outcome: dict[str, Any] = field(default_factory=dict)
    checks: list[Check] = field(default_factory=list)

    def check(self, name: str, passed: bool, detail: str = "") -> bool:
        self.checks.append(Check(name, bool(passed), detail))
        return bool(passed)

    @property
    def passed(self) -> bool:
        return all(c.passed for c in self.checks)

    def to_json(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "category": self.category,
            "synthetic": self.synthetic,
            "inputs": self.inputs,
            "outcome": self.outcome,
            "passed": self.passed,
            "checks": [c.to_json() for c in self.checks],
        }


@dataclass(frozen=True)
class Dataset:
    site_id: str
    path: Path
    series: ScientificTimeSeries
    prepared: PreparedSeries
    load_s: float
    prepare_s: float


# --- the standard lander (same as docs/viability-engine.md §5c/§5e and docs/member2-part2-sampling.md) -----------


@dataclass(frozen=True)
class Lander:
    """Hard limits of a solar, direct-to-Earth lander. Hours and percent for readability; converted to SI."""

    dark_h: float = 50.0
    blackout_h: float = 96.0
    panel_threshold: float = 0.25
    min_mean_disk_fraction: float = 0.5
    min_earth_percent: float = 40.0
    min_initial_sun_h: float = 24.0
    min_initial_earth_h: float = 12.0
    min_sunlight_percent: float = 50.0

    def spacecraft(self) -> SpacecraftConfiguration:
        return SpacecraftConfiguration(
            name="Solar direct-to-Earth lander",
            power_source=PowerSource.SOLAR,
            communication_mode=CommunicationMode.DIRECT_TO_EARTH,
            max_continuous_darkness_s=self.dark_h * H,
            max_communication_blackout_s=self.blackout_h * H,
            solar_power_min_disk_fraction=self.panel_threshold,
        )

    def requirements(self) -> MissionRequirements:
        return MissionRequirements(
            min_mean_solar_disk_fraction=self.min_mean_disk_fraction,
            min_earth_visibility_percent=self.min_earth_percent,
            min_initial_sunlight_s=self.min_initial_sun_h * H,
            min_initial_earth_visibility_s=self.min_initial_earth_h * H,
            min_sunlight_percent=self.min_sunlight_percent,
        )

    def to_json(self) -> dict[str, float]:
        return {k: float(v) for k, v in self.__dict__.items()}


STANDARD_LANDER: Final = Lander()


def mission(
    ds: Dataset | ScientificTimeSeries,
    start: datetime,
    duration: timedelta,
    *,
    lander: Lander = STANDARD_LANDER,
    preferences: RankingPreferences | None = None,
    scenario_id: str | None = None,
) -> MissionScenario:
    series = ds.series if isinstance(ds, Dataset) else ds
    return MissionScenario(
        scenario_id=scenario_id or f"{series.site.id}-{start:%Y%m%dT%H%M}-{duration.total_seconds() / H:g}h",
        site=series.site,
        mission_start_utc=start,
        mission_end_utc=start + duration,
        spacecraft=lander.spacecraft(),
        requirements=lander.requirements(),
        preferences=preferences or RankingPreferences(),
    )


def _iso(t: datetime) -> str:
    return t.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _score_text(a: ViabilityAssessment) -> dict[str, Any]:
    s = a.score
    b = s.score_bounds
    return {
        "status": None if s.status is None else s.status.value,
        "score": s.score,
        "bounds": None
        if b is None
        else [b.value if b.lower is None else b.lower, b.value if b.upper is None else b.upper],
    }


def _summary(a: ViabilityAssessment) -> dict[str, Any]:
    """The fields a reader needs to see what was decided (quoted from the assessment, nothing recomputed)."""
    q = a.data_quality
    return {
        "scenario_id": a.scenario_id,
        "site": a.site.id,
        "start_utc": _iso(a.evaluated_start_utc),
        "end_utc": _iso(a.evaluated_end_utc),
        "eligibility": a.eligibility.value,
        "failed": [c.constraint_id.value for c in a.constraints if c.status is ConstraintStatus.FAIL],
        "unknown": [c.constraint_id.value for c in a.constraints if c.status is ConstraintStatus.UNKNOWN],
        "overall_risk": a.overall_risk.value,
        "high_risk_indicators": [r.code for r in a.risks if r.level is RiskLevel.HIGH],
        "score": _score_text(a),
        "data_basis": a.data_basis.value,
        "dataset_id": q.dataset_id,
        "uncovered_h": q.uncovered_duration_s / H,
    }


# --- datasets -----------------------------------------------------------------------------------------------------


def load_datasets(sites: Iterable[str] | None = None, sites_dir: Path = SITES_DIR) -> dict[str, Dataset]:
    """Load (adapter + validation) and prepare (sample-and-hold step functions) each site file, timing both."""
    from ..adapters import load_site_file  # local: keeps importing the suite cheap

    ids = sorted(p.stem for p in sites_dir.glob("*.json")) if sites is None else list(sites)
    out: dict[str, Dataset] = {}
    for site_id in ids:
        path = sites_dir / f"{site_id}.json"
        t0 = time.perf_counter()
        series = load_site_file(path)
        t1 = time.perf_counter()
        prepared = prepare_series(series)
        t2 = time.perf_counter()
        out[site_id] = Dataset(site_id, path, series, prepared, t1 - t0, t2 - t1)
    return out


def dataset_identity(ds: Dataset) -> dict[str, Any]:
    s, p = ds.series, ds.series.provenance
    return {
        "site_id": ds.site_id,
        "file": f"data/sites/{ds.path.name}",
        "sha256": hashlib.sha256(ds.path.read_bytes()).hexdigest(),
        "dataset_id": s.dataset_id,
        "generator": p.generator,
        "generated_at_utc": None if p.generated_at_utc is None else _iso(p.generated_at_utc),
        "ephemeris_source": p.ephemeris_source,
        "terrain_source": p.terrain_source,
        "calculation_basis": s.calculation_basis.value,
        "is_synthetic": p.is_synthetic,
        "coverage_start_utc": _iso(s.coverage_start_utc),
        "coverage_end_utc": _iso(s.coverage_end_utc),
        "sample_count": len(s.samples),
        "nominal_interval_s": s.sampling.nominal_interval_s,
        "max_gap_s": s.sampling.max_gap_s,
    }


# --- 1. smoke coverage ---------------------------------------------------------------------------------------------


def _consistency_checks(prefix: str, a: ViabilityAssessment, *, covered: bool) -> list[Check]:
    s = a.score
    checks = [
        Check(f"{prefix}: engine version", a.engine_version == ENGINE_VERSION, a.engine_version),
        Check(f"{prefix}: scoring method", s.method_version == SCORING_METHOD_VERSION, s.method_version),
        Check(
            f"{prefix}: eligibility derived from constraints",
            derive_eligibility(x.status for x in a.constraints) is a.eligibility,
        ),
        Check(f"{prefix}: rank-eligible iff PASS", s.rank_eligible is (a.eligibility is Eligibility.PASS)),
        Check(
            f"{prefix}: UNKNOWN is never scored",
            a.eligibility is not Eligibility.UNKNOWN
            or (s.status is ScoreStatus.ELIGIBILITY_UNKNOWN and s.score is None and s.score_bounds is None),
        ),
        Check(
            f"{prefix}: exact score only with status KNOWN",
            (s.score is not None) == (s.status is ScoreStatus.KNOWN),
            f"status={None if s.status is None else s.status.value} score={s.score}",
        ),
        Check(f"{prefix}: explanations present", bool(a.explanations)),
        Check(
            f"{prefix}: JSON round trip",
            ViabilityAssessment.model_validate_json(a.model_dump_json()) == a,
        ),
    ]
    if covered:
        q = a.data_quality
        checks.append(
            Check(
                f"{prefix}: fully covered mission has no unknown time",
                q.uncovered_duration_s == 0.0 and q.sun_coverage_percent == q.earth_coverage_percent == 100.0,
                f"uncovered {q.uncovered_duration_s / H:g} h",
            )
        )
        checks.append(
            Check(
                f"{prefix}: no UNKNOWN constraint from missing data",
                not any(
                    c.unknown_reason in (UnknownReason.INCOMPLETE_DATA, UnknownReason.NO_DATA) for c in a.constraints
                ),
            )
        )
    return checks


def smoke_dataset(ds: Dataset, reference: Dataset | None = None) -> tuple[dict[str, Any], list[Check]]:
    """Scientific-input checks and three standard 14-day evaluations (start, middle, end of the data)."""
    s, sid = ds.series, ds.site_id
    times = [x.time_utc for x in s.samples]
    checks = [
        Check(f"{sid}: real, not synthetic", s.provenance.is_synthetic is False),
        Check(f"{sid}: terrain-aware basis", s.calculation_basis.value == "terrain_aware", s.calculation_basis.value),
        Check(
            f"{sid}: hourly nominal sampling", s.sampling.nominal_interval_s == H, str(s.sampling.nominal_interval_s)
        ),
        Check(
            f"{sid}: samples span exactly the stated coverage",
            times[0] == s.coverage_start_utc and times[-1] == s.coverage_end_utc,
            f"{_iso(times[0])} .. {_iso(times[-1])}",
        ),
        Check(
            f"{sid}: regular hourly spacing, no gaps",
            all((b - a).total_seconds() == H for a, b in itertools.pairwise(times)),
        ),
        Check(f"{sid}: site id matches file", s.site.id == sid, s.site.id),
    ]
    if reference is not None:
        r = reference.series
        checks.append(
            Check(
                f"{sid}: same coverage as {reference.site_id}",
                (s.coverage_start_utc, s.coverage_end_utc) == (r.coverage_start_utc, r.coverage_end_utc),
            )
        )
    span = s.coverage_end_utc - s.coverage_start_utc
    middle = s.coverage_start_utc + timedelta(days=(span.days // 2))
    landings = {
        "first": s.coverage_start_utc,
        "middle": middle,
        "last": s.coverage_end_utc - timedelta(days=14),
    }
    evaluated: dict[str, Any] = {}
    for label, start in landings.items():
        a = evaluate_scenario(mission(ds, start, timedelta(days=14)), ds.prepared)
        evaluated[label] = _summary(a)
        checks += _consistency_checks(f"{sid} {label}", a, covered=True)
        checks.append(Check(f"{sid} {label}: real data basis", a.data_basis is DataBasis.REAL_TERRAIN_AWARE))
        checks.append(
            Check(
                f"{sid} {label}: explanations not labelled synthetic",
                not any(e.message.startswith(SYNTHETIC_PREFIX) for e in a.explanations),
            )
        )
    return {"identity": dataset_identity(ds), "evaluations": evaluated}, checks


# --- 2. deep cases --------------------------------------------------------------------------------------------------

# Real cases found by sweeping the committed files (14-day missions, standard lander, every 3 days 2027-2028).
_PASS_CASE: Final = ("malapert-massif", datetime(2027, 7, 20, tzinfo=UTC))
_FAIL_CASE: Final = ("connecting-ridge", datetime(2027, 3, 1, tzinfo=UTC))
_PASS_HIGH_RISK_CASE: Final = ("peak-near-shackleton", datetime(2027, 10, 13, tzinfo=UTC))
_PAIR_DATE: Final = datetime(2027, 12, 3, tzinfo=UTC)  # Malapert Massif and Connecting Ridge both PASS
_SAMPLING_AGREE: Final = ("malapert-massif", datetime(2027, 7, 20, 0, tzinfo=UTC))
_SAMPLING_DISAGREE: Final = ("malapert-massif", datetime(2027, 7, 20, 14, tzinfo=UTC))
# Lit and Earth-visible through the final covered hours of the committed files (Malapert is power-dark there).
_END_SITE: Final = "connecting-ridge"
_SYNTHETIC_FIXTURE: Final = "intermittent_sunlight"
DEEP_SITES: Final = ("connecting-ridge", "malapert-massif", "peak-near-shackleton")


def _case_pass(d: dict[str, Dataset]) -> Case:
    site, start = _PASS_CASE
    c = Case("pass_exact", "PASS", False, {"site": site, "start_utc": _iso(start), "days": 14})
    a = evaluate_scenario(mission(d[site], start, timedelta(days=14)), d[site].prepared)
    c.outcome = _summary(a)
    c.check("eligibility PASS", a.eligibility is Eligibility.PASS, a.eligibility.value)
    c.check(
        "every configured constraint passes",
        all(
            x.status is ConstraintStatus.PASS for x in a.constraints if x.status is not ConstraintStatus.NOT_APPLICABLE
        ),
    )
    c.check("exact score", a.score.status is ScoreStatus.KNOWN and a.score.score is not None)
    return c


def _case_fail(d: dict[str, Dataset]) -> Case:
    site, start = _FAIL_CASE
    c = Case("fail_confirmed", "confirmed FAIL", False, {"site": site, "start_utc": _iso(start), "days": 14})
    a = evaluate_scenario(mission(d[site], start, timedelta(days=14)), d[site].prepared)
    c.outcome = _summary(a)
    failed = [x for x in a.constraints if x.status is ConstraintStatus.FAIL]
    c.check("eligibility FAIL", a.eligibility is Eligibility.FAIL, a.eligibility.value)
    c.check("at least one proven violation", bool(failed), ", ".join(x.constraint_id.value for x in failed))
    for x in failed:  # a proven failure: the measured value (or its whole interval) is past the threshold
        m = x.measured
        lo = m.value if m.lower is None else m.lower
        hi = m.value if m.upper is None else m.upper
        past = (
            lo is not None and x.threshold is not None and lo > x.threshold
            if x.comparison is not None and x.comparison.value == "at_most"
            else hi is not None and x.threshold is not None and hi < x.threshold
        )
        c.check(f"{x.constraint_id.value}: measurement past threshold", past, f"{lo}..{hi} vs {x.threshold}")
    c.check("not rank-eligible", a.score.rank_eligible is False)
    return c


def _case_pass_high_risk(d: dict[str, Dataset]) -> Case:
    site, start = _PASS_HIGH_RISK_CASE
    c = Case(
        "pass_high_screening_risk",
        "PASS with high screening risk",
        False,
        {"site": site, "start_utc": _iso(start), "days": 14},
    )
    a = evaluate_scenario(mission(d[site], start, timedelta(days=14)), d[site].prepared)
    c.outcome = _summary(a)
    c.check("eligibility PASS", a.eligibility is Eligibility.PASS, a.eligibility.value)
    c.check("overall screening risk HIGH", a.overall_risk is RiskLevel.HIGH, a.overall_risk.value)
    c.check("risk does not remove it from the viable ranking", a.score.rank_eligible is True)
    c.check("high indicators named", bool(c.outcome["high_risk_indicators"]), str(c.outcome["high_risk_indicators"]))
    return c


def _end(d: dict[str, Dataset]) -> datetime:
    return d[_END_SITE].series.coverage_end_utc


def _case_unknown(d: dict[str, Dataset]) -> Case:
    ds, end = d[_END_SITE], _end(d)
    start = end - timedelta(days=7)
    c = Case(
        "unknown_missing_data",
        "UNKNOWN from missing data",
        False,
        {"site": _END_SITE, "start_utc": _iso(start), "days": 14, "dataset_end_utc": _iso(end)},
    )
    a = evaluate_scenario(mission(ds, start, timedelta(days=14)), ds.prepared)
    c.outcome = _summary(a)
    c.check("eligibility UNKNOWN", a.eligibility is Eligibility.UNKNOWN, a.eligibility.value)
    c.check("no proven failure", not c.outcome["failed"])
    c.check(
        "undecided constraints cite missing data",
        all(
            x.unknown_reason in (UnknownReason.INCOMPLETE_DATA, UnknownReason.NO_DATA)
            for x in a.constraints
            if x.status is ConstraintStatus.UNKNOWN
        ),
    )
    c.check("not scored", a.score.score is None and a.score.status is ScoreStatus.ELIGIBILITY_UNKNOWN)
    c.check(
        "168 h uncovered, nothing extrapolated",
        a.data_quality.uncovered_duration_s == 168 * H,
        f"{a.data_quality.uncovered_duration_s / H:g} h",
    )
    return c


def _end_pair(d: dict[str, Dataset]) -> tuple[ViabilityAssessment, ViabilityAssessment]:
    """3-day missions at the end of the data: fully covered (exact) and one hour past the last sample (bounded)."""
    ds, end = d[_END_SITE], _end(d)
    exact = evaluate_scenario(mission(ds, end - timedelta(hours=72), timedelta(days=3)), ds.prepared)
    bounded = evaluate_scenario(mission(ds, end - timedelta(hours=71), timedelta(days=3)), ds.prepared)
    return exact, bounded


def _case_bounded(d: dict[str, Dataset]) -> Case:
    _, a = _end_pair(d)
    c = Case(
        "bounded_score",
        "bounded score",
        False,
        {"site": _END_SITE, "start_utc": _iso(a.evaluated_start_utc), "days": 3, "last_hour": "beyond the data"},
    )
    c.outcome = _summary(a)
    b = a.score.score_bounds
    c.check("eligibility PASS despite one unknown hour", a.eligibility is Eligibility.PASS, a.eligibility.value)
    c.check("score BOUNDED, no point value", a.score.status is ScoreStatus.BOUNDED and a.score.score is None)
    c.check(
        "proper interval",
        b is not None and b.lower is not None and b.upper is not None and b.lower < b.upper,
        str(c.outcome["score"]["bounds"]),
    )
    return c


def _case_overlap(d: dict[str, Dataset]) -> Case:
    exact, bounded = _end_pair(d)
    c = Case(
        "overlapping_intervals",
        "overlapping candidate score intervals / uncertain ranking",
        False,
        {
            "site": _END_SITE,
            "missions": [_iso(exact.evaluated_start_utc), _iso(bounded.evaluated_start_utc)],
            "days": 3,
        },
    )
    ranking = rank_assessments([bounded, exact])
    ev = compare_scenarios(exact, bounded, ranking=ranking)
    sd = ev.score_difference
    c.outcome = {
        "ranking": [(e.rank, e.scenario_id, e.score, e.lower_bound) for e in ranking.entries],
        "deciding_criterion": None if ev.deciding_criterion is None else ev.deciding_criterion.value,
        "difference_status": sd.status.value,
        "difference_interval": None if sd.interval is None else [sd.interval.lower, sd.interval.upper],
        "explanation": ev.explanation,
    }
    c.check("both PASS and ranked", [e.rank for e in ranking.entries] == [1, 2])
    c.check("exact one ranked first", ranking.entries[0].scenario_id == exact.scenario_id)
    c.check("ordered by guaranteed lower bound", ev.deciding_criterion is RankingCriterion.SCORE_LOWER_BOUND)
    c.check(
        "advantage NOT established (interval contains 0)",
        sd.status is DifferenceStatus.NOT_ESTABLISHED,
        sd.status.value,
    )
    c.check("explanation says the ranges overlap", "overlap" in ev.explanation)
    return c


def _pair(d: dict[str, Dataset]) -> tuple[ViabilityAssessment, ViabilityAssessment]:
    m = evaluate_scenario(mission(d["malapert-massif"], _PAIR_DATE, timedelta(days=14)), d["malapert-massif"].prepared)
    r = evaluate_scenario(
        mission(d["connecting-ridge"], _PAIR_DATE, timedelta(days=14)), d["connecting-ridge"].prepared
    )
    return m, r


def _case_exact_ranking(d: dict[str, Dataset]) -> Case:
    m, r = _pair(d)
    c = Case(
        "exact_ranking",
        "exact ranking with an established score advantage",
        False,
        {"sites": ["malapert-massif", "connecting-ridge"], "start_utc": _iso(_PAIR_DATE), "days": 14},
    )
    ranking = rank_assessments([r, m])
    first, second = (m, r) if ranking.entries[0].scenario_id == m.scenario_id else (r, m)
    ev = compare_scenarios(first, second, ranking=ranking)
    sd = ev.score_difference
    c.outcome = {
        "summaries": [_summary(m), _summary(r)],
        "ranking": [(e.rank, e.scenario_id, e.score) for e in ranking.entries],
        "difference_status": sd.status.value,
        "difference_interval": None if sd.interval is None else [sd.interval.lower, sd.interval.upper],
    }
    c.check("both PASS", m.eligibility is r.eligibility is Eligibility.PASS)
    c.check("both exact scores", m.score.status is r.score.status is ScoreStatus.KNOWN)
    c.check("advantage established", sd.status is DifferenceStatus.SELECTED_HIGHER, sd.status.value)
    c.check("deciding criterion is the score", ev.deciding_criterion is RankingCriterion.SCORE_LOWER_BOUND)
    return c


def _case_incompatible(d: dict[str, Dataset]) -> Case:
    ds = d["malapert-massif"]
    start = _PASS_CASE[1]
    a14 = evaluate_scenario(mission(ds, start, timedelta(days=14), scenario_id="m14"), ds.prepared)
    a7 = evaluate_scenario(mission(ds, start, timedelta(days=7), scenario_id="m7"), ds.prepared)
    aw = evaluate_scenario(
        mission(
            ds,
            start,
            timedelta(days=14),
            scenario_id="m14-sun-only",
            preferences=RankingPreferences(
                earth_visibility_weight=0.0, darkness_margin_weight=0.0, blackout_margin_weight=0.0
            ),
        ),
        ds.prepared,
    )
    c = Case(
        "incompatible_configurations",
        "incompatible configurations",
        False,
        {
            "site": "malapert-massif",
            "start_utc": _iso(start),
            "scenarios": {"m14": "14 d", "m7": "7 d", "m14-sun-only": "14 d, sunlight weight only"},
        },
    )
    try:
        rank_assessments([a14, a7, aw])
        refused, msg = False, ""
    except RankingComparabilityError as exc:
        refused, msg = True, str(exc)
    groups = partition_comparable([a14, a7, aw])
    ev = compare_scenarios(a14, a7)
    c.outcome = {
        "refused": refused,
        "message": msg,
        "groups": [[a.scenario_id for a in g] for g in groups],
        "evidence_status": ev.score_difference.status.value,
        "issues": ev.comparability_issues,
    }
    c.check("one combined ranking refused", refused, msg[:160])
    c.check("three separate comparability groups", len(groups) == 3)
    c.check(
        "evidence states no order",
        not ev.comparable and ev.higher_id is None and ev.score_difference.status is DifferenceStatus.NOT_COMPARABLE,
    )
    c.check(
        "weights never change eligibility",
        a14.eligibility is aw.eligibility and [x.status for x in a14.constraints] == [x.status for x in aw.constraints],
    )
    return c


def _case_synthetic(d: dict[str, Dataset]) -> Case:
    fx = load_fixture(_SYNTHETIC_FIXTURE)
    syn = evaluate_scenario(example_scenario(fx, "synthetic-fixture"), fx)
    real = evaluate_scenario(
        mission(d["malapert-massif"], _PASS_CASE[1], timedelta(days=14)), d["malapert-massif"].prepared
    )
    c = Case(
        "synthetic_kept_separate",
        "synthetic data kept separate",
        True,
        {"fixture": _SYNTHETIC_FIXTURE, "real": real.scenario_id, "label": "SYNTHETIC (not NASA-derived)"},
    )
    try:
        rank_assessments([syn, real], policy="same_method_and_weights")
        refused = False
    except RankingComparabilityError:
        refused = True
    groups = partition_comparable([syn, real], policy="same_method_and_weights")
    ev = compare_scenarios(syn, real)
    c.outcome = {
        "synthetic": _summary(syn),
        "groups": [[a.scenario_id for a in g] for g in groups],
        "issues": ev.comparability_issues,
    }
    c.check(
        "synthetic basis recorded", syn.data_basis is DataBasis.SYNTHETIC and syn.data_quality.provenance.is_synthetic
    )
    c.check(
        "every explanation labelled [SYNTHETIC DATA]",
        all(e.message.startswith(SYNTHETIC_PREFIX) for e in syn.explanations),
    )
    c.check("never ranked with real data, even under the permissive policy", refused)
    c.check("separate groups", len(groups) == 2)
    c.check("evidence states no order", not ev.comparable and ev.higher_id is None)
    return c


def _case_boundaries(d: dict[str, Dataset]) -> Case:
    ds = d[_END_SITE]
    start_data, end = ds.series.coverage_start_utc, ds.series.coverage_end_utc
    c = Case(
        "dataset_boundaries",
        "dataset boundary cases",
        False,
        {"site": _END_SITE, "coverage": [_iso(start_data), _iso(end)]},
    )
    runs = {
        "ends_at_last_sample": (end - timedelta(days=14), timedelta(days=14)),
        "one_hour_past_end": (end - timedelta(days=14) + timedelta(hours=1), timedelta(days=14)),
        "starts_before_first_sample": (start_data - 2 * DAY, timedelta(days=7)),
        "entirely_after_data": (end + timedelta(days=31), timedelta(days=14)),
    }
    out: dict[str, Any] = {}
    res: dict[str, ViabilityAssessment] = {}
    for k, (s, dur) in runs.items():
        res[k] = evaluate_scenario(mission(ds, s, dur), ds.prepared)
        out[k] = _summary(res[k])
    c.outcome = out
    q = {k: a.data_quality for k, a in res.items()}
    c.check("ending at the last sample is fully covered", q["ends_at_last_sample"].uncovered_duration_s == 0.0)
    c.check(
        "one hour past the end leaves exactly one hour uncovered",
        q["one_hour_past_end"].uncovered_duration_s == H,
        f"{q['one_hour_past_end'].uncovered_duration_s / H:g} h",
    )
    c.check(
        "one hour past the end is never scored exactly", res["one_hour_past_end"].score.status is not ScoreStatus.KNOWN
    )
    c.check(
        "starting before the data leaves the first 48 h uncovered",
        q["starts_before_first_sample"].uncovered_duration_s == 48 * H,
    )
    after = res["entirely_after_data"]
    c.check(
        "entirely after the data: UNKNOWN, every undecided check NO_DATA",
        after.eligibility is Eligibility.UNKNOWN
        and all(
            x.unknown_reason is UnknownReason.NO_DATA for x in after.constraints if x.status is ConstraintStatus.UNKNOWN
        ),
    )
    for k, a in res.items():
        c.check(
            f"{k}: no proven result contradicts the covered data",
            derive_eligibility(x.status for x in a.constraints) is a.eligibility,
        )
    return c


def _case_sampling(d: dict[str, Dataset], pairs: dict[str, PolicySeriesPair]) -> Case:
    (s1, t1), (s2, t2) = _SAMPLING_AGREE, _SAMPLING_DISAGREE
    c = Case(
        "sampling_policy",
        "sampling-policy agreement and disagreement",
        False,
        {
            "baseline": BASELINE_POLICY.value,
            "alternate": ALTERNATE_POLICY.value,
            "agree": {"site": s1, "start_utc": _iso(t1), "days": 14},
            "disagree": {"site": s2, "start_utc": _iso(t2), "days": 14},
        },
    )
    agree = sampling_sensitivity_report(mission(d[s1], t1, timedelta(days=14)), pairs[s1])
    differ = sampling_sensitivity_report(mission(d[s2], t2, timedelta(days=14)), pairs[s2])
    c.outcome = {
        "agree": {
            "verdict": agree.verdict.value,
            "summary": agree.summary,
            "eligibility": [agree.baseline.assessment.eligibility.value, agree.alternate.assessment.eligibility.value],
        },
        "disagree": {
            "verdict": differ.verdict.value,
            "summary": differ.summary,
            "changed_constraints": [x.value for x in differ.changed_constraints],
            "eligibility": [
                differ.baseline.assessment.eligibility.value,
                differ.alternate.assessment.eligibility.value,
            ],
            "statements": differ.statements[:4],
        },
    }
    c.check("agreement: verdict unchanged", agree.verdict is SensitivityVerdict.UNCHANGED, agree.verdict.value)
    c.check("disagreement: verdict changed", differ.verdict is SensitivityVerdict.CHANGED, differ.verdict.value)
    c.check("disagreement explained by a named constraint", bool(differ.changed_constraints))
    c.check(
        "baseline is exactly the canonical result",
        differ.baseline.assessment == evaluate_scenario(mission(d[s2], t2, timedelta(days=14)), d[s2].series),
    )
    return c


def case_names() -> tuple[str, ...]:
    return tuple(name for name, _ in _CASES) + ("sampling_policy",)


_CASES: Final[tuple[tuple[str, Callable[[dict[str, Dataset]], Case]], ...]] = (
    ("pass_exact", _case_pass),
    ("fail_confirmed", _case_fail),
    ("pass_high_screening_risk", _case_pass_high_risk),
    ("unknown_missing_data", _case_unknown),
    ("bounded_score", _case_bounded),
    ("overlapping_intervals", _case_overlap),
    ("exact_ranking", _case_exact_ranking),
    ("incompatible_configurations", _case_incompatible),
    ("synthetic_kept_separate", _case_synthetic),
    ("dataset_boundaries", _case_boundaries),
)


def run_cases(d: dict[str, Dataset], pairs: dict[str, PolicySeriesPair] | None = None) -> list[Case]:
    if pairs is None:
        pairs = {s: prepare_policy_series(d[s].series) for s in {_SAMPLING_AGREE[0], _SAMPLING_DISAGREE[0]}}
    return [build(d) for _, build in _CASES] + [_case_sampling(d, pairs)]


# --- 3. invariants --------------------------------------------------------------------------------------------------

_STATUS_RANK: Final = {ConstraintStatus.FAIL: 0, ConstraintStatus.UNKNOWN: 1, ConstraintStatus.PASS: 2}
_ELIG_RANK: Final = {Eligibility.FAIL: 0, Eligibility.UNKNOWN: 1, Eligibility.PASS: 2}

# (knob, stricter lander, constraints it may affect). Each knob only tightens.
_STRICTER: Final[tuple[tuple[str, Callable[[Lander], Lander], tuple[ConstraintId, ...]], ...]] = (
    ("darkness limit x0.6", lambda x: _with(x, dark_h=x.dark_h * 0.6), (ConstraintId.MAX_CONTINUOUS_DARKNESS,)),
    (
        "blackout limit x0.6",
        lambda x: _with(x, blackout_h=x.blackout_h * 0.6),
        (ConstraintId.MAX_COMMUNICATION_BLACKOUT,),
    ),
    (
        "panel threshold 0.25 -> 0.6",
        lambda x: _with(x, panel_threshold=0.6),
        (ConstraintId.MAX_CONTINUOUS_DARKNESS, ConstraintId.MIN_INITIAL_SUNLIGHT),
    ),
    (
        "min Earth visibility +20 pp",
        lambda x: _with(x, min_earth_percent=x.min_earth_percent + 20),
        (ConstraintId.MIN_EARTH_VISIBILITY_PERCENT,),
    ),
    (
        "min sunlight +20 pp",
        lambda x: _with(x, min_sunlight_percent=x.min_sunlight_percent + 20),
        (ConstraintId.MIN_SUNLIGHT_PERCENT,),
    ),
    (
        "min mean disk fraction +0.2",
        lambda x: _with(x, min_mean_disk_fraction=x.min_mean_disk_fraction + 0.2),
        (ConstraintId.MIN_MEAN_SOLAR_DISK_FRACTION,),
    ),
    (
        "min initial sunlight x3",
        lambda x: _with(x, min_initial_sun_h=x.min_initial_sun_h * 3),
        (ConstraintId.MIN_INITIAL_SUNLIGHT,),
    ),
    (
        "min initial Earth x4",
        lambda x: _with(x, min_initial_earth_h=x.min_initial_earth_h * 4),
        (ConstraintId.MIN_INITIAL_EARTH_VISIBILITY,),
    ),
)


def _with(lander: Lander, **kw: float) -> Lander:
    return Lander(**{**lander.__dict__, **kw})


def _invariant_missions(d: dict[str, Dataset]) -> list[tuple[str, datetime, timedelta]]:
    """A deterministic spread of real missions: PASS and FAIL, lit and dark seasons, 3 sites, 7- and 14-day."""
    base = [
        (s, datetime(2027, 1, 1, tzinfo=UTC) + timedelta(days=k), timedelta(days=dur))
        for s in DEEP_SITES
        for k, dur in ((19, 14), (139, 7), (200, 14), (283, 14), (345, 7), (400, 14))
    ]
    extra = [("malapert-massif", _PAIR_DATE), ("connecting-ridge", _PAIR_DATE), _PASS_HIGH_RISK_CASE, _FAIL_CASE]
    return base + [(s, t, timedelta(days=14)) for s, t in extra]


def _inv_stricter(d: dict[str, Dataset], missions: Sequence[tuple[str, datetime, timedelta]]) -> list[Check]:
    bad: list[str] = []
    n = 0
    for site, start, dur in missions:
        ds = d[site]
        base = evaluate_scenario(mission(ds, start, dur), ds.prepared)
        bstat = {x.constraint_id: x.status for x in base.constraints}
        for knob, tighten, affected in _STRICTER:
            strict = evaluate_scenario(mission(ds, start, dur, lander=tighten(STANDARD_LANDER)), ds.prepared)
            n += 1
            if _ELIG_RANK[strict.eligibility] > _ELIG_RANK[base.eligibility]:
                bad.append(f"{site} {_iso(start)} {knob}: eligibility improved")
            for x in strict.constraints:
                before = bstat[x.constraint_id]
                if (
                    x.constraint_id in affected
                    and x.status in _STATUS_RANK
                    and before in _STATUS_RANK
                    and _STATUS_RANK[x.status] > _STATUS_RANK[before]
                ):
                    bad.append(f"{site} {_iso(start)} {knob}: {x.constraint_id.value} improved")
    return [
        Check(
            "stricter operational limits never improve the corresponding constraint or eligibility",
            not bad,
            f"{n} tightened evaluations; " + ("; ".join(bad[:5]) or "no improvement found"),
        )
    ]


def _window(
    series: ScientificTimeSeries, start: datetime, end: datetime, gap: tuple[datetime, datetime] | None
) -> ScientificTimeSeries:
    """Re-validated sub-series over [start, end]; samples strictly inside ``gap`` are removed (a coverage gap)."""
    samples = [
        s for s in series.samples if start <= s.time_utc <= end and (gap is None or not gap[0] < s.time_utc < gap[1])
    ]
    data = series.model_dump()
    data.update(coverage_start_utc=start, coverage_end_utc=end, samples=[s.model_dump() for s in samples])
    return ScientificTimeSeries.model_validate(data)


def _contains(full: Metric, partial: Metric) -> bool | None:
    """Is the full-data value consistent with the partial-data metric? None = nothing to compare."""
    if full.status is not MetricStatus.KNOWN or full.value is None:
        return None
    v = full.value
    if partial.status is MetricStatus.KNOWN:
        return partial.value is not None and abs(partial.value - v) <= 1e-9 * max(1.0, abs(v))
    if partial.status is MetricStatus.BOUNDED:
        lo, hi = partial.lower, partial.upper
        tol = 1e-6 * max(1.0, abs(v))
        return (lo is None or lo <= v + tol) and (hi is None or v - tol <= hi)
    return None


def _inv_missing_data(d: dict[str, Dataset], missions: Sequence[tuple[str, datetime, timedelta]]) -> list[Check]:
    bad: list[str] = []
    decided = bounded_metrics = 0
    for site, start, dur in missions:
        series = d[site].series
        lo, hi = start - 2 * DAY, start + dur + 2 * DAY
        mid = start + dur / 2
        gap = (mid - timedelta(hours=12), mid + timedelta(hours=12))  # 24 h without samples inside the mission
        sc = mission(series, start, dur)
        full = evaluate_scenario(sc, _window(series, lo, hi, None))
        part = evaluate_scenario(sc, _window(series, lo, hi, gap))
        tag = f"{site} {_iso(start)}"
        if part.data_quality.uncovered_duration_s <= 0:
            bad.append(f"{tag}: gap not reported as uncovered time")
        fstat = {x.constraint_id: x.status for x in full.constraints}
        for x in part.constraints:
            if x.status in (ConstraintStatus.PASS, ConstraintStatus.FAIL):
                decided += 1
                if fstat[x.constraint_id] is not x.status:
                    bad.append(
                        f"{tag}: {x.constraint_id.value} decided {x.status.value} with the gap, "
                        f"{fstat[x.constraint_id].value} with full data"
                    )
        if part.eligibility in (Eligibility.PASS, Eligibility.FAIL) and part.eligibility is not full.eligibility:
            bad.append(f"{tag}: eligibility {part.eligibility.value} with the gap, {full.eligibility.value} full")
        for (name, fm), (_, pm) in zip(full.metrics, part.metrics, strict=True):
            if isinstance(fm, Metric) and isinstance(pm, Metric):
                ok = _contains(fm, pm)
                if pm.status is MetricStatus.BOUNDED:
                    bounded_metrics += 1
                if ok is False:
                    bad.append(f"{tag}: metric {name} {pm.lower}..{pm.upper} excludes full value {fm.value}")
        fs, ps = full.score, part.score
        pb = ps.score_bounds
        if (
            fs.score is not None
            and pb is not None
            and pb.status is MetricStatus.BOUNDED
            and not ((pb.lower or 0.0) - 1e-6 <= fs.score <= (100.0 if pb.upper is None else pb.upper) + 1e-6)
        ):
            bad.append(f"{tag}: score bounds {pb.lower}..{pb.upper} exclude the full-data score {fs.score}")
        if ps.status is ScoreStatus.KNOWN and part.data_quality.sun_coverage_percent < 100.0:
            # An exact score with unknown Sun time would be fake certainty unless no active component depends on it.
            bad.append(f"{tag}: exact score despite unknown Sun time")
    return [
        Check(
            "missing data never creates certainty (decided-with-gap == full-data result; bounds contain it)",
            not bad,
            f"{len(missions)} missions with a 24 h gap; {decided} decided constraints and "
            f"{bounded_metrics} bounded metrics compared; " + ("; ".join(bad[:5]) or "all consistent"),
        )
    ]


def _inv_weights(d: dict[str, Dataset], missions: Sequence[tuple[str, datetime, timedelta]]) -> list[Check]:
    rng = random.Random(20261114)
    bad: list[str] = []
    n = 0
    for site, start, dur in missions:
        ds = d[site]
        base = evaluate_scenario(mission(ds, start, dur), ds.prepared)
        for _ in range(4):
            prefs = RankingPreferences(
                sunlight_weight=rng.choice([0.0, 0.5, 1.0, 3.0]),
                earth_visibility_weight=rng.choice([0.0, 1.0, 2.0]),
                simultaneous_weight=rng.choice([0.0, 1.0]),
                darkness_margin_weight=rng.choice([0.0, 1.0, 5.0]),
                blackout_margin_weight=rng.choice([0.0, 0.25, 1.0]),
            )
            other = evaluate_scenario(mission(ds, start, dur, preferences=prefs), ds.prepared)
            n += 1
            if (
                other.eligibility is not base.eligibility
                or [(x.constraint_id, x.status) for x in other.constraints]
                != [(x.constraint_id, x.status) for x in base.constraints]
                or other.metrics != base.metrics
                or other.margins != base.margins
                or [(r.code, r.level) for r in other.risks] != [(r.code, r.level) for r in base.risks]
            ):
                bad.append(f"{site} {_iso(start)} {prefs.model_dump()}")
    return [
        Check(
            "preference-weight changes never alter eligibility, constraints, metrics, margins or risk",
            not bad,
            f"{n} reweighted evaluations; " + ("; ".join(bad[:3]) or "identical"),
        )
    ]


def _inv_explanations(d: dict[str, Dataset], missions: Sequence[tuple[str, datetime, timedelta]]) -> list[Check]:
    bad: list[str] = []
    for site, start, dur in missions:
        ds = d[site]
        sc = mission(ds, start, dur)
        a = evaluate_scenario(sc, ds.prepared)
        # The same stages without any explanation step.
        env = analyze_scenario(sc, ds.prepared)
        checks = build_constraint_assessment(sc, env)
        margins = margins_from_assessment(checks)
        risks = assess_risks(sc, checks, margins)
        score = score_scenario(sc, env.metrics, margins, checks.eligibility, data_basis=env.data_quality.data_basis)
        same = (
            a.eligibility is checks.eligibility
            and a.constraints == checks.constraints
            and a.metrics == env.metrics
            and a.margins == margins
            and a.risks == risks
            and a.score == score
            and a.overall_risk is overall_risk(risks)
        )
        before = a.model_dump_json()
        again = generate_explanations(
            a.eligibility, a.constraints, a.margins, a.risks, a.data_quality, score=a.score, overall_risk=a.overall_risk
        )
        explain_assessment(a)
        if not same:
            bad.append(f"{site} {_iso(start)}: calculations differ from the explanation-free pipeline")
        if a.model_dump_json() != before:
            bad.append(f"{site} {_iso(start)}: explaining changed the assessment")
        if again != a.explanations:
            bad.append(f"{site} {_iso(start)}: explanations not reproducible")
    return [
        Check(
            "explanation generation never changes the underlying calculations",
            not bad,
            f"{len(missions)} missions; " + ("; ".join(bad[:3]) or "identical"),
        )
    ]


def _inv_ranking_order(d: dict[str, Dataset]) -> list[Check]:
    """Six comparable 14-day assessments in every order: three PASS (one with high screening risk), one UNKNOWN
    (straddling the end of the data) and two FAIL with different numbers of failed constraints."""
    end = _end(d)
    specs = [
        ("malapert-massif", _PAIR_DATE),
        ("connecting-ridge", _PAIR_DATE),
        (_PASS_HIGH_RISK_CASE[0], _PASS_HIGH_RISK_CASE[1]),
        (_FAIL_CASE[0], _FAIL_CASE[1]),
        (_END_SITE, end - timedelta(days=7)),
        (_END_SITE, end - timedelta(days=14) + timedelta(hours=1)),
    ]
    items = [
        evaluate_scenario(mission(d[s], t, timedelta(days=14), scenario_id=f"r{i}-{s}"), d[s].prepared)
        for i, (s, t) in enumerate(specs)
    ]
    reference = rank_assessments(items)
    ref_text = ranking_explanations(items, reference)
    perms = 0
    bad = False
    for order in itertools.permutations(items):
        perms += 1
        r = rank_assessments(order)
        if r != reference or ranking_explanations(order, r) != ref_text:
            bad = True
            break
    tiers = sorted({a.eligibility.value for a in items})
    return [
        Check(
            "ranking is deterministic regardless of input order",
            not bad,
            f"{perms} permutations of {len(items)} assessments (eligibility tiers {tiers}); order "
            + " > ".join(f"{e.scenario_id}({e.rank})" for e in reference.entries),
        )
    ]


def run_invariants(d: dict[str, Dataset]) -> list[Check]:
    missions = _invariant_missions(d)
    return (
        _inv_stricter(d, missions)
        + _inv_missing_data(d, missions)
        + _inv_weights(d, missions)
        + _inv_explanations(d, missions)
        + _inv_ranking_order(d)
    )


# --- 4. timing ------------------------------------------------------------------------------------------------------


def _stats(samples: Sequence[float]) -> dict[str, float]:
    ordered = sorted(samples)
    p95 = ordered[min(len(ordered) - 1, round(0.95 * (len(ordered) - 1)))]
    return {
        "n": float(len(samples)),
        "total_s": sum(samples),
        "median_ms": 1e3 * statistics.median(samples),
        "mean_ms": 1e3 * statistics.fmean(samples),
        "p95_ms": 1e3 * p95,
        "max_ms": 1e3 * ordered[-1],
    }


def time_workload(d: dict[str, Dataset], *, evaluations: int = 200, sensitivity: int = 40) -> dict[str, Any]:
    """Repeated evaluations on already-prepared data (preparation is timed in ``load_datasets``)."""
    site = "malapert-massif"
    ds = d[site]
    starts = [datetime(2027, 1, 1, tzinfo=UTC) + timedelta(hours=37 * k) for k in range(evaluations)]
    evals = []
    for t in starts:
        sc = mission(ds, t, timedelta(days=14))
        t0 = time.perf_counter()
        evaluate_scenario(sc, ds.prepared)
        evals.append(time.perf_counter() - t0)
    t0 = time.perf_counter()
    pair = prepare_policy_series(ds.series)
    pair_s = time.perf_counter() - t0
    sens = []
    for t in starts[:sensitivity]:
        sc = mission(ds, t, timedelta(days=14))
        t0 = time.perf_counter()
        sampling_sensitivity_report(sc, pair)
        sens.append(time.perf_counter() - t0)
    group = [evaluate_scenario(mission(x, _PAIR_DATE, timedelta(days=14)), x.prepared) for x in d.values()]
    ranks = []
    for _ in range(50):
        t0 = time.perf_counter()
        rank_assessments(group)
        ranks.append(time.perf_counter() - t0)
    prep = {k: {"load_s": v.load_s, "prepare_s": v.prepare_s, "samples": len(v.series.samples)} for k, v in d.items()}
    return {
        "data_preparation": {
            "per_site": prep,
            "total_load_s": sum(v.load_s for v in d.values()),
            "total_prepare_s": sum(v.prepare_s for v in d.values()),
            "description": "load = adapters.load_site_file (JSON parse + contract validation of every sample); "
            "prepare = windows.prepare_series (sample-and-hold step functions), once per dataset",
            "policy_pair_prepare_s": pair_s,
            "policy_pair_description": f"prepare_policy_series({site}): both sampling policies, once per dataset",
        },
        "evaluate_scenario": {
            "workload": f"{evaluations} x 14-day missions at {site}, landings every 37 h from 2027-01-01, standard "
            "lander, on the prepared series (full pipeline incl. explanations)",
            **_stats(evals),
        },
        "sampling_sensitivity_report": {
            "workload": f"{sensitivity} x 14-day missions at {site} on the prepared policy pair (two full evaluations "
            "+ comparison each)",
            **_stats(sens),
        },
        "rank_assessments": {"workload": f"50 x ranking of {len(group)} assessments (one per site)", **_stats(ranks)},
        "caches": "none added: preparation is already done once per dataset by the caller (prepare_series / "
        "prepare_policy_series); per-evaluation time is milliseconds",
    }


def machine_info() -> dict[str, Any]:
    def ver(pkg: str) -> str | None:
        try:
            return importlib.metadata.version(pkg)
        except importlib.metadata.PackageNotFoundError:
            return None

    return {
        "platform": platform.platform(),
        "machine": platform.machine(),
        "processor": platform.processor(),
        "cpu_count": os.cpu_count(),
        "python": platform.python_version(),
        "implementation": platform.python_implementation(),
        "numpy": ver("numpy"),
        "pydantic": ver("pydantic"),
    }


def versions() -> dict[str, str]:
    return {
        "validation": VALIDATION_VERSION,
        "engine": ENGINE_VERSION,
        "scoring_method": SCORING_METHOD_VERSION,
        "ranking_method": RANKING_METHOD_VERSION,
        "explanations": EXPLANATION_METHOD_VERSION,
        "ranking_evidence": EVIDENCE_METHOD_VERSION,
        "sampling_sensitivity": SENSITIVITY_METHOD_VERSION,
        "default_sampling_policy": BASELINE_POLICY.value,
        "alternate_sampling_policy": ALTERNATE_POLICY.value,
        "sampling_policies_supported": ", ".join(p.value for p in SamplingPolicy),
    }


# --- report ---------------------------------------------------------------------------------------------------------


def run_validation(
    *, quick: bool = False, sites_dir: Path = SITES_DIR, datasets: dict[str, Dataset] | None = None
) -> dict[str, Any]:
    """Full validation report (JSON-ready). ``quick`` shrinks only the timing workload; ``datasets`` reuses data
    already loaded with ``load_datasets`` (their preparation times are reported as measured then)."""
    started = datetime.now(UTC)
    t0 = time.perf_counter()
    d = datasets if datasets is not None else load_datasets(sites_dir=sites_dir)
    reference = d.get("malapert-massif")
    smoke: dict[str, Any] = {}
    smoke_checks: list[Check] = []
    for site_id, ds in d.items():
        rec, checks = smoke_dataset(ds, reference if site_id != "malapert-massif" else None)
        smoke[site_id] = rec
        smoke_checks += checks
    cases = run_cases(d)
    invariants = run_invariants(d)
    timing = time_workload(d, evaluations=40 if quick else 200, sensitivity=10 if quick else 40)
    all_checks = smoke_checks + [c for case in cases for c in case.checks] + invariants
    return {
        "validation_version": VALIDATION_VERSION,
        "started_utc": _iso(started),
        "wall_s": time.perf_counter() - t0,
        "versions": versions(),
        "machine": machine_info(),
        "lander": STANDARD_LANDER.to_json(),
        "datasets": [dataset_identity(ds) for ds in d.values()],
        "smoke": {
            "datasets": len(d),
            "checks": len(smoke_checks),
            "failed": [c.to_json() for c in smoke_checks if not c.passed],
            "results": smoke,
        },
        "cases": [c.to_json() for c in cases],
        "invariants": [c.to_json() for c in invariants],
        "timing": timing,
        "summary": {"checks": len(all_checks), "failed": sum(not c.passed for c in all_checks)},
    }


def summarize(report: dict[str, Any]) -> str:
    """Plain-text summary of a report."""
    v, t, s = report["versions"], report["timing"], report["summary"]
    lines = [
        (
            f"Member 2 Part 2 validation ({report['validation_version']}), engine {v['engine']}, scoring "
            f"{v['scoring_method']}, default sampling {v['default_sampling_policy']}"
        ),
        (
            f"Datasets: {len(report['datasets'])} committed site files; smoke checks {report['smoke']['checks']}, "
            f"failed {len(report['smoke']['failed'])}"
        ),
    ]
    for c in report["cases"]:
        flag = "ok " if c["passed"] else "FAIL"
        lines.append(f"  [{flag}] case {c['name']:<28} {c['category']}{' (SYNTHETIC)' if c['synthetic'] else ''}")
        lines += [f"         x {k['name']}: {k['detail']}" for k in c["checks"] if not k["passed"]]
    for k in report["invariants"]:
        lines.append(f"  [{'ok ' if k['passed'] else 'FAIL'}] invariant: {k['name']} ({k['detail']})")
    p = t["data_preparation"]
    lines += [
        (
            f"Timing on {report['machine']['platform']} ({report['machine']['cpu_count']} logical CPUs, Python "
            f"{report['machine']['python']}):"
        ),
        (
            f"  data preparation: load {p['total_load_s']:.2f} s + prepare {p['total_prepare_s']:.2f} s for "
            f"{len(p['per_site'])} files"
        ),
        (
            f"  evaluate_scenario: median {t['evaluate_scenario']['median_ms']:.2f} ms, p95 "
            f"{t['evaluate_scenario']['p95_ms']:.2f} ms ({t['evaluate_scenario']['workload']})"
        ),
        f"  sampling_sensitivity_report: median {t['sampling_sensitivity_report']['median_ms']:.2f} ms",
        f"  rank_assessments: median {t['rank_assessments']['median_ms']:.3f} ms",
        f"Checks: {s['checks']}, failed: {s['failed']}  (wall {report['wall_s']:.1f} s)",
    ]
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(prog="python -m app.viability.validation", description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, help="write the JSON report here")
    ap.add_argument("--quick", action="store_true", help="smaller timing workload")
    args = ap.parse_args(argv)
    report = run_validation(quick=args.quick)
    if args.out:
        args.out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(summarize(report))
    return 0 if report["summary"]["failed"] == 0 else 1
