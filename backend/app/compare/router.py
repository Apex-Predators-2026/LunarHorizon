"""HTTP endpoint for Multi-Scenario Comparison (Member 4)."""
from __future__ import annotations

from fastapi import APIRouter

from .schemas import CompareRequest, CompareResponse
from .service import compare

router = APIRouter(prefix="/api/compare", tags=["compare"])


@router.post("", response_model=CompareResponse, summary="Evaluate scenarios side by side")
def post_compare(req: CompareRequest) -> CompareResponse:
    """For each scenario: viability (team evaluator), sunlight / Earth-visibility windows, elevation statistics,
    an idealised panel incidence factor, events and a decimated timeline for charts. Scenarios without real data
    come back as `unavailable` unless `allow_demo_data` is true."""
    return compare(req)
