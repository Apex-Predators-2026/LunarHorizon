"""Whole-Moon terrain tiles and polar overlays for the 3D view.

GET /api/terrain/info                     tiling description (shared with frontend/src/viz/globe/cubeSphere.ts)
GET /api/terrain/tile/{face}/{z}/{x}/{y}  heights of one cube-sphere tile (binary float32, N x N)
GET /api/psr                              PSR points and surface-ice detections near the south pole
"""

from functools import lru_cache

from fastapi import APIRouter, HTTPException, Query, Response

from .engine import psr
from .engine.dem import SOURCES
from .engine.tiles import FACES, MAX_ZOOM, N, max_zoom_for, tile_heights, validate_tile

router = APIRouter(prefix="/api")


@router.get("/terrain/info")
def terrain_info() -> dict:
    return {
        "tile_size": N,
        "max_zoom": MAX_ZOOM,
        "faces": FACES,
        "vertex_order": "heights[j * tile_size + i]; i along the face's right axis, j along its up axis",
        "mapping": "equal-angle cube: p = centre + tan(u*pi/4)*right + tan(v*pi/4)*up, normalised",
        "heights": "metres relative to the 1737.4 km reference sphere",
        "sources": [{"name": s.name, "service": s.service, "resolution_m": round(s.native_m, 1)} for s in SOURCES.values()],
    }


@lru_cache(maxsize=4096)  # ~70 MB of recently served tiles; failures are not cached
def _tile_payload(face: int, z: int, x: int, y: int, pad: int) -> tuple[bytes, float, float, bool]:
    heights = tile_heights(face, z, x, y, pad=pad)
    inner = heights[pad : pad + N, pad : pad + N]
    leaf = z >= max_zoom_for(face, z, x, y)
    return heights.astype("<f4").tobytes(), float(inner.min()), float(inner.max()), leaf


@router.get("/terrain/tile/{face}/{z}/{x}/{y}")
def terrain_tile(
    face: int,
    z: int,
    x: int,
    y: int,
    pad: int = Query(0, ge=0, le=1, description="1 = add a ring of the neighbours' vertices (for seamless normals)"),
) -> Response:
    """Float32 little-endian heights, row-major [j, i]: tile_size^2 values, or (tile_size + 2)^2
    with pad=1 (the inner tile_size^2 are the same). Header X-Tile-Leaf: 1 when there is no finer
    data below this tile; X-Tile-Min / X-Tile-Max describe the tile itself (without the ring)."""
    try:
        validate_tile(face, z, x, y)
    except ValueError as e:
        raise HTTPException(404, str(e))
    try:
        content, hmin, hmax, leaf = _tile_payload(face, z, x, y, pad)
    except OSError as e:  # Moon Trek unreachable or refused the request
        raise HTTPException(502, f"Terrain source unavailable: {e}")
    return Response(
        content=content,
        media_type="application/octet-stream",
        headers={
            "X-Tile-Leaf": "1" if leaf else "0",
            "X-Tile-Min": f"{hmin:.1f}",
            "X-Tile-Max": f"{hmax:.1f}",
            "Cache-Control": "public, max-age=604800",
            "Access-Control-Expose-Headers": "X-Tile-Leaf, X-Tile-Min, X-Tile-Max",
        },
    )


@router.get("/psr")
def psr_points() -> dict:
    try:
        return psr.load()
    except OSError as e:
        raise HTTPException(502, f"Moon Trek PSR layers unavailable: {e}")
