# API models. Mirrors docs/interfaces.md and frontend/src/types.ts. Keep all three in sync.
from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class Site(BaseModel):
    """A location. Shared by every feature (e.g. inside a rescue Scenario), so keep it minimal."""

    id: str
    name: str
    lat: float  # degrees, negative = south
    lon: float  # degrees east


# ---------------------------------------------------------------------------
# Data engine (Andrew): site info, horizon, timelines, terrain.
# ---------------------------------------------------------------------------


class SiteSummaryStats(BaseModel):
    """Percentages are over hours where the answer is known (None if nothing is known)."""

    sunlit_pct: float | None
    mean_sun_fraction_pct: float | None
    earth_visible_pct: float | None
    horizon_min_deg: float | None
    horizon_max_deg: float | None
    unknown_horizon_pct: float = 0  # directions with missing terrain data
    unknown_hours_pct: float = 0  # hours where Sun or Earth visibility is unknown


class SiteInfo(Site):
    """A Site plus what the data engine knows about it (returned by /api/sites)."""

    source: str = ""
    kind: str = "custom"  # artemis | control | apollo | clps | international | custom
    approximate: bool = False  # coordinates are a region estimate, not a published point
    # Artemis sites: NASA's list naming the region, "2024" (current 9), "2022" (original 13 only) or
    # "unconfirmed" (see engine/sites.py). None for other sites.
    artemis_list: str | None = None
    ground_height_m: float  # relative to the 1737.4 km reference sphere
    observer_height_m: float
    summary: SiteSummaryStats
    data_start_utc: str
    data_stop_utc: str


class CustomSiteRequest(BaseModel):
    lat: float = Field(ge=-90, le=90, description="Anywhere on the Moon (degrees, negative = south)")
    lon: float = Field(ge=-360, le=360)
    name: str | None = None


class Horizon(BaseModel):
    azimuth_deg: list[float]  # clockwise from north
    elevation_deg: list[float | None]  # terrain horizon elevation per azimuth (None = unknown)
    distance_m: list[float | None]  # how far away the blocking terrain is (None = unknown)
    ground_height_m: float
    observer_height_m: float


# None in the fields below means "unknown": terrain data is missing in that direction
# (only possible for custom sites). Curated sites are always fully known.


class BodyState(BaseModel):
    azimuth_deg: float
    elevation_deg: float
    horizon_deg: float | None  # terrain horizon elevation at this azimuth


class SunState(BodyState):
    visible_fraction: float | None  # portion of the solar disk above terrain, 0..1
    visible: bool | None = None  # any of the disk above terrain (authoritative, unlike fraction > 0)
    angular_radius_deg: float | None = None  # apparent solar radius used for the disk


class EarthState(BodyState):
    visible: bool | None
    margin_deg: float | None  # elevation_deg - horizon_deg


class TimelineStep(BaseModel):
    time_utc: str
    sun: SunState
    earth: EarthState


class SiteStatus(TimelineStep):
    """Conditions at one moment plus upcoming events (null = not within the data range)."""

    next_sunset_utc: str | None
    next_sunrise_utc: str | None
    next_earthset_utc: str | None
    next_earthrise_utc: str | None


class TerrainGrid(BaseModel):
    """Height grid in the site's local frame: rows run north -> south, columns west -> east.

    For 3D: x = east, z = -north, y = height. Then Sun/Earth azimuth (clockwise from north)
    maps directly onto the scene.
    """

    size: int  # grid is size x size
    half_width_m: float  # grid spans -half..+half metres east and north of the site
    spacing_m: float
    site_height_m: float
    min_height_m: float
    max_height_m: float
    heights_m: list[float]  # row-major, size*size, relative to the reference sphere


# ---------------------------------------------------------------------------
# Mission scenario + viability result. Proposed by Member 5 (rescue) as the contract
# between viability (Brandon), rescue, comparison and the UI; agree changes with them.
# Rescue-only request/response models live in app/rescue/schemas.py.
# ---------------------------------------------------------------------------


def to_utc(dt: datetime) -> datetime:
    """Convert a timezone-aware datetime to UTC. Times without a timezone are rejected (team
    decision): silently assuming UTC could shift a mission by hours and change its results."""
    if dt.tzinfo is None or dt.utcoffset() is None:
        raise ValueError("landing_utc must include a timezone, e.g. '2027-01-07T00:00:00Z' (UTC)")
    return dt.astimezone(timezone.utc)


class MissionRequirements(BaseModel):
    """Constraints a scenario must satisfy. min_* are lower bounds; battery_hours and
    max_* are upper bounds on outages. Fractions are 0..1."""

    min_sunlight_fraction: float = Field(0.5, ge=0, le=1, description="Mean fraction of the solar disk visible over the mission")
    battery_hours: float = Field(50, gt=0, description="Longest the lander can survive with panels in darkness")
    panel_threshold: float = Field(0.25, ge=0, le=1, description="Visible solar-disk fraction below which panels count as dark")
    min_earth_visibility_fraction: float = Field(0.4, ge=0, le=1, description="Fraction of mission time Earth must be above the terrain")
    max_comms_gap_hours: float = Field(96, gt=0, description="Longest allowed direct-to-Earth blackout")
    min_initial_sun_hours: float = Field(24, ge=0, description="Continuous sunlight required right after landing")
    min_initial_comms_hours: float = Field(12, ge=0, description="Continuous Earth visibility required right after landing")


