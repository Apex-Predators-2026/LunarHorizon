"""Service layer of the viability HTTP API: site-file lookup, cached preparation and response assembly.

``assess`` runs exactly the canonical pipeline the rest of the project uses on Member 1's site files
(``adapters.load_site_file`` -> ``windows.prepare_series`` -> ``engine.evaluate_scenario``; see
``consumer_examples`` and the validation suite). It never re-derives a verdict, a metric or a score: the
response embeds the ``ViabilityAssessment`` unchanged, and ``RankingStatus`` / ``InputDataset`` are verbatim
projections of the assessment and of the validated input series.

Caching: loading and validating one 5-year hourly site file takes about 2 s and preparing it about 0.2 s, so the
prepared series is cached per file (keyed by path, size and modification time, so a regenerated file is reloaded).
``evaluate_scenario`` documents that a ``PreparedSeries`` gives a result identical to the raw series.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import UTC, timedelta
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final

from ..adapters import load_site_file
from ..conventions import SCHEMA_VERSION
from ..engine import ENGINE_VERSION, evaluate_scenario
from ..explain import EXPLANATION_METHOD_VERSION, STANDARD_LIMITATIONS, explain_assessment_details
from ..mission import LandingSite, MissionScenario
from ..outputs import ViabilityAssessment
from ..ranking import RANKING_METHOD_VERSION
from ..scoring import SCORING_METHOD_VERSION
from ..windows import PreparedSeries, prepare_series
from .schemas import (
    API_VERSION,
    AssessRequest,
    AssessResponse,
    CheckResult,
    CheckTotals,
    InputDataset,
    MethodVersions,
    RankingStatus,
    ReportCurrency,
    ScoreComparability,
    TimingSummary,
    ValidatedDataset,
    ValidationCase,
    ValidationSummaryResponse,
)

REPO_ROOT: Final = Path(__file__).resolve().parents[4]
SITES_DIR: Final = REPO_ROOT / "data" / "sites"
VALIDATION_REPORT: Final = REPO_ROOT / "data" / "validation" / "viability_validation.json"
REGENERATE_COMMAND: Final = (
    "cd backend && python -m app.viability.validation --out ../data/validation/viability_validation.json"
)
PREPARED_CACHE_SIZE: Final = 4  # about 150 MB per prepared 5-year hourly file


_SITE_ID: Final = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")  # same pattern as schemas.SiteId

if TYPE_CHECKING:
    from ...models import Scenario


class SiteNotFoundError(LookupError):
    """No precomputed site file for the requested id."""


class ValidationReportMissingError(LookupError):
    """The stored validation report does not exist (it has not been generated)."""


@dataclass(frozen=True)
class SiteDataset:
    path: Path
    relative_path: str
    sha256: str
    prepared: PreparedSeries


# --- site files ---------------------------------------------------------------------------------------------------


def site_file_path(site_id: str, sites_dir: Path = SITES_DIR) -> Path:
    """``<sites_dir>/<id>.json``, else a custom site at ``<sites_dir>/custom/<id>.json``.

    ``site_id`` is already restricted to ``[A-Za-z0-9._-]`` by the request model; the resolved path is still
    required to stay inside ``sites_dir``.
    """
    root = sites_dir.resolve()
    for candidate in (root / f"{site_id}.json", root / "custom" / f"{site_id}.json"):
        path = candidate.resolve()
        if path.is_relative_to(root) and path.is_file():
            return path
    raise SiteNotFoundError(f"Unknown site {site_id!r}: no precomputed site file data/sites/{site_id}.json")


def _relative(path: Path) -> str:
    try:
        return path.relative_to(REPO_ROOT).as_posix()
    except ValueError:  # a sites_dir outside the repository (tests)
        return path.name


@lru_cache(maxsize=PREPARED_CACHE_SIZE)
def _load_prepared(path: str, size: int, mtime_ns: int) -> SiteDataset:
    p = Path(path)
    digest = hashlib.sha256(p.read_bytes()).hexdigest()
    series = load_site_file(p)  # raises SiteFileError (a ValueError) for invalid data
    return SiteDataset(path=p, relative_path=_relative(p), sha256=digest, prepared=prepare_series(series))


def load_site_dataset(site_id: str, sites_dir: Path = SITES_DIR) -> SiteDataset:
    path = site_file_path(site_id, sites_dir)
    stat = path.stat()
    return _load_prepared(str(path), stat.st_size, stat.st_mtime_ns)


def clear_cache() -> None:
    _load_prepared.cache_clear()
    _file_sha256.cache_clear()


# --- assessment ---------------------------------------------------------------------------------------------------


def build_scenario(req: AssessRequest, site: LandingSite) -> MissionScenario:
    """The canonical ``MissionScenario`` for a request; the site is the site file's own (ids always match).

    Raises pydantic ``ValidationError`` for an invalid window (end not after start, or beyond the sanity cap).
    """
    scenario_id = req.scenario_id or f"{site.id}_{req.mission_start_utc:%Y%m%dT%H%M%SZ}"[:64]
    return MissionScenario(
        scenario_id=scenario_id,
        name=req.name,
        site=site,
        mission_start_utc=req.mission_start_utc,
        mission_end_utc=req.mission_end_utc,
        spacecraft=req.spacecraft,
        requirements=req.requirements,
        preferences=req.preferences,
    )


def ranking_status(a: ViabilityAssessment) -> RankingStatus:
    """Verbatim projection of ``a``'s eligibility, score and comparability identity (no new decision)."""
    s = a.score
    signature = s.weights_signature()
    if signature is None:  # never produced by the Phase 5 engine; refuse rather than guess
        raise ValueError(f"{a.scenario_id}: score has no Phase 5 metadata and cannot be ranked")
    return RankingStatus(
        eligibility=a.eligibility,
        rank_eligible=s.rank_eligible,
        score_status=s.status,
        score=s.score,
        score_bounds=s.score_bounds,
        score_lower_bound=s.lower_bound,
        overall_risk=a.overall_risk,
        comparability=ScoreComparability(
            data_basis=a.data_basis,
            scoring_method_version=s.method_version,
            effective_weights={component: str(weight) for component, weight in signature},
            configuration_key=s.configuration_key,
        ),
    )


