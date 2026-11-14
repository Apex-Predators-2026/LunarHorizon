"""HTTP endpoints for Mission Rescue & Optimization."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .catalog import PSRS, SITES
from .compromise import compromise
from .engine import Evaluator
from .schemas import (CompromiseRequest, CompromiseResponse, RescueRequest, RescueResponse, SensitivityRequest,
                      SensitivityResponse)
from .search import rescue
from .sensitivity import analyse

router = APIRouter(prefix="/api/rescue", tags=["rescue"])

# One evaluator per process; it is stateless apart from a call counter.
_evaluator = Evaluator()


def _run(fn, req):
    try:
        return fn(req, _evaluator)
    except KeyError as e:  # unknown site / PSR id
        raise HTTPException(status_code=422, detail=str(e).strip("'\"")) from e


@router.get("/sites", summary="Sites and science targets the rescue search uses")
def get_sites() -> dict:
    """Rescue's candidate landing sites (the data engine's curated list plus approximate extras), each
    with the period its real data covers, and PSR science targets."""
    def entry(s) -> dict:
        cov = _evaluator.coverage(s.to_site())
        iso = lambda t: f"{str(t.astype('datetime64[s]'))}Z"  # noqa: E731
        return {"id": s.id, "name": s.name, "lat": s.lat, "lon": s.lon, "description": s.description,
                "source": s.source, "approximate": s.approximate, "has_real_data": cov is not None,
                "data_start_utc": iso(cov[0]) if cov else None, "data_end_utc": iso(cov[1]) if cov else None}

    return {
        "sites": [entry(s) for s in SITES],
        "psrs": [{"id": p.id, "name": p.name, "lat": p.lat, "lon": p.lon, "radius_km": p.radius_km,
                  "ice_interest": p.ice_interest} for p in PSRS],
        "note": ("Sites with has_real_data use the data engine's precomputed Horizons + LOLA timelines for "
                 "data_start_utc..data_end_utc; missions outside that period are reported as unknown. "
                 "'approximate' sites sit at estimated coordinates inside their named region."),
    }


@router.post("", response_model=RescueResponse, summary="Re-plan after a delay or requirement change")
def post_rescue(req: RescueRequest) -> RescueResponse:
    """Evaluates the changed plan and searches nearby dates and sites for the best alternatives."""
    return _run(rescue, req)


@router.post("/sensitivity", response_model=SensitivityResponse, summary="How fragile is this plan?")
def post_sensitivity(req: SensitivityRequest) -> SensitivityResponse:
    return _run(analyse, req)


@router.post("/compromise", response_model=CompromiseResponse, summary="Science vs engineering trade-off")
def post_compromise(req: CompromiseRequest) -> CompromiseResponse:
    return _run(compromise, req)
