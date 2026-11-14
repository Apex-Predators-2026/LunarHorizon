"""One elevation registry for the whole Moon, sampled at any latitude/longitude.

Every source is a Moon Trek LOLA ImageServer (the challenge's terrain source). Polar products
(stereographic, 5-100 m) are preferred near the poles; the global 1/256-degree product (~118 m)
covers everything else.

Data is fetched with `exportImage` in fixed BLOCK x BLOCK pixel blocks at power-of-two
downsamplings of each product ("level" k: pixel size = native x 2^k), cached on disk as .npy,
so many terrain tiles and horizon rays share a few requests. A lookup for spacing s uses the
coarsest level whose pixels are still <= s, so zoomed-out tiles don't download 5 m data.
"""

import threading
import time
import urllib.parse
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio

from .geo import latlon_to_xy, latlon_to_xy_np
from .net import CACHE_DIR
from .terrain import INVALID_BELOW, TREK

BLOCK = 1024  # pixels per block side (at most)
DEM_CACHE = CACHE_DIR / "dem"
MAX_BLOCKS_IN_MEMORY = 48  # each block is at most 4 MB (float32)
# Moon Trek's global ImageServer fails (HTTP 502) when one request spans too large an area,
# regardless of output size; 32 x 32 degrees works. Coarse global blocks therefore use fewer pixels.
MAX_SPAN_EQ_DEG = 32.0


@dataclass(frozen=True)
class DemSource:
    name: str
    service: str
    kind: str  # "sp" / "np" (polar stereographic, metres) or "eq" (lon/lat degrees)
    native: float  # native pixel size: metres (sp/np) or degrees (eq)
    extent: tuple[float, float, float, float]  # xmin, ymin, xmax, ymax in the source's units
    native_m: float  # native pixel size in metres (for choosing between sources)
    pixel_type: str = "F32"  # exportImage pixelType: F32 for elevations, U8 for imagery (see imagery.py)
    zero_is_nodata: bool = False  # imagery mosaics mark missing pixels with 0


R_DEG_M = 2 * np.pi * 1_737_400.0 / 360  # metres per degree on the reference sphere

SOURCES = {
    s.name: s
    for s in (
        DemSource("sp5", "LRO_LOLA_DEM_SPole875_5mp_v04", "sp", 5, (-75840, -75840, 75840, 75840), 5),
        DemSource("sp20", "ldem_85s_20m_Spole_float_SP", "sp", 20, (-151680, -151680, 151680, 151680), 20),
        DemSource("sp30", "LRO_LOLA_DEM_SPole75_30mp_v04", "sp", 30, (-457440, -457440, 457440, 457440), 30),
        DemSource("sp100", "LRO_LOLA_DEM_SPole45_100mp_v04", "sp", 100, (-1440000, -1440000, 1440000, 1440000), 100),
        DemSource("np5", "LRO_LOLA_DEM_NPole875_5mp_v04", "np", 5, (-75840, -75840, 75840, 75840), 5),
        DemSource("np30", "LRO_LOLA_DEM_NPole75_30mp_v04", "np", 30, (-457440, -457440, 457440, 457440), 30),
        DemSource("np100", "LRO_LOLA_DEM_NPole45_100mp_v04", "np", 100, (-1440000, -1440000, 1440000, 1440000), 100),
        DemSource("global", "LRO_LOLA_DEM_Global_256ppd_v06", "eq", 1 / 256, (-180, -90, 180, 90), R_DEG_M / 256),
    )
}
# Candidates by latitude band, finest first. Polar products are used poleward of 60 deg.
SOUTH = ("sp5", "sp20", "sp30", "sp100", "global")
NORTH = ("np5", "np30", "np100", "global")
GLOBAL_ONLY = ("global",)
POLAR_LAT = 60.0


def project(src: DemSource, lat, lon):
    """Lat/lon (deg) -> the source's map units."""
    if src.kind == "sp":
        return latlon_to_xy(lat, lon)
    if src.kind == "np":
        return latlon_to_xy_np(lat, lon)
    return (np.asarray(lon) + 180.0) % 360.0 - 180.0, np.asarray(lat, dtype=float)


def level_for(src: DemSource, spacing_m: float) -> int:
    """Coarsest power-of-two level whose pixels are no larger than spacing_m (>= 0)."""
    if spacing_m <= src.native_m:
        return 0
    return int(np.floor(np.log2(spacing_m / src.native_m)))


def block_px(src: DemSource, level: int) -> int:
    """Pixels per block side at this level (smaller for coarse global levels, see MAX_SPAN_EQ_DEG)."""
    if src.kind != "eq":
        return BLOCK
    px = src.native * 2**level
    return max(1, min(BLOCK, int(MAX_SPAN_EQ_DEG / px)))


