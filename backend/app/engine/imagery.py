"""LRO Wide Angle Camera mosaics from Moon Trek, for the optional imagery layer of the 3D view.

Same machinery as the elevation registry (dem.py): exportImage blocks cached on disk, sampled at
any latitude/longitude. Polar mosaics (100 m, polar stereographic, poleward of 60 deg) first, the
global mosaic (303 px/deg, ~100 m) elsewhere.

The mosaics are photographs: their shadows are from when they were taken, not from the date
shown in the app. The layer is for recognising places; the engine's numbers never use it.
"""

import struct
import zlib

import numpy as np

from .dem import R_DEG_M, DemSource, _BlockStore, level_for, project, sample_source
from .net import CACHE_DIR
from .tiles import uv_to_vec, validate_tile, vec_to_latlon

IMAGERY_SOURCES = {
    s.name: s
    for s in (
        DemSource("wac_sp", "LRO_WAC_Mosaic_SPole60_100m_v02", "sp", 100, (-1095700, -1095600, 1095600, 1095700), 100, "U8", True),
        DemSource("wac_np", "LRO_WAC_Mosaic_NPole60_100m_v02", "np", 100, (-1095700, -1095600, 1095600, 1095700), 100, "U8", True),
        DemSource("wac_global", "LRO_WAC_Mosaic_Global_303ppd_v02", "eq", 0.00329779, (-180, -90, 180, 90), R_DEG_M * 0.00329779, "U8", True),
    )
}
POLAR_LAT = 60.0
TEXTURE_PX = 256  # imagery texture per tile side
# The mosaics are ~100 m/px; a level-7 tile (~21 km) at 256 px is already ~83 m/px, so deeper
# tiles reuse their level-7 ancestor's texture instead of fetching upsampled copies.
IMAGERY_MAX_ZOOM = 7

_store = _BlockStore(CACHE_DIR / "imagery")


def sample_imagery(lat, lon, spacing_m: float) -> np.ndarray:
    """Brightness 0-255 (float, NaN where no mosaic covers the point) at lat/lon."""
    lat = np.asarray(lat, dtype=float)
    lon = np.asarray(lon, dtype=float)
    out = np.full(lat.shape, np.nan)
    polar = np.where(lat <= -POLAR_LAT, "wac_sp", np.where(lat >= POLAR_LAT, "wac_np", ""))
    for name in ("wac_sp", "wac_np", "wac_global"):
        sel = np.isnan(out) & ((polar == name) if name != "wac_global" else True)
        if not sel.any():
            continue
        src = IMAGERY_SOURCES[name]
        idx = np.flatnonzero(sel)
        x, y = project(src, lat[idx], lon[idx])
        xmin, ymin, xmax, ymax = src.extent
        inside = (x >= xmin) & (x <= xmax) & (y >= ymin) & (y <= ymax)
        if inside.any():
            out[idx[inside]] = sample_source(src, level_for(src, spacing_m), x[inside], y[inside], _store)
    return out


def imagery_tile(face: int, z: int, x: int, y: int, px: int = TEXTURE_PX) -> np.ndarray:
    """uint8 (px, px) image of a tile (z <= IMAGERY_MAX_ZOOM), sampled at texel centres.
    Row 0 is the tile's top edge (largest v), so it maps onto the mesh's uv = (i, j) / (N - 1)
    with the usual image orientation (texture v = 1 at the top row)."""
    validate_tile(face, z, x, y)
    if z > IMAGERY_MAX_ZOOM:
        raise ValueError(f"Imagery tiles stop at level {IMAGERY_MAX_ZOOM}; use the ancestor tile")
    # Texel centres: (k + 0.5) / px across the tile, expressed in tile_uv's vertex units.
    size = 2.0 / 2**z
    k = (np.arange(px) + 0.5) / px
    U, V = np.meshgrid(-1 + size * (x + k), -1 + size * (y + k))
    lat, lon = vec_to_latlon(uv_to_vec(face, U, V))
    spacing = 2 * np.pi * 1_737_400.0 / 4 / 2**z / px
    img = sample_imagery(lat.ravel(), lon.ravel(), spacing).reshape(px, px)
    if np.isnan(img).all():
        img = np.zeros_like(img)
    elif np.isnan(img).any():
        img = np.where(np.isnan(img), np.nanmean(img), img)
    return np.clip(np.round(img), 0, 255).astype(np.uint8)[::-1]  # top row = largest v


def png_gray(img: np.ndarray) -> bytes:
    """Minimal 8-bit grayscale PNG encoder (no imaging library needed)."""
    h, w = img.shape

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    rows = b"".join(b"\x00" + img[r].tobytes() for r in range(h))  # filter type 0 per row
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows, 6))
        + chunk(b"IEND", b"")
    )

