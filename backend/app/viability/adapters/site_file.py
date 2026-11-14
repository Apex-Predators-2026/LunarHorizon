"""Adapter: Member 1 precomputed site file -> ``ScientificTimeSeries``.

Source format: ``data/sites/<id>.json`` written by ``backend/scripts/precompute.py`` and
described in docs/interfaces.md ("Precomputed site file"). Column-oriented: index ``i``
across every ``timeline`` array is one time step.

This module only *translates*. It never computes ephemerides, horizons or visibility,
never fills in missing values, and never loosens the core contract. Conversions done here
(and only here):

* Longitude: the file uses east-positive 0..360; values above 180 become ``lon - 360``
  (same meridian, contract range [-180, 180]). The original value is kept in provenance.
* Azimuth: a value of exactly 360.0 (a rounding artifact of 359.9995+) becomes 0.0, the
  same direction. Anything else outside [0, 360) is rejected.
* Visibility: ``sun_visible_fraction`` 0 / (0,1) / 1 -> ``not_visible`` / ``partial`` /
  ``visible`` with the fraction preserved (``apparent_disk`` criterion);
  ``earth_visible`` (centre above terrain) -> ``visible`` / ``not_visible`` (``center``).
* Missing element (``null`` or ``NaN``) -> that body's state is ``unknown`` and the
  missing value stays ``None``. A visibility value that depends on a missing angle is
  treated as inconsistent and rejected.

NOT verified here: the lunar body-fixed frame of the Horizons site coordinates vs. the
Moon Trek DEM (see docs/viability-engine.md, "Remaining integration decisions").
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping, Sequence
from datetime import datetime
from itertools import pairwise
from pathlib import Path
from typing import Any, Final

from pydantic import TypeAdapter, ValidationError

from ..conventions import UTCDatetime
from ..enums import AngleType, CalculationBasis, VisibilityCriterion, VisibilityState
from ..inputs import ScientificTimeSeries

ADAPTER_VERSION: Final = "site-file-adapter/0.1.0"

# Default coverage-gap threshold, as a multiple of the declared step. Adapter policy, not data.
DEFAULT_MAX_GAP_FACTOR: Final = 1.5

# Tolerances for checks between rounded columns (the file rounds angles to 3 decimals).
_MARGIN_TOLERANCE_DEG: Final = 2e-3  # margin vs (elevation - horizon): three roundings
_FLAG_TOLERANCE_DEG: Final = 1e-3  # earth_visible vs rounded margin
_SPACING_TOLERANCE_S: Final = 1.0

REQUIRED_COLUMNS: Final = (
    "time_utc",
    "sun_azimuth_deg",
    "sun_elevation_deg",
    "sun_horizon_deg",
    "sun_visible_fraction",
    "earth_azimuth_deg",
    "earth_elevation_deg",
    "earth_horizon_deg",
    "earth_margin_deg",
    "earth_visible",
)
OPTIONAL_COLUMNS: Final = ("sun_angular_radius_deg", "earth_angular_radius_deg")

_STEP_RE: Final = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(m|min|h|d)\s*$")
_STEP_UNIT_S: Final = {"m": 60.0, "min": 60.0, "h": 3600.0, "d": 86400.0}
_ID_UNSAFE: Final = re.compile(r"[^A-Za-z0-9._-]+")
_UTC: Final = TypeAdapter(UTCDatetime)


class SiteFileError(ValueError):
    """The site file is malformed, incomplete or internally inconsistent."""


# --- normalisation helpers ----------------------------------------------------------------


def normalize_longitude_deg(lon: float) -> float:
    """East-positive longitude in [-180, 360) -> contract range [-180, 180]."""
    if isinstance(lon, bool) or not isinstance(lon, (int, float)) or not math.isfinite(lon):
        raise SiteFileError(f"longitude must be a finite number, got {lon!r}")
    if not -180.0 <= lon < 360.0:
        raise SiteFileError(f"longitude {lon} outside accepted range [-180, 360)")
    return float(lon) - 360.0 if lon > 180.0 else float(lon)


def normalize_azimuth_deg(az: float, where: str = "azimuth") -> float:
    """Azimuth in [0, 360] -> [0, 360). Only exactly 360.0 is wrapped (to 0.0)."""
    if not 0.0 <= az <= 360.0:
        raise SiteFileError(f"{where}: azimuth {az} outside [0, 360]")
    return 0.0 if az == 360.0 else az + 0.0  # + 0.0 turns -0.0 into 0.0


def parse_step_s(step: str) -> float:
    """Horizons-style step ('1h', '30m', '10 min', '1d') -> seconds."""
    m = _STEP_RE.match(step) if isinstance(step, str) else None
    if m is None:
        raise SiteFileError(f"meta.step {step!r} is not a recognised step (e.g. '1h', '30m', '1d')")
    seconds = float(m.group(1)) * _STEP_UNIT_S[m.group(2)]
    if seconds <= 0:
        raise SiteFileError(f"meta.step {step!r} must be positive")
    return seconds


# --- low-level readers --------------------------------------------------------------------


def _get(mapping: Mapping[str, Any], key: str, kind: type | tuple[type, ...], where: str) -> Any:
    if key not in mapping:
        raise SiteFileError(f"{where}.{key} is missing")
    value = mapping[key]
    if isinstance(value, bool) and kind is not bool:
        raise SiteFileError(f"{where}.{key} must be {kind}, got bool")
    if not isinstance(value, kind):
        raise SiteFileError(f"{where}.{key} has type {type(value).__name__}, expected {kind}")
    return value


def _number(value: Any, where: str) -> float | None:
    """A finite float, or None for null/NaN (missing). Rejects bools, strings, infinities."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SiteFileError(f"{where}: expected a number or null, got {value!r}")
    if math.isnan(value):
        return None
    if math.isinf(value):
        raise SiteFileError(f"{where}: infinite values are not valid")
    return float(value)


