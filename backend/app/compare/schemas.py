"""Request/response models for the comparison endpoint (Member 4).

Mirrored in frontend/src/features/compare/types.ts and documented in docs/comparison.md.
"""
from __future__ import annotations

from ..models import CanonicalMarginItem, OperationalHeadroom

from typing import Literal

from pydantic import BaseModel, Field

from ..models import Scenario, ViabilityResult

PanelMode = Literal["vertical_sun_tracking", "vertical_fixed", "horizontal", "two_axis"]
DataKind = Literal["real", "demonstration", "unavailable"]


class SpacecraftConfig(BaseModel):
    """Lander power configuration. Only used for the idealised incidence factor and the
    idealised energy ceiling; it never changes viability (that uses `requirements`)."""

    panel_mode: PanelMode = Field(
        "vertical_sun_tracking",
        description="vertical_sun_tracking: vertical panel rotated to face the Sun's azimuth (common polar "
                    "lander design); vertical_fixed: vertical panel facing panel_azimuth_deg; horizontal: "
                    "panel facing straight up; two_axis: always pointed at the Sun.")
    panel_azimuth_deg: float = Field(0, ge=0, lt=360, description="Facing direction for vertical_fixed")
    panel_rated_power_w: float | None = Field(None, gt=0, description="Output at normal incidence, full Sun")
    average_load_w: float | None = Field(None, gt=0)
    battery_capacity_wh: float | None = Field(None, gt=0)


class CompareScenarioIn(BaseModel):
    key: str = Field(description="Client id, echoed back so results can be matched to scenarios")
    scenario: Scenario
    spacecraft: SpacecraftConfig = Field(default_factory=SpacecraftConfig)


class CompareRequest(BaseModel):
    scenarios: list[CompareScenarioIn] = Field(min_length=1, max_length=6)
    allow_demo_data: bool = Field(
        False, description="Use the SYNTHETIC placeholder timeline where no real data exists. Off by default: "
                           "such scenarios are then returned as 'unavailable' instead.")
    max_points: int = Field(1500, ge=50, le=10000, description="Max timeline samples returned per scenario")


class Window(BaseModel):
    """A continuous period (sunlight, darkness, Earth visibility or blackout)."""

    start_hour: float  # hours after landing
    end_hour: float
    duration_hours: float
    start_utc: str
    end_utc: str
    open_start: bool = Field(description="Already in progress at landing")
    open_end: bool = Field(description="Still in progress at the end of the mission")


class MissionEvent(BaseModel):
    type: Literal["sunrise", "sunset", "earthrise", "earthset"]
    hour: float
    time_utc: str


class SolarStats(BaseModel):
    sunlit_hours: float = Field(description="Hours with any part of the solar disk above the terrain")
    sunlit_fraction: float
    mean_visible_fraction: float = Field(description="Mean share of the solar disk above the terrain (0-1)")
    equivalent_full_sun_hours: float
    mean_elevation_deg: float
    mean_elevation_lit_deg: float | None
    max_elevation_deg: float
    min_elevation_lit_deg: float | None
    mean_clearance_lit_deg: float | None = Field(description="Mean Sun elevation above the terrain horizon while lit")
    longest_dark_hours: float = Field(description="Longest run with no solar disk visible (geometric)")
    windows_count: int


class EarthStats(BaseModel):
    visible_hours: float
    visible_fraction: float
    longest_blackout_hours: float
    windows_count: int
    mean_elevation_visible_deg: float | None
    min_elevation_visible_deg: float | None
    mean_margin_visible_deg: float | None
    min_margin_visible_deg: float | None


class PowerStats(BaseModel):
    """Idealised direct-beam model, P ∝ visible_fraction × max(0, cos θ). NOT electrical output."""

    panel_mode: PanelMode
    mean_incidence_factor: float
    max_incidence_factor: float
    equivalent_full_power_hours: float
    idealized_mean_power_w: float | None
    idealized_energy_wh: float | None
    load_energy_wh: float | None
    idealized_energy_to_load_ratio: float | None
    battery_endurance_hours: float | None = Field(description="battery_capacity_wh / average_load_w")
    model: str


