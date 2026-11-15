"""TestClient tests of the viability HTTP API (``app.viability.api``): /api/viability/assess and
/api/viability/validation-summary.

The router is mounted on a fresh FastAPI app here, so these tests do not depend on its registration in
``app/main.py`` (owned by the application owner). Real cases use Member 1's committed site files and the
validation suite's standard lander; every expected outcome is cross-checked against a direct call of the
canonical engine on the same data, never typed in.
"""

from __future__ import annotations

import json
import shutil
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from app.viability.api import service
from app.viability.api.router import router, sites_dir, validation_report_path
from app.viability.api.schemas import API_VERSION, AssessResponse, ValidationSummaryResponse
from app.viability.engine import evaluate_scenario
from app.viability.enums import (
    CommunicationMode,
    ConstraintStatus,
    DataBasis,
    Eligibility,
    MetricStatus,
    PowerSource,
    ScoreComponent,
    ScoreStatus,
    UnknownReason,
)
from app.viability.explain import STANDARD_LIMITATIONS, explain_assessment_details
from app.viability.mission import RankingPreferences, SpacecraftConfiguration
from app.viability.outputs import ViabilityAssessment
from app.viability.validation.suite import STANDARD_LANDER, versions
from tests.viability.real_data import SITES_DIR, timeline_bounds

REAL = ("malapert-massif", "connecting-ridge")
pytestmark = pytest.mark.skipif(
    not all((SITES_DIR / f"{s}.json").exists() for s in REAL), reason="committed site files not present"
)
H = 3600.0


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    return app


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(_app())


def _iso(t: datetime) -> str:
    return t.astimezone(UTC).isoformat().replace("+00:00", "Z")


def body(
    site: str, start: datetime, duration: timedelta, *, spacecraft: dict[str, Any] | None = None, **extra: Any
) -> dict[str, Any]:
    return {
        "site_id": site,
        "mission_start_utc": _iso(start),
        "mission_end_utc": _iso(start + duration),
        "spacecraft": spacecraft or STANDARD_LANDER.spacecraft().model_dump(mode="json"),
        "requirements": STANDARD_LANDER.requirements().model_dump(mode="json"),
        **extra,
    }


def assess(client: TestClient, payload: dict[str, Any]) -> AssessResponse:
    r = client.post("/api/viability/assess", json=payload)
    assert r.status_code == 200, r.text
    # Strict response contract: the JSON validates back into the response model.
    return AssessResponse.model_validate_json(r.text)


def canonical(resp: AssessResponse) -> ViabilityAssessment:
    """The same scenario evaluated directly on the raw (unprepared) validated series of the same file."""
    ds = service.load_site_dataset(resp.assessment.site.id)
    a = resp.assessment
    from app.viability.mission import MissionScenario

    scenario = MissionScenario(
        scenario_id=a.scenario_id,
        site=ds.prepared.series.site,
        mission_start_utc=a.evaluated_start_utc,
        mission_end_utc=a.evaluated_end_utc,
        spacecraft=STANDARD_LANDER.spacecraft(),
        requirements=STANDARD_LANDER.requirements(),
    )
    return evaluate_scenario(scenario, ds.prepared.series)


def assert_projection(resp: AssessResponse) -> None:
    """ranking_status and input_dataset are verbatim views of the assessment and its input series."""
    a, rs = resp.assessment, resp.ranking_status
    assert rs.eligibility is a.eligibility
    assert rs.rank_eligible is a.score.rank_eligible is (a.eligibility is Eligibility.PASS)
    assert rs.score_status is a.score.status
    assert rs.score == a.score.score
    assert rs.score_bounds == a.score.score_bounds
    assert rs.score_lower_bound == a.score.lower_bound
    assert rs.overall_risk is a.overall_risk
    key = a.comparability_key()
    signature = a.score.weights_signature()
    assert signature is not None and key == (a.data_basis, a.score.method_version, signature, a.score.configuration_key)
    assert rs.comparability.data_basis is a.data_basis
    assert rs.comparability.scoring_method_version == a.score.method_version
    assert [(c, str(w)) for c, w in signature] == list(rs.comparability.effective_weights.items())
    assert rs.comparability.configuration_key == a.score.configuration_key
    assert resp.input_dataset.dataset_id == a.data_quality.dataset_id
    assert resp.input_dataset.provenance == a.data_quality.provenance
    assert resp.methods.engine == a.engine_version
    assert resp.methods.scoring == a.score.method_version
    assert resp.api_version == API_VERSION
    assert a.limitations == list(STANDARD_LIMITATIONS)
    if resp.explanation_details is not None:
        assert resp.explanation_details == explain_assessment_details(a)
        assert [d.explanation for d in resp.explanation_details] == a.explanations
        keys = [d.key for d in resp.explanation_details]
        assert len(keys) == len(set(keys))


