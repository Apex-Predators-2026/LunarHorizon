"""Deterministic builders for SYNTHETIC test fixtures.

Every value here is hand-constructed for testing. Nothing is derived from NASA, JPL
Horizons, LOLA or any other real dataset, and the site is fictional. Angles are merely
plausible for a near-polar site (Sun within ~2 deg of the horizontal, Earth within ~7 deg).

Each fixture is specified by the *clearance* (elevation minus terrain horizon) of the Sun
and Earth at each sample time, which makes intended visibility transitions exact.
Sentinels: ``NO_DATA`` = ephemeris missing (all angles None, state unknown);
``UNKNOWN_TERRAIN`` = angles known but terrain horizon unknown (state unknown).
"""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from datetime import UTC, datetime, timedelta
from typing import Final

from ..enums import (
    AngleType,
    CalculationBasis,
    CommunicationMode,
    PowerSource,
    VisibilityCriterion,
    VisibilityState,
)
from ..inputs import (
    BodyObservation,
    HorizonProfile,
    Provenance,
    SamplingInfo,
    ScientificSample,
    ScientificTimeSeries,
)
from ..mission import LandingSite, MissionRequirements, MissionScenario, SpacecraftConfiguration

NO_DATA: Final = "no_data"
UNKNOWN_TERRAIN: Final = "unknown_terrain"
Clearance = float | str

T0: Final = datetime(2027, 1, 1, tzinfo=UTC)
HOUR_S: Final = 3600.0
# Synthetic approximation of the Sun's apparent angular radius seen from the Moon.
SUN_RADIUS_DEG: Final = 0.2666
# Mean synodic rate of the Sun's azimuth seen near the lunar pole (360 deg / 29.53 d).
SUN_AZ_RATE_DEG_PER_H: Final = 360.0 / (29.530589 * 24.0)
_DP: Final = 4  # decimal places written to JSON

SYNTHETIC_SITE: Final = LandingSite(
    id="synthetic-site-a",
    name="Synthetic Site A (fictional test location)",
    lat=-89.5,
    lon=0.0,
)


def _r(x: float) -> float:
    return round(x, _DP)


def disk_fraction(clearance_deg: float, radius_deg: float = SUN_RADIUS_DEG) -> float:
    """Fraction of a uniform disk above a straight horizon whose centre clears it by
    ``clearance_deg``. Flat-horizon approximation used for synthetic data only."""
    if clearance_deg >= radius_deg:
        return 1.0
    if clearance_deg <= -radius_deg:
        return 0.0
    d = clearance_deg / radius_deg
    return 1.0 - (math.acos(d) - d * math.sqrt(1.0 - d * d)) / math.pi


def _sun_angles(h: float) -> tuple[float, float]:
    az = (120.0 + SUN_AZ_RATE_DEG_PER_H * h) % 360.0
    el = 1.5 + 0.3 * math.sin(2.0 * math.pi * h / 72.0)
    return az, el


def _earth_angles(h: float) -> tuple[float, float]:
    az = (20.0 + 0.05 * h) % 360.0
    el = 3.0 + 0.02 * h
    return az, el


def _observation(
    az: float,
    el: float,
    clearance: Clearance,
    criterion: VisibilityCriterion,
    terrain: bool,
) -> BodyObservation:
    if clearance == NO_DATA:
        return BodyObservation(azimuth_deg=None, elevation_deg=None, horizon_deg=None, state=VisibilityState.UNKNOWN)
    az_r = _r(az) % 360.0
    if clearance == UNKNOWN_TERRAIN:
        return BodyObservation(azimuth_deg=az_r, elevation_deg=_r(el), horizon_deg=None, state=VisibilityState.UNKNOWN)
    assert isinstance(clearance, float)
    if terrain:
        el_r, horizon = _r(el), _r(el - clearance)
        actual = el_r - horizon
    else:  # geometric only: reference plane is the local horizontal, elevation = clearance
        el_r, horizon = _r(clearance), None
        actual = el_r
    if criterion is VisibilityCriterion.APPARENT_DISK:
        fraction = _r(disk_fraction(actual))
        state = (
            VisibilityState.NOT_VISIBLE
            if fraction == 0.0
            else VisibilityState.VISIBLE
            if fraction == 1.0
            else VisibilityState.PARTIAL
        )
        return BodyObservation(
            azimuth_deg=az_r, elevation_deg=el_r, horizon_deg=horizon, state=state, visible_fraction=fraction
        )
    # Centre criterion: visible only when the centre is strictly above the horizon.
    state = VisibilityState.VISIBLE if actual > 0.0 else VisibilityState.NOT_VISIBLE
    return BodyObservation(azimuth_deg=az_r, elevation_deg=el_r, horizon_deg=horizon, state=state)


def _provenance(notes: str, terrain: bool) -> Provenance:
    return Provenance(
        is_synthetic=True,
        ephemeris_source="SYNTHETIC: hand-constructed test values, not NASA/JPL-derived",
        terrain_source="SYNTHETIC: hand-constructed horizon values, not DEM-derived" if terrain else None,
        generated_at_utc=T0,
        generator="app.viability.fixtures.builders",
        notes=f"SYNTHETIC FIXTURE - NOT REAL DATA. {notes}",
    )