class SiteContext(BaseModel):
    ground_height_m: float | None
    observer_height_m: float | None
    horizon_min_deg: float | None
    horizon_max_deg: float | None
    coordinate_source: str


class ScienceContext(BaseModel):
    """Distance to the nearest permanently shadowed region in the rescue catalog."""

    nearest_psr_id: str
    nearest_psr_name: str
    distance_to_psr_edge_km: float
    ice_interest: float
    source: str


class TimelineColumns(BaseModel):
    """Decimated mission timeline for charts. Index i across all arrays is one sample.
    ``None`` = unknown at that sample (e.g. terrain or ephemeris gap); never a measured value."""

    step_hours: float
    hour: list[float]
    time_utc: list[str]
    sun_elevation_deg: list[float | None]
    sun_azimuth_deg: list[float | None]
    sun_horizon_deg: list[float | None]
    sun_visible_fraction: list[float | None]
    earth_elevation_deg: list[float | None]
    earth_azimuth_deg: list[float | None]
    earth_horizon_deg: list[float | None]
    earth_visible: list[bool | None]
    incidence_factor: list[float | None]


class CanonicalMetric(BaseModel):
    """A metric exactly as the viability engine reports it, converted to display units (s -> h).
    ``known``: ``value``; ``bounded``: true value lies in [``lower``, ``upper``]; ``unavailable``: no number."""

    status: Literal["known", "bounded", "unavailable", "not_applicable"]
    unit: str  # h | % | fraction | deg
    value: float | None = None
    lower: float | None = None
    upper: float | None = None
    reason: str | None = None


class EvidenceWindow(BaseModel):
    """A window the engine cites as evidence for a requirement verdict (e.g. the longest power-dark period)."""

    kind: str  # power_dark, communication_blackout, earth_visible, ...
    start_hour: float  # hours after mission start
    end_hour: float
    duration_hours: float
    start_utc: str
    end_utc: str
    clipped_at_start: bool  # the condition was already in progress at landing
    clipped_at_end: bool


class ConstraintItem(BaseModel):
    """One mission requirement as the engine judged it."""

    id: str
    name: str | None
    status: Literal["pass", "fail", "unknown", "not_applicable"]
    comparison: str | None  # at_least | at_most
    threshold: float | None  # display units
    measured: CanonicalMetric
    message: str
    requirement_field: str | None
    unknown_reason: str | None = None
    evidence_windows: list[EvidenceWindow] = []


class RiskItem(BaseModel):
    code: str
    level: str
    message: str


class AssessmentInfo(BaseModel):
    """Evidence from the canonical assessment beyond pass/fail and score (docs/member2-part2-consumer-handoff.md §12.7)."""

    engine_version: str
    scoring_method_version: str
    dataset_id: str
    data_basis: str
    is_synthetic: bool
    overall_risk: str
    risks: list[RiskItem]
    sun_coverage_percent: float
    earth_coverage_percent: float
    uncovered_hours: float
    metrics: dict[str, CanonicalMetric]
    constraints: list[ConstraintItem]
    margins: list[CanonicalMarginItem] = Field(default_factory=list)
    headroom: OperationalHeadroom | None = None
    explanations: list[str]
    limitations: list[str]


