"""Cross-team contract checks: shared-draft compatibility and FastAPI/OpenAPI readiness."""

from __future__ import annotations

import json
from typing import Any

import pytest
from pydantic import BaseModel, ValidationError

from app.viability import (
    LandingSite,
    MissionScenario,
    RankingResult,
    ScientificTimeSeries,
    ViabilityAssessment,
)


def test_frontend_site_object_validates_as_landing_site() -> None:
    # Shape of `Site` in docs/interfaces.md and frontend/src/types.ts.
    site = LandingSite.model_validate({"id": "test-site", "name": "Test site", "lat": -89.4, "lon": 0.0})
    assert site.surface_height_m is None


@pytest.mark.parametrize("value", ["false", "no", 0, 1])
def test_provenance_synthetic_flag_is_strict(series_dict: dict[str, Any], value: object) -> None:
    series_dict["provenance"]["is_synthetic"] = value
    with pytest.raises(ValidationError):
        ScientificTimeSeries.model_validate(series_dict)


@pytest.mark.parametrize("model", [ScientificTimeSeries, MissionScenario, ViabilityAssessment, RankingResult])
@pytest.mark.parametrize("mode", ["validation", "serialization"])
def test_json_schema_generates(model: type[BaseModel], mode: str) -> None:
    schema = model.model_json_schema(mode=mode)  # type: ignore[arg-type]
    json.dumps(schema)  # must itself be JSON-serializable for OpenAPI
    assert schema["type"] == "object"
    assert schema.get("additionalProperties") is False


def test_enums_appear_as_string_values_in_schema() -> None:
    defs = ScientificTimeSeries.model_json_schema()["$defs"]
    assert set(defs["VisibilityState"]["enum"]) == {"visible", "partial", "not_visible", "unknown"}
