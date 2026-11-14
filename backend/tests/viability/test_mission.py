from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from app.viability.enums import CommunicationMode, PowerSource, ScoreComponent, UnknownDataPolicy
from app.viability.mission import (
    LandingSite,
    MissionRequirements,
    MissionScenario,
    RankingPreferences,
    SpacecraftConfiguration,
)


def test_valid_scenario(scenario_dict: dict[str, Any]) -> None:
    s = MissionScenario.model_validate(scenario_dict)
    assert s.duration_s == 14 * 86400.0
    assert s.requirements.unknown_data_policy is UnknownDataPolicy.REPORT_UNKNOWN
    assert s.preferences == RankingPreferences()


def test_scenario_json_round_trip(scenario_dict: dict[str, Any]) -> None:
    s = MissionScenario.model_validate(scenario_dict)
    again = MissionScenario.model_validate_json(s.model_dump_json())
    assert again == s


@pytest.mark.parametrize("end", ["2027-01-01T00:00:00Z", "2026-12-31T23:00:00Z"])
def test_end_must_follow_start(scenario_dict: dict[str, Any], end: str) -> None:
    scenario_dict["mission_end_utc"] = end
    with pytest.raises(ValidationError, match="after mission_start_utc"):
        MissionScenario.model_validate(scenario_dict)


def test_absurd_duration_rejected(scenario_dict: dict[str, Any]) -> None:
    scenario_dict["mission_end_utc"] = "2040-01-01T00:00:00Z"
    with pytest.raises(ValidationError, match="sanity cap"):
        MissionScenario.model_validate(scenario_dict)


def test_naive_mission_time_rejected(scenario_dict: dict[str, Any]) -> None:
    scenario_dict["mission_start_utc"] = "2027-01-01T00:00:00"
    with pytest.raises(ValidationError):
        MissionScenario.model_validate(scenario_dict)


@pytest.mark.parametrize(("lat", "lon"), [(-90.0001, 0.0), (90.1, 0.0), (0.0, 180.01), (0.0, -181.0), (0.0, 270.0)])
def test_invalid_coordinates_rejected(lat: float, lon: float) -> None:
    with pytest.raises(ValidationError):
        LandingSite(id="s", name="s", lat=lat, lon=lon)


@pytest.mark.parametrize(("lat", "lon"), [(-90.0, 0.0), (-89.45, -180.0), (-89.45, 180.0), (90.0, 0.0)])
def test_boundary_coordinates_accepted(lat: float, lon: float) -> None:
    assert LandingSite(id="s", name="s", lat=lat, lon=lon).lat == lat


def test_blank_site_name_rejected() -> None:
    with pytest.raises(ValidationError):
        LandingSite(id="s", name="   ", lat=-89.0, lon=0.0)


@pytest.mark.parametrize("field", ["max_continuous_darkness_s", "max_communication_blackout_s"])
@pytest.mark.parametrize("value", [0.0, -1.0, float("nan")])
def test_invalid_spacecraft_durations_rejected(field: str, value: float) -> None:
    with pytest.raises(ValidationError):
        SpacecraftConfiguration.model_validate(
            {"name": "x", "power_source": "solar", "communication_mode": "direct_to_earth", field: value}
        )


def test_non_solar_relay_spacecraft_needs_no_limits() -> None:
    sc = SpacecraftConfiguration(
        name="RTG rover", power_source=PowerSource.RADIOISOTOPE, communication_mode=CommunicationMode.RELAY
    )
    assert sc.max_continuous_darkness_s is None
    assert sc.max_communication_blackout_s is None


def test_unknown_power_source_rejected() -> None:
    with pytest.raises(ValidationError):
        SpacecraftConfiguration.model_validate({"name": "x", "power_source": "fusion", "communication_mode": "relay"})


@pytest.mark.parametrize("field", ["min_sunlight_percent", "min_earth_visibility_percent", "min_simultaneous_percent"])
@pytest.mark.parametrize("value", [-0.1, 100.1, 150.0])
def test_impossible_percentages_rejected(field: str, value: float) -> None:
    with pytest.raises(ValidationError):
        MissionRequirements.model_validate({field: value})


@pytest.mark.parametrize("value", [-90.5, 91.0])
def test_impossible_clearance_rejected(value: float) -> None:
    with pytest.raises(ValidationError):
        MissionRequirements(min_earth_clearance_deg=value)


def test_requirements_default_to_not_required() -> None:
    r = MissionRequirements()
    assert r.min_sunlight_percent is None and r.min_earth_clearance_deg is None


def test_no_optimistic_unknown_policy_exists() -> None:
    assert {p.value for p in UnknownDataPolicy} == {"report_unknown", "worst_case"}
    with pytest.raises(ValidationError):
        MissionRequirements.model_validate({"unknown_data_policy": "best_case"})


def test_all_zero_weights_rejected() -> None:
    with pytest.raises(ValidationError, match="at least one ranking weight"):
        RankingPreferences(
            sunlight_weight=0.0,
            earth_visibility_weight=0.0,
            simultaneous_weight=0.0,
            darkness_margin_weight=0.0,
            blackout_margin_weight=0.0,
            clearance_margin_weight=0.0,
        )


def test_negative_weight_rejected() -> None:
    with pytest.raises(ValidationError):
        RankingPreferences(sunlight_weight=-1.0)


def test_weights_keyed_by_score_component() -> None:
    assert set(RankingPreferences().weights()) == set(ScoreComponent)


def test_unknown_scenario_field_rejected(scenario_dict: dict[str, Any]) -> None:
    scenario_dict["battery_kwh"] = 5
    with pytest.raises(ValidationError):
        MissionScenario.model_validate(scenario_dict)


# --- requirements added for Mission Rescue compatibility ----------------------------------


@pytest.mark.parametrize("value", [-0.01, 1.01])
def test_solar_power_threshold_must_be_a_fraction(value: float) -> None:
    with pytest.raises(ValidationError):
        SpacecraftConfiguration(
            name="x",
            power_source=PowerSource.SOLAR,
            communication_mode=CommunicationMode.DIRECT_TO_EARTH,
            solar_power_min_disk_fraction=value,
        )


def test_solar_power_threshold_optional_and_preserved() -> None:
    base = {"name": "x", "power_source": "solar", "communication_mode": "direct_to_earth"}
    assert SpacecraftConfiguration.model_validate(base).solar_power_min_disk_fraction is None
    assert (
        SpacecraftConfiguration.model_validate(
            {**base, "solar_power_min_disk_fraction": 0.25}
        ).solar_power_min_disk_fraction
        == 0.25
    )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("min_mean_solar_disk_fraction", 1.5),
        ("min_mean_solar_disk_fraction", -0.1),
        ("min_initial_sunlight_s", -1.0),
        ("min_initial_earth_visibility_s", -60.0),
    ],
)
def test_invalid_rescue_requirements_rejected(field: str, value: float) -> None:
    with pytest.raises(ValidationError):
        MissionRequirements.model_validate({field: value})


def test_initial_requirements_may_be_zero() -> None:
    r = MissionRequirements(min_initial_sunlight_s=0.0, min_initial_earth_visibility_s=0.0)
    assert r.min_initial_sunlight_s == 0.0