def input_dataset(ds: SiteDataset, scenario: MissionScenario) -> InputDataset:
    s = ds.prepared.series
    return InputDataset(
        site_file=ds.relative_path,
        sha256=ds.sha256,
        dataset_id=s.dataset_id,
        coverage_start_utc=s.coverage_start_utc,
        coverage_end_utc=s.coverage_end_utc,
        mission_within_coverage=(
            s.coverage_start_utc <= scenario.mission_start_utc and scenario.mission_end_utc <= s.coverage_end_utc
        ),
        sample_count=len(s.samples),
        sampling=s.sampling,
        calculation_basis=s.calculation_basis,
        angle_type=s.angle_type,
        sun_criterion=s.sun_criterion,
        earth_criterion=s.earth_criterion,
        fraction_decimals=s.fraction_decimals,
        observer_height_m=s.observer_height_m,
        provenance=s.provenance,
    )


def method_versions() -> MethodVersions:
    return MethodVersions(
        api=API_VERSION,
        schema_version=SCHEMA_VERSION,
        engine=ENGINE_VERSION,
        scoring=SCORING_METHOD_VERSION,
        ranking=RANKING_METHOD_VERSION,
        explanations=EXPLANATION_METHOD_VERSION,
    )


def assess_request_for_scenario(scenario: Scenario, include_explanation_details: bool = True) -> AssessRequest:
    """Team ``Scenario`` -> canonical ``AssessRequest`` through the shared Rescue mapping (no second mapping).

    Raises ``SiteNotFoundError`` for a site that is not a precomputed site file (e.g. ``custom:...``).
    """
    from ..compat.rescue import requirements_to_canonical  # imported here to avoid an import cycle

    site_id = scenario.site.id
    if not _SITE_ID.fullmatch(site_id):
        raise SiteNotFoundError(f"Site {site_id!r} has no precomputed site file; only curated sites can be assessed")
    from ...timegrid import snap_duration_days, snap_time

    spacecraft, requirements = requirements_to_canonical(scenario.requirements)
    # One time policy on every screen (app.timegrid, shared with Comparison, Rescue and the Atlas): a team Scenario
    # is evaluated on the hourly data grid. The response's assessment reports the evaluated interval.
    start = snap_time(scenario.landing_utc).astimezone(UTC)
    return AssessRequest(
        site_id=site_id,
        mission_start_utc=start,
        mission_end_utc=start + timedelta(days=snap_duration_days(scenario.duration_days)),
        spacecraft=spacecraft,
        requirements=requirements,
        name=scenario.site.name.strip() or None,
        include_explanation_details=include_explanation_details,
    )


def assess(req: AssessRequest, sites_dir: Path = SITES_DIR) -> AssessResponse:
    """Evaluate one request with the canonical engine. Raises ``SiteNotFoundError``, ``SiteFileError`` (invalid
    site data) or pydantic ``ValidationError`` (invalid mission window)."""
    ds = load_site_dataset(req.site_id, sites_dir)
    scenario = build_scenario(req, ds.prepared.series.site)
    assessment = evaluate_scenario(scenario, ds.prepared)
    return AssessResponse(
        assessment=assessment,
        ranking_status=ranking_status(assessment),
        explanation_details=explain_assessment_details(assessment) if req.include_explanation_details else None,
        input_dataset=input_dataset(ds, scenario),
        methods=method_versions(),
    )


