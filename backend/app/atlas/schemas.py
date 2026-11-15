"""Request / response of the Feasibility Atlas (/api/atlas)."""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from ..models import MissionRequirements, to_utc

MAX_DATES = 120
MAX_DURATIONS = 8
MAX_CELLS = 600

CellStatus = Literal["pass", "fail", "unknown", "not_evaluated"]


class AtlasRequest(BaseModel):
    """One site and one spacecraft; a grid of landing dates x mission durations to test."""

    site_id: str
    start_utc: datetime = Field(description="First landing date tested")
    step_hours: float = Field(24, ge=1, le=720, description="Sampling interval between tested landing dates")
    count: int = Field(60, ge=1, le=MAX_DATES, description="Number of landing dates tested")
    durations_days: list[float] = Field(default_factory=lambda: [3, 7, 14, 28], min_length=1, max_length=MAX_DURATIONS)
    requirements: MissionRequirements = Field(default_factory=MissionRequirements)

    @field_validator("start_utc")
    @classmethod
    def _utc(cls, v: datetime) -> datetime:
        return to_utc(v)

    @field_validator("durations_days")
    @classmethod
    def _durations(cls, v: list[float]) -> list[float]:
        if any(d <= 0 or d > 365 for d in v):
            raise ValueError("durations must be between 0 and 365 days")
        return sorted(set(v))

    @model_validator(mode="after")
    def _size(self) -> AtlasRequest:
        if self.count * len(self.durations_days) > MAX_CELLS:
            raise ValueError(f"at most {MAX_CELLS} cells (landing dates x durations) per request")
        return self


class RequirementInfo(BaseModel):
    """A requirement as the engine checks it (the same for every cell)."""

    id: str
    name: str | None
    comparison: str | None  # at_least | at_most
    threshold: float | None  # display units
    unit: str
    requirement_field: str | None


class CellConstraint(BaseModel):
    """One requirement in one cell, compact: the requirement's name, limit and unit are in `requirements`."""

    id: str
    status: Literal["pass", "fail", "unknown", "not_applicable"]
    measured: Literal["known", "bounded", "unavailable", "not_applicable"]
    value: float | None = None  # display units, when known
    lower: float | None = None  # when bounded
    upper: float | None = None
    margin: float | None = None  # (measured - limit) for "at least", (limit - measured) for "at most"; when known
    note: str | None = None  # why it can't be decided (unknown only)


class AtlasCell(BaseModel):
    landing_utc: str
    duration_days: float
    status: CellStatus
    limiting: str | None  # the requirement that decides this cell (fail: worst; pass: closest to failing; unknown: undecided)
    reason: str  # one line: why this status (the engine's message for the limiting requirement)
    constraints: list[CellConstraint] = []


class AtlasResponse(BaseModel):
    site_id: str
    site_name: str
    data_start_utc: str
    data_stop_utc: str
    start_utc: str
    step_hours: float
    landing_utc: list[str]  # columns
    durations_days: list[float]  # rows
    requirements_input: MissionRequirements
    requirements: list[RequirementInfo]
    cells: list[list[AtlasCell]]  # [duration row][landing column]
    counts: dict[str, int]
    engine_version: str
    method: str
    limitations: list[str]