# --- outcomes on real data ----------------------------------------------------------------------------------------


def test_pass_with_exact_score_equals_the_canonical_engine(client: TestClient) -> None:
    resp = assess(client, body("malapert-massif", datetime(2027, 7, 20, tzinfo=UTC), timedelta(days=14)))
    a = resp.assessment
    assert a.eligibility is Eligibility.PASS
    assert all(c.status in (ConstraintStatus.PASS, ConstraintStatus.NOT_APPLICABLE) for c in a.constraints)
    assert a.score.status is ScoreStatus.KNOWN and a.score.score is not None
    assert resp.ranking_status.rank_eligible is True
    assert a.data_basis is DataBasis.REAL_TERRAIN_AWARE and not a.data_quality.provenance.is_synthetic
    assert resp.input_dataset.mission_within_coverage is True
    assert resp.input_dataset.site_file == "data/sites/malapert-massif.json"
    assert a.data_quality.uncovered_duration_s == 0.0
    # Identical to evaluate_scenario on the raw validated series (the API reuses a PreparedSeries).
    assert a == canonical(resp)
    assert resp.assessment.model_dump_json() == canonical(resp).model_dump_json()
    assert_projection(resp)


def test_confirmed_fail_is_not_rank_eligible_and_keeps_failure_evidence(client: TestClient) -> None:
    resp = assess(client, body("connecting-ridge", datetime(2027, 3, 1, tzinfo=UTC), timedelta(days=14)))
    a = resp.assessment
    assert a.eligibility is Eligibility.FAIL
    failed = [c for c in a.constraints if c.status is ConstraintStatus.FAIL]
    assert failed
    for c in failed:
        assert c.threshold is not None and c.message and c.requirement_field
        assert c.measured.status in (MetricStatus.KNOWN, MetricStatus.BOUNDED)
    darkness = next(c for c in failed if c.constraint_id.value == "max_continuous_darkness")
    assert darkness.evidence_windows  # the longest outage window that breaks the limit
    # A FAIL keeps a descriptive score but is never rank-eligible.
    assert resp.ranking_status.rank_eligible is False
    assert a.score.status is ScoreStatus.KNOWN and a.score.score is not None
    assert a == canonical(resp)
    assert_projection(resp)


def test_unknown_beyond_the_data_is_never_reported_as_fail_or_zero(client: TestClient) -> None:
    _, end = timeline_bounds("connecting-ridge")
    # Validation case "unknown_missing_data": 14-day mission starting 7 days before the last sample.
    resp = assess(client, body("connecting-ridge", end - timedelta(days=7), timedelta(days=14)))
    a = resp.assessment
    assert a.eligibility is Eligibility.UNKNOWN
    statuses = {c.status for c in a.constraints}
    assert ConstraintStatus.UNKNOWN in statuses and ConstraintStatus.FAIL not in statuses
    for c in a.constraints:
        assert (c.unknown_reason is not None) is (c.status is ConstraintStatus.UNKNOWN)
    assert a.score.status is ScoreStatus.ELIGIBILITY_UNKNOWN
    assert a.score.score is None and resp.ranking_status.score is None
    assert resp.ranking_status.score_lower_bound is None and resp.ranking_status.rank_eligible is False
    assert resp.input_dataset.mission_within_coverage is False
    assert a.data_quality.uncovered_duration_s == pytest.approx(7 * 24 * H)
    assert a == canonical(resp)
    assert_projection(resp)


