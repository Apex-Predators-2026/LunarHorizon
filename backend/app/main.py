"""Lunar Landing Site Navigator API.

Run from backend/:  .venv\\Scripts\\python.exe -m uvicorn app.main:app --reload --port 8000
Interactive docs:   http://localhost:8000/docs
"""

import json

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from . import store
from .engine.net import OfflineError
from .engine.sites import ALL_SITES
from .engine.validation_summary import summarize
from .engine.verify import verify
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
from .assistant.router import router as assistant_router
from .atlas.router import router as atlas_router
from .compare.router import router as compare_router
from .rescue.router import router as rescue_router
from .terrain_router import router as terrain_router
from .viability.api import router as viability_router

app = FastAPI(title="Lunar Landing Site Navigator API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(rescue_router)  # Member 5: /api/rescue/*
app.include_router(compare_router)  # Member 4: /api/compare
app.include_router(assistant_router)  # Member 4: /api/assistant/* (Mission Assistant)
app.include_router(terrain_router)  # Andrew: /api/terrain/*, /api/psr
app.include_router(viability_router)  # Member 2: /api/viability/assess, /assess-scenario, /validation-summary
app.include_router(atlas_router)  # Feasibility Atlas: /api/atlas


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


def _grid_index(times: np.ndarray, t: np.datetime64) -> int:
    """Index of the sample on the shared hourly evaluation grid (app.timegrid): nearest whole hour, half rounds up."""
    secs = int(t.astype("datetime64[s]").astype(np.int64))
    snapped = np.datetime64(((secs + 1800) // 3600) * 3600, "s")
    return int(np.abs(times - snapped).argmin())


def _iso(t) -> str:
    return str(np.datetime64(t, "m")) + "Z"


# Labels that live in engine/sites.py rather than in the precomputed site files (so they can be corrected
# without regenerating the data), e.g. which NASA Artemis III list names the region.
_SITE_LABELS = {s["id"]: s for s in ALL_SITES}


def _site_model(d: store.SiteData) -> SiteInfo:
    s = d.site
    return SiteInfo(
        id=s["id"],
        name=s["name"],
        lat=s["lat"],
        lon=s["lon"],
        source=s.get("source", ""),
        kind=s.get("kind", "custom"),
        approximate=bool(s.get("approximate", False)),
        artemis_list=_SITE_LABELS.get(s["id"], {}).get("artemis_list"),
        ground_height_m=s["ground_height_m"],
        observer_height_m=s["observer_height_m"],
        summary=d.record["summary"],
        data_start_utc=_iso(d.times[0]),
        data_stop_utc=_iso(d.times[-1]),
    )


def _num(col: np.ndarray | None, i: int) -> float | None:
    """Column value as a float, or None if unknown (NaN) or the column is absent."""
    if col is None:
        return None
    v = float(col[i])
    return None if np.isnan(v) else v


def _flag(d: store.SiteData, name: str, i: int) -> bool | None:
    return bool(d.cols[name][i]) if d.known[name][i] else None


def _step(d: store.SiteData, i: int) -> dict:
    c = d.cols
    return {
        "time_utc": _iso(d.times[i]),
        "sun": SunState(
            azimuth_deg=c["sun_azimuth_deg"][i],
            elevation_deg=c["sun_elevation_deg"][i],
            horizon_deg=_num(c["sun_horizon_deg"], i),
            visible_fraction=_num(c["sun_visible_fraction"], i),
            visible=_flag(d, "sun_visible", i),
            angular_radius_deg=_num(c.get("sun_angular_radius_deg"), i),
        ),
        "earth": EarthState(
            azimuth_deg=c["earth_azimuth_deg"][i],
            elevation_deg=c["earth_elevation_deg"][i],
            horizon_deg=_num(c["earth_horizon_deg"], i),
            visible=_flag(d, "earth_visible", i),
            margin_deg=_num(c["earth_margin_deg"], i),
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
    except OfflineError:
        # A pin away from the warmed areas needs LOLA terrain out to 300 km that isn't cached.
        raise HTTPException(
            503,
            "A new pin here needs terrain that isn't stored yet, and the backend is in offline mode. Pick one "
            "of the listed sites, or a point near one (their terrain is stored).",
        )
    except OSError as e:  # Moon Trek / JPL unreachable or too busy
        raise HTTPException(502, f"Terrain or ephemeris source unavailable, try again shortly: {e}")


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
    """Conditions at `time` on the hourly evaluation grid (nearest whole hour, half rounds up; see app.timegrid),
    plus the next sunset/sunrise/Earthset/Earthrise."""
    d = _get(site_id)
    t = _parse_time(time, "time")
    if t < d.times[0] or t > d.times[-1]:
        raise HTTPException(422, f"time must be within {_iso(d.times[0])} .. {_iso(d.times[-1])}")
    i = _grid_index(d.times, t)

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


@app.get("/api/sites/{site_id}/verify")
def verify_site(site_id: str, time: str = Query(..., description="ISO UTC time")) -> dict:
    """Live check of the stored Sun/Earth positions at the hour nearest `time` against JPL Horizons
    and an independent local ephemeris (Skyfield + DE421)."""
    d = _get(site_id)
    t = _parse_time(time, "time")
    if t < d.times[0] or t > d.times[-1]:
        raise HTTPException(422, f"time must be within {_iso(d.times[0])} .. {_iso(d.times[-1])}")
    i = _grid_index(d.times, t)
    stored = {
        b: {"azimuth_deg": float(d.cols[f"{b}_azimuth_deg"][i]), "elevation_deg": float(d.cols[f"{b}_elevation_deg"][i])}
        for b in ("sun", "earth")
    }
    try:
        return verify(d.site["lat"], d.site["lon"], d.times[i], stored)
    except OfflineError:
        # The one feature that must go online: the point is a fresh answer from JPL.
        raise HTTPException(
            503,
            "This check asks JPL Horizons live, so it needs an internet connection (the backend is in offline "
            "mode). Everything else runs from the stored NASA data.",
        )
    except (OSError, RuntimeError) as e:
        raise HTTPException(502, f"Couldn't reach JPL Horizons for the live check ({type(e).__name__}); try again in a minute.")


@app.get("/api/validation")
def validation_report() -> dict:
    """Results of scripts/validate_engine.py (independent ephemeris, horizon geometry, LROC illumination).
    `summary` holds the headline numbers by kind, each with scope, date, reference and limitation, derived
    from the per-site results (show those, not hand-typed numbers)."""
    path = store.DATA_DIR / "validation" / "engine_validation.json"
    if not path.exists():
        raise HTTPException(404, "No validation report yet: run backend/scripts/validate_engine.py")
    report = json.loads(path.read_text())
    report["summary"] = summarize(report)  # always from the per-site results it is served with
    return report


@app.get("/api/sites/{site_id}/terrain")
def get_terrain(
    site_id: str,
    size: int = Query(256, ge=16, le=512),
    half_width_m: float = Query(5000, ge=500, le=40000),
) -> TerrainGrid:
    _get(site_id)
    return TerrainGrid(**store.terrain_grid(site_id, size, half_width_m))
