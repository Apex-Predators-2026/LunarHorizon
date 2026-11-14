from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from app.viability.enums import VisibilityState
from app.viability.inputs import ANGLE_CONSISTENCY_TOLERANCE_DEG, HorizonProfile, SamplingInfo, ScientificTimeSeries

# series_dict is the SYNTHETIC "intermittent_sunlight" fixture (terrain-aware, Sun =
# apparent_disk, Earth = centre criterion), hourly over 48 h.


def _validate(d: dict[str, Any]) -> ScientificTimeSeries:
    return ScientificTimeSeries.model_validate(d)


def _sun(d: dict[str, Any], i: int = 0) -> dict[str, Any]:
    return d["samples"][i]["sun"]  # type: ignore[no-any-return]


def _earth(d: dict[str, Any], i: int = 0) -> dict[str, Any]:
    return d["samples"][i]["earth"]  # type: ignore[no-any-return]


def test_baseline_valid(series_dict: dict[str, Any]) -> None:
    assert len(_validate(series_dict).samples) == 49


# --- timestamps and ordering -------------------------------------------------------------


def test_samples_must_be_strictly_increasing(series_dict: dict[str, Any]) -> None:
    s = series_dict["samples"]
    s[3], s[4] = s[4], s[3]
    with pytest.raises(ValidationError, match="strictly after"):
        _validate(series_dict)


def test_duplicate_timestamps_rejected(series_dict: dict[str, Any]) -> None:
    series_dict["samples"][5]["time_utc"] = series_dict["samples"][4]["time_utc"]
    with pytest.raises(ValidationError, match="strictly after"):
        _validate(series_dict)


def test_samples_outside_coverage_rejected(series_dict: dict[str, Any]) -> None:
    series_dict["coverage_end_utc"] = "2027-01-02T12:00:00Z"
    with pytest.raises(ValidationError, match="within"):
        _validate(series_dict)


def test_coverage_must_be_positive(series_dict: dict[str, Any]) -> None:
    series_dict["coverage_end_utc"] = series_dict["coverage_start_utc"]
    with pytest.raises(ValidationError, match="coverage_end_utc"):
        _validate(series_dict)


def test_non_utc_sample_timestamp_rejected(series_dict: dict[str, Any]) -> None:
    series_dict["samples"][0]["time_utc"] = "2027-01-01T00:00:00"
    with pytest.raises(ValidationError):
        _validate(series_dict)


def test_empty_series_rejected(series_dict: dict[str, Any]) -> None:
    series_dict["samples"] = []
    with pytest.raises(ValidationError):
        _validate(series_dict)


def test_schema_version_mismatch_rejected(series_dict: dict[str, Any]) -> None:
    series_dict["schema_version"] = "9.9.9"
    with pytest.raises(ValidationError, match="schema_version"):
        _validate(series_dict)


# --- missing values and unknown states ---------------------------------------------------


def test_unknown_state_with_missing_angles_accepted(series_dict: dict[str, Any]) -> None:
    _sun(series_dict).update(
        azimuth_deg=None, elevation_deg=None, horizon_deg=None, state="unknown", visible_fraction=None
    )
    obs = _validate(series_dict).samples[0].sun
    assert obs.state is VisibilityState.UNKNOWN
    assert obs.elevation_deg is None


def test_unknown_state_survives_json_round_trip(series_dict: dict[str, Any]) -> None:
    _earth(series_dict).update(azimuth_deg=None, elevation_deg=None, horizon_deg=None, state="unknown")
    series = _validate(series_dict)
    again = ScientificTimeSeries.model_validate_json(series.model_dump_json())
    assert again.samples[0].earth.state is VisibilityState.UNKNOWN
    assert again.samples[0].earth.horizon_deg is None  # not coerced to 0
    assert again == series


def test_nullable_fields_must_be_explicit(series_dict: dict[str, Any]) -> None:
    del _earth(series_dict)["horizon_deg"]
    with pytest.raises(ValidationError, match="horizon_deg"):
        _validate(series_dict)


def test_terrain_aware_definite_state_needs_horizon(series_dict: dict[str, Any]) -> None:
    _earth(series_dict)["horizon_deg"] = None  # state stays "visible"
    with pytest.raises(ValidationError, match="use state 'unknown'"):
        _validate(series_dict)


def test_unknown_terrain_with_unknown_state_accepted(series_dict: dict[str, Any]) -> None:
    _earth(series_dict).update(horizon_deg=None, state="unknown")
    assert _validate(series_dict).samples[0].earth.state is VisibilityState.UNKNOWN


def test_definite_state_needs_elevation(series_dict: dict[str, Any]) -> None:
    _earth(series_dict).update(elevation_deg=None)
    with pytest.raises(ValidationError, match="requires elevation_deg"):
        _validate(series_dict)


def test_horizon_without_azimuth_rejected(series_dict: dict[str, Any]) -> None:
    _earth(series_dict).update(azimuth_deg=None, state="unknown")
    with pytest.raises(ValidationError, match="azimuth_deg is required"):
        _validate(series_dict)


def test_fraction_with_unknown_state_rejected(series_dict: dict[str, Any]) -> None:
    _sun(series_dict).update(state="unknown")  # visible_fraction 1.0 still present
    with pytest.raises(ValidationError, match="visible_fraction given but state is unknown"):
        _validate(series_dict)