def test_mission_entirely_after_the_data_is_unknown_no_data(client: TestClient) -> None:
    _, end = timeline_bounds("malapert-massif")
    resp = assess(client, body("malapert-massif", end + timedelta(days=30), timedelta(days=3)))
    a = resp.assessment
    assert a.eligibility is Eligibility.UNKNOWN
    unknown = [c for c in a.constraints if c.status is ConstraintStatus.UNKNOWN]
    assert unknown and all(c.unknown_reason is UnknownReason.NO_DATA for c in unknown)
    assert a.data_quality.sample_count == 0
    assert_projection(resp)


def test_bounded_score_stays_an_interval(client: TestClient) -> None:
    _, end = timeline_bounds("connecting-ridge")
    # 3-day mission whose last hour lies after the final sample (validation case "bounded_score").
    resp = assess(client, body("connecting-ridge", end - timedelta(hours=71), timedelta(days=3)))
    a, rs = resp.assessment, resp.ranking_status
    assert a.eligibility is Eligibility.PASS
    assert rs.score_status is ScoreStatus.BOUNDED
    assert rs.score is None  # a bound is never written into the point score
    assert rs.score_bounds is not None and rs.score_bounds.status is MetricStatus.BOUNDED
    assert rs.score_bounds.lower is not None and rs.score_bounds.upper is not None
    assert 0.0 < rs.score_bounds.lower < rs.score_bounds.upper
    assert rs.score_lower_bound == rs.score_bounds.lower
    assert rs.rank_eligible is True
    assert a == canonical(resp)
    assert_projection(resp)


def test_score_unavailable_when_no_component_is_scorable(client: TestClient) -> None:
    # Only the darkness-margin weight is set, but the spacecraft has no darkness limit: nothing can be scored.
    spacecraft = SpacecraftConfiguration(
        name="RTG lander", power_source=PowerSource.RADIOISOTOPE, communication_mode=CommunicationMode.RELAY
    ).model_dump(mode="json")
    weights = RankingPreferences(
        sunlight_weight=0.0, earth_visibility_weight=0.0, blackout_margin_weight=0.0, darkness_margin_weight=1.0
    ).model_dump(mode="json")
    payload = body("malapert-massif", datetime(2027, 7, 20, tzinfo=UTC), timedelta(days=14), spacecraft=spacecraft)
    payload["requirements"] = {}
    payload["preferences"] = weights
    resp = assess(client, payload)
    a = resp.assessment
    assert a.eligibility is Eligibility.PASS  # vacuously: no hard constraint applies
    assert all(c.status is ConstraintStatus.NOT_APPLICABLE for c in a.constraints)
    assert a.score.status is ScoreStatus.NO_SCORABLE_COMPONENTS
    assert a.score.score is None and a.score.score_bounds is None
    assert resp.ranking_status.score is None and resp.ranking_status.score_lower_bound is None
    assert set(resp.ranking_status.comparability.effective_weights.values()) == {"0"}
    assert_projection(resp)


def test_response_exposes_every_canonical_section(client: TestClient) -> None:
    resp = assess(client, body("malapert-massif", datetime(2027, 7, 20, tzinfo=UTC), timedelta(days=14)))
    raw = json.loads(resp.model_dump_json())
    assert set(raw) == {
        "api_version",
        "assessment",
        "ranking_status",
        "explanation_details",
        "input_dataset",
        "methods",
    }
    assert set(raw["assessment"]) >= {
        "eligibility",
        "constraints",
        "metrics",
        "windows",
        "margins",
        "risks",
        "overall_risk",
        "score",
        "explanations",
        "data_quality",
        "limitations",
    }
    a = resp.assessment
    assert a.margins and a.windows and a.explanations
    assert a.data_quality.assumptions  # sampling rule etc.
    assert a.data_quality.provenance.ephemeris_source and a.data_quality.provenance.terrain_source
    assert [c.component for c in a.score.components] == list(ScoreComponent)


def test_explanation_details_are_optional(client: TestClient) -> None:
    payload = body("malapert-massif", datetime(2027, 7, 20, tzinfo=UTC), timedelta(days=14))
    resp = assess(client, {**payload, "include_explanation_details": False})
    assert resp.explanation_details is None
    assert resp.assessment.explanations  # the assessment's own explanations are always present


def test_scenario_id_and_name_are_echoed(client: TestClient) -> None:
    payload = body("malapert-massif", datetime(2027, 7, 20, tzinfo=UTC), timedelta(days=1))
    default = assess(client, payload)
    assert default.assessment.scenario_id == "malapert-massif_20270720T000000Z"
    named = assess(client, {**payload, "scenario_id": "plan-a.1", "name": "Plan A"})
    assert named.assessment.scenario_id == "plan-a.1"


