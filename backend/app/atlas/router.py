"""HTTP endpoint for the Feasibility Atlas."""
from __future__ import annotations

from fastapi import APIRouter

from .schemas import AtlasRequest, AtlasResponse
from .service import atlas

router = APIRouter(prefix="/api/atlas", tags=["atlas"])


@router.post("", response_model=AtlasResponse, response_model_exclude_none=True,
             summary="Which landing dates work for which mission lengths")
def post_atlas(req: AtlasRequest) -> AtlasResponse:
    """Evaluate every tested landing date x mission duration for one site and one spacecraft with the canonical
    viability engine: PASS / FAIL / UNKNOWN per cell (NOT_EVALUATED outside the site's data), the requirement
    that decides each cell, and its margins."""
    return atlas(req)
