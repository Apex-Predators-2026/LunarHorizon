"""HTTP endpoints of the canonical viability engine (Member 2): ``/api/viability/*``.

Registered in ``app/main.py`` by the application owner (``app.include_router(viability_router)``); see
docs/viability-api.md. The directories are FastAPI dependencies so tests can point them at fixtures.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError

from ..adapters.site_file import SiteFileError
from . import service
from .schemas import AssessRequest, AssessResponse, AssessScenarioRequest, ValidationSummaryResponse

router = APIRouter(prefix="/api/viability", tags=["viability"])


def sites_dir() -> Path:
    return service.SITES_DIR


def validation_report_path() -> Path:
    return service.VALIDATION_REPORT


SitesDir = Annotated[Path, Depends(sites_dir)]
ReportPath = Annotated[Path, Depends(validation_report_path)]


@router.post(
    "/assess",
    response_model=AssessResponse,
    summary="Canonical viability assessment of one mission at one precomputed site",
    responses={404: {"description": "Unknown site id"}, 422: {"description": "Invalid request or site data"}},
)
def post_assess(req: AssessRequest, directory: SitesDir) -> AssessResponse:
    """PASS / FAIL / UNKNOWN eligibility with every constraint result, metrics, evidence windows, operational
    margins, risk indicators, the exact / bounded / unavailable score, ranking eligibility, explanations, data
    quality, provenance, assumptions and limitations, exactly as ``evaluate_scenario`` returns them.

    The first request for a site loads and validates its 5-year hourly file (about 2 s); later requests reuse it.
    A mission outside the data's coverage is not an error: the uncovered time is UNKNOWN, never extrapolated.
    """
    try:
        return service.assess(req, directory)
    except service.SiteNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except SiteFileError as e:
        raise HTTPException(status_code=422, detail=f"Site data for {req.site_id!r} cannot be assessed: {e}") from e
    except ValidationError as e:  # the mission window (end after start, sanity cap)
        errors = e.errors(include_url=False, include_context=False, include_input=False)
        raise RequestValidationError([{**err, "loc": ("body", *err["loc"])} for err in errors]) from e


@router.post(
    "/assess-scenario",
    response_model=AssessResponse,
    summary="Canonical assessment of a Mission Planner / Rescue scenario (team Scenario shape)",
    responses={404: {"description": "Not a precomputed site"}, 422: {"description": "Invalid request or site data"}},
)
def post_assess_scenario(body: AssessScenarioRequest, directory: SitesDir) -> AssessResponse:
    """Same as ``/assess`` for a team ``Scenario``: its Rescue-style requirements are converted with the mapping
    Rescue and Comparison use (``requirements_to_canonical``), then the canonical engine evaluates it."""
    try:
        req = service.assess_request_for_scenario(body.scenario, body.include_explanation_details)
    except service.SiteNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValidationError as e:
        errors = e.errors(include_url=False, include_context=False, include_input=False)
        raise RequestValidationError([{**err, "loc": ("body", *err["loc"])} for err in errors]) from e
    return post_assess(req, directory)


@router.get(
    "/validation-summary",
    response_model=ValidationSummaryResponse,
    summary="Structured summary of the viability engine's validation suite",
    responses={404: {"description": "No validation report has been generated"}},
)
def get_validation_summary(report: ReportPath, directory: SitesDir) -> ValidationSummaryResponse:
    """Cases (PASS, confirmed FAIL, UNKNOWN from missing data, bounded score, ranking, synthetic separation,
    dataset boundaries, sampling policy), invariants, validated datasets with SHA-256, versions, timing and
    limitations, from the stored report of ``python -m app.viability.validation``. ``currency`` states whether
    that report still matches the running engine versions and the committed site files."""
    try:
        return service.validation_summary(report, directory)
    except service.ValidationReportMissingError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
