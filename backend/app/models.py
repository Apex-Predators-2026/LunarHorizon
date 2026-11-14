# Mirrors docs/interfaces.md and frontend/src/types.ts. Keep all three in sync.
from pydantic import BaseModel


class Site(BaseModel):
    id: str
    name: str
    lat: float  # degrees, negative = south
    lon: float  # degrees east


class BodyState(BaseModel):
    azimuth_deg: float
    elevation_deg: float
    horizon_deg: float  # terrain horizon elevation at this azimuth


class SunState(BodyState):
    visible_fraction: float  # portion of the solar disk above terrain, 0..1


class EarthState(BodyState):
    visible: bool
    margin_deg: float  # elevation_deg - horizon_deg


class TimelineStep(BaseModel):
    time_utc: str
    sun: SunState
    earth: EarthState


# ---------------------------------------------------------------------------
# Mission scenario + viability result. Proposed by Member 5 (rescue) as the contract
# between viability (Brandon), rescue, comparison and the UI; agree changes with them.
# Rescue-only request/response models live in app/rescue/schemas.py.
# ---------------------------------------------------------------------------
from datetime import datetime, timezone  # noqa: E402

from pydantic import Field, field_validator  # noqa: E402


def to_utc(dt: datetime) -> datetime:
    """Treat naive datetimes as UTC and convert aware ones to UTC."""
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


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


class ViabilityResult(BaseModel):
    scenario: Scenario
    passes: bool
    score: float = Field(ge=0, le=100)
    metrics: ViabilityMetrics
    violations: list[Violation]
    source: str = Field(description="Which viability implementation produced this result")
    data_source: str = Field(description="Which timeline source the metrics came from")