def _columns(timeline: Mapping[str, Any]) -> tuple[dict[str, Sequence[Any]], int, list[str]]:
    missing = [c for c in REQUIRED_COLUMNS if c not in timeline]
    if missing:
        raise SiteFileError(f"timeline is missing required column(s): {', '.join(missing)}")
    cols: dict[str, Sequence[Any]] = {}
    for name in (*REQUIRED_COLUMNS, *(c for c in OPTIONAL_COLUMNS if c in timeline)):
        col = timeline[name]
        if not isinstance(col, list):
            raise SiteFileError(f"timeline.{name} must be an array")
        cols[name] = col
    lengths = {name: len(col) for name, col in cols.items()}
    if len(set(lengths.values())) != 1:
        detail = ", ".join(f"{k}={v}" for k, v in lengths.items())
        raise SiteFileError(f"timeline arrays have inconsistent lengths: {detail}")
    n = lengths["time_utc"]
    if n < 2:
        raise SiteFileError(f"timeline needs at least 2 samples to define a coverage period, got {n}")
    ignored = sorted(set(timeline) - set(cols))
    return cols, n, ignored


# --- per-sample conversion ----------------------------------------------------------------


def _sun(cols: Mapping[str, Sequence[Any]], i: int) -> dict[str, Any]:
    az = _number(cols["sun_azimuth_deg"][i], f"timeline.sun_azimuth_deg[{i}]")
    el = _number(cols["sun_elevation_deg"][i], f"timeline.sun_elevation_deg[{i}]")
    hz = _number(cols["sun_horizon_deg"][i], f"timeline.sun_horizon_deg[{i}]")
    frac = _number(cols["sun_visible_fraction"][i], f"timeline.sun_visible_fraction[{i}]")
    radius = (
        _number(cols["sun_angular_radius_deg"][i], f"timeline.sun_angular_radius_deg[{i}]")
        if "sun_angular_radius_deg" in cols
        else None
    )
    if az is not None:
        az = normalize_azimuth_deg(az, f"timeline.sun_azimuth_deg[{i}]")
    if hz is not None and az is None:
        raise SiteFileError(f"sample {i}: sun_horizon_deg given but sun_azimuth_deg is missing")

    if frac is None or az is None or el is None or hz is None:
        if frac is not None:
            raise SiteFileError(
                f"sample {i}: sun_visible_fraction given but an angle it depends on is missing (inconsistent)"
            )
        state, out_frac = VisibilityState.UNKNOWN, None
    else:
        if not 0.0 <= frac <= 1.0:
            raise SiteFileError(f"timeline.sun_visible_fraction[{i}]: {frac} outside [0, 1]")
        state = (
            VisibilityState.NOT_VISIBLE
            if frac == 0.0
            else VisibilityState.VISIBLE
            if frac == 1.0
            else VisibilityState.PARTIAL
        )
        out_frac = frac
    return {
        "azimuth_deg": az,
        "elevation_deg": el,
        "horizon_deg": hz,
        "state": state,
        "visible_fraction": out_frac,
        "angular_radius_deg": radius,
    }


