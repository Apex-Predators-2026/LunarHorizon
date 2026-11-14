"""PROPOSED scientific input contract (Member 1 -> viability engine). Status: draft for review.

One ``ScientificTimeSeries`` describes Sun and Earth geometry at one site over a period.
The viability engine consumes these values; it never computes ephemerides or terrain.

Key rules (enforced by validators below):

* Samples are instantaneous, strictly increasing in time, and lie inside the coverage period.
* Missing values are ``None`` and missing determinations are ``VisibilityState.UNKNOWN``.
  A terrain horizon is never assumed to be 0 deg when terrain data is missing.
* A definite state (visible / partial / not_visible) must be backed by the angles that
  decided it: elevation always, plus azimuth and terrain horizon when terrain-aware.
* Geometric-only series carry no terrain horizons (the reference plane is the local
  horizontal by definition, recorded via ``calculation_basis``).
* States must agree with the angles: a body whose centre clears the horizon cannot be
  NOT_VISIBLE, and one whose centre is below it cannot be (fully) VISIBLE.
* Absent samples are not darkness: gaps longer than ``sampling.max_gap_s`` are coverage
  gaps and will be treated as UNKNOWN by the engine.
"""

from __future__ import annotations

from itertools import pairwise
from typing import Annotated, Self

from pydantic import Field, Strict, field_validator, model_validator

from .conventions import (
    SCHEMA_VERSION,
    AzimuthDeg,
    ContractModel,
    ElevationDeg,
    Fraction,
    Identifier,
    NonEmptyStr,
    NonNegativeFloat,
    PositiveDurationS,
    PositiveFloat,
    StrictBool,
    UTCDatetime,
)
from .enums import AngleType, Body, CalculationBasis, VisibilityCriterion, VisibilityState
from .mission import LandingSite

# Rounding allowance when checking state against (elevation - horizon). JSON producers may
# round angles to ~3 decimals; 1e-3 deg (3.6 arcsec) avoids rejecting valid grazing samples.
ANGLE_CONSISTENCY_TOLERANCE_DEG = 1e-3

_DEFINITE_STATES = frozenset({VisibilityState.VISIBLE, VisibilityState.PARTIAL, VisibilityState.NOT_VISIBLE})


class Provenance(ContractModel):
    """Where the numbers came from. Propagated unchanged into every assessment."""

    is_synthetic: StrictBool  # True for test fixtures / mock data; never NASA-derived
    ephemeris_source: NonEmptyStr  # e.g. "JPL Horizons API, quantity 4, CENTER=coord@301"
    terrain_source: NonEmptyStr | None = None  # e.g. DEM product name; None if geometric-only
    terrain_resolution_m: PositiveFloat | None = None
    horizon_azimuth_step_deg: PositiveFloat | None = None
    # Required but nullable: null means the producer did not record it (never back-filled).
    generated_at_utc: UTCDatetime | None
    generator: NonEmptyStr  # software name + version that produced the file
    references: list[NonEmptyStr] = Field(default_factory=list)
    notes: str | None = None


class SamplingInfo(ContractModel):
    nominal_interval_s: PositiveDurationS | None  # None = intentionally irregular
    # Consecutive samples farther apart than this bound a coverage gap; the engine will not
    # interpolate or hold state across it.
    max_gap_s: PositiveDurationS

    @model_validator(mode="after")
    def _gap_not_below_interval(self) -> Self:
        if self.nominal_interval_s is not None and self.max_gap_s < self.nominal_interval_s:
            raise ValueError("sampling.max_gap_s must be >= sampling.nominal_interval_s")
        return self


class UncertaintyInfo(ContractModel):
    """Series-level 1-sigma angular uncertainty estimates, if available (Member 6 methodology)."""

    ephemeris_angle_uncertainty_deg: NonNegativeFloat | None = None
    horizon_angle_uncertainty_deg: NonNegativeFloat | None = None
    notes: str | None = None


class HorizonProfile(ContractModel):
    """Terrain horizon elevation as a function of azimuth for the site/observer height."""

    azimuths_deg: list[AzimuthDeg] = Field(min_length=1)
    horizon_deg: list[ElevationDeg | None]  # None = terrain unknown in that direction

    @model_validator(mode="after")
    def _aligned_and_sorted(self) -> Self:
        if len(self.azimuths_deg) != len(self.horizon_deg):
            raise ValueError("azimuths_deg and horizon_deg must have the same length")
        if any(b <= a for a, b in pairwise(self.azimuths_deg)):
            raise ValueError("azimuths_deg must be strictly increasing")
        return self


class BodyObservation(ContractModel):
    """Sun or Earth as seen from the site at one instant.

    All fields except ``visible_fraction`` and ``angular_radius_deg`` are required but
    nullable, so a producer must state explicitly that a value is unknown rather than omit it.
    """

    azimuth_deg: AzimuthDeg | None
    elevation_deg: ElevationDeg | None
    horizon_deg: ElevationDeg | None  # terrain horizon at azimuth_deg; None = unknown/not modelled
    state: VisibilityState
    visible_fraction: Fraction | None = None  # fraction of apparent disk above the horizon
    # Apparent angular radius actually used for disk calculations (e.g. Horizons Ang-diam / 2).
    angular_radius_deg: Annotated[float, Strict(), Field(gt=0.0, le=10.0)] | None = None

    @model_validator(mode="after")
    def _self_consistent(self) -> Self:
        if self.horizon_deg is not None and self.azimuth_deg is None:
            raise ValueError("horizon_deg is defined at the body azimuth; azimuth_deg is required")
        if self.state is VisibilityState.UNKNOWN and self.visible_fraction is not None:
            raise ValueError("visible_fraction given but state is unknown; report the state")
        return self


