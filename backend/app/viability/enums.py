"""Enumerations shared by the viability input and output contracts.

All enums are ``StrEnum`` so they serialize to stable lowercase strings in JSON.
"""

from __future__ import annotations

from enum import StrEnum


class Body(StrEnum):
    SUN = "sun"
    EARTH = "earth"


class VisibilityState(StrEnum):
    """Per-sample visibility of a body, as reported by the scientific data engine.

    ``unknown`` means the state could not be determined (missing ephemeris, missing
    terrain, failed calculation). It must never be read as ``not_visible``.
    """

    VISIBLE = "visible"
    PARTIAL = "partial"  # only allowed with VisibilityCriterion.APPARENT_DISK
    NOT_VISIBLE = "not_visible"
    UNKNOWN = "unknown"


class VisibilityCriterion(StrEnum):
    """What a VISIBLE/NOT_VISIBLE state means geometrically."""

    CENTER = "center"  # body centre above the (terrain or geometric) horizon; no PARTIAL
    APPARENT_DISK = "apparent_disk"  # VISIBLE = whole disk, PARTIAL = some, NOT_VISIBLE = none


class CalculationBasis(StrEnum):
    TERRAIN_AWARE = "terrain_aware"  # horizon = local terrain horizon at the body azimuth
    GEOMETRIC_ONLY = "geometric_only"  # horizon = local horizontal plane (0 deg); no terrain


class AngleType(StrEnum):
    """Apparent includes light-time and stellar aberration (no refraction: no atmosphere)."""

    APPARENT = "apparent"
    GEOMETRIC = "geometric"


class PowerSource(StrEnum):
    SOLAR = "solar"
    RADIOISOTOPE = "radioisotope"
    BATTERY_ONLY = "battery_only"
    HYBRID = "hybrid"
    OTHER = "other"


class CommunicationMode(StrEnum):
    DIRECT_TO_EARTH = "direct_to_earth"
    RELAY = "relay"
    DIRECT_AND_RELAY = "direct_and_relay"
    NONE = "none"


class UnknownDataPolicy(StrEnum):
    """How constraint evaluation treats UNKNOWN samples. There is deliberately no
    optimistic option: unknown data can never make a constraint pass."""

    REPORT_UNKNOWN = "report_unknown"  # constraint is UNKNOWN unless decidable from bounds
    WORST_CASE = "worst_case"  # unknown counts as dark / blacked-out


class Eligibility(StrEnum):
    """Overall hard-constraint verdict. Independent of score and risk level."""

    PASS = "pass"
    FAIL = "fail"
    UNKNOWN = "unknown"


class ConstraintStatus(StrEnum):
    PASS = "pass"
    FAIL = "fail"
    UNKNOWN = "unknown"
    NOT_APPLICABLE = "not_applicable"  # constraint not configured for this scenario


class ConstraintId(StrEnum):
    MAX_CONTINUOUS_DARKNESS = "max_continuous_darkness"
    MAX_COMMUNICATION_BLACKOUT = "max_communication_blackout"
    MIN_SUNLIGHT_PERCENT = "min_sunlight_percent"
    MIN_EARTH_VISIBILITY_PERCENT = "min_earth_visibility_percent"
    MIN_SIMULTANEOUS_PERCENT = "min_simultaneous_percent"
    MIN_SUN_CLEARANCE = "min_sun_clearance"
    MIN_EARTH_CLEARANCE = "min_earth_clearance"
    MIN_MEAN_SOLAR_DISK_FRACTION = "min_mean_solar_disk_fraction"
    MIN_INITIAL_SUNLIGHT = "min_initial_sunlight"
    MIN_INITIAL_EARTH_VISIBILITY = "min_initial_earth_visibility"


class MetricStatus(StrEnum):
    KNOWN = "known"  # exact value from fully known data
    BOUNDED = "bounded"  # data partly unknown; true value lies in [lower, upper]
    UNAVAILABLE = "unavailable"  # cannot be calculated from the supplied data
    NOT_APPLICABLE = "not_applicable"


class Unit(StrEnum):
    SECONDS = "s"
    DEGREES = "deg"
    PERCENT = "percent"
    FRACTION = "fraction"


class WindowKind(StrEnum):
    SUNLIGHT = "sunlight"
    DARKNESS = "darkness"
    EARTH_VISIBLE = "earth_visible"
    COMMUNICATION_BLACKOUT = "communication_blackout"
    SIMULTANEOUS_SUN_EARTH = "simultaneous_sun_earth"
    UNKNOWN_DATA = "unknown_data"


class RiskLevel(StrEnum):
    """Rule-based categories, not probabilities. Ordered low < moderate < high."""

    LOW = "low"
    MODERATE = "moderate"
    HIGH = "high"
    UNKNOWN = "unknown"


class ScoreComponent(StrEnum):
    SUNLIGHT = "sunlight"
    EARTH_VISIBILITY = "earth_visibility"
    SIMULTANEOUS = "simultaneous"
    DARKNESS_MARGIN = "darkness_margin"
    BLACKOUT_MARGIN = "blackout_margin"
    CLEARANCE_MARGIN = "clearance_margin"


class ExplanationCategory(StrEnum):
    SUMMARY = "summary"
    CONSTRAINT = "constraint"
    MARGIN = "margin"
    RISK = "risk"
    DATA_QUALITY = "data_quality"
    LIMITATION = "limitation"


class Severity(StrEnum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"
