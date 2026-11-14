from __future__ import annotations

import copy
from typing import Any

import pytest

from app.viability.enums import CommunicationMode, PowerSource
from app.viability.fixtures import build_fixture


@pytest.fixture
def series_dict() -> dict[str, Any]:
    """A valid terrain-aware SYNTHETIC series as a JSON-mode dict, safe to mutate per test."""
    return copy.deepcopy(build_fixture("intermittent_sunlight").model_dump(mode="json"))


@pytest.fixture
def scenario_dict() -> dict[str, Any]:
    return {
        "scenario_id": "test-scenario-1",
        "name": "Test scenario",
        "site": {"id": "site-1", "name": "Test site", "lat": -89.5, "lon": 45.0},
        "mission_start_utc": "2027-01-01T00:00:00Z",
        "mission_end_utc": "2027-01-15T00:00:00Z",
        "spacecraft": {
            "name": "Test lander",
            "power_source": PowerSource.SOLAR.value,
            "communication_mode": CommunicationMode.DIRECT_TO_EARTH.value,
            "max_continuous_darkness_s": 72 * 3600.0,
            "max_communication_blackout_s": 48 * 3600.0,
        },
        "requirements": {"min_sunlight_percent": 60.0, "min_earth_visibility_percent": 40.0},
    }
