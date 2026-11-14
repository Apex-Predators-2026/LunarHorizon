"""Request/response models for Mission Rescue & Optimization (Member 5).

Mirrored in frontend/src/types/rescue.ts and documented in docs/interfaces.md.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from ..models import MissionRequirements, Scenario, Site, ViabilityResult


# ---------------------------------------------------------------- inputs

class RequirementOverrides(BaseModel):
    """Any subset of MissionRequirements to change. Unset fields keep their old value."""

    min_sunlight_fraction: float | None = Field(None, ge=0, le=1)
    battery_hours: float | None = Field(None, gt=0)
    panel_threshold: float | None = Field(None, ge=0, le=1)
    min_earth_visibility_fraction: float | None = Field(None, ge=0, le=1)
    max_comms_gap_hours: float | None = Field(None, gt=0)
    min_initial_sun_hours: float | None = Field(None, ge=0)
    min_initial_comms_hours: float | None = Field(None, ge=0)

    def apply(self, req: MissionRequirements) -> MissionRequirements:
        return req.model_copy(update=self.model_dump(exclude_none=True))


class PlanChange(BaseModel):
    """What happened to the plan."""

    launch_delay_days: float = Field(0, ge=0, le=730, description="How many days later the lander can now arrive")
    new_duration_days: float | None = Field(None, gt=0, le=365)
    requirement_overrides: RequirementOverrides = Field(default_factory=RequirementOverrides)
    reason: str | None = Field(None, description="Free text, e.g. 'Launch slipped 3 weeks'")


class SearchOptions(BaseModel):
    """Where and when to look for alternatives."""

    date_window_days: float = Field(30, ge=0, le=365, description="Search this many days after the earliest possible landing")
    date_step_hours: float = Field(12, ge=1, le=240)
    allow_earlier_dates: bool = Field(False, description="Also search before the delayed date (e.g. requirements changed, not the launch)")
    earlier_window_days: float = Field(0, ge=0, le=365)
    candidate_site_ids: list[str] | None = Field(None, description="Catalog sites to consider; None = all")
    max_site_distance_km: float | None = Field(None, gt=0, description="Ignore catalog sites farther than this from the original")
    include_nearby_points: bool = Field(True, description="Also try custom points around the original site")
    nearby_radii_km: list[float] = Field(default_factory=lambda: [2.0, 5.0])
    nearby_bearings: int = Field(8, ge=1, le=36)
    top_n: int = Field(5, ge=1, le=20)
    min_separation_hours: float = Field(48, ge=0, description="Alternatives at the same place must be at least this far apart in time")
    date_penalty_per_day: float = Field(0.5, ge=0, description="Ranking points lost per day of extra shift")
    distance_penalty_per_km: float = Field(0.05, ge=0, description="Ranking points lost per km moved")
    clearance_bonus_per_deg: float = Field(1.0, ge=0, description="Ranking points gained per degree the Sun/Earth clear the terrain (capped at 3 deg)")
    robustness_check: bool = True
    include_synthetic: bool | None = Field(
        None, description="Compare against synthetic-placeholder data? None = only if the plan itself has no real data")


class RescueRequest(BaseModel):
    original: Scenario
    change: PlanChange = Field(default_factory=PlanChange)
    search: SearchOptions = Field(default_factory=SearchOptions)


# ---------------------------------------------------------------- outputs

AltKind = Literal["unchanged", "date_shift", "site_change", "site_and_date"]


class MetricDelta(BaseModel):
    metric: str
    label: str
    unit: str
    before: float | None
    after: float | None
    delta: float | None
    better: bool | None = Field(description="True if the change is an improvement, None if unchanged/unknown")


class Robustness(BaseModel):
    checked_points: int
    passing_points: int
    pass_rate: float
    worst_score: float
    verdict: Literal["robust", "sensitive", "fragile"]
    note: str


class Alternative(BaseModel):
    rank: int
    kind: AltKind
    is_catalog_site: bool
    scenario: Scenario
    viability: ViabilityResult
    rank_score: float
    date_shift_hours: float = Field(description="Relative to the delayed (changed) landing time")
    distance_km: float = Field(description="Distance from the original landing site")
    improvements: list[MetricDelta] = Field(description="Compared with the changed (broken) plan")
    robustness: Robustness | None
    headline: str
    reasons: list[str]


class NearMiss(BaseModel):
    kind: AltKind
    scenario: Scenario
    viability: ViabilityResult
    closeness: float = Field(description="Sum of relative shortfalls; 0.1 = misses by 10% in total")
    date_shift_hours: float
    distance_km: float
    why_it_fails: list[str]


class RequirementChange(BaseModel):
    constraint: str
    label: str
    unit: str
    current: float
    suggested: float
    change_percent: float


class LooseningSuggestion(BaseModel):
    changes: list[RequirementChange]
    total_relative_change: float
    keeps_original_plan: bool = Field(description="True if this relaxes requirements so the changed plan itself passes")
    unlocks: Scenario
    unlocks_score: float | None
    message: str


class SearchStats(BaseModel):
    candidates_evaluated: int
    locations_considered: int
    passing: int
    synthetic_candidates_excluded: int = Field(0, description="Candidates skipped because they only had synthetic data")
    undecided: int = Field(0, description="Candidates whose viability could not be decided (eligibility 'unknown')")
    date_range_start: datetime
    date_range_end: datetime


class RescueResponse(BaseModel):
    status: Literal["still_viable", "rescued", "no_viable_alternative"]
    summary: str
    original: ViabilityResult
    changed: ViabilityResult
    alternatives: list[Alternative]
    near_misses: list[NearMiss]
    loosening: list[LooseningSuggestion]
    stats: SearchStats
    data_source: str
    assumptions: list[str]


# ---------------------------------------------------------------- sensitivity

class SensitivityRequest(BaseModel):
    scenario: Scenario
    date_offsets_hours: list[float] = Field(default_factory=lambda: [-72, -48, -24, -12, 12, 24, 48, 72])
    position_offsets_km: list[float] = Field(default_factory=lambda: [0.5, 1.0, 2.0])
    bearings: int = Field(8, ge=1, le=36)
    include_synthetic: bool | None = Field(
        None, description="Use synthetic data for points without real data? None = only if the plan has no real data")


class SensitivityPoint(BaseModel):
    date_offset_hours: float
    distance_km: float
    bearing_deg: float | None
    lat: float
    lon: float
    passes: bool
    score: float
    failing_constraints: list[str]


class SensitivityResponse(BaseModel):
    base: ViabilityResult
    points: list[SensitivityPoint]
    date_pass_rate: float | None = Field(description="None if no date slips could be checked")
    position_pass_rate: float | None = Field(description="None if no landing-position errors could be checked")
    safe_date_window_hours: tuple[float, float] | None = Field(
        description="Contiguous range of tested date offsets around 0 that all pass; None if the base fails")
    score_min: float
    score_max: float
    most_sensitive_constraint: str | None
    skipped_points: int = Field(0, description="Points left out because they only had synthetic data")
    verdict: Literal["robust", "sensitive", "fragile", "fails"]
    explanation: str


# ---------------------------------------------------------------- science vs engineering

class ScienceGoal(BaseModel):
    target: Site | None = Field(None, description="Science target (e.g. an icy PSR). None = nearest catalog PSR")
    target_psr_id: str | None = Field(None, description="Use a catalog PSR as the target (overrides `target`)")
    max_traverse_km: float = Field(15, gt=0, description="Beyond this distance from the target, science value is 0")
    min_science_score: float = Field(0.5, ge=0, le=1)


class CompromiseRequest(BaseModel):
    scenario: Scenario = Field(description="Earliest landing time, duration and the engineering requirements")
    science: ScienceGoal = Field(default_factory=ScienceGoal)
    engineering_weight: float = Field(0.5, ge=0)
    science_weight: float = Field(0.5, ge=0)
    search: SearchOptions = Field(default_factory=SearchOptions)

    @field_validator("science_weight")
    @classmethod
    def _weights(cls, v: float, info) -> float:
        if v == 0 and info.data.get("engineering_weight", 0) == 0:
            raise ValueError("engineering_weight and science_weight cannot both be 0")
        return v


class CompromiseOption(BaseModel):
    scenario: Scenario
    viability: ViabilityResult
    engineering_score: float
    science_score: float
    combined_score: float
    meets_engineering: bool
    meets_science: bool
    distance_to_science_km: float
    pareto_optimal: bool
    explanation: str


class CompromiseResponse(BaseModel):
    status: Literal["both_met", "tradeoff_required"]
    summary: str
    best: CompromiseOption | None
    best_for_engineering: CompromiseOption | None
    best_for_science: CompromiseOption | None
    pareto_front: list[CompromiseOption]
    suggestions: list[str]
    loosening: list[LooseningSuggestion]
    stats: SearchStats
    data_source: str
    assumptions: list[str]