def _series(
    name: str,
    notes: str,
    hours: Sequence[float],
    sun: Callable[[float], Clearance],
    earth: Callable[[float], Clearance],
    *,
    nominal_interval_s: float | None = HOUR_S,
    max_gap_s: float = 1.5 * HOUR_S,
    coverage_hours: tuple[float, float] | None = None,
    basis: CalculationBasis = CalculationBasis.TERRAIN_AWARE,
    horizon_profile: HorizonProfile | None = None,
    sun_obs: Callable[[float], BodyObservation] | None = None,
) -> ScientificTimeSeries:
    terrain = basis is CalculationBasis.TERRAIN_AWARE
    samples = []
    for h in hours:
        s_az, s_el = _sun_angles(h)
        e_az, e_el = _earth_angles(h)
        samples.append(
            ScientificSample(
                time_utc=T0 + timedelta(hours=h),
                sun=sun_obs(h)
                if sun_obs
                else _observation(s_az, s_el, sun(h), VisibilityCriterion.APPARENT_DISK, terrain),
                earth=_observation(e_az, e_el, earth(h), VisibilityCriterion.CENTER, terrain),
            )
        )
    start_h, end_h = coverage_hours if coverage_hours else (hours[0], hours[-1])
    return ScientificTimeSeries(
        dataset_id=f"synthetic-{name.replace('_', '-')}",
        site=SYNTHETIC_SITE,
        observer_height_m=2.0,
        coverage_start_utc=T0 + timedelta(hours=start_h),
        coverage_end_utc=T0 + timedelta(hours=end_h),
        calculation_basis=basis,
        angle_type=AngleType.APPARENT,
        sun_criterion=VisibilityCriterion.APPARENT_DISK,
        earth_criterion=VisibilityCriterion.CENTER,
        sampling=SamplingInfo(nominal_interval_s=nominal_interval_s, max_gap_s=max_gap_s),
        provenance=_provenance(notes, terrain),
        horizon_profile=horizon_profile,
        samples=samples,
    )


def _hours(end: int, step: float = 1.0) -> list[float]:
    n = round(end / step)
    return [i * step for i in range(n + 1)]


def _const(value: float) -> Callable[[float], Clearance]:
    return lambda _h: value


# --- fixtures ---------------------------------------------------------------------------


def continuous_sunlight() -> ScientificTimeSeries:
    return _series(
        "continuous_sunlight",
        "Sun fully visible for all 24 h; Earth below the terrain horizon throughout.",
        _hours(24),
        _const(0.8),
        _const(-2.0),
    )


def continuous_darkness() -> ScientificTimeSeries:
    return _series(
        "continuous_darkness",
        "Sun fully below the terrain horizon for all 24 h; Earth visible throughout.",
        _hours(24),
        _const(-1.2),
        _const(2.0),
    )


def intermittent_sunlight() -> ScientificTimeSeries:
    return _series(
        "intermittent_sunlight",
        "Sun clearance 0.6*cos(2*pi*h/24) deg over 48 h: alternating lit/partial/dark; Earth visible.",
        _hours(48),
        lambda h: 0.6 * math.cos(2.0 * math.pi * h / 24.0),
        _const(2.0),
    )


def continuous_earth_visibility() -> ScientificTimeSeries:
    return _series(
        "continuous_earth_visibility",
        "Earth clearance 2+sin(2*pi*h/36) deg (always > 0) over 72 h at 2 h spacing; Sun intermittent.",
        _hours(72, 2.0),
        lambda h: 0.6 * math.cos(2.0 * math.pi * h / 36.0),
        lambda h: 2.0 + math.sin(2.0 * math.pi * h / 36.0),
        nominal_interval_s=2 * HOUR_S,
        max_gap_s=3 * HOUR_S,
    )


def intermittent_blackouts() -> ScientificTimeSeries:
    return _series(
        "intermittent_blackouts",
        "Earth clearance 1.5*sin(2*pi*h/16) deg over 48 h: ~8 h visible / ~8 h blackout; Sun lit.",
        _hours(48),
        _const(0.8),
        lambda h: 1.5 * math.sin(2.0 * math.pi * h / 16.0),
    )


def simultaneous_sun_earth() -> ScientificTimeSeries:
    return _series(
        "simultaneous_sun_earth",
        "Sun and Earth both periodic (24 h) with phase offset, so they overlap only part of the time.",
        _hours(48),
        lambda h: 0.8 * math.cos(2.0 * math.pi * h / 24.0),
        lambda h: 1.5 * math.sin(2.0 * math.pi * h / 24.0 + 0.5),
    )


def missing_samples() -> ScientificTimeSeries:
    absent = {8, 9, 10, 11, 12, 13}  # 7 h gap between 07:00 and 14:00 (> max_gap_s)
    return _series(
        "missing_samples",
        "Samples 08:00-13:00 absent (coverage gap); 03:00-04:00 ephemeris missing for both bodies; "
        "18:00 Earth ephemeris missing. Otherwise Sun lit, Earth visible.",
        [h for h in _hours(24) if h not in absent],
        lambda h: NO_DATA if h in (3.0, 4.0) else 0.8,
        lambda h: NO_DATA if h in (3.0, 4.0, 18.0) else 2.0,
    )


