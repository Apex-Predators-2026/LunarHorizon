"""Compatibility layer: Mission Rescue (Member 5) <-> canonical viability engine (Member 2).

Rescue calls ``evaluate_timeline(scenario: Scenario, timeline: Timeline) -> ViabilityResult``
(shared models in ``app/models.py``; ``Timeline`` in ``app/rescue/timeline/base.py``). This
module provides exactly that signature on top of ``app.viability.engine.evaluate_scenario``:

    Scenario  --scenario_to_mission-->  MissionScenario  --+
    Timeline  --timeline_to_series--->  ScientificTimeSeries --+--> evaluate_scenario()
                                                                       |
    ViabilityResult <--assessment_to_result-- ViabilityAssessment <---+

No viability quantity is computed here: every metric, constraint result and score comes
from the canonical engine. This module only converts units and shapes.

STATUS (Phase 6B): works end to end with the real ``evaluate_scenario``, which is the default
engine. On fully covered real data it reproduces rescue's placeholder exactly for all twelve
``ViabilityMetrics`` fields, every verdict and every ``Violation`` (side-by-side tests); only
``score`` differs (different, documented formula). Rescue still imports its placeholder; to
switch, Member 5 changes the import in ``app/rescue/viability/__init__.py``.

Canonical -> rescue (shared ``ViabilityResult`` with ``eligibility``, nullable ``score`` and
``Violation.is_unknown``; docs/interfaces.md):

* ``eligibility`` is copied exactly (``pass`` / ``fail`` / ``unknown``); the legacy
  ``passes`` flag is ``eligibility == "pass"``, so UNKNOWN is never reported as passing.
* Each FAIL or UNKNOWN constraint becomes a ``Violation``; UNKNOWN ones carry
  ``is_unknown=True`` (rescue then gives no loosening advice) and a message starting
  ``UNKNOWN``.
* ``ViabilityMetrics`` still requires plain floats, so unknown/bounded metrics are reported at
  their *unfavourable* bound (never optimistic); a metric with no bounds at all is reported at
  the worst value possible within the mission (0 for "more is better", the whole mission for
  outage durations).
* A missing score stays ``None`` (rescue: "not scored"). A *bounded* canonical score (some
  component only bounded) is also ``None``: the shared contract has no field for an interval,
  and a bound is never written into ``score``. The interval is in
  ``assessment.score.score_bounds`` (``evaluate_timeline_detailed``).
* Violations follow the order of rescue's ``MissionRequirements`` fields (= rescue's ``CHECKS``
  order), so rescue's messages and loosening text read exactly as with its placeholder.
The full canonical assessment is always available from ``evaluate_timeline_detailed``.

Timeline coverage: the final rescue bin is represented only when its time is covered by the
source (synthetic model, or a precomputed file confirmed to extend to mission end); nothing
beyond the dataset is fabricated. Reading that file's last timestamp and precision metadata is
the only file access in this module (cached per file and modification time).

Policy differences and contract limits (verified in tests; not approximated away):

* Coverage policy. Rescue's ``Evaluator`` decides coverage itself: a mission not fully inside the
  real data is answered by rescue (``source="rescue-coverage-check"``, UNKNOWN, one
  ``data_coverage`` violation) and never reaches this layer. The canonical engine applied to the
  whole site file would instead bound such a mission and may *prove* PASS or FAIL from the covered
  part. Rescue is stricter (it withholds a proven verdict) but never wrong.
* Last sample. Rescue counts a file's final instant as covering one more hour; the canonical
  series ends at that instant. A mission ending one hour after the file's last sample therefore
  gets one unknown hour here: a bounded score (``None``) and, rarely, UNKNOWN where the placeholder
  decides (e.g. a 1-day mission needing 24 h of initial sunlight). Never a PASS<->FAIL flip.
* Rescue's ``Timeline`` carries no ``sun_visible`` flag, so a sub-precision sliver (flag true,
  fraction written 0.0) reads as not visible. That affects only direct-sunlight time and mean Sun
  clearance, never a rescue requirement (power-lit needs fraction > 0). The committed 1.2 files
  have no such sample.
* ``ViabilityResult`` has no data-basis or risk fields; ``data_source`` names the timeline source
  (``precomputed:*`` / ``synthetic-placeholder``) and the assessment keeps the rest.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final, Literal

from pydantic import ValidationError

from ...models import MissionRequirements as RescueRequirements
from ...models import Scenario, ViabilityMetrics, ViabilityResult, Violation
from ..adapters.site_file import (
    FRACTION_DECIMALS_BY_GENERATOR_VERSION,
    SiteFileError,
    earth_observation,
    normalize_longitude_deg,
    parse_times,
    sun_observation,
)
from ..engine import ENGINE_VERSION, evaluate_scenario
from ..enums import (
    AngleType,
    CalculationBasis,
    CommunicationMode,
    ConstraintId,
    ConstraintStatus,
    Eligibility,
    MetricStatus,
    PowerSource,
    Unit,
    VisibilityCriterion,
)
from ..inputs import ScientificTimeSeries
from ..mission import LandingSite, MissionRequirements, MissionScenario, SpacecraftConfiguration
from ..outputs import ConstraintEvaluation, Metric, ViabilityAssessment

if TYPE_CHECKING:  # rescue's Timeline pulls in numpy; only needed for type checking
    from ...rescue.timeline.base import Timeline

COMPAT_VERSION: Final = "rescue-compat/0.3.0"
SOURCE: Final = f"viability-engine/{ENGINE_VERSION}"
DEFAULT_MAX_GAP_FACTOR: Final = 1.5
# Rescue passes round(duration / step) samples, so mission end lies at most 1.5 steps after the last one.
_MAX_REMAINDER_STEPS: Final = 1.5
_HOUR_S: Final = 3600.0
_ID_UNSAFE: Final = re.compile(r"[^A-Za-z0-9._-]+")

Engine = Callable[[MissionScenario, ScientificTimeSeries], ViabilityAssessment]
Better = Literal["more", "less"]


class RescueCompatError(ValueError):
    """Input or output cannot be converted faithfully between the two contracts."""


# --- identifiers --------------------------------------------------------------------------


def internal_site_id(rescue_site_id: str) -> str:
    """Map a shared ``Site.id`` (may be ``custom:-89.46012,221.98000``) to a contract Identifier."""
    cleaned = _ID_UNSAFE.sub("_", rescue_site_id).strip("_.-")[:64]
    if not cleaned:
        raise RescueCompatError(f"site id {rescue_site_id!r} has no usable characters")
    return cleaned


def rescue_longitude(lon: float) -> float:
    """Shared ``Site.lon`` (degrees east, any finite value) -> canonical range [-180, 180].

    Identical to the site-file adapter's ``normalize_longitude_deg`` on its domain [-180, 360).
    Other finite values are first reduced modulo 360 (same meridian). This matters because
    rescue's ``custom_site`` stores ``lon % 360``, which is exactly 360.0 for a tiny negative input.
    """
    if isinstance(lon, bool) or not isinstance(lon, (int, float)) or not math.isfinite(lon):
        raise RescueCompatError(f"site longitude must be a finite number, got {lon!r}")
    if not -180.0 <= lon < 360.0:
        lon = lon % 360.0
        if lon >= 360.0:  # float rounding of a tiny negative remainder
            lon = 0.0
    return normalize_longitude_deg(lon)


# --- Scenario -> MissionScenario ----------------------------------------------------------


def requirements_to_canonical(req: RescueRequirements) -> tuple[SpacecraftConfiguration, MissionRequirements]:
    """Rescue's flat requirement set -> canonical spacecraft limits + hard requirements.

    Rescue's checks presuppose solar arrays (battery_hours, panel_threshold) and a
    direct-to-Earth link (max_comms_gap_hours), so the spacecraft is SOLAR / DIRECT_TO_EARTH.
    """
    spacecraft = SpacecraftConfiguration(
        name="Rescue scenario lander (from shared MissionRequirements)",
        power_source=PowerSource.SOLAR,
        communication_mode=CommunicationMode.DIRECT_TO_EARTH,
        max_continuous_darkness_s=req.battery_hours * _HOUR_S,
        max_communication_blackout_s=req.max_comms_gap_hours * _HOUR_S,
        solar_power_min_disk_fraction=req.panel_threshold,
    )
    requirements = MissionRequirements(
        min_mean_solar_disk_fraction=req.min_sunlight_fraction,
        min_earth_visibility_percent=req.min_earth_visibility_fraction * 100.0,
        min_initial_sunlight_s=req.min_initial_sun_hours * _HOUR_S,
        min_initial_earth_visibility_s=req.min_initial_comms_hours * _HOUR_S,
    )
    return spacecraft, requirements


def scenario_to_mission(scenario: Scenario) -> MissionScenario:
    """Shared ``Scenario`` (landing + duration) -> canonical ``MissionScenario`` (start/end)."""
    landing = scenario.landing_utc
    if landing.tzinfo is None:  # the shared validator converts to UTC; refuse anything else
        raise RescueCompatError("scenario.landing_utc must be timezone-aware UTC")
    start = landing.astimezone(UTC)
    site = scenario.site
    sid = internal_site_id(site.id)
    spacecraft, requirements = requirements_to_canonical(scenario.requirements)
    try:
        lon = rescue_longitude(site.lon)
    except RescueCompatError as e:
        raise RescueCompatError(f"scenario.site.lon: {e}") from e
    return MissionScenario(
        scenario_id=internal_site_id(f"rescue_{sid}_{start:%Y%m%dT%H%M%SZ}"),
        site=LandingSite(id=sid, name=site.name.strip() or site.id, lat=site.lat, lon=lon),
        mission_start_utc=start,
        mission_end_utc=start + timedelta(days=scenario.duration_days),
        spacecraft=spacecraft,
        requirements=requirements,
    )


# --- Timeline -> ScientificTimeSeries -----------------------------------------------------


@dataclass(frozen=True)
class _SourceInfo:
    is_synthetic: bool
    angle_type: AngleType
    ephemeris: str
    terrain: str


def _classify_source(source: str) -> _SourceInfo:
    if source.startswith("precomputed:"):
        return _SourceInfo(
            is_synthetic=False,
            angle_type=AngleType.APPARENT,
            ephemeris=f"Member 1 precomputed site file via rescue ({source}); JPL Horizons apparent az/el",
            terrain=f"Member 1 precomputed site file via rescue ({source}); Moon Trek LOLA DEM tiers",
        )
    if source.startswith("synthetic"):
        return _SourceInfo(
            is_synthetic=True,
            angle_type=AngleType.GEOMETRIC,
            ephemeris=f"SYNTHETIC: rescue placeholder geometry ({source}), not NASA/JPL-derived",
            terrain=f"SYNTHETIC: rescue placeholder invented terrain ({source}), not DEM-derived",
        )
    raise RescueCompatError(f"unrecognised timeline source {source!r}; cannot tell real from synthetic data")


@dataclass(frozen=True)
class PrecomputedFileInfo:
    """What this layer reads from the precomputed file behind a rescue timeline (nothing else).

    ``fraction_decimals``: ``meta.fraction_decimals`` when present and valid, else the documented
    rounding of ``meta.generator_version`` (1.0 = 3, 1.1 = 6); None when neither states it
    (including a malformed value, which is never guessed at).
    """

    last_sample_utc: datetime | None
    fraction_decimals: int | None
    generator_version: str | None


def _fraction_decimals(meta: Any) -> tuple[int | None, str | None]:
    if not isinstance(meta, dict):
        return None, None
    version = meta.get("generator_version")
    version = version if isinstance(version, str) else None
    explicit = meta.get("fraction_decimals")
    if explicit is None:
        return (FRACTION_DECIMALS_BY_GENERATOR_VERSION.get(version) if version else None), version
    if isinstance(explicit, bool) or not isinstance(explicit, int) or not 0 <= explicit <= 17:
        return None, version
    return explicit, version


@lru_cache(maxsize=64)
def _file_info(path: str, mtime_ns: int) -> PrecomputedFileInfo | None:
    """Last ``time_utc`` and precision metadata of a precomputed file (both layouts rescue accepts)."""
    try:
        raw: Any = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    body: Any = raw.get("timeline") if isinstance(raw, dict) else raw
    try:
        last: Any = body["time_utc"][-1] if isinstance(body, dict) else body[-1]["time_utc"]
        last_time: datetime | None = parse_times([last])[0]
    except (ValueError, KeyError, IndexError, TypeError):  # SiteFileError is a ValueError
        last_time = None
    decimals, version = _fraction_decimals(raw.get("meta") if isinstance(raw, dict) else None)
    return PrecomputedFileInfo(last_sample_utc=last_time, fraction_decimals=decimals, generator_version=version)


def precomputed_file_info(source: str, data_dir: Path | None = None) -> PrecomputedFileInfo | None:
    """Info on the precomputed file behind a rescue ``source`` (``precomputed:<path>``).

    ``data_dir`` defaults to rescue's ``DEFAULT_DATA_DIR``. Returns None when the source is not
    precomputed or the file cannot be found or read (callers must then not assume coverage).
    """
    if not source.startswith("precomputed:"):
        return None
    if data_dir is None:
        from ...rescue.timeline.precomputed import DEFAULT_DATA_DIR  # numpy is loaded with any Timeline

        data_dir = DEFAULT_DATA_DIR
    root = Path(data_dir).resolve()
    path = (root / source.removeprefix("precomputed:")).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        return None
    return _file_info(str(path), path.stat().st_mtime_ns)


def precomputed_dataset_end(source: str, data_dir: Path | None = None) -> datetime | None:
    """Last sample time of the precomputed file behind a rescue ``source``; None if not known."""
    info = precomputed_file_info(source, data_dir)
    return None if info is None else info.last_sample_utc


def timeline_to_series(
    timeline: Timeline,
    *,
    max_gap_factor: float = DEFAULT_MAX_GAP_FACTOR,
    mission_end_utc: datetime | None = None,
    precomputed_data_dir: Path | None = None,
) -> ScientificTimeSeries:
    """Rescue ``Timeline`` (numpy arrays) -> validated ``ScientificTimeSeries``.

    Uses the same per-sample converters as the site-file adapter, so null/NaN, 360-degree
    azimuths, partial disks and inconsistencies are handled identically.

    Coverage ends at the last sample, unless ``mission_end_utc`` lies at most 1.5 steps after
    it. That is rescue's documented layout: ``Evaluator.evaluate_many`` passes
    ``max(1, round(duration * 24))`` hourly samples starting at landing, each the start of a
    one-step bin, and rescue states the timeline covers the mission. The last sample is then held
    for one step, capped at mission end, exactly as the canonical engine would hold the same sample
    inside the full dataset; so an integer-hour mission is fully covered, and the at most half step
    a fractional duration leaves beyond that has no sample and stays unknown. This happens only if
    the held time is actually covered by the source: always for the synthetic model; for a
    precomputed file only if its last sample is at or after the held time (``precomputed_data_dir``
    defaults to rescue's data directory). Otherwise the final bin stays unknown. Any other layout
    is left as is: coverage is never extended by more than one step or on a guess.

    A single sample is accepted only together with that one-step hold (a mission shorter than
    1.5 h); without it no coverage period can be defined.

    Unknown Earth visibility (NaN margin; rescue stores ``earth_visible=False`` there) is kept
    as unknown, never read as a blackout.
    """
    info = _classify_source(timeline.source)
    if not timeline.step_hours > 0:
        raise RescueCompatError(f"timeline.step_hours must be positive, got {timeline.step_hours}")
    margin = timeline.earth_el - timeline.earth_horizon
    columns: dict[str, list[Any]] = {
        "time_utc": [str(t) + "Z" for t in timeline.times.astype("datetime64[s]")],
        "sun_azimuth_deg": timeline.sun_az.tolist(),
        "sun_elevation_deg": timeline.sun_el.tolist(),
        "sun_horizon_deg": timeline.sun_horizon.tolist(),
        "sun_visible_fraction": timeline.sun_visible_fraction.tolist(),
        "earth_azimuth_deg": timeline.earth_az.tolist(),
        "earth_elevation_deg": timeline.earth_el.tolist(),
        "earth_horizon_deg": timeline.earth_horizon.tolist(),
        "earth_margin_deg": margin.tolist(),
        "earth_visible": [
            None if math.isnan(m) else bool(v)
            for v, m in zip(timeline.earth_visible.tolist(), margin.tolist(), strict=True)
        ],
    }
    site = timeline.site
    lengths = {name: len(col) for name, col in columns.items()}
    if len(set(lengths.values())) != 1:
        detail = ", ".join(f"{k}={v}" for k, v in lengths.items())
        raise RescueCompatError(f"timeline for site {site.id!r}: arrays have inconsistent lengths: {detail}")
    n = lengths["time_utc"]
    if n == 0:
        raise RescueCompatError(f"timeline for site {site.id!r} has no samples")
    try:
        times = parse_times(columns["time_utc"])
        samples = [
            {"time_utc": times[i], "sun": sun_observation(columns, i), "earth": earth_observation(columns, i)}
            for i in range(n)
        ]
    except SiteFileError as e:
        raise RescueCompatError(f"timeline for site {site.id!r}: {e}") from e
    lon = rescue_longitude(site.lon)

    step_s = timeline.step_hours * _HOUR_S
    sid = internal_site_id(site.id)
    file_info = None if info.is_synthetic else precomputed_file_info(timeline.source, precomputed_data_dir)
    coverage_end = times[-1]
    bin_note = "Coverage ends at the last sample (no bin layout assumed)."
    if mission_end_utc is not None:
        if mission_end_utc.tzinfo is None:
            raise RescueCompatError("mission_end_utc must be timezone-aware UTC")
        end = mission_end_utc.astimezone(UTC)
        step = timedelta(seconds=step_s)
        remainder = end - times[-1]
        if timedelta(0) < remainder <= step * _MAX_REMAINDER_STEPS:
            held_to = min(end, times[-1] + step)  # a sample never represents more than one step
            dataset_end = None if file_info is None else file_info.last_sample_utc
            if info.is_synthetic or (dataset_end is not None and held_to <= dataset_end):
                coverage_end = held_to
                how = "by one step" if held_to - times[-1] == step else f"by {held_to - times[-1]} (part of one step)"
                rest = "" if held_to == end else f"; the remaining {end - held_to} has no sample and stays unknown"
                bin_note = (
                    f"Coverage extended {how}: rescue's bin layout (round(duration / step) samples; the last one "
                    f"starts the final bin), and the source covers that time{rest}."
                )
            else:
                bin_note = (
                    "Final bin NOT extended: the source dataset is not known to cover it "
                    f"(dataset ends {dataset_end.isoformat() if dataset_end else 'unknown'}); that time is unknown."
                )
    if n == 1 and coverage_end <= times[0]:
        raise RescueCompatError(
            f"timeline for site {site.id!r} needs at least 2 samples to define a coverage period, got {n} "
            "(a single sample is accepted only as the one bin of a mission shorter than 1.5 steps)"
        )
    precision_note = ""
    if file_info is not None:
        precision_note = (
            f" Source file: generator_version={file_info.generator_version!r}, "
            f"sun_visible_fraction rounded to {file_info.fraction_decimals} decimals"
            " (meta.fraction_decimals, else the documented generator-version default)."
            if file_info.fraction_decimals is not None
            else f" Source file: generator_version={file_info.generator_version!r}; fraction precision not stated."
        )
    payload = {
        "dataset_id": internal_site_id(f"rescue_{sid}_{times[0]:%Y%m%dT%H%M}_{n}"),
        "site": {"id": sid, "name": site.name.strip() or site.id, "lat": site.lat, "lon": lon},
        "observer_height_m": None,  # not carried by rescue's Timeline
        "coverage_start_utc": times[0],
        "coverage_end_utc": coverage_end,
        "calculation_basis": CalculationBasis.TERRAIN_AWARE,
        "angle_type": info.angle_type,
        "sun_criterion": VisibilityCriterion.APPARENT_DISK,
        "earth_criterion": VisibilityCriterion.CENTER,
        "sampling": {"nominal_interval_s": step_s, "max_gap_s": step_s * max_gap_factor},
        "provenance": {
            "is_synthetic": info.is_synthetic,
            "ephemeris_source": info.ephemeris,
            "terrain_source": info.terrain,
            "generated_at_utc": None,
            "generator": f"app.rescue timeline provider -> {COMPAT_VERSION}",
            "notes": (
                f"Converted by {COMPAT_VERSION} from rescue Timeline (source={timeline.source!r}, "
                f"site.id={site.id!r}, site.lon={site.lon}). Rescue samples are hourly bins starting "
                f"at landing; the last sample starts the final bin. {bin_note} Rescue's Timeline has no "
                f"sun_visible flag: disk state comes from the rounded fraction.{precision_note}"
            ),
        },
        "fraction_decimals": None if file_info is None else file_info.fraction_decimals,
        "samples": samples,
    }
    try:
        return ScientificTimeSeries.model_validate(payload)
    except ValidationError as e:
        first = e.errors()[0]
        loc = ".".join(str(p) for p in first["loc"])
        raise RescueCompatError(
            f"timeline for site {site.id!r} violates the viability input contract at {loc}: {first['msg']}"
        ) from e


# --- ViabilityAssessment -> ViabilityResult -----------------------------------------------


def _to_rescue_unit(value: float, unit: Unit) -> float:
    if unit is Unit.SECONDS:
        return value / _HOUR_S
    if unit is Unit.PERCENT:
        return value / 100.0
    return value  # fraction, degrees


def conservative_value(metric: Metric, better: Better, worst_case: float | None, *, name: str) -> float | None:
    """Metric -> single float in rescue units, never optimistic.

    KNOWN -> value; BOUNDED -> unfavourable bound; UNAVAILABLE -> ``worst_case`` (rescue units);
    NOT_APPLICABLE -> None.
    """
    if metric.status is MetricStatus.KNOWN:
        assert metric.value is not None
        return _to_rescue_unit(metric.value, metric.unit)
    if metric.status is MetricStatus.BOUNDED:
        assert metric.lower is not None and metric.upper is not None
        return _to_rescue_unit(metric.lower if better == "more" else metric.upper, metric.unit)
    if metric.status is MetricStatus.UNAVAILABLE:
        if worst_case is None:
            raise RescueCompatError(f"metric {name} is unavailable and has no defined worst case")
        return worst_case
    return None


def _required(value: float | None, name: str) -> float:
    if value is None:
        raise RescueCompatError(f"metric {name} is not applicable but rescue requires a number")
    return value


def metrics_to_rescue(a: ViabilityAssessment) -> ViabilityMetrics:
    m, hours = a.metrics, a.evaluated_duration_s / _HOUR_S
    mean_fraction = _required(
        conservative_value(m.mean_solar_disk_fraction, "more", 0.0, name="mean_solar_disk_fraction"),
        "mean_solar_disk_fraction",
    )

    def first_event(metric: Metric, name: str) -> float | None:
        # NOT_APPLICABLE = the event never happens in range -> None (rescue's meaning).
        # BOUNDED -> earliest possible; UNAVAILABLE -> assume immediately (0 h).
        return conservative_value(metric, "more", 0.0, name=name)

    def clearance(metric: Metric, name: str) -> float | None:
        if metric.status is MetricStatus.UNAVAILABLE:
            return None  # rescue: None = no samples to average
        return conservative_value(metric, "more", None, name=name)

    return ViabilityMetrics(
        sunlight_fraction=mean_fraction,
        equivalent_sun_hours=mean_fraction * hours,
        longest_dark_gap_hours=_required(
            conservative_value(m.longest_continuous_darkness, "less", hours, name="longest_continuous_darkness"),
            "longest_continuous_darkness",
        ),
        earth_visibility_fraction=_required(
            conservative_value(m.earth_visible_percent, "more", 0.0, name="earth_visible_percent"),
            "earth_visible_percent",
        ),
        longest_comms_gap_hours=_required(
            conservative_value(m.longest_communication_blackout, "less", hours, name="longest_communication_blackout"),
            "longest_communication_blackout",
        ),
        initial_sun_hours=_required(
            conservative_value(m.initial_sunlight_duration, "more", 0.0, name="initial_sunlight_duration"),
            "initial_sunlight_duration",
        ),
        initial_comms_hours=_required(
            conservative_value(
                m.initial_earth_visibility_duration, "more", 0.0, name="initial_earth_visibility_duration"
            ),
            "initial_earth_visibility_duration",
        ),
        hours_to_first_sunset=first_event(m.time_to_first_sunset, "time_to_first_sunset"),
        hours_to_first_earthset=first_event(m.time_to_first_earthset, "time_to_first_earthset"),
        mean_sun_clearance_deg=clearance(m.mean_sun_clearance, "mean_sun_clearance"),
        mean_earth_clearance_deg=clearance(m.mean_earth_clearance, "mean_earth_clearance"),
        mean_solar_elevation_deg=_required(
            conservative_value(m.mean_solar_elevation, "more", None, name="mean_solar_elevation"),
            "mean_solar_elevation",
        ),
    )


# canonical constraint -> (rescue requirements field, rescue unit, better direction)
CONSTRAINT_TO_RESCUE: Final[dict[ConstraintId, tuple[str, str, Better]]] = {
    ConstraintId.MIN_MEAN_SOLAR_DISK_FRACTION: ("min_sunlight_fraction", "fraction", "more"),
    ConstraintId.MAX_CONTINUOUS_DARKNESS: ("battery_hours", "h", "less"),
    ConstraintId.MIN_EARTH_VISIBILITY_PERCENT: ("min_earth_visibility_fraction", "fraction", "more"),
    ConstraintId.MAX_COMMUNICATION_BLACKOUT: ("max_comms_gap_hours", "h", "less"),
    ConstraintId.MIN_INITIAL_SUNLIGHT: ("min_initial_sun_hours", "h", "more"),
    ConstraintId.MIN_INITIAL_EARTH_VISIBILITY: ("min_initial_comms_hours", "h", "more"),
}


def constraint_to_violation(c: ConstraintEvaluation, mission_hours: float) -> Violation:
    if c.constraint_id not in CONSTRAINT_TO_RESCUE:
        raise RescueCompatError(f"constraint {c.constraint_id.value!r} has no rescue requirement field")
    field, unit, better = CONSTRAINT_TO_RESCUE[c.constraint_id]
    assert c.threshold is not None  # FAIL / UNKNOWN always carry a threshold
    required = _to_rescue_unit(c.threshold, c.unit)
    worst = 0.0 if better == "more" else (mission_hours if unit == "h" else 1.0)
    actual = _required(conservative_value(c.measured, better, worst, name=c.constraint_id.value), c.constraint_id.value)
    shortfall = max(0.0, required - actual if better == "more" else actual - required)
    relative = shortfall / required if required else 0.0
    unknown = c.status is ConstraintStatus.UNKNOWN
    prefix = "UNKNOWN (incomplete data; worst case shown): " if unknown else ""
    return Violation(
        constraint=field,
        required=required,
        actual=actual,
        unit=unit,
        shortfall=shortfall,
        relative_shortfall=relative,
        message=prefix + c.message,
        is_unknown=unknown,
    )


# Rescue's requirement order (its CHECKS table follows the MissionRequirements field order).
_RESCUE_FIELD_ORDER: Final = {name: i for i, name in enumerate(RescueRequirements.model_fields)}


def assessment_to_result(assessment: ViabilityAssessment, scenario: Scenario, data_source: str) -> ViabilityResult:
    """Canonical assessment -> rescue ``ViabilityResult`` (see module docstring)."""
    hours = assessment.evaluated_duration_s / _HOUR_S
    violations = sorted(
        (
            constraint_to_violation(c, hours)
            for c in assessment.constraints
            if c.status in (ConstraintStatus.FAIL, ConstraintStatus.UNKNOWN)
        ),
        key=lambda v: _RESCUE_FIELD_ORDER[v.constraint],
    )
    eligibility = assessment.eligibility
    passes = eligibility is Eligibility.PASS
    # Guaranteed by derive_eligibility; checked so the shared invariants can never be broken:
    # passes == no violations; UNKNOWN has unknown violations and no FAIL ones.
    if passes == bool(violations):
        raise RescueCompatError("eligibility and violations disagree")
    if eligibility is Eligibility.UNKNOWN and not all(v.is_unknown for v in violations):
        raise RescueCompatError("UNKNOWN eligibility with a decided failure")
    return ViabilityResult(
        scenario=scenario,
        passes=passes,
        eligibility=eligibility.value,
        score=assessment.score.score,  # None = not scored
        metrics=metrics_to_rescue(assessment),
        violations=violations,
        source=SOURCE,
        data_source=data_source,
    )


# --- rescue-facing entry points -----------------------------------------------------------


def evaluate_timeline_detailed(
    scenario: Scenario,
    timeline: Timeline,
    *,
    engine: Engine = evaluate_scenario,
    precomputed_data_dir: Path | None = None,
) -> tuple[ViabilityResult, ViabilityAssessment]:
    """Rescue result plus the full canonical assessment (with PASS/FAIL/UNKNOWN intact)."""
    mission = scenario_to_mission(scenario)
    series = timeline_to_series(
        timeline, mission_end_utc=mission.mission_end_utc, precomputed_data_dir=precomputed_data_dir
    )
    assessment = engine(mission, series)
    return assessment_to_result(assessment, scenario, timeline.source), assessment


def evaluate_timeline(
    scenario: Scenario,
    timeline: Timeline,
    *,
    engine: Engine = evaluate_scenario,
    precomputed_data_dir: Path | None = None,
) -> ViabilityResult:
    """Drop-in for rescue's ``evaluate_timeline`` (shared contract, docs/interfaces.md).

    Raises ``RescueCompatError`` for input that cannot be converted faithfully (e.g. a timeline
    source that is neither ``precomputed:*`` nor ``synthetic*``), never a guessed result.
    """
    return evaluate_timeline_detailed(scenario, timeline, engine=engine, precomputed_data_dir=precomputed_data_dir)[0]


def make_evaluate_fn(
    engine: Engine = evaluate_scenario, *, precomputed_data_dir: Path | None = None
) -> Callable[[Scenario, Timeline], ViabilityResult]:
    """A callable with rescue's ``EvaluateFn`` signature, e.g. ``Evaluator(evaluate=make_evaluate_fn())``.

    Pass ``precomputed_data_dir`` when rescue's provider reads site files from a non-default
    directory, so the final-bin coverage check finds the same files.
    """

    def evaluate(scenario: Scenario, timeline: Timeline) -> ViabilityResult:
        return evaluate_timeline(scenario, timeline, engine=engine, precomputed_data_dir=precomputed_data_dir)

    return evaluate


__all__ = [
    "COMPAT_VERSION",
    "CONSTRAINT_TO_RESCUE",
    "SOURCE",
    "PrecomputedFileInfo",
    "RescueCompatError",
    "assessment_to_result",
    "evaluate_timeline",
    "evaluate_timeline_detailed",
    "internal_site_id",
    "make_evaluate_fn",
    "metrics_to_rescue",
    "precomputed_dataset_end",
    "precomputed_file_info",
    "requirements_to_canonical",
    "rescue_longitude",
    "scenario_to_mission",
    "timeline_to_series",
]
