"""Mission scenario, spacecraft configuration, hard requirements and soft preferences.

Supplied by the UI (Member 3), comparison (Member 4) and rescue/optimisation (Member 5).
Every operational limit is optional: ``None`` means "not a requirement for this
scenario" and the corresponding constraint evaluates to NOT_APPLICABLE. Nothing here
assumes solar power or a direct-to-Earth link.
"""

from __future__ import annotations

import hashlib
import json
import math
from datetime import timedelta
from typing import Final, Self

from pydantic import Field, model_validator

from .conventions import (
    MAX_MISSION_DURATION_S,
    ContractModel,
    DurationS,
    ElevationDeg,
    Fraction,
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
from .enums import CommunicationMode, PowerSource, ScoreComponent, ScoreComponentStatus, UnknownDataPolicy

# Score components this engine version cannot evaluate. Clearance requirements are unsupported
# (docs §5c), and the time-mean clearance is never used as a stand-in, so CLEARANCE_MARGIN is
# never part of a score whatever its weight.
UNSUPPORTED_SCORE_COMPONENTS: Final = frozenset({ScoreComponent.CLEARANCE_MARGIN})

# Score components that need a spacecraft outage limit as their reference (docs §5e, D2).
_LIMIT_FIELD: Final = {
    ScoreComponent.DARKNESS_MARGIN: "max_continuous_darkness_s",
    ScoreComponent.BLACKOUT_MARGIN: "max_communication_blackout_s",
}

# Version of the configuration-key payload below; bump if its content changes.
CONFIGURATION_KEY_VERSION: Final = 1


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
    # Solar-array usability threshold on the visible solar-disk fraction. When set, a sample is
    # "power-lit" iff visible_fraction > 0 and visible_fraction >= this value; otherwise it
    # counts as power-dark for darkness / initial-sunlight metrics. The fraction itself is
    # always preserved. None = power-lit follows the Sun visibility state (Phase 2 rule).
    solar_power_min_disk_fraction: Fraction | None = None


class MissionRequirements(ContractModel):
    """Additional hard (mandatory) requirements. Any FAIL makes the scenario ineligible."""

    min_sunlight_percent: Percent | None = None  # share of TIME with the Sun visible
    min_earth_visibility_percent: Percent | None = None
    min_simultaneous_percent: Percent | None = None
    # Time-averaged visible solar-disk fraction (0..1), i.e. mean of visible_fraction over the
    # mission. Distinct from min_sunlight_percent (share of time sunlit).
    min_mean_solar_disk_fraction: Fraction | None = None
    # Continuous power-lit time / Earth visibility required from mission start (landing).
    min_initial_sunlight_s: DurationS | None = None
    min_initial_earth_visibility_s: DurationS | None = None
    # Minimum body elevation above the terrain horizon (e.g. antenna mask angle), applied
    # whenever the body is counted as visible. None = no clearance requirement.
    min_sun_clearance_deg: ElevationDeg | None = None
    min_earth_clearance_deg: ElevationDeg | None = None
    # Only REPORT_UNKNOWN has an effect; WORST_CASE is deprecated and accepted for compatibility.
    unknown_data_policy: UnknownDataPolicy = UnknownDataPolicy.REPORT_UNKNOWN


class RankingPreferences(ContractModel):
    """Soft preferences: relative weights for the desirability score (Phase 5).

    Weights are relative: they are normalised over the scenario's ACTIVE components
    (``MissionScenario.effective_score_weights``), which depend on configuration only. They only
    order scenarios; they can never turn a failed hard requirement into an eligible scenario.

    ``clearance_margin_weight`` defaults to 0 because clearance scoring is not supported yet
    (docs §5c, §5e). A user-specified positive value is kept as given, but that component stays
    UNSUPPORTED and does not enter the score.
    """

    sunlight_weight: NonNegativeFloat = 1.0
    earth_visibility_weight: NonNegativeFloat = 1.0
    simultaneous_weight: NonNegativeFloat = 0.0
    darkness_margin_weight: NonNegativeFloat = 1.0
    blackout_margin_weight: NonNegativeFloat = 1.0
    clearance_margin_weight: NonNegativeFloat = 0.0

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

    # --- Phase 5 scoring configuration (docs §5e). Configuration only: never measurements. ---

    def score_component_status(self, component: ScoreComponent) -> ScoreComponentStatus:
        """Whether ``component`` takes part in this scenario's score, from configuration alone.

        Order: UNSUPPORTED (engine cannot evaluate it), NOT_CONFIGURED (its outage limit is not
        set), ZERO_WEIGHT (preference weight 0), otherwise ACTIVE.
        """
        if component in UNSUPPORTED_SCORE_COMPONENTS:
            return ScoreComponentStatus.UNSUPPORTED
        limit_field = _LIMIT_FIELD.get(component)
        if limit_field is not None and getattr(self.spacecraft, limit_field) is None:
            return ScoreComponentStatus.NOT_CONFIGURED
        if self.preferences.weights()[component] == 0.0:
            return ScoreComponentStatus.ZERO_WEIGHT
        return ScoreComponentStatus.ACTIVE

    def effective_score_weights(self) -> dict[ScoreComponent, float]:
        """Normalised weights: ``w_c / sum(w over ACTIVE)`` for ACTIVE components, 0 otherwise.

        Every component appears, in ``ScoreComponent`` order. All zeros when no component is
        ACTIVE (the score is then NO_SCORABLE_COMPONENTS). Missing measurements never change
        these weights; they widen the score bounds instead. Weights are scaled by their maximum
        before summing, so very large declared weights cannot overflow.
        """
        declared = self.preferences.weights()
        active = [c for c in ScoreComponent if self.score_component_status(c) is ScoreComponentStatus.ACTIVE]
        if not active:
            return dict.fromkeys(ScoreComponent, 0.0)
        top = max(declared[c] for c in active)
        scaled = {c: declared[c] / top for c in active}
        total = math.fsum(scaled.values())
        return {c: (scaled[c] / total if c in scaled else 0.0) for c in ScoreComponent}

    def configuration_key(self) -> str:
        """Deterministic identity of what a score is measured against (strict comparability, D7).

        ``"sha256:"`` + the SHA-256 of canonical JSON (sorted keys, no whitespace, no NaN) of:
        the key version; the mission duration in integer microseconds; the spacecraft's power
        source, communication mode, both outage limits and ``solar_power_min_disk_fraction``;
        and every ``MissionRequirements`` field except the inert ``unknown_data_policy``. Numbers
        are written as floats (so ``50`` and ``50.0`` agree, and ``-0.0`` becomes ``0.0``).
        Scenario id, name, site, start time, spacecraft name and preferences are not part of it.
        """

        def number(value: float | None) -> float | None:
            return None if value is None else float(value) + 0.0

        sc = self.spacecraft
        payload = {
            "key_version": CONFIGURATION_KEY_VERSION,
            "mission_duration_us": (self.mission_end_utc - self.mission_start_utc) // timedelta(microseconds=1),
            "spacecraft": {
                "power_source": sc.power_source.value,
                "communication_mode": sc.communication_mode.value,
                "max_continuous_darkness_s": number(sc.max_continuous_darkness_s),
                "max_communication_blackout_s": number(sc.max_communication_blackout_s),
                "solar_power_min_disk_fraction": number(sc.solar_power_min_disk_fraction),
            },
            "requirements": {
                name: number(getattr(self.requirements, name))
                for name in MissionRequirements.model_fields
                if name != "unknown_data_policy"
            },
        }
        text = json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False)
        return "sha256:" + hashlib.sha256(text.encode("ascii")).hexdigest()
