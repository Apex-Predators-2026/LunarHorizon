"""Lunar Landing Site Navigator API.

Run from backend/:  .venv\\Scripts\\python.exe -m uvicorn app.main:app --reload --port 8000
Interactive docs:   http://localhost:8000/docs
"""

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from . import store
from .engine.visibility import next_edge
from .models import (
    CustomSiteRequest,
    EarthState,
    Horizon,
    SiteInfo,
    SiteStatus,
    SunState,
    TerrainGrid,
    TimelineStep,
)
from .rescue.router import router as rescue_router

app = FastAPI(title="Lunar Landing Site Navigator API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(rescue_router)  # Member 5: /api/rescue/*


# ---------- helpers ----------

def _get(site_id: str) -> store.SiteData:
    data = store.get_site(site_id)
    if data is None:
        raise HTTPException(404, f"Unknown site '{site_id}'")
    return data


def _parse_time(value: str, name: str) -> np.datetime64:
    try:
        return np.datetime64(value.strip().removesuffix("Z").replace("+00:00", ""), "s")
    except ValueError:
        raise HTTPException(422, f"'{name}' must be an ISO UTC time like 2027-01-01T00:00Z")


def _iso(t) -> str:
    return str(np.datetime64(t, "m")) + "Z"


def _site_model(d: store.SiteData) -> SiteInfo:
    s = d.site
    return SiteInfo(
        id=s["id"],
        name=s["name"],
        lat=s["lat"],
        lon=s["lon"],
        source=s.get("source", ""),
        ground_height_m=s["ground_height_m"],
        observer_height_m=s["observer_height_m"],
        summary=d.record["summary"],
        data_start_utc=_iso(d.times[0]),
        data_stop_utc=_iso(d.times[-1]),
    )


def _step(d: store.SiteData, i: int) -> dict:
    c = d.cols
    return {
        "time_utc": _iso(d.times[i]),
        "sun": SunState(
            azimuth_deg=c["sun_azimuth_deg"][i],
            elevation_deg=c["sun_elevation_deg"][i],
            horizon_deg=c["sun_horizon_deg"][i],
            visible_fraction=c["sun_visible_fraction"][i],
        ),
        "earth": EarthState(
            azimuth_deg=c["earth_azimuth_deg"][i],
            elevation_deg=c["earth_elevation_deg"][i],
            horizon_deg=c["earth_horizon_deg"][i],
            visible=bool(c["earth_visible"][i]),
            margin_deg=c["earth_margin_deg"][i],
        ),
    }


# ---------- endpoints ----------

@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/sites")
def list_sites(include_custom: bool = False) -> list[SiteInfo]:
    return [_site_model(store.get_site(i)) for i in store.list_site_ids(include_custom)]


@app.post("/api/sites/custom")
def create_custom_site(req: CustomSiteRequest) -> SiteInfo:
    """Analyse arbitrary south-polar coordinates. The first call for a point downloads terrain
    and ephemeris and can take a minute; repeat calls return the cached result."""
    try:
        return _site_model(store.create_custom_site(req.lat, req.lon, req.name))
    except ValueError as e:
        raise HTTPException(422, str(e))


@app.get("/api/sites/{site_id}")
def get_site(site_id: str) -> SiteInfo:
    return _site_model(_get(site_id))


@app.get("/api/sites/{site_id}/horizon")
def get_horizon(site_id: str) -> Horizon:
    d = _get(site_id)
    return Horizon(
        **d.record["horizon"],
        ground_height_m=d.site["ground_height_m"],
        observer_height_m=d.site["observer_height_m"],
    )


@app.get("/api/sites/{site_id}/timeline")
def get_timeline(
    site_id: str,
    start: str | None = Query(None, description="ISO UTC, default = start of data"),
    end: str | None = Query(None, description="ISO UTC (exclusive), default = end of data"),
    step_hours: int = Query(1, ge=1, le=24 * 30, description="Return every Nth hourly sample"),
) -> list[TimelineStep]:
    d = _get(site_id)
    i0 = 0 if start is None else int(np.searchsorted(d.times, _parse_time(start, "start")))
    i1 = len(d.times) if end is None else int(np.searchsorted(d.times, _parse_time(end, "end")))
    return [_step(d, i) for i in range(i0, i1, step_hours)]


@app.get("/api/sites/{site_id}/status")
def get_status(site_id: str, time: str = Query(..., description="ISO UTC time")) -> SiteStatus:
    """Conditions at the hourly sample nearest `time`, plus the next sunset/sunrise/Earthset/Earthrise."""
    d = _get(site_id)
    t = _parse_time(time, "time")
    if t < d.times[0] or t > d.times[-1]:
        raise HTTPException(422, f"time must be within {_iso(d.times[0])} .. {_iso(d.times[-1])}")
    i = int(np.abs(d.times - t).argmin())

    def when(on, to_state):
        j = next_edge(on, i, to_state)
        return None if j is None else _iso(d.times[j])

    return SiteStatus(
        **_step(d, i),
        next_sunset_utc=when(d.sunlit, False),
        next_sunrise_utc=when(d.sunlit, True),
        next_earthset_utc=when(d.earth_visible, False),
        next_earthrise_utc=when(d.earth_visible, True),
    )


@app.get("/api/sites/{site_id}/terrain")
def get_terrain(
    site_id: str,
    size: int = Query(256, ge=16, le=512),
    half_width_m: float = Query(5000, ge=500, le=40000),
) -> TerrainGrid:
    _get(site_id)
    return TerrainGrid(**store.terrain_grid(site_id, size, half_width_m))
