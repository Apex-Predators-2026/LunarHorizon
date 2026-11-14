"""Explanation generation (Phase 6 - interface only) and standing limitations."""

from __future__ import annotations

from .enums import Eligibility
from .outputs import ConstraintEvaluation, DataQualitySummary, Explanation, OperationalMargin, RiskIndicator

# Included in every assessment's ``limitations``; reviewed with Member 6.
STANDARD_LIMITATIONS: tuple[str, ...] = (
    "Solar illumination is not electrical power generation; array orientation, efficiency, "
    "temperature, dust and power-system design are not modelled.",
    "Earth line of sight is not guaranteed radio connectivity; antenna pointing, link budget, "
    "ground-station availability and interference are not modelled.",
    "Viability covers illumination and direct-to-Earth line of sight under the stated "
    "constraints only; it is not an assessment of landing safety (slopes, hazards, terrain).",
    "Terrain-aware results inherit the resolution and accuracy of the elevation model and "
    "horizon calculation; geometric-only results ignore terrain entirely.",
    "Sampled time series can miss events shorter than the sampling interval.",
)


def generate_explanations(
    eligibility: Eligibility,
    constraints: list[ConstraintEvaluation],
    margins: list[OperationalMargin],
    risks: list[RiskIndicator],
    data_quality: DataQualitySummary,
) -> list[Explanation]:
    raise NotImplementedError("Phase 6: explanations")