class ScientificSample(ContractModel):
    time_utc: UTCDatetime
    sun: BodyObservation
    earth: BodyObservation

    def body(self, body: Body) -> BodyObservation:
        return self.sun if body is Body.SUN else self.earth


class ScientificTimeSeries(ContractModel):
    schema_version: str = SCHEMA_VERSION
    dataset_id: Identifier
    site: LandingSite
    # Height of the reference point (solar array / antenna) above local terrain used for
    # horizon calculations. None = not stated.
    observer_height_m: NonNegativeFloat | None
    coverage_start_utc: UTCDatetime
    coverage_end_utc: UTCDatetime
    calculation_basis: CalculationBasis
    angle_type: AngleType
    sun_criterion: VisibilityCriterion
    earth_criterion: VisibilityCriterion
    sampling: SamplingInfo
    provenance: Provenance
    uncertainty: UncertaintyInfo = Field(default_factory=UncertaintyInfo)
    horizon_profile: HorizonProfile | None = None
    samples: list[ScientificSample] = Field(min_length=1)

    @field_validator("schema_version")
    @classmethod
    def _known_version(cls, value: str) -> str:
        if value != SCHEMA_VERSION:
            raise ValueError(f"unsupported schema_version {value!r}; expected {SCHEMA_VERSION!r}")
        return value

    @model_validator(mode="after")
    def _validate_series(self) -> Self:
        if self.coverage_end_utc <= self.coverage_start_utc:
            raise ValueError("coverage_end_utc must be after coverage_start_utc")
        self._check_time_order()
        self._check_basis()
        for index, sample in enumerate(self.samples):
            for body in Body:
                self._check_observation(index, body, sample.body(body))
        return self

    def _check_time_order(self) -> None:
        times = [s.time_utc for s in self.samples]
        for i, (a, b) in enumerate(pairwise(times)):
            if b <= a:
                raise ValueError(f"samples[{i + 1}].time_utc must be strictly after samples[{i}].time_utc")
        if times[0] < self.coverage_start_utc or times[-1] > self.coverage_end_utc:
            raise ValueError("all samples must lie within [coverage_start_utc, coverage_end_utc]")

    def _check_basis(self) -> None:
        if self.calculation_basis is CalculationBasis.TERRAIN_AWARE:
            if self.provenance.terrain_source is None:
                raise ValueError("terrain_aware series must state provenance.terrain_source")
        else:
            if self.provenance.terrain_source is not None or self.horizon_profile is not None:
                raise ValueError("geometric_only series must not carry terrain_source or horizon_profile")
            if any(s.sun.horizon_deg is not None or s.earth.horizon_deg is not None for s in self.samples):
                raise ValueError("geometric_only series must not carry horizon_deg values")

    def _criterion(self, body: Body) -> VisibilityCriterion:
        return self.sun_criterion if body is Body.SUN else self.earth_criterion

    def _check_observation(self, index: int, body: Body, obs: BodyObservation) -> None:
        where = f"samples[{index}].{body.value}"
        criterion = self._criterion(body)
        terrain = self.calculation_basis is CalculationBasis.TERRAIN_AWARE

        if obs.state is VisibilityState.PARTIAL and criterion is VisibilityCriterion.CENTER:
            raise ValueError(f"{where}: state 'partial' requires the apparent_disk criterion")

        if obs.state in _DEFINITE_STATES:
            if obs.elevation_deg is None:
                raise ValueError(f"{where}: definite state '{obs.state.value}' requires elevation_deg")
            if terrain and obs.horizon_deg is None:
                raise ValueError(
                    f"{where}: terrain-aware state '{obs.state.value}' requires horizon_deg; "
                    "use state 'unknown' when the terrain horizon is unknown"
                )

        if criterion is VisibilityCriterion.APPARENT_DISK and obs.visible_fraction is not None:
            expected = (
                VisibilityState.NOT_VISIBLE
                if obs.visible_fraction == 0.0
                else VisibilityState.VISIBLE
                if obs.visible_fraction == 1.0
                else VisibilityState.PARTIAL
            )
            if obs.state is not expected:
                raise ValueError(
                    f"{where}: visible_fraction {obs.visible_fraction} implies '{expected.value}', "
                    f"got '{obs.state.value}'"
                )

        if obs.elevation_deg is None or obs.state not in _DEFINITE_STATES:
            return
        reference = obs.horizon_deg if terrain else 0.0
        if reference is None:
            return
        clearance = obs.elevation_deg - reference
        tol = ANGLE_CONSISTENCY_TOLERANCE_DEG
        if clearance > tol and obs.state is VisibilityState.NOT_VISIBLE:
            raise ValueError(f"{where}: centre is {clearance:.4f} deg above the horizon but state is not_visible")
        if clearance < -tol and obs.state is VisibilityState.VISIBLE:
            raise ValueError(f"{where}: centre is {-clearance:.4f} deg below the horizon but state is visible")
