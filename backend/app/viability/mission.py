"""Mission scenario, spacecraft configuration, hard requirements and soft preferences.

Supplied by the UI (Member 3), comparison (Member 4) and rescue/optimisation (Member 5).
Every operational limit is optional: ``None`` means "not a requirement for this
scenario" and the corresponding constraint evaluates to NOT_APPLICABLE. Nothing here
assumes solar power or a direct-to-Earth link.
"""

from __future__ import annotations

from typing import Self

from pydantic import Field, model_validator

from .conventions import (
    MAX_MISSION_DURATION_S,
    ContractModel,
    ElevationDeg,
    Identifier,
    LatitudeDeg,
    LongitudeDeg,
    NonEmptyStr,
    NonNegativeFloat,
    Percent,
    PositiveDurationS,
    StrictFloat,
    UTCDatetime,
)
from .enums import CommunicationMode, PowerSource, ScoreComponent, UnknownDataPolicy


class LandingSite(ContractModel):
    """A landing location. See conventions.py for the coordinate frame.

    Field names match the team's shared ``Site`` draft (docs/interfaces.md,
    frontend/src/types.ts), so a frontend Site object validates as a LandingSite.
    """

    id: Identifier
    name: NonEmptyStr
    lat: LatitudeDeg  # degrees, selenographic, negative = south
    lon: LongitudeDeg  # degrees east, [-180, 180]
    # Height of the surface above the 1737.4 km reference sphere, if known.
    surface_height_m: StrictFloat | None = None


class SpacecraftConfiguration(ContractModel):
    """Physical capabilities that translate into operational limits."""

    name: NonEmptyStr
    power_source: PowerSource
    communication_mode: CommunicationMode
    # Longest continuous darkness the energy storage can survive. None = no limit
    # (e.g. radioisotope power) or not yet specified -> constraint NOT_APPLICABLE.
    max_continuous_darkness_s: PositiveDurationS | None = None
    # Longest tolerable gap in direct-to-Earth line of sight. None = no limit
    # (e.g. relay-only) -> constraint NOT_APPLICABLE.
    max_communication_blackout_s: PositiveDurationS | None = None


class MissionRequirements(ContractModel):
    """Additional hard (mandatory) requirements. Any FAIL makes the scenario ineligible."""

    min_sunlight_percent: Percent | None = None
    min_earth_visibility_percent: Percent | None = None
    min_simultaneous_percent: Percent | None = None
    # Minimum body elevation above the terrain horizon (e.g. antenna mask angle), applied
    # whenever the body is counted as visible. None = no clearance requirement.
    min_sun_clearance_deg: ElevationDeg | None = None
    min_earth_clearance_deg: ElevationDeg | None = None
    unknown_data_policy: UnknownDataPolicy = UnknownDataPolicy.REPORT_UNKNOWN


class RankingPreferences(ContractModel):
    """Soft preferences: relative weights for the desirability score (Phase 5).

    Weights are relative (normalised by their sum). They only order scenarios; they can
    never turn a failed hard requirement into an eligible scenario.
    """

    sunlight_weight: NonNegativeFloat = 1.0
    earth_visibility_weight: NonNegativeFloat = 1.0
    simultaneous_weight: NonNegativeFloat = 0.0
    darkness_margin_weight: NonNegativeFloat = 1.0
    blackout_margin_weight: NonNegativeFloat = 1.0
    clearance_margin_weight: NonNegativeFloat = 0.5

    @model_validator(mode="after")
    def _at_least_one_weight(self) -> Self:
        if sum(self.weights().values()) <= 0.0:
            raise ValueError("at least one ranking weight must be greater than zero")
        return self

    def weights(self) -> dict[ScoreComponent, float]:
        return {
            ScoreComponent.SUNLIGHT: self.sunlight_weight,
            ScoreComponent.EARTH_VISIBILITY: self.earth_visibility_weight,
            ScoreComponent.SIMULTANEOUS: self.simultaneous_weight,
            ScoreComponent.DARKNESS_MARGIN: self.darkness_margin_weight,
            ScoreComponent.BLACKOUT_MARGIN: self.blackout_margin_weight,
            ScoreComponent.CLEARANCE_MARGIN: self.clearance_margin_weight,
        }


class MissionScenario(ContractModel):
    """One site + time window + spacecraft + requirements to evaluate."""

    scenario_id: Identifier
    name: NonEmptyStr | None = None
    site: LandingSite
    mission_start_utc: UTCDatetime
    mission_end_utc: UTCDatetime
    spacecraft: SpacecraftConfiguration
    requirements: MissionRequirements = Field(default_factory=MissionRequirements)
    preferences: RankingPreferences = Field(default_factory=RankingPreferences)

    @model_validator(mode="after")
    def _valid_window(self) -> Self:
        if self.mission_end_utc <= self.mission_start_utc:
            raise ValueError("mission_end_utc must be after mission_start_utc")
        if self.duration_s > MAX_MISSION_DURATION_S:
            raise ValueError(f"mission duration exceeds sanity cap of {MAX_MISSION_DURATION_S:.0f} s")
        return self

    @property
    def duration_s(self) -> float:
        return (self.mission_end_utc - self.mission_start_utc).total_seconds()
