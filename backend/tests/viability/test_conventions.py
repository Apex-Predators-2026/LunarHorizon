from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from app.viability.conventions import ContractModel, Identifier, LatitudeDeg, UTCDatetime


class _Stamp(ContractModel):
    t: UTCDatetime


class _Num(ContractModel):
    lat: LatitudeDeg


class _Id(ContractModel):
    id: Identifier


@pytest.mark.parametrize(
    "value",
    ["2027-01-01T00:00:00Z", "2027-01-01T00:00:00+00:00", datetime(2027, 1, 1, tzinfo=UTC)],
)
def test_utc_timestamps_accepted(value: object) -> None:
    stamp = _Stamp(t=value)  # type: ignore[arg-type]
    assert stamp.t == datetime(2027, 1, 1, tzinfo=UTC)
    assert stamp.t.tzinfo is UTC


@pytest.mark.parametrize(
    "value",
    [
        "2027-01-01T00:00:00",  # naive string
        datetime(2027, 1, 1),  # naive datetime
        "2027-01-01T05:00:00+05:00",  # aware but not UTC, even though same instant
        datetime(2027, 1, 1, tzinfo=timezone(timedelta(hours=-5))),
        1798761600,  # Unix epoch int
        1798761600.0,  # Unix epoch float
        "not a date",
    ],
)
def test_non_utc_or_ambiguous_timestamps_rejected(value: object) -> None:
    with pytest.raises(ValidationError):
        _Stamp(t=value)  # type: ignore[arg-type]


def test_timestamps_serialize_with_z_suffix() -> None:
    assert _Stamp(t="2027-01-01T00:00:00+00:00").model_dump_json() == '{"t":"2027-01-01T00:00:00Z"}'  # type: ignore[arg-type]


@pytest.mark.parametrize("value", [True, "-89.5", float("nan"), float("inf")])
def test_numbers_are_strict_and_finite(value: object) -> None:
    with pytest.raises(ValidationError):
        _Num(lat=value)  # type: ignore[arg-type]


def test_integer_accepted_for_float_field() -> None:
    assert _Num.model_validate_json('{"lat": -89}').lat == -89.0


def test_unknown_fields_rejected() -> None:
    with pytest.raises(ValidationError):
        _Num.model_validate({"lat": -89.0, "latitude": -89.0})


def test_models_are_immutable() -> None:
    n = _Num(lat=-89.0)
    with pytest.raises(ValidationError):
        n.lat = 0.0


@pytest.mark.parametrize("value", ["", "has space", "-leading-dash", "a" * 65, "émoji"])
def test_identifier_rejects_malformed(value: str) -> None:
    with pytest.raises(ValidationError):
        _Id(id=value)


@pytest.mark.parametrize("value", ["shackleton-peak", "site_01", "A.b-c_9"])
def test_identifier_accepts_well_formed(value: str) -> None:
    assert _Id(id=value).id == value