def candidates(lat: float) -> tuple[str, ...]:
    if lat <= -POLAR_LAT:
        return SOUTH
    if lat >= POLAR_LAT:
        return NORTH
    return GLOBAL_ONLY


class _BlockStore:
    """Disk + memory cache of exportImage blocks. Thread-safe (FastAPI runs sync routes in threads)."""

    def __init__(self, root: Path = DEM_CACHE):
        self.root = root
        self.mem: OrderedDict[tuple, np.ndarray] = OrderedDict()
        self.lock = threading.Lock()
        self.key_locks: dict[tuple, threading.Lock] = {}

    def _bbox(self, src: DemSource, level: int, bx: int, by: int):
        px = src.native * 2**level
        bp = block_px(src, level)
        xmin0, _, _, ymax0 = src.extent
        x0 = xmin0 + bx * bp * px
        y1 = ymax0 - by * bp * px
        return x0, y1 - bp * px, x0 + bp * px, y1, px

    def in_memory(self, src: DemSource, level: int, bx: int, by: int) -> bool:
        return (src.name, level, bx, by) in self.mem

    def get(self, src: DemSource, level: int, bx: int, by: int) -> np.ndarray:
        key = (src.name, level, bx, by)
        with self.lock:
            if key in self.mem:
                self.mem.move_to_end(key)
                return self.mem[key]
            klock = self.key_locks.setdefault(key, threading.Lock())
        with klock:  # one download per block even under concurrent requests
            with self.lock:
                if key in self.mem:
                    return self.mem[key]
            path = self.root / src.name / str(level) / f"{bx}_{by}.npy"
            if path.exists():
                z = np.load(path)
            else:
                z = self._download(src, level, bx, by)
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp = path.with_name(path.name + ".part")
                with open(tmp, "wb") as f:
                    np.save(f, z)
                tmp.replace(path)
            if src.zero_is_nodata:  # on load, so blocks cached before this rule are covered too
                z = np.where(z == 0, np.float32(np.nan), z)
            with self.lock:
                self.mem[key] = z
                while len(self.mem) > MAX_BLOCKS_IN_MEMORY:
                    self.mem.popitem(last=False)
            return z

    def _download(self, src: DemSource, level: int, bx: int, by: int) -> np.ndarray:
        """Fetch one block; parts outside the product's extent are NaN."""
        import urllib.request

        x0, y0, x1, y1, px = self._bbox(src, level, bx, by)
        bp = block_px(src, level)
        ex0, ey0, ex1, ey1 = src.extent
        cx0, cy0, cx1, cy1 = max(x0, ex0), max(y0, ey0), min(x1, ex1), min(y1, ey1)
        z = np.full((bp, bp), np.nan, dtype=np.float32)
        if cx1 <= cx0 or cy1 <= cy0:
            return z
        w = int(round((cx1 - cx0) / px))
        h = int(round((cy1 - cy0) / px))
        if w < 1 or h < 1:
            return z
        params = {
            "bbox": f"{cx0},{cy0},{cx1},{cy1}",
            "size": f"{w},{h}",
            "format": "tiff",
            "pixelType": src.pixel_type,
            "interpolation": "RSP_BilinearInterpolation",
            "f": "image",
        }
        url = f"{TREK}/{src.service}/ImageServer/exportImage?" + urllib.parse.urlencode(params)
        # Moon Trek occasionally answers 500/502 for a request that works moments later.
        # A block (<= 1024^2 px) normally arrives in seconds; 120 s per attempt keeps a stalled
        # connection from tying up a terrain request for many minutes (the 3D view retries).
        for attempt in range(4):
            try:
                with urllib.request.urlopen(url, timeout=120) as r:
                    data = r.read()
                break
            except OSError:
                if attempt == 3:
                    raise
                time.sleep(2 * (attempt + 1))
        with rasterio.MemoryFile(data) as mf, mf.open() as ds:
            a = ds.read(1).astype(np.float32)
        a[a < INVALID_BELOW] = np.nan
        c0 = int(round((cx0 - x0) / px))
        r0 = int(round((y1 - cy1) / px))
        hh, ww = min(a.shape[0], bp - r0), min(a.shape[1], bp - c0)
        z[r0 : r0 + hh, c0 : c0 + ww] = a[:hh, :ww]
        return z


_store = _BlockStore()
_BLOCK_ID_STRIDE = 1 << 31  # block id = by * stride + bx