# --- validation summary -------------------------------------------------------------------------------------------


@lru_cache(maxsize=64)
def _file_sha256(path: str, size: int, mtime_ns: int) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _current_sha256(path: Path) -> str | None:
    if not path.is_file():
        return None
    stat = path.stat()
    return _file_sha256(str(path), stat.st_size, stat.st_mtime_ns)


def _check(raw: dict[str, Any]) -> CheckResult:
    return CheckResult(name=raw["name"], passed=raw["passed"], detail=raw.get("detail", ""))


def validation_summary(report_path: Path = VALIDATION_REPORT, sites_dir: Path = SITES_DIR) -> ValidationSummaryResponse:
    """Structured summary of the stored validation report, plus whether it still matches the running code and
    the committed site files. The suite itself is not re-run here (a full run takes about a minute)."""
    from ..validation.suite import versions  # local: keeps importing the API module cheap

    if not report_path.is_file():
        raise ValidationReportMissingError(f"No viability validation report yet: run `{REGENERATE_COMMAND}`")
    report: dict[str, Any] = json.loads(report_path.read_text(encoding="utf-8"))

    current_versions = versions()
    mismatches = [
        f"{key}: report {report['versions'].get(key)!r}, running {value!r}"
        for key, value in current_versions.items()
        if report["versions"].get(key) != value
    ]
    datasets: list[ValidatedDataset] = []
    for d in report["datasets"]:
        now = _current_sha256(sites_dir / Path(d["file"]).name)
        datasets.append(
            ValidatedDataset(
                site_id=d["site_id"],
                file=d["file"],
                sha256=d["sha256"],
                current_sha256=now,
                unchanged=now == d["sha256"],
                is_synthetic=d["is_synthetic"],
                calculation_basis=d["calculation_basis"],
                coverage_start_utc=d["coverage_start_utc"],
                coverage_end_utc=d["coverage_end_utc"],
                sample_count=d["sample_count"],
            )
        )
    changed = [d.site_id for d in datasets if not d.unchanged]
    validated = {d.site_id for d in datasets}
    unvalidated = sorted(p.stem for p in sites_dir.glob("*.json") if p.stem not in validated)
    current = not mismatches and not changed and not unvalidated
    note = (
        "The stored report matches the running engine versions and every committed site file."
        if current
        else "The stored report is OUT OF DATE for the items listed; regenerate it before relying on it."
    )

    timing, prep = report["timing"], report["timing"]["data_preparation"]
    totals = report["summary"]
    return ValidationSummaryResponse(
        status="passed" if totals["failed"] == 0 else "failed",
        validation_version=report["validation_version"],
        generated_utc=report["started_utc"],
        report_file=_relative(report_path),
        regenerate_command=REGENERATE_COMMAND,
        versions=report["versions"],
        currency=ReportCurrency(
            current=current,
            version_mismatches=mismatches,
            changed_datasets=changed,
            unvalidated_datasets=unvalidated,
            note=note,
        ),
        totals=CheckTotals(
            checks=totals["checks"],
            failed=totals["failed"],
            smoke_checks=report["smoke"]["checks"],
            smoke_failed=[_check(c) for c in report["smoke"]["failed"]],
        ),
        cases=[
            ValidationCase(
                name=c["name"],
                category=c["category"],
                synthetic=c["synthetic"],
                passed=c["passed"],
                check_count=len(c["checks"]),
                failed_checks=[_check(k) for k in c["checks"] if not k["passed"]],
                inputs=c["inputs"],
                outcome=c["outcome"],
            )
            for c in report["cases"]
        ],
        invariants=[_check(k) for k in report["invariants"]],
        datasets=datasets,
        standard_lander=report["lander"],
        timing=TimingSummary(
            evaluate_scenario_median_ms=timing["evaluate_scenario"]["median_ms"],
            evaluate_scenario_p95_ms=timing["evaluate_scenario"]["p95_ms"],
            evaluate_scenario_workload=timing["evaluate_scenario"]["workload"],
            data_load_total_s=prep["total_load_s"],
            data_prepare_total_s=prep["total_prepare_s"],
            machine=report["machine"],
        ),
        limitations=list(STANDARD_LIMITATIONS),
    )


__all__ = [
    "PREPARED_CACHE_SIZE",
    "REGENERATE_COMMAND",
    "SITES_DIR",
    "VALIDATION_REPORT",
    "SiteDataset",
    "SiteNotFoundError",
    "ValidationReportMissingError",
    "assess",
    "build_scenario",
    "clear_cache",
    "input_dataset",
    "load_site_dataset",
    "method_versions",
    "ranking_status",
    "site_file_path",
    "validation_summary",
]
