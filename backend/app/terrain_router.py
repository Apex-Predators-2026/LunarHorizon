"""Whole-Moon terrain tiles and polar overlays for the 3D view.

GET /api/terrain/info                     tiling description (shared with frontend/src/viz/globe/cubeSphere.ts)
GET /api/terrain/tile/{face}/{z}/{x}/{y}  heights of one cube-sphere tile (binary float32, N x N)
GET /api/imagery/tile/{face}/{z}/{x}/{y}  LRO WAC imagery of a tile (8-bit grayscale PNG, levels 0-7)
GET /api/psr                              PSR points and surface-ice detections near the south pole
"""

from functools import lru_cache

from fastapi import APIRouter, HTTPException, Query, Response

from .engine import psr
from .engine.imagery import IMAGERY_MAX_ZOOM, TEXTURE_PX, imagery_tile, png_gray
from .engine.dem import SOURCES, DownloadBusy
from .engine.tiles import FACES, MAX_ZOOM, N, max_zoom_for, tile_heights, validate_tile
from .memory import cache_size

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


@lru_cache(maxsize=cache_size(4096, 256))  # ~70 MB of recently served tiles (~4 MB with LOW_MEMORY); failures are not cached
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
    except DownloadBusy as e:  # Moon Trek slow: too many downloads waiting (the 3D view retries)
        raise HTTPException(503, f"Terrain source busy, try again shortly: {e}")
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


@lru_cache(maxsize=cache_size(1024, 128))  # ~40 MB of recently served PNGs (~5 MB with LOW_MEMORY)
def _imagery_png(face: int, z: int, x: int, y: int) -> bytes:
    return png_gray(imagery_tile(face, z, x, y))


@router.get("/imagery/tile/{face}/{z}/{x}/{y}")
def imagery_tile_png(face: int, z: int, x: int, y: int) -> Response:
    """LRO WAC mosaic (Moon Trek) over one tile: TEXTURE_PX^2 grayscale PNG, top row = the tile's
    largest v. Only levels 0-IMAGERY_MAX_ZOOM; deeper tiles use their ancestor's image."""
    try:
        validate_tile(face, z, x, y)
        if z > IMAGERY_MAX_ZOOM:
            raise ValueError(f"Imagery tiles stop at level {IMAGERY_MAX_ZOOM}")
    except ValueError as e:
        raise HTTPException(404, str(e))
    try:
        content = _imagery_png(face, z, x, y)
    except DownloadBusy as e:
        raise HTTPException(503, f"Imagery source busy, try again shortly: {e}")
    except OSError as e:
        raise HTTPException(502, f"Imagery source unavailable: {e}")
    return Response(
        content=content,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=604800", "X-Texture-Px": str(TEXTURE_PX), "Access-Control-Expose-Headers": "X-Texture-Px"},
    )


@router.get("/psr")
def psr_points() -> dict:
    try:
        return psr.load()
    except OSError as e:
        raise HTTPException(502, f"Moon Trek PSR layers unavailable: {e}")
