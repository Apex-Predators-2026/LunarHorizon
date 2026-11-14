"""Loads precomputed site records (data/sites/*.json) and computes custom sites on demand."""

import json
import threading
from functools import lru_cache
from pathlib import Path

import numpy as np

from .engine.geo import latlon_to_xy, local_north_east, scale_factor
from .engine.net import DATA_DIR
from .engine.pipeline import analyze_site
from .engine.terrain import load_terrain

SITES_DIR = DATA_DIR / "sites"
CUSTOM_DIR = SITES_DIR / "custom"
_custom_lock = threading.Lock()


BOOL_COLUMNS = ("sun_visible", "earth_visible")


class SiteData:
    """One site record with the timeline as numpy arrays for fast slicing.

    Numeric columns: float arrays, NaN where the file has null (unknown).
    Boolean columns: bool arrays (False where unknown) plus `known[name]` masks.
    """

    def __init__(self, record: dict):
        self.record = record
        self.site = record["site"]
        tl = dict(record["timeline"])
        self.times = np.array([t.rstrip("Z") for t in tl.pop("time_utc")], dtype="datetime64[s]")
        self.cols: dict[str, np.ndarray] = {}
        self.known: dict[str, np.ndarray] = {}
        for name, values in tl.items():
            if name in BOOL_COLUMNS:
                self.known[name] = np.array([v is not None for v in values])
                self.cols[name] = np.array([bool(v) for v in values])
            else:
                self.cols[name] = np.array([np.nan if v is None else v for v in values], dtype=float)
        if "sun_visible" not in self.cols:  # files from generator 1.0
            frac = self.cols["sun_visible_fraction"]
            self.known["sun_visible"] = ~np.isnan(frac)
            self.cols["sun_visible"] = np.nan_to_num(frac) > 0
        self.sunlit = self.cols["sun_visible"]
        self.earth_visible = self.cols["earth_visible"]


def _site_files() -> dict[str, Path]:
    files = {p.stem: p for p in SITES_DIR.glob("*.json")}
    files.update({p.stem: p for p in CUSTOM_DIR.glob("*.json")})
    return files


@lru_cache(maxsize=32)
def _load(path: str, mtime: float) -> SiteData:
    return SiteData(json.loads(Path(path).read_text()))


def list_site_ids(include_custom: bool = False) -> list[str]:
    ids = sorted(p.stem for p in SITES_DIR.glob("*.json"))
    if include_custom:
        ids += sorted(p.stem for p in CUSTOM_DIR.glob("*.json"))
    return ids


def get_site(site_id: str) -> SiteData | None:
    path = _site_files().get(site_id)
    if path is None:
        return None
    return _load(str(path), path.stat().st_mtime)


def custom_site_id(lat: float, lon: float) -> str:
    return f"custom_{lat:.4f}_{lon % 360:.4f}".replace("-", "m")


def create_custom_site(lat: float, lon: float, name: str | None) -> SiteData:
    """Run the full pipeline for arbitrary coordinates (slow the first time: downloads)."""
    site_id = custom_site_id(lat, lon)
    with _custom_lock:
        existing = get_site(site_id)
        if existing:
            return existing
        record = analyze_site(
            {
                "id": site_id,
                "name": name or f"Custom ({lat:.3f}, {lon % 360:.3f})",
                "lat": lat,
                "lon": lon % 360,
                "source": "User-entered coordinates",
            }
        )
        CUSTOM_DIR.mkdir(parents=True, exist_ok=True)
        (CUSTOM_DIR / f"{site_id}.json").write_text(json.dumps(record, separators=(",", ":")))
    return get_site(site_id)


@lru_cache(maxsize=16)
def terrain_grid(site_id: str, size: int, half_width_m: float) -> dict:
    """Height grid aligned with the site's local north/east axes."""
    s = get_site(site_id).site
    x0, y0 = (float(v) for v in latlon_to_xy(s["lat"], s["lon"]))
    terrain = load_terrain(x0, y0)
    north, east = local_north_east(s["lon"])
    k = float(scale_factor(s["lat"]))

    offsets = np.linspace(-half_width_m, half_width_m, size)
    E, N = np.meshgrid(offsets, offsets[::-1])  # rows north -> south, cols west -> east
    px = x0 + k * (E * east[0] + N * north[0])
    py = y0 + k * (E * east[1] + N * north[1])
    z = terrain.sample(px, py)
    if np.isnan(z).any():  # fill any gaps with the mean so the mesh stays continuous
        z = np.where(np.isnan(z), np.nanmean(z), z)

    return {
        "size": size,
        "half_width_m": half_width_m,
        "spacing_m": float(offsets[1] - offsets[0]),
        "site_height_m": s["ground_height_m"],
        "min_height_m": round(float(z.min()), 1),
        "max_height_m": round(float(z.max()), 1),
        "heights_m": [round(float(v), 1) for v in z.ravel()],
    }