def test_repeated_requests_are_identical(client: TestClient) -> None:
    payload = body("connecting-ridge", datetime(2027, 12, 3, tzinfo=UTC), timedelta(days=14))
    first = client.post("/api/viability/assess", json=payload)
    second = client.post("/api/viability/assess", json=payload)
    assert first.status_code == second.status_code == 200
    assert first.content == second.content


# --- request validation -------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("change", "where"),
    [
        ({"surprise": 1}, "surprise"),  # unknown top-level field
        ({"spacecraft": {**STANDARD_LANDER.spacecraft().model_dump(mode="json"), "battery_wh": 5}}, "battery_wh"),
        ({"mission_start_utc": "2027-07-20T00:00:00"}, "mission_start_utc"),  # naive time
        ({"mission_start_utc": "2027-07-20T00:00:00+02:00"}, "mission_start_utc"),  # non-UTC offset
        ({"mission_start_utc": 1815868800}, "mission_start_utc"),  # epoch number
        ({"site_id": "../secrets"}, "site_id"),
        ({"site_id": "a/b"}, "site_id"),
        ({"include_explanation_details": "yes"}, "include_explanation_details"),
        (
            {"spacecraft": {**STANDARD_LANDER.spacecraft().model_dump(mode="json"), "max_continuous_darkness_s": "1"}},
            "max_continuous_darkness_s",
        ),
        (
            {"spacecraft": {**STANDARD_LANDER.spacecraft().model_dump(mode="json"), "max_continuous_darkness_s": True}},
            "max_continuous_darkness_s",
        ),
        ({"requirements": {"min_earth_visibility_percent": 140.0}}, "min_earth_visibility_percent"),
        ({"preferences": {"sunlight_weight": -1.0}}, "sunlight_weight"),
    ],
)
def test_invalid_requests_are_422(client: TestClient, change: dict[str, Any], where: str) -> None:
    payload = {**body("malapert-massif", datetime(2027, 7, 20, tzinfo=UTC), timedelta(days=1)), **change}
    r = client.post("/api/viability/assess", json=payload)
    assert r.status_code == 422, r.text
    assert where in json.dumps(r.json()["detail"])


def test_missing_required_fields_are_422(client: TestClient) -> None:
    for field in ("site_id", "mission_start_utc", "mission_end_utc", "spacecraft"):
        payload = body("malapert-massif", datetime(2027, 7, 20, tzinfo=UTC), timedelta(days=1))
        del payload[field]
        r = client.post("/api/viability/assess", json=payload)
        assert r.status_code == 422 and field in r.text


def test_mission_window_errors_are_422_with_body_location(client: TestClient) -> None:
    start = datetime(2027, 7, 20, tzinfo=UTC)
    for end in (start, start - timedelta(hours=1), start + timedelta(days=4000)):
        payload = {**body("malapert-massif", start, timedelta(days=1)), "mission_end_utc": _iso(end)}
        r = client.post("/api/viability/assess", json=payload)
        assert r.status_code == 422, r.text
        assert r.json()["detail"][0]["loc"][0] == "body"


def test_unknown_site_is_404(client: TestClient) -> None:
    r = client.post("/api/viability/assess", json=body("no-such-site", datetime(2027, 1, 1, tzinfo=UTC), timedelta(1)))
    assert r.status_code == 404 and "no-such-site" in r.json()["detail"]


# --- site lookup, invalid data and caching (temporary directories) ------------------------------------------------


@pytest.fixture
def tmp_sites(tmp_path: Path) -> Iterator[tuple[TestClient, Path]]:
    app = _app()
    app.dependency_overrides[sites_dir] = lambda: tmp_path
    yield TestClient(app), tmp_path
    service.clear_cache()


def test_invalid_site_data_is_422_never_a_guess(tmp_sites: tuple[TestClient, Path]) -> None:
    client, root = tmp_sites
    raw = json.loads((SITES_DIR / "malapert-massif.json").read_text(encoding="utf-8"))
    raw["meta"]["ephemeris"] = "some ephemeris without an angle type"
    (root / "broken.json").write_text(json.dumps(raw), encoding="utf-8")
    r = client.post("/api/viability/assess", json=body("broken", datetime(2027, 7, 20, tzinfo=UTC), timedelta(1)))
    assert r.status_code == 422
    assert "cannot be assessed" in r.json()["detail"] and "apparent" in r.json()["detail"]