def _earth(cols: Mapping[str, Sequence[Any]], i: int) -> dict[str, Any]:
    az = _number(cols["earth_azimuth_deg"][i], f"timeline.earth_azimuth_deg[{i}]")
    el = _number(cols["earth_elevation_deg"][i], f"timeline.earth_elevation_deg[{i}]")
    hz = _number(cols["earth_horizon_deg"][i], f"timeline.earth_horizon_deg[{i}]")
    margin = _number(cols["earth_margin_deg"][i], f"timeline.earth_margin_deg[{i}]")
    visible = cols["earth_visible"][i]
    radius = (
        _number(cols["earth_angular_radius_deg"][i], f"timeline.earth_angular_radius_deg[{i}]")
        if "earth_angular_radius_deg" in cols
        else None
    )
    if visible is not None and not isinstance(visible, bool):
        raise SiteFileError(f"timeline.earth_visible[{i}]: expected true/false/null, got {visible!r}")
    if az is not None:
        az = normalize_azimuth_deg(az, f"timeline.earth_azimuth_deg[{i}]")
    if hz is not None and az is None:
        raise SiteFileError(f"sample {i}: earth_horizon_deg given but earth_azimuth_deg is missing")
    if margin is not None and el is not None and hz is not None and abs(margin - (el - hz)) > _MARGIN_TOLERANCE_DEG:
        raise SiteFileError(f"sample {i}: earth_margin_deg {margin} disagrees with elevation - horizon ({el - hz:.4f})")

    if visible is None or az is None or el is None or hz is None:
        if visible is not None:
            raise SiteFileError(f"sample {i}: earth_visible given but an angle it depends on is missing (inconsistent)")
        state = VisibilityState.UNKNOWN
    else:
        if margin is not None and (
            (margin > _FLAG_TOLERANCE_DEG and not visible) or (margin < -_FLAG_TOLERANCE_DEG and visible)
        ):
            raise SiteFileError(f"sample {i}: earth_visible={visible} contradicts earth_margin_deg={margin}")
        state = VisibilityState.VISIBLE if visible else VisibilityState.NOT_VISIBLE
    return {
        "azimuth_deg": az,
        "elevation_deg": el,
        "horizon_deg": hz,
        "state": state,
        "visible_fraction": None,
        "angular_radius_deg": radius,
    }


def _times(column: Sequence[Any]) -> list[datetime]:
    out: list[datetime] = []
    for i, raw in enumerate(column):
        if not isinstance(raw, str):
            raise SiteFileError(f"timeline.time_utc[{i}]: expected an ISO 8601 UTC string, got {raw!r}")
        try:
            out.append(_UTC.validate_python(raw))
        except ValidationError as e:
            raise SiteFileError(f"timeline.time_utc[{i}] {raw!r}: {e.errors()[0]['msg']}") from e
    return out


def _horizon_profile(block: Any) -> tuple[dict[str, Any] | None, float | None]:
    if block is None:
        return None, None
    if not isinstance(block, Mapping):
        raise SiteFileError("horizon must be an object")
    azs = _get(block, "azimuth_deg", list, "horizon")
    els = _get(block, "elevation_deg", list, "horizon")
    if len(azs) != len(els):
        raise SiteFileError(
            f"horizon arrays have inconsistent lengths: azimuth_deg={len(azs)}, elevation_deg={len(els)}"
        )
    az_out: list[float] = []
    for j, a in enumerate(azs):
        value = _number(a, f"horizon.azimuth_deg[{j}]")
        if value is None:
            raise SiteFileError(f"horizon.azimuth_deg[{j}] is missing")
        az_out.append(normalize_azimuth_deg(value, f"horizon.azimuth_deg[{j}]"))
    el_out = [_number(e, f"horizon.elevation_deg[{j}]") for j, e in enumerate(els)]
    steps = {round(b - a, 6) for a, b in pairwise(az_out)}
    step = None  # only reported when the profile is uniformly spaced
    if len(steps) == 1:
        (only,) = steps
        step = only if only > 0 else None
    return {"azimuths_deg": az_out, "horizon_deg": el_out}, step


# --- public API ---------------------------------------------------------------------------


