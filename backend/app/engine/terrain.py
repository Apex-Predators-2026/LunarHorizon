"""Multi-resolution LOLA terrain from Moon Trek, cropped around a site.

Three tiers: fine near the site, coarse far away. Each lookup uses the finest
tier that has valid data at that point (the 5 m product only covers 87.5S-90S).
"""

import urllib.parse
from dataclasses import dataclass

import numpy as np
import rasterio

from .net import RAW_DIR, fetch_cached

TREK = "https://trek.nasa.gov/moon/trekarcgis/rest/services"
# Moon Trek fills pixels outside a product's coverage with float32 min (~-3.4e38).
INVALID_BELOW = -1e30


@dataclass(frozen=True)
class TierSpec:
    name: str
    service: str
    res_m: float
    half_width_m: float


TIERS = (
    TierSpec("near", "LRO_LOLA_DEM_SPole875_5mp_v04", 5, 5_000),  # 2000 px
    TierSpec("mid", "LRO_LOLA_DEM_SPole75_30mp_v04", 30, 45_000),  # 3000 px
    TierSpec("far", "LRO_LOLA_DEM_SPole45_100mp_v04", 200, 300_000),  # 3000 px, resampled
)


class Tier:
    """One terrain grid with bilinear sampling in projected metres."""

    def __init__(self, spec: TierSpec, z: np.ndarray, x0: float, y0: float, res: float):
        self.spec = spec
        self.z = z  # float64, NaN where invalid; row 0 = top (max y)
        self.x0, self.y0, self.res = x0, y0, res  # top-left corner of top-left pixel

    @classmethod
    def from_file(cls, spec: TierSpec, path) -> "Tier":
        with rasterio.open(path) as ds:
            z = ds.read(1).astype("float64")
            t = ds.transform
        z[z < INVALID_BELOW] = np.nan
        return cls(spec, z, t.c, t.f, t.a)

    def sample(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        """Bilinear height at projected (x, y); NaN outside the grid or on invalid data."""
        col = (np.asarray(x) - self.x0) / self.res - 0.5
        row = (self.y0 - np.asarray(y)) / self.res - 0.5
        c0 = np.floor(col).astype(np.int64)
        r0 = np.floor(row).astype(np.int64)
        fc, fr = col - c0, row - r0
        h, w = self.z.shape
        inside = (c0 >= 0) & (r0 >= 0) & (c0 + 1 < w) & (r0 + 1 < h)
        c0c = np.clip(c0, 0, w - 2)
        r0c = np.clip(r0, 0, h - 2)
        z00 = self.z[r0c, c0c]
        z01 = self.z[r0c, c0c + 1]
        z10 = self.z[r0c + 1, c0c]
        z11 = self.z[r0c + 1, c0c + 1]
        out = (z00 * (1 - fc) + z01 * fc) * (1 - fr) + (z10 * (1 - fc) + z11 * fc) * fr
        return np.where(inside, out, np.nan)


class Terrain:
    """Stack of tiers; each point uses the finest tier with valid data."""

    def __init__(self, tiers: list[Tier]):
        self.tiers = sorted(tiers, key=lambda t: t.res)

    def sample(self, x, y) -> np.ndarray:
        x = np.asarray(x, dtype="float64")
        y = np.asarray(y, dtype="float64")
        out = np.full(np.broadcast(x, y).shape, np.nan)
        for tier in self.tiers:
            missing = np.isnan(out)
            if not missing.any():
                break
            out[missing] = tier.sample(x[missing], y[missing])
        return out

    @property
    def max_range_m(self) -> float:
        return max(t.spec.half_width_m for t in self.tiers)


def fetch_tier(spec: TierSpec, x: float, y: float) -> Tier:
    """Download (once) a square crop of `spec` centred on projected (x, y)."""
    half = spec.half_width_m
    n = int(round(2 * half / spec.res_m))
    params = {
        "bbox": f"{x - half},{y - half},{x + half},{y + half}",
        "size": f"{n},{n}",
        "format": "tiff",
        "pixelType": "F32",
        "interpolation": "RSP_BilinearInterpolation",
        "f": "image",
    }
    url = f"{TREK}/{spec.service}/ImageServer/exportImage?" + urllib.parse.urlencode(params)
    path = fetch_cached(url, RAW_DIR / f"{spec.name}_{spec.res_m:g}m_{x:.0f}_{y:.0f}.tif", timeout=600)
    return Tier.from_file(spec, path)


def load_terrain(x: float, y: float, tiers=TIERS) -> Terrain:
    return Terrain([fetch_tier(s, x, y) for s in tiers])
