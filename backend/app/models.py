# Mirrors docs/interfaces.md and frontend/src/types.ts. Keep all three in sync.
from pydantic import BaseModel


class Site(BaseModel):
    id: str
    name: str
    lat: float  # degrees, negative = south
    lon: float  # degrees east


class BodyState(BaseModel):
    azimuth_deg: float
    elevation_deg: float
    horizon_deg: float  # terrain horizon elevation at this azimuth


class SunState(BodyState):
    visible_fraction: float  # portion of the solar disk above terrain, 0..1


class EarthState(BodyState):
    visible: bool
    margin_deg: float  # elevation_deg - horizon_deg


class TimelineStep(BaseModel):
    time_utc: str
    sun: SunState
    earth: EarthState