def site_file_to_series(
    data: Mapping[str, Any],
    *,
    source: str = "site file",
    max_gap_factor: float = DEFAULT_MAX_GAP_FACTOR,
) -> ScientificTimeSeries:
    """Convert a parsed precomputed site file into a validated ``ScientificTimeSeries``.

    Raises ``SiteFileError`` for malformed or inconsistent input, including when the
    converted data fails the core contract (the pydantic error is chained as ``__cause__``).
    """
    if not isinstance(data, Mapping):
        raise SiteFileError(f"{source}: top level must be a JSON object")
    if max_gap_factor < 1.0:
        raise SiteFileError("max_gap_factor must be >= 1")
    site = _get(data, "site", Mapping, "file")
    meta = _get(data, "meta", Mapping, "file")
    timeline = _get(data, "timeline", Mapping, "file")

    site_id = _get(site, "id", str, "site")
    name = _get(site, "name", str, "site")
    lat = _number(_get(site, "lat", (int, float), "site"), "site.lat")
    lon_raw = _get(site, "lon", (int, float), "site")
    lon = normalize_longitude_deg(lon_raw)
    ground = _number(site.get("ground_height_m"), "site.ground_height_m")
    observer = _number(site.get("observer_height_m"), "site.observer_height_m")

    ephemeris = _get(meta, "ephemeris", str, "meta")
    if "apparent" not in ephemeris.lower():
        raise SiteFileError(f"meta.ephemeris does not state apparent angles; cannot set angle_type: {ephemeris!r}")
    terrain = _get(meta, "terrain", list, "meta")
    if not terrain or not all(isinstance(t, str) and t.strip() for t in terrain):
        raise SiteFileError("meta.terrain must be a non-empty list of strings (terrain-aware data requires a source)")
    step_raw = _get(meta, "step", str, "meta")
    step_s = parse_step_s(step_raw)
    generated_raw = meta.get("generated_utc")
    generated = _times([generated_raw])[0] if generated_raw is not None else None

    cols, n, ignored = _columns(timeline)
    times = _times(cols["time_utc"])
    for i, (a, b) in enumerate(pairwise(times)):
        if (b - a).total_seconds() < step_s - _SPACING_TOLERANCE_S:
            raise SiteFileError(
                f"timeline.time_utc[{i + 1}] is closer to the previous sample than meta.step={step_raw!r}"
            )

    profile, az_step = _horizon_profile(data.get("horizon"))
    samples = [{"time_utc": times[i], "sun": _sun(cols, i), "earth": _earth(cols, i)} for i in range(n)]

    start = meta.get("start_utc")
    stop = meta.get("stop_utc")
    dataset_id = _ID_UNSAFE.sub("-", f"{site_id}_{start}_{stop}")[:64]
    notes = (
        f"Converted by {ADAPTER_VERSION} from {source}. "
        f"Original site.lon = {lon_raw} deg E (0-360 convention); normalized to {lon} deg. "
        f"meta: start_utc={start!r}, stop_utc={stop!r}, step={step_raw!r}. "
        f"Projected x_m={site.get('x_m')!r}, y_m={site.get('y_m')!r} (Moon Trek south polar stereographic). "
        "Sun visibility = fraction of solar disk above terrain; Earth visibility = centre above terrain. "
        "Lunar body-fixed frame of ephemeris vs DEM NOT verified."
    )
    if ignored:
        notes += f" Ignored timeline columns: {', '.join(ignored)}."
    references = [site["source"]] if isinstance(site.get("source"), str) and site["source"].strip() else []

    payload = {
        "dataset_id": dataset_id,
        "site": {"id": site_id, "name": name, "lat": lat, "lon": lon, "surface_height_m": ground},
        "observer_height_m": observer,
        "coverage_start_utc": times[0],
        "coverage_end_utc": times[-1],
        "calculation_basis": CalculationBasis.TERRAIN_AWARE,
        "angle_type": AngleType.APPARENT,
        "sun_criterion": VisibilityCriterion.APPARENT_DISK,
        "earth_criterion": VisibilityCriterion.CENTER,
        "sampling": {"nominal_interval_s": step_s, "max_gap_s": step_s * max_gap_factor},
        "provenance": {
            "is_synthetic": False,
            "ephemeris_source": ephemeris,
            "terrain_source": "; ".join(t.strip() for t in terrain),
            "terrain_resolution_m": None,  # multi-resolution tiers; listed in terrain_source
            "horizon_azimuth_step_deg": az_step,
            "generated_at_utc": generated,
            "generator": meta.get("generator")
            or "not recorded in file (format: Member 1 precomputed site file, docs/interfaces.md)",
            "references": references,
            "notes": notes,
        },
        "horizon_profile": profile,
        "samples": samples,
    }
    try:
        return ScientificTimeSeries.model_validate(payload)
    except ValidationError as e:
        first = e.errors()[0]
        loc = ".".join(str(p) for p in first["loc"])
        raise SiteFileError(
            f"{source}: converted data violates the viability input contract at {loc}: {first['msg']} "
            f"({e.error_count()} error(s))"
        ) from e


def _reject_constant(token: str) -> float:
    if token == "NaN":
        return math.nan  # treated as missing by the converter
    raise SiteFileError(f"non-finite JSON constant {token!r} is not valid")


def load_site_file(path: str | Path, *, max_gap_factor: float = DEFAULT_MAX_GAP_FACTOR) -> ScientificTimeSeries:
    """Read and convert ``data/sites/<id>.json``."""
    p = Path(path)
    try:
        data = json.loads(p.read_text(encoding="utf-8"), parse_constant=_reject_constant)
    except json.JSONDecodeError as e:
        raise SiteFileError(f"{p.name}: invalid JSON: {e}") from e
    return site_file_to_series(data, source=p.name, max_gap_factor=max_gap_factor)