def sample_source(src: DemSource, level: int, x: np.ndarray, y: np.ndarray, store: _BlockStore | None = None) -> np.ndarray:
    """Bilinear heights from one source at one level, at map coordinates (x, y). NaN where no data."""
    store = store or _store
    px = src.native * 2**level
    bp = block_px(src, level)
    xmin0, _, _, ymax0 = src.extent
    col = (np.asarray(x, dtype=float) - xmin0) / px - 0.5  # pixel-centre coordinates
    row = (ymax0 - np.asarray(y, dtype=float)) / px - 0.5
    c0 = np.floor(col).astype(np.int64)
    r0 = np.floor(row).astype(np.int64)
    fc, fr = col - c0, row - r0
    ncols = int(round((src.extent[2] - xmin0) / px))  # for wrapping longitude on the global grid

    def neighbour(dr, dc):
        rr, cc = r0 + dr, c0 + dc
        if src.kind == "eq":
            cc = cc % ncols  # the 180 deg meridian is continuous
        return rr, cc

    # Which block each of the 4 bilinear neighbours falls in, as one integer id per point
    # (1-D np.unique is ~50x faster than unique rows over (bx, by) pairs).
    corners_idx = []
    for dr, dc in ((0, 0), (0, 1), (1, 0), (1, 1)):
        rr, cc = neighbour(dr, dc)
        ok = (rr >= 0) & (cc >= 0)
        bid = np.where(ok, (rr // bp) * _BLOCK_ID_STRIDE + cc // bp, -1)
        corners_idx.append((rr, cc, bid))
    needed = np.unique(np.concatenate([b for _, _, b in corners_idx]))
    needed = [(int(b % _BLOCK_ID_STRIDE), int(b // _BLOCK_ID_STRIDE)) for b in needed if b >= 0]

    # Download missing blocks in parallel first (cold starts are request-latency bound).
    missing = [k for k in needed if not store.in_memory(src, level, *k)]
    if len(missing) > 1:
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda k: store.get(src, level, k[0], k[1]), missing))

    # Gather the 4 neighbours, each possibly in a different block.
    corners = []
    for rr, cc, bid in corners_idx:
        vals = np.full(col.shape, np.nan)
        for kx, ky in needed:
            sel = bid == ky * _BLOCK_ID_STRIDE + kx
            if sel.any():
                block = store.get(src, level, kx, ky)
                vals[sel] = block[rr[sel] - ky * bp, cc[sel] - kx * bp]
        corners.append(vals)
    z00, z01, z10, z11 = corners
    return (z00 * (1 - fc) + z01 * fc) * (1 - fr) + (z10 * (1 - fc) + z11 * fc) * fr


def sample_latlon(lat, lon, spacing_m: float, store: _BlockStore | None = None) -> np.ndarray:
    """Heights (m, relative to the 1737.4 km sphere) at lat/lon, using data no coarser than
    `spacing_m` where available. Each point tries its latitude band's sources from the coarsest
    adequate one downwards in resolution, then falls back to coarser ones where data is missing."""
    lat = np.asarray(lat, dtype=float)
    lon = np.asarray(lon, dtype=float)
    out = np.full(lat.shape, np.nan)
    bands = np.where(lat <= -POLAR_LAT, 0, np.where(lat >= POLAR_LAT, 1, 2))
    for band, names in enumerate((SOUTH, NORTH, GLOBAL_ONLY)):
        sel = bands == band
        if not sel.any():
            continue
        srcs = [SOURCES[n] for n in names]
        # In polar bands the polar products come first and the global grid (poor near the pole)
        # is only a last resort. Within them, start at the coarsest product that is still fine
        # enough (fewer downloads), then try coarser ones, then finer ones where data is missing.
        main = [s for s in srcs if s.kind != "eq"] or srcs
        fallback = [s for s in srcs if s not in main]
        fine_enough = [i for i, s in enumerate(main) if s.native_m <= spacing_m]
        start = fine_enough[-1] if fine_enough else 0
        order = main[start:] + main[:start][::-1] + fallback
        idx = np.flatnonzero(sel)
        for src in order:
            todo = idx[np.isnan(out[idx])]
            if not todo.size:
                break
            x, y = project(src, lat[todo], lon[todo])
            xmin, ymin, xmax, ymax = src.extent
            inside = (x >= xmin) & (x <= xmax) & (y >= ymin) & (y <= ymax)
            if not inside.any():
                continue
            vals = sample_source(src, level_for(src, spacing_m), x[inside], y[inside], store)
            out[todo[inside]] = vals
    return out


def finest_native_m(lat: float, lon: float) -> float:
    """Finest native resolution (m) of any source whose extent contains the point."""
    best = np.inf
    for name in candidates(lat):
        src = SOURCES[name]
        x, y = project(src, lat, lon)
        xmin, ymin, xmax, ymax = src.extent
        if xmin <= float(x) <= xmax and ymin <= float(y) <= ymax:
            best = min(best, src.native_m)
    return best

