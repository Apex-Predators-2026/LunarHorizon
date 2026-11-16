"""Loads precomputed site records (data/sites/*.json) and computes custom sites on demand."""

import json
import os
import threading
from functools import lru_cache
from pathlib import Path

import numpy as np

from .engine.dem import sample_latlon
from .engine.geo import destination
from .engine.net import DATA_DIR
from .engine.pipeline import analyze_site

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


def _cache_size() -> int:
    """Parsed sites kept in memory. Each is ~25 MB, so small hosts (Render free: 512 MB) set SITE_CACHE_SIZE=4."""
    try:
        return max(1, int(os.environ.get("SITE_CACHE_SIZE", "32")))
    except ValueError:
        return 32


@lru_cache(maxsize=_cache_size())
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
    """Run the full pipeline for any point on the Moon. Uses the local ephemeris (no Horizons
    round trip); the first call for a new area may still download terrain blocks."""
    site_id = custom_site_id(lat, lon)
    with _custom_lock:
        existing = get_site(site_id)
        if existing:
            return existing
        record = analyze_site(
            {
                "id": site_id,
                "name": name or f"Custom ({lat:.3f}, {lon % 360:.3f})",
                "kind": "custom",
                "lat": lat,
                "lon": lon % 360,
                "source": "User-entered coordinates",
            },
            ephemeris="local",
        )
        CUSTOM_DIR.mkdir(parents=True, exist_ok=True)
        (CUSTOM_DIR / f"{site_id}.json").write_text(json.dumps(record, separators=(",", ":")))
    return get_site(site_id)


@lru_cache(maxsize=16)
def terrain_grid(site_id: str, size: int, half_width_m: float) -> dict:
    """Height grid aligned with the site's local north/east axes (any site on the Moon).
    Superseded in the 3D view by the whole-Moon tiles (/api/terrain/tile); kept for compatibility."""
    s = get_site(site_id).site
    offsets = np.linspace(-half_width_m, half_width_m, size)
    E, N = np.meshgrid(offsets, offsets[::-1])  # rows north -> south, cols west -> east
    # Each grid point = a great-circle step from the site (bearing clockwise from north).
    lat, lon = destination(s["lat"], s["lon"], np.degrees(np.arctan2(E, N)), np.hypot(E, N))
    z = sample_latlon(lat.ravel(), lon.ravel(), 2 * half_width_m / (size - 1)).reshape(size, size)
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
