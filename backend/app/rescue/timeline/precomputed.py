"""Loads the data engine's precomputed per-site timelines from data/sites/.

Primary format: the file `backend/scripts/precompute.py` writes, `data/sites/<id>.json`, with
columnar arrays under "timeline" (see docs/interfaces.md, "Precomputed site file"):

    {"site": {...}, "meta": {...}, "summary": {...}, "horizon": {...},
     "timeline": {"time_utc": [...], "sun_azimuth_deg": [...], ..., "earth_visible": [...]}}

Also accepted: a list of TimelineStep objects, or {"timeline": [TimelineStep, ...]}.

Files are looked up as data/sites/<id>.json, then <id>/timeline.json, then <id>.timeline.json.
A site with no file, or a request outside the file's time range or step, falls back to
another provider (synthetic by default); each timeline's `source` says which one answered.
Rescue only takes that fallback in simulation mode: by default its Evaluator checks
`coverage()` first and reports anything not fully covered by real data as UNKNOWN.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import numpy as np

from ...models import Site, TimelineStep
from ..catalog import CUSTOM_PREFIX
from .base import Timeline, TimelineProvider, to_np_utc

DEFAULT_DATA_DIR = Path(__file__).resolve().parents[4] / "data" / "sites"

COLUMNS = ["sun_azimuth_deg", "sun_elevation_deg", "sun_horizon_deg", "sun_visible_fraction",
           "earth_azimuth_deg", "earth_elevation_deg", "earth_horizon_deg", "earth_visible"]


def candidate_paths(data_dir: Path, site_id: str) -> list[Path]:
    return [data_dir / f"{site_id}.json", data_dir / site_id / "timeline.json", data_dir / f"{site_id}.timeline.json"]


def _parse_times(values) -> np.ndarray:
    return np.array([np.datetime64(str(v).rstrip("Z"), "s") for v in values])


def _check_spacing(times: np.ndarray, where: str) -> int:
    if len(times) < 2:
        raise ValueError(f"{where}: timeline needs at least 2 samples")
    steps = np.diff(times).astype("timedelta64[s]").astype(np.int64)
    if steps[0] <= 0 or np.any(steps != steps[0]):
        raise ValueError(f"{where}: timeline steps must be evenly spaced and increasing")
    return int(steps[0])


def _from_columns(cols: dict, site: Site, source: str, where: str) -> Timeline:
    missing = [c for c in ["time_utc", *COLUMNS] if c not in cols]
    if missing:
        raise ValueError(f"{where}: timeline is missing columns {missing}")
    times = _parse_times(cols["time_utc"])
    n = len(times)
    bad = [c for c in COLUMNS if len(cols[c]) != n]
    if bad:
        raise ValueError(f"{where}: columns {bad} do not have {n} values like time_utc")
    step_s = _check_spacing(times, where)
    f = lambda c: np.asarray([np.nan if v is None else v for v in cols[c]], dtype=float)  # noqa: E731
    sun_frac, earth_horizon = f("sun_visible_fraction"), f("earth_horizon_deg")
    # A null flag is unknown, never "not visible": the canonical adapter reads NaN as unknown.
    earth_flag = cols["earth_visible"]
    earth_horizon[np.array([v is None for v in earth_flag], dtype=bool)] = np.nan
    sun_flag = None
    if "sun_visible" in cols and len(cols["sun_visible"]) == n:
        sun_flag = np.array([np.nan if v is None else float(bool(v)) for v in cols["sun_visible"]], dtype=float)
        sun_frac[np.isnan(sun_flag)] = np.nan
    return Timeline(
        site=site, times=times, step_hours=step_s / 3600.0,
        sun_az=f("sun_azimuth_deg"), sun_el=f("sun_elevation_deg"), sun_horizon=f("sun_horizon_deg"),
        sun_visible_fraction=sun_frac,
        earth_az=f("earth_azimuth_deg"), earth_el=f("earth_elevation_deg"), earth_horizon=earth_horizon,
        earth_visible=np.array([bool(v) for v in earth_flag], dtype=bool), source=source, sun_visible=sun_flag,
    )


def _from_steps(rows: list, site: Site, source: str, where: str) -> Timeline:
    steps = [TimelineStep.model_validate(r) for r in rows]
    cols = {
        "time_utc": [s.time_utc for s in steps],
        "sun_azimuth_deg": [s.sun.azimuth_deg for s in steps], "sun_elevation_deg": [s.sun.elevation_deg for s in steps],
        "sun_horizon_deg": [s.sun.horizon_deg for s in steps],
        "sun_visible_fraction": [s.sun.visible_fraction for s in steps],
        "earth_azimuth_deg": [s.earth.azimuth_deg for s in steps],
        "earth_elevation_deg": [s.earth.elevation_deg for s in steps],
        "earth_horizon_deg": [s.earth.horizon_deg for s in steps], "earth_visible": [s.earth.visible for s in steps],
    }
    return _from_columns(cols, site, source, where)


def load_timeline_file(path: Path, site: Site, label: str | None = None) -> Timeline:
    raw = json.loads(path.read_text(encoding="utf-8"))
    source = f"precomputed:{label or path.name}"
    body = raw.get("timeline") if isinstance(raw, dict) else raw
    if isinstance(body, dict):
        return _from_columns(body, site, source, str(path))
    if isinstance(body, list):
        return _from_steps(body, site, source, str(path))
    raise ValueError(f"{path}: no 'timeline' found")


class PrecomputedTimelineProvider:
    def __init__(self, fallback: TimelineProvider, data_dir: Path = DEFAULT_DATA_DIR):
        self.fallback = fallback
        self.data_dir = Path(data_dir)
        self._cache: dict[str, Timeline | None] = {}

    def _load(self, site: Site) -> Timeline | None:
        if site.id.startswith(CUSTOM_PREFIX):
            return None
        if site.id not in self._cache:
            path = next((p for p in candidate_paths(self.data_dir, site.id) if p.exists()), None)
            self._cache[site.id] = (load_timeline_file(path, site, path.relative_to(self.data_dir).as_posix())
                                    if path else None)
        return self._cache[site.id]

    def coverage(self, site: Site) -> tuple[np.datetime64, np.datetime64] | None:
        """(first, last) sample time of the real data for this site, or None if there is none."""
        tl = self._load(site)
        return None if tl is None else (tl.times[0], tl.times[-1])

    def has_data(self, site: Site, start: datetime | None = None, end: datetime | None = None) -> bool:
        """True if real precomputed data exists for this site (and covers start..end if given)."""
        tl = self._load(site)
        if tl is None:
            return False
        first, last = tl.times[0], tl.times[-1]
        return all(first <= to_np_utc(t) <= last for t in (start, end) if t is not None)

    def timeline(self, site: Site, start: datetime, end: datetime, step_hours: float = 1.0) -> Timeline:
        tl = self._load(site)
        if tl is not None and abs(tl.step_hours - step_hours) < 1e-9:
            s, e = to_np_utc(start), to_np_utc(end)
            if tl.times[0] <= s and e <= tl.times[-1]:
                # Samples stay on the file's own grid (e.g. whole hours); callers slice by time.
                i = int(np.searchsorted(tl.times, s))
                j = int(np.searchsorted(tl.times, e, side="right"))
                out = tl.slice(i, j)
                out.site = site
                return out
        return self.fallback.timeline(site, start, end, step_hours)