class Scenario(BaseModel):
    """One landing plan: where, when, for how long, under which requirements."""

    site: Site
    landing_utc: datetime
    duration_days: float = Field(7, gt=0, le=365)
    requirements: MissionRequirements = Field(default_factory=MissionRequirements)

    @field_validator("landing_utc")
    @classmethod
    def _utc(cls, v: datetime) -> datetime:
        return to_utc(v)

    @field_validator("site")
    @classmethod
    def _site_on_moon(cls, v: Site) -> Site:
        if not -90 <= v.lat <= 90:
            raise ValueError("site.lat must be between -90 and 90")
        return v


class Violation(BaseModel):
    constraint: str = Field(description="Name of the MissionRequirements field that was violated")
    required: float
    actual: float
    unit: str  # "fraction" or "h"
    shortfall: float = Field(description="How far the actual value misses the requirement, in `unit` (>= 0)")
    relative_shortfall: float = Field(description="shortfall / required (0.2 = misses by 20%)")
    message: str
    is_unknown: bool = Field(False, description=(
        "True when the check could not be decided because data is missing (not a real failure). "
        "Relaxing the requirement would not fix it, so rescue gives no loosening advice for it."))


class ViabilityMetrics(BaseModel):
    sunlight_fraction: float
    equivalent_sun_hours: float
    longest_dark_gap_hours: float
    earth_visibility_fraction: float
    longest_comms_gap_hours: float
    initial_sun_hours: float = Field(description="Continuous sunlight from landing until the first sunset")
    initial_comms_hours: float = Field(description="Continuous Earth visibility from landing until the first Earthset")
    hours_to_first_sunset: float | None = Field(description="None if the Sun never sets during the mission")
    hours_to_first_earthset: float | None = Field(description="None if Earth never sets during the mission")
    mean_sun_clearance_deg: float | None = Field(description="Mean height of the Sun's centre above the terrain while it is up")
    mean_earth_clearance_deg: float | None = Field(description="Mean Earth margin_deg while Earth is up")
    mean_solar_elevation_deg: float


Eligibility = Literal["pass", "fail", "unknown"]
MarginStatus = Literal[
    "comfortable",
    "narrow",
    "at_threshold",
    "negative",
    "uncertain",
    "unsupported",
    "not_applicable",
]
HeadroomStatus = Literal[
    "comfortable",
    "limited",
    "at_threshold",
    "failed",
    "uncertain",
    "vacuous",
]


class MarginMetricValue(BaseModel):
    status: Literal["known", "bounded", "unavailable", "not_applicable"]
    unit: str
    value: float | None = None
    lower: float | None = None
    upper: float | None = None
    reason: str | None = None


class CanonicalMarginItem(BaseModel):
    id: str
    requirement_field: str | None = None
    name: str
    short_label: str
    comparison: Literal["at_least", "at_most"] | None = None
    unit: str
    threshold: float | None = None
    measured: MarginMetricValue
    margin: MarginMetricValue
    relative_margin: MarginMetricValue | None = None
    margin_class: MarginStatus
    narrow_reason: str | None = None
    description: str


class InitialWindowSummary(BaseModel):
    kind: Literal["sunlight", "earth"]
    duration: MarginMetricValue
    first_end_hours: MarginMetricValue
    requirement_hours: float | None = None
    headroom: CanonicalMarginItem | None = None
    summary_text: str


class ClosestRequirementInfo(BaseModel):
    constraint_id: str
    requirement_field: str | None = None
    label: str
    margin_class: MarginStatus
    unit: str
    headroom_text: str
    relative_pct: float | None = None
    summary_text: str


class OperationalHeadroom(BaseModel):
    status: HeadroomStatus
    qualified_verdict: str
    limited_constraints: list[str] = Field(default_factory=list)
    darkness: CanonicalMarginItem | None = None
    communication_blackout: CanonicalMarginItem | None = None
    initial_sunlight: InitialWindowSummary
    initial_earth: InitialWindowSummary
    closest_constraint: ClosestRequirementInfo | None = None
    constraints: list[CanonicalMarginItem] = Field(default_factory=list)
    screening_note: str


class ViabilityResult(BaseModel):
    scenario: Scenario
    passes: bool = Field(description="True only when eligibility is 'pass'. Kept for backward compatibility")
    eligibility: Eligibility | None = Field(None, description=(
        "'pass' / 'fail' / 'unknown' (= could not be decided, e.g. missing data). None = not provided by the "
        "evaluator; then read `passes` (True = pass, False = fail)"))
    score: float | None = Field(None, ge=0, le=100, description="0-100, or None if the scenario was not scored")
    metrics: ViabilityMetrics
    violations: list[Violation]
    headroom: OperationalHeadroom | None = Field(
        None,
        description="Canonical operational headroom and initial window context computed by the viability engine",
    )
    source: str = Field(description="Which viability implementation produced this result")
    data_source: str = Field(description="Which timeline source the metrics came from")

    @property
    def verdict(self) -> Eligibility:
        """Eligibility, falling back to `passes` for evaluators that don't report it."""
        return self.eligibility or ("pass" if self.passes else "fail")

    @property
    def score_or_zero(self) -> float:
        return 0.0 if self.score is None else self.score