def _profile_horizon(az: float) -> float | None:
    return None if 130.0 <= az <= 140.0 else _r(0.4 + 0.5 * math.sin(math.radians(2.0 * az)))


UNKNOWN_TERRAIN_PROFILE: Final = HorizonProfile(
    azimuths_deg=[float(a) for a in range(0, 360, 5)],
    horizon_deg=[_profile_horizon(float(a)) for a in range(0, 360, 5)],
)


def _interp_profile(profile: HorizonProfile, az: float) -> float | None:
    azs, hs = profile.azimuths_deg, profile.horizon_deg
    for i, a0 in enumerate(azs):
        a1 = azs[(i + 1) % len(azs)] + (360.0 if i + 1 == len(azs) else 0.0)
        if a0 <= az <= a1:
            h0, h1 = hs[i], hs[(i + 1) % len(azs)]
            if h0 is None or h1 is None:
                return None
            return h0 + (h1 - h0) * (az - a0) / (a1 - a0)
    return None


def unknown_terrain() -> ScientificTimeSeries:
    def sun_obs(h: float) -> BodyObservation:
        az, _ = _sun_angles(h)
        el = 1.5
        horizon = _interp_profile(UNKNOWN_TERRAIN_PROFILE, _r(az))
        clearance: Clearance = UNKNOWN_TERRAIN if horizon is None else el - horizon
        return _observation(az, el, clearance, VisibilityCriterion.APPARENT_DISK, terrain=True)

    return _series(
        "unknown_terrain",
        "Horizon profile has no terrain data for azimuths 130-140 deg, so interpolation is impossible "
        "beyond 125 deg; the Sun passes 125 deg after ~10 h and its state becomes unknown (not dark). "
        "Earth visible in a known sector.",
        _hours(24),
        _const(0.0),  # unused: sun_obs overrides
        _const(2.0),
        horizon_profile=UNKNOWN_TERRAIN_PROFILE,
        sun_obs=sun_obs,
    )


def irregular_sampling() -> ScientificTimeSeries:
    hours = [0, 1, 2, 3, 4, 4.5, 4.75, 4.9, 5.0, 5.1, 5.25, 5.5, 6, 8, 10, 12]
    return _series(
        "irregular_sampling",
        "Irregular timestamps, densest around the sunset at 05:00 (Sun clearance 0.3*(5-h) deg); Earth visible.",
        [float(h) for h in hours],
        lambda h: 0.3 * (5.0 - h),
        _const(2.0),
        nominal_interval_s=None,
        max_gap_s=2 * HOUR_S,
    )


def mission_boundary() -> ScientificTimeSeries:
    return _series(
        "mission_boundary",
        "Coverage exactly 00:00-24:00 with samples on both bounds. Dark at the start (00-03 h) and "
        "end (21-24 h), lit between. Earth centre exactly on the horizon (clearance 0) at 12:00, "
        "which counts as not visible under the centre criterion.",
        _hours(24),
        lambda h: -0.8 if h <= 3 or h >= 21 else 0.8,
        lambda h: 0.0 if h == 12 else 2.0,
        coverage_hours=(0.0, 24.0),
    )


def geometric_only() -> ScientificTimeSeries:
    return _series(
        "geometric_only",
        "No terrain: visibility relative to the local horizontal plane only (horizon_deg null).",
        _hours(24),
        lambda h: 0.5 * math.cos(2.0 * math.pi * h / 24.0),
        _const(3.0),
        basis=CalculationBasis.GEOMETRIC_ONLY,
    )


FIXTURE_BUILDERS: Final[dict[str, Callable[[], ScientificTimeSeries]]] = {
    f.__name__: f
    for f in (
        continuous_sunlight,
        continuous_darkness,
        intermittent_sunlight,
        continuous_earth_visibility,
        intermittent_blackouts,
        simultaneous_sun_earth,
        missing_samples,
        unknown_terrain,
        irregular_sampling,
        mission_boundary,
        geometric_only,
    )
}


def example_scenario(series: ScientificTimeSeries, scenario_id: str = "synthetic-scenario") -> MissionScenario:
    """A synthetic solar/DTE lander scenario spanning a fixture's coverage period."""
    return MissionScenario(
        scenario_id=scenario_id,
        name="Synthetic solar lander (test only)",
        site=series.site,
        mission_start_utc=series.coverage_start_utc,
        mission_end_utc=series.coverage_end_utc,
        spacecraft=SpacecraftConfiguration(
            name="Synthetic lander",
            power_source=PowerSource.SOLAR,
            communication_mode=CommunicationMode.DIRECT_TO_EARTH,
            max_continuous_darkness_s=6 * HOUR_S,
            max_communication_blackout_s=10 * HOUR_S,
        ),
        requirements=MissionRequirements(min_sunlight_percent=50.0),
    )
