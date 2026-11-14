"""Shared conventions, scalar types and the base model for the viability engine.

Units and conventions (normative; see docs/viability-engine.md):

* Time: timezone-aware UTC only. Naive datetimes, non-zero UTC offsets and numeric
  (Unix epoch) timestamps are rejected. Serialized as ISO 8601 with a ``Z`` suffix.
* Durations: seconds (float), field names end in ``_s``.
* Angles: degrees, field names end in ``_deg``.
* Percentages: 0..100, field names end in ``_percent``. Fractions: 0..1.
* Latitude: selenographic, degrees, north positive (south pole = -90).
* Longitude: degrees EAST positive, in [-180, 180], Moon mean-Earth/polar-axis (ME) frame.
* Azimuth: degrees clockwise from local north, in [0, 360). Undefined exactly at a pole.
* Elevation: degrees above the local horizontal plane (perpendicular to the local
  radius vector), in [-90, 90]. Terrain horizons may be negative (e.g. on a peak).
* Numbers are strict: booleans and numeric strings are contract errors, not coerced.
* "Unavailable" is ``None``; NaN/Inf are rejected. Zero is never a stand-in for unknown.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from pydantic import (
    AfterValidator,
    AwareDatetime,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    Strict,
    StringConstraints,
)

SCHEMA_VERSION = "0.1.0-draft"
# Version of the viability computations (re-exported by engine.py). Phase 3 = constraint verdicts.
ENGINE_VERSION = "0.4.0-phase4"

# Sanity cap on a single mission window. Not a physical limit; guards against typos.
MAX_MISSION_DURATION_S = 10 * 365.25 * 86400.0


def _reject_numeric_timestamp(value: Any) -> Any:
    # Epoch numbers are ambiguous (s vs ms) and carry no explicit zone; require ISO 8601.
    if isinstance(value, (int, float)):
        # ValueError (not TypeError): pydantic turns only ValueError into a ValidationError.
        raise ValueError(  # noqa: TRY004
            "numeric timestamps are not accepted; use ISO 8601 UTC, e.g. '2027-01-01T00:00:00Z'"
        )
    return value


def _require_utc(value: datetime) -> datetime:
    offset = value.utcoffset()
    if offset is None or offset != timedelta(0):
        raise ValueError("timestamp must be timezone-aware UTC (offset +00:00 / 'Z')")
    return value.astimezone(UTC)


# Aware datetime whose offset is exactly zero; stored as tzinfo=UTC.
UTCDatetime = Annotated[
    AwareDatetime,
    BeforeValidator(_reject_numeric_timestamp),
    AfterValidator(_require_utc),
]

Identifier = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")]
NonEmptyStr = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]

StrictBool = Annotated[bool, Strict()]  # JSON true/false only; "no", 0, "false" rejected
StrictFloat = Annotated[float, Strict()]
LatitudeDeg = Annotated[float, Strict(), Field(ge=-90.0, le=90.0)]
LongitudeDeg = Annotated[float, Strict(), Field(ge=-180.0, le=180.0)]
AzimuthDeg = Annotated[float, Strict(), Field(ge=0.0, lt=360.0)]
ElevationDeg = Annotated[float, Strict(), Field(ge=-90.0, le=90.0)]
DurationS = Annotated[float, Strict(), Field(ge=0.0)]
PositiveDurationS = Annotated[float, Strict(), Field(gt=0.0)]
Percent = Annotated[float, Strict(), Field(ge=0.0, le=100.0)]
Fraction = Annotated[float, Strict(), Field(ge=0.0, le=1.0)]
NonNegativeFloat = Annotated[float, Strict(), Field(ge=0.0)]
PositiveFloat = Annotated[float, Strict(), Field(gt=0.0)]


class ContractModel(BaseModel):
    """Base for every contract model: strict, immutable, JSON-safe floats."""

    model_config = ConfigDict(
        extra="forbid",  # unknown fields are contract errors, not silently dropped
        frozen=True,
        allow_inf_nan=False,  # NaN/Inf are not valid JSON; use None for "unavailable"
        use_enum_values=False,
    )