def test_custom_site_files_are_found_and_regenerated_files_reloaded(tmp_sites: tuple[TestClient, Path]) -> None:
    client, root = tmp_sites
    (root / "custom").mkdir()
    target = root / "custom" / "custom_m89.0000_0.0000.json"
    shutil.copyfile(SITES_DIR / "malapert-massif.json", target)
    payload = body("custom_m89.0000_0.0000", datetime(2027, 7, 20, tzinfo=UTC), timedelta(days=1))
    first = assess(client, payload)
    assert first.input_dataset.site_file == target.name  # outside the repository: file name only
    assert service.load_site_dataset("custom_m89.0000_0.0000", root) is service.load_site_dataset(
        "custom_m89.0000_0.0000", root
    )
    raw = json.loads(target.read_text(encoding="utf-8"))
    raw["meta"]["ephemeris"] += " (regenerated)"
    target.write_text(json.dumps(raw), encoding="utf-8")
    second = assess(client, payload)
    assert second.input_dataset.sha256 != first.input_dataset.sha256
    assert "(regenerated)" in second.input_dataset.provenance.ephemeris_source


def test_site_lookup_stays_inside_the_sites_directory(tmp_path: Path) -> None:
    (tmp_path / "sites").mkdir()
    (tmp_path / "outside.json").write_text("{}", encoding="utf-8")
    with pytest.raises(service.SiteNotFoundError):
        service.site_file_path("..", tmp_path / "sites")
    with pytest.raises(service.SiteNotFoundError):
        service.site_file_path("outside", tmp_path / "sites")


# --- validation summary -------------------------------------------------------------------------------------------


def test_validation_summary_of_the_committed_report(client: TestClient) -> None:
    if not service.VALIDATION_REPORT.exists():
        pytest.skip("validation report not generated")
    r = client.get("/api/viability/validation-summary")
    assert r.status_code == 200, r.text
    s = ValidationSummaryResponse.model_validate_json(r.text)
    report = json.loads(service.VALIDATION_REPORT.read_text(encoding="utf-8"))
    assert s.status == ("passed" if report["summary"]["failed"] == 0 else "failed")
    assert s.totals.checks == report["summary"]["checks"] and s.totals.failed == report["summary"]["failed"]
    assert [c.name for c in s.cases] == [c["name"] for c in report["cases"]]
    assert {c.name for c in s.cases} >= {"pass_exact", "fail_confirmed", "unknown_missing_data", "bounded_score"}
    assert [c.synthetic for c in s.cases].count(True) == 1  # only the labelled SYNTHETIC fixture case
    assert len(s.invariants) == len(report["invariants"])
    assert s.report_file == "data/validation/viability_validation.json"
    assert s.limitations == list(STANDARD_LIMITATIONS)
    cur = s.currency
    assert cur.current is (not cur.version_mismatches and not cur.changed_datasets and not cur.unvalidated_datasets)
    assert all(d.unchanged is (d.current_sha256 == d.sha256) for d in s.datasets)


def _small_report(sha: str) -> dict[str, Any]:
    check = {"name": "c", "passed": True, "detail": ""}
    return {
        "validation_version": "member2-part2-validation-v1",
        "started_utc": "2026-11-14T00:00:00Z",
        "versions": versions(),
        "machine": {"platform": "test", "cpu_count": 1},
        "lander": STANDARD_LANDER.to_json(),
        "datasets": [
            {
                "site_id": "s1",
                "file": "data/sites/s1.json",
                "sha256": sha,
                "is_synthetic": False,
                "calculation_basis": "terrain_aware",
                "coverage_start_utc": "2026-01-01T00:00:00Z",
                "coverage_end_utc": "2031-01-01T00:00:00Z",
                "sample_count": 2,
            }
        ],
        "smoke": {"checks": 1, "failed": []},
        "cases": [
            {
                "name": "pass_exact",
                "category": "PASS",
                "synthetic": False,
                "passed": False,
                "checks": [check, {"name": "exact score", "passed": False, "detail": "bounded"}],
                "inputs": {"site": "s1"},
                "outcome": {"eligibility": "pass"},
            }
        ],
        "invariants": [check],
        "timing": {
            "evaluate_scenario": {"median_ms": 1.0, "p95_ms": 2.0, "workload": "w"},
            "data_preparation": {"total_load_s": 1.0, "total_prepare_s": 0.5},
        },
        "summary": {"checks": 3, "failed": 1},
    }