class RankingInfo(BaseModel):
    """This scenario's place in the viability engine's canonical ranking (app/viability/ranking.py).

    Only ``eligibility == "pass"`` entries carry a ``rank``, and only within their ``group``: scenarios in
    different groups (different data basis, scoring method, requirements or mission duration) are never
    ranked against each other. ``score`` is the exact score or ``None``; ``None`` never means 0."""

    eligibility: Literal["pass", "fail", "unknown"]
    assessed: bool = Field(True, description="False = the engine never assessed it (e.g. no data); eligibility is then UNKNOWN")
    rank: int | None = Field(None, ge=1)
    group: str | None = Field(None, description="Comparable group id (G1 = primary group)")
    group_size: int
    ranked_in_group: int = Field(description="Number of PASS (ranked) scenarios in the group")
    explanation: str = Field(description="The engine's own reason for this rank or absence of rank")
    score_status: str | None = Field(None, description="known | bounded | eligibility_unknown | no_scorable_components")
    score: float | None = Field(None, description="Exact score only (status known); None = no exact number")
    score_lower: float | None = Field(None, description="Guaranteed lower bound (equals score when known)")
    score_upper: float | None = None
    overall_risk: str
    data_basis: str


class ScoreDifferenceInfo(BaseModel):
    """Conservative interval of (higher - lower) score, as the engine computed it."""

    status: Literal["selected_higher", "competitor_higher", "not_established", "unavailable", "not_comparable"]
    lower: float | None = None
    upper: float | None = None
    both_exact: bool
    statement: str


class ComponentAdvantage(BaseModel):
    component: str
    label: str
    advantage: Literal["selected", "competitor", "equal", "not_established", "inactive", "unavailable"]


class PairEvidence(BaseModel):
    """The viability engine's own evidence for the order of two scenarios (app/viability/ranking_evidence.py).

    ``selected`` is the scenario the engine places first when they are comparable (else the earlier one in
    canonical order). Nothing here is recomputed: it restates ``compare_scenarios``."""

    selected: str
    competitor: str
    selected_id: str = Field(description="Engine scenario id of `selected` as it appears in the texts")
    competitor_id: str
    comparable: bool
    comparability_issues: list[str]
    higher: str | None = Field(None, description="Key placed first by the ranking policy; None when not comparable")
    deciding_criterion: str | None
    deciding_detail: str
    policy_tie_break: bool = Field(description="True when the order is decided by a policy tie-break, not a measured difference")
    score_difference: ScoreDifferenceInfo
    components: list[ComponentAdvantage]
    limitations: list[str]
    explanation: str


class RankingGroup(BaseModel):
    """One set of scenarios that may share a ranking, in the engine's canonical order."""

    id: str
    primary: bool = Field(description="The largest group; the others are listed separately")
    keys: list[str] = Field(description="All member scenario keys in canonical order (PASS, UNKNOWN, FAIL)")
    ranked_keys: list[str] = Field(description="PASS members, in rank order")
    data_basis: str | None
    policy: str
    method_version: str
    separate_reason: str | None = Field(None, description="Why this group cannot share the primary group's ranking")


class CompareResult(BaseModel):
    key: str
    status: Literal["ok", "unavailable"]
    message: str | None = None
    data_kind: DataKind
    data_source: str
    site_context: SiteContext | None = None
    science_context: ScienceContext | None = None
    viability: ViabilityResult | None = None
    ranking: RankingInfo | None = Field(None, description="Canonical ranking (UNKNOWN with no rank when no assessment exists)")
    assessment: AssessmentInfo | None = Field(None, description="Canonical evidence: metric states, constraints, risk, coverage")
    solar: SolarStats | None = None
    earth: EarthStats | None = None
    power: PowerStats | None = None
    sun_windows: list[Window] = []
    dark_windows: list[Window] = []
    earth_windows: list[Window] = []
    blackout_windows: list[Window] = []
    events: list[MissionEvent] = []
    timeline: TimelineColumns | None = None


class CompareResponse(BaseModel):
    results: list[CompareResult]
    ranking_groups: list[RankingGroup] = []
    ranking_method: str | None = None
    pairwise: list[PairEvidence] = Field(default_factory=list, description="Engine evidence for every pair of assessed scenarios")
    viability_source: str
    notes: list[str]