def test_unrecognised_state_rejected(series_dict: dict[str, Any]) -> None:
    _sun(series_dict)["state"] = "maybe"
    with pytest.raises(ValidationError):
        _validate(series_dict)


# --- angle ranges ------------------------------------------------------------------------


@pytest.mark.parametrize(("field", "value"), [("azimuth_deg", 360.0), ("azimuth_deg", -0.5), ("elevation_deg", 90.5)])
def test_out_of_range_angles_rejected(series_dict: dict[str, Any], field: str, value: float) -> None:
    _earth(series_dict)[field] = value
    with pytest.raises(ValidationError):
        _validate(series_dict)


def test_negative_terrain_horizon_allowed(series_dict: dict[str, Any]) -> None:
    # A summit can see below the local horizontal plane.
    _earth(series_dict).update(elevation_deg=-0.5, horizon_deg=-1.2, state="visible")
    assert _validate(series_dict).samples[0].earth.horizon_deg == -1.2


# --- criterion and consistency -----------------------------------------------------------


def test_partial_state_requires_apparent_disk(series_dict: dict[str, Any]) -> None:
    _earth(series_dict)["state"] = "partial"  # Earth uses the centre criterion
    with pytest.raises(ValidationError, match="apparent_disk"):
        _validate(series_dict)


@pytest.mark.parametrize(
    ("fraction", "state"), [(0.5, "visible"), (0.0, "partial"), (1.0, "partial"), (0.3, "not_visible")]
)
def test_fraction_state_mismatch_rejected(series_dict: dict[str, Any], fraction: float, state: str) -> None:
    _sun(series_dict).update(visible_fraction=fraction, state=state)
    with pytest.raises(ValidationError, match="implies"):
        _validate(series_dict)


def test_state_contradicting_clearance_rejected(series_dict: dict[str, Any]) -> None:
    _earth(series_dict).update(elevation_deg=3.0, horizon_deg=1.0, state="not_visible")
    with pytest.raises(ValidationError, match="above the horizon"):
        _validate(series_dict)


def test_visible_below_horizon_rejected(series_dict: dict[str, Any]) -> None:
    _earth(series_dict).update(elevation_deg=1.0, horizon_deg=3.0, state="visible")
    with pytest.raises(ValidationError, match="below the horizon"):
        _validate(series_dict)


def test_full_disk_visible_with_centre_below_horizon_rejected(series_dict: dict[str, Any]) -> None:
    _sun(series_dict).update(elevation_deg=1.0, horizon_deg=1.5, state="visible", visible_fraction=None)
    with pytest.raises(ValidationError, match="below the horizon"):
        _validate(series_dict)


def test_grazing_within_rounding_tolerance_accepted(series_dict: dict[str, Any]) -> None:
    eps = ANGLE_CONSISTENCY_TOLERANCE_DEG / 2
    _earth(series_dict).update(elevation_deg=2.0, horizon_deg=2.0 + eps, state="visible")
    assert _validate(series_dict).samples[0].earth.state is VisibilityState.VISIBLE


# --- calculation basis -------------------------------------------------------------------


def test_terrain_aware_requires_terrain_source(series_dict: dict[str, Any]) -> None:
    series_dict["provenance"]["terrain_source"] = None
    with pytest.raises(ValidationError, match="terrain_source"):
        _validate(series_dict)


def test_geometric_only_rejects_horizon_values(series_dict: dict[str, Any]) -> None:
    series_dict["calculation_basis"] = "geometric_only"
    series_dict["provenance"]["terrain_source"] = None
    with pytest.raises(ValidationError, match="must not carry horizon_deg"):
        _validate(series_dict)


def test_geometric_only_rejects_terrain_source(series_dict: dict[str, Any]) -> None:
    series_dict["calculation_basis"] = "geometric_only"
    with pytest.raises(ValidationError, match="must not carry terrain_source"):
        _validate(series_dict)


# --- sampling and horizon profile --------------------------------------------------------


def test_max_gap_below_nominal_interval_rejected() -> None:
    with pytest.raises(ValidationError):
        SamplingInfo(nominal_interval_s=3600.0, max_gap_s=1800.0)


def test_irregular_sampling_allowed() -> None:
    assert SamplingInfo(nominal_interval_s=None, max_gap_s=7200.0).nominal_interval_s is None


@pytest.mark.parametrize("value", [0.0, -60.0])
def test_non_positive_sampling_rejected(value: float) -> None:
    with pytest.raises(ValidationError):
        SamplingInfo(nominal_interval_s=value, max_gap_s=3600.0)


def test_horizon_profile_length_mismatch_rejected() -> None:
    with pytest.raises(ValidationError, match="same length"):
        HorizonProfile(azimuths_deg=[0.0, 1.0], horizon_deg=[0.5])


def test_horizon_profile_unsorted_rejected() -> None:
    with pytest.raises(ValidationError, match="strictly increasing"):
        HorizonProfile(azimuths_deg=[0.0, 2.0, 1.0], horizon_deg=[0.5, 0.6, None])


def test_horizon_profile_allows_unknown_directions() -> None:
    assert HorizonProfile(azimuths_deg=[0.0, 1.0], horizon_deg=[0.5, None]).horizon_deg[1] is None