@pytest.fixture
def tmp_report(tmp_path: Path) -> Iterator[tuple[TestClient, Path, Path]]:
    sites = tmp_path / "sites"
    sites.mkdir()
    report = tmp_path / "report.json"
    app = _app()
    app.dependency_overrides[sites_dir] = lambda: sites
    app.dependency_overrides[validation_report_path] = lambda: report
    yield TestClient(app), report, sites
    service.clear_cache()


def test_validation_summary_reports_failures_and_currency(tmp_report: tuple[TestClient, Path, Path]) -> None:
    import hashlib

    client, report, sites = tmp_report
    (sites / "s1.json").write_text("{}", encoding="utf-8")
    sha = hashlib.sha256(b"{}").hexdigest()
    report.write_text(json.dumps(_small_report(sha)), encoding="utf-8")
    s = ValidationSummaryResponse.model_validate_json(client.get("/api/viability/validation-summary").text)
    assert s.status == "failed" and s.totals.failed == 1
    assert s.cases[0].passed is False and [c.name for c in s.cases[0].failed_checks] == ["exact score"]
    assert s.cases[0].check_count == 2
    assert s.currency.current is True

    # A regenerated data file, a new file and a different engine version all make the report out of date.
    (sites / "s1.json").write_text('{"x": 1}', encoding="utf-8")
    (sites / "s2.json").write_text("{}", encoding="utf-8")
    stale = _small_report(sha)
    stale["versions"]["engine"] = "0.0.0-old"
    report.write_text(json.dumps(stale), encoding="utf-8")
    s = ValidationSummaryResponse.model_validate_json(client.get("/api/viability/validation-summary").text)
    assert s.currency.current is False
    assert s.currency.changed_datasets == ["s1"] and s.currency.unvalidated_datasets == ["s2"]
    assert len(s.currency.version_mismatches) == 1 and "engine" in s.currency.version_mismatches[0]
    assert "OUT OF DATE" in s.currency.note

    (sites / "s1.json").unlink()
    s = ValidationSummaryResponse.model_validate_json(client.get("/api/viability/validation-summary").text)
    assert s.datasets[0].current_sha256 is None and s.datasets[0].unchanged is False


def test_validation_summary_missing_report_is_404(tmp_report: tuple[TestClient, Path, Path]) -> None:
    client, _, _ = tmp_report
    r = client.get("/api/viability/validation-summary")
    assert r.status_code == 404 and "python -m app.viability.validation" in r.json()["detail"]


# --- integration with the team application ------------------------------------------------------------------------


def test_router_prefix_does_not_collide_with_the_team_app() -> None:
    from app.main import app as team_app

    ours = {(r.path, m) for r in router.routes if isinstance(r, APIRoute) for m in r.methods or ()}
    assert ours == {
        ("/api/viability/assess", "POST"),
        ("/api/viability/assess-scenario", "POST"),
        ("/api/viability/validation-summary", "GET"),
    }
    theirs = {(r.path, m) for r in team_app.routes if isinstance(r, APIRoute) for m in r.methods or ()}
    assert not ours & {(p, m) for p, m in theirs if not p.startswith("/api/viability")}


def test_core_package_stays_free_of_fastapi() -> None:
    import subprocess
    import sys

    code = "import sys, app.viability; assert 'fastapi' not in sys.modules, 'core imported fastapi'"
    subprocess.run([sys.executable, "-c", code], check=True, cwd=Path(__file__).resolve().parents[2])


def test_openapi_schema_generates() -> None:
    schema = _app().openapi()  # what /docs renders once the router is registered
    assert set(schema["paths"]) == {
        "/api/viability/assess",
        "/api/viability/assess-scenario",
        "/api/viability/validation-summary",
    }
    assert {"AssessRequest", "AssessResponse", "ViabilityAssessment"} <= set(schema["components"]["schemas"])
