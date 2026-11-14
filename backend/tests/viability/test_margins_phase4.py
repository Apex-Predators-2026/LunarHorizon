"""Phase 4A operational margins: signed headroom per constraint (docs: margins.py module docstring).

Expected values are derived by hand from the per-hour states of SYNTHETIC series (each hourly
sample holds exactly one hour under sample-and-hold), or independently from the raw columns of
Member 1's real site files with NumPy. They never come from the engine's own output.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from pydantic import ValidationError

from app.viability import analyze_scenario, prepare_series
from app.viability.adapters import load_site_file
from app.viability.constraints import assess_constraints
from app.viability.enums import (
    CommunicationMode,
    Comparison,
    ConstraintId,
    ConstraintStatus,
    Eligibility,
    MetricStatus,
    PowerSource,
    Unit,
    UnknownReason,
)
from app.viability.inputs import ScientificTimeSeries
from app.viability.margins import (
    NARROW_MARGIN_FRACTION,
    MarginAssessment,
    MarginBasis,
    MarginClass,
    assess_margin,
    assess_margins,
    classify_margin,
    compute_margins,
    margin_bounds,
    margin_interval,
    margins_from_assessment,
    margins_from_constraints,
    operational_margin,
    relative_margin,
    signed_margin,
)
from app.viability.mission import MissionRequirements, MissionScenario, SpacecraftConfiguration
from app.viability.outputs import ConstraintAssessment, ConstraintEvaluation, Metric, OperationalMargin
from app.viability.windows import PreparedSeries

from .helpers import at, constraint, hourly

H = 3600.0
C = ConstraintId
PASS, FAIL, UNKNOWN, NA = (
    ConstraintStatus.PASS,
    ConstraintStatus.FAIL,
    ConstraintStatus.UNKNOWN,
    ConstraintStatus.NOT_APPLICABLE,
)
AT_LEAST, AT_MOST = Comparison.AT_LEAST, Comparison.AT_MOST
MC = MarginClass


def scenario(
    series: ScientificTimeSeries,
    hours: float,
    *,
    start_h: float = 0.0,
    dark_h: float | None = None,
    blackout_h: float | None = None,
    threshold: float | None = None,
    **req: Any,
) -> MissionScenario:
    return MissionScenario(
        scenario_id="phase4-margins-test",
        site=series.site,
        mission_start_utc=at(start_h),
        mission_end_utc=at(start_h + hours),
        spacecraft=SpacecraftConfiguration(
            name="Synthetic lander",
            power_source=PowerSource.SOLAR,
            communication_mode=CommunicationMode.DIRECT_TO_EARTH,
            max_continuous_darkness_s=None if dark_h is None else dark_h * H,
            max_communication_blackout_s=None if blackout_h is None else blackout_h * H,
            solar_power_min_disk_fraction=threshold,
        ),
        requirements=MissionRequirements(**req),
    )


def assessed(series: ScientificTimeSeries, hours: float, **kw: Any) -> ConstraintAssessment:
    return assess_constraints(scenario(series, hours, **kw), series)


def margin_of(series: ScientificTimeSeries, hours: float, cid: ConstraintId, **kw: Any) -> MarginAssessment:
    [m] = [m for m in assess_margins(assessed(series, hours, **kw)) if m.constraint_id is cid]
    return m


def known(m: MarginAssessment) -> float:
    assert m.margin.value.status is MetricStatus.KNOWN and m.margin.value.value is not None
    return m.margin.value.value


def bounds(m: MarginAssessment) -> tuple[float, float]:
    v = m.margin.value
    assert v.status is MetricStatus.BOUNDED and v.lower is not None and v.upper is not None
    return v.lower, v.upper


def handmade(value: Metric, reference: float | None = 50.0) -> OperationalMargin:
    return OperationalMargin(
        margin_id="handmade",
        related_constraint=C.MIN_SUNLIGHT_PERCENT,
        reference=reference,
        value=value,
        description="t",
    )


# Dark 2-4 h (3 h); Earth blocked 6-7 h (2 h); sunlight 7/10 = 70 %; Earth 8/10 = 80 %.
SUN10 = ["V", "V", "N", "N", "N", "V", "V", "V", "V", "V"]
EARTH10 = ["V", "V", "V", "V", "V", "V", "N", "N", "V", "V"]


# --- 1-5, 10-12: pure margin arithmetic (hand values) ------------------------------------------


@pytest.mark.parametrize(
    ("comparison", "threshold", "observed", "expected"),
    [
        (AT_LEAST, 50.0, 62.5, 12.5),  # minimum, headroom
        (AT_LEAST, 50.0, 50.0, 0.0),  # minimum, exactly at threshold
        (AT_LEAST, 50.0, 40.0, -10.0),  # minimum, violated
        (AT_MOST, 50 * H, 36 * H, 14 * H),  # maximum, headroom
        (AT_MOST, 50 * H, 50 * H, 0.0),  # maximum, exactly at limit
        (AT_MOST, 50 * H, 53 * H, -3 * H),  # maximum, violated
        (AT_LEAST, 0.0, 0.0, 0.0),  # zero threshold, zero observation
        (AT_LEAST, 0.0, 0.25, 0.25),  # zero threshold: margin = observation
    ],
)
def test_signed_margin(comparison: Comparison, threshold: float, observed: float, expected: float) -> None:
    assert signed_margin(comparison, threshold, observed) == expected


def test_representation_tolerance_snaps_to_exact_zero_only() -> None:
    # Rescue's 0.55 * 100 = 55.00000000000001 is the same number as 55 (Phase 3 tolerance).
    assert 0.55 * 100 != 55.0
    assert signed_margin(AT_LEAST, 55.0, 0.55 * 100) == 0.0
    assert signed_margin(AT_MOST, 55.0, 0.55 * 100) == 0.0
    # 1e-9 relative is a real difference, kept with its sign.
    assert signed_margin(AT_MOST, 55.0, 55.0 * (1 + 1e-9)) < 0.0
    assert signed_margin(AT_LEAST, 55.0, 55.0 * (1 + 1e-9)) > 0.0
    # No absolute tolerance at a zero threshold: the tiniest observation is real headroom.
    assert signed_margin(AT_LEAST, 0.0, 1e-300) == 1e-300


@pytest.mark.parametrize(
    ("comparison", "threshold", "lower", "upper", "expected"),
    [
        (AT_LEAST, 50.0, 40.0, 70.0, (-10.0, 20.0)),  # [L - t, U - t]
        (AT_MOST, 10.0, 4.0, 12.0, (-2.0, 6.0)),  # [t - U, t - L]: order flips
        (AT_LEAST, 50.0, 60.0, 80.0, (10.0, 30.0)),
        (AT_MOST, 10.0, 11.0, 15.0, (-5.0, -1.0)),
        (AT_MOST, 10.0, 3.0, 3.0, (7.0, 7.0)),  # degenerate bounds = point
    ],
)
def test_margin_interval_ordering(
    comparison: Comparison, threshold: float, lower: float, upper: float, expected: tuple[float, float]
) -> None:
    got = margin_interval(comparison, threshold, lower, upper)
    assert got == expected and got[0] <= got[1]


def test_margin_interval_rejects_inverted_bounds() -> None:
    with pytest.raises(ValueError, match="exceeds"):
        margin_interval(AT_LEAST, 1.0, 2.0, 1.0)


# --- classification and normalisation on hand-made margins -------------------------------------


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (Metric.known(20.0, Unit.PERCENT), MC.COMFORTABLE),
        (Metric.known(5.0, Unit.PERCENT), MC.COMFORTABLE),  # exactly 10 % of 50: not below the band
        (Metric.known(4.999, Unit.PERCENT), MC.NARROW),
        (Metric.known(0.0, Unit.PERCENT), MC.AT_THRESHOLD),
        (Metric.known(-0.001, Unit.PERCENT), MC.NEGATIVE),
        (Metric.bounded(10.0, 30.0, Unit.PERCENT), MC.COMFORTABLE),
        (Metric.bounded(1.0, 30.0, Unit.PERCENT), MC.NARROW),  # judged by the least favourable bound
        (Metric.bounded(0.0, 30.0, Unit.PERCENT), MC.AT_THRESHOLD),
        (Metric.bounded(-5.0, 15.0, Unit.PERCENT), MC.UNCERTAIN),  # crosses zero
        (Metric.bounded(-5.0, 0.0, Unit.PERCENT), MC.UNCERTAIN),  # best case exactly at limit
        (Metric.bounded(-20.0, -10.0, Unit.PERCENT), MC.NEGATIVE),
        (Metric.unavailable(Unit.DEGREES, "unsupported"), MC.UNSUPPORTED),
        (Metric.not_applicable(Unit.PERCENT), MC.NOT_APPLICABLE),
    ],
)
def test_classification_uses_least_favourable_bound(value: Metric, expected: MarginClass) -> None:
    assert classify_margin(handmade(value)) is expected


def test_narrow_band_is_configurable_and_zero_threshold_has_none() -> None:
    m = handmade(Metric.known(8.0, Unit.PERCENT))
    assert classify_margin(m) is MC.COMFORTABLE  # 8 >= 5
    assert classify_margin(m, narrow_fraction=0.2) is MC.NARROW  # 8 < 10
    assert classify_margin(m, narrow_fraction=0.0) is MC.COMFORTABLE
    # Zero threshold: no relative band and no division (relative margin undefined).
    z = handmade(Metric.known(0.5, Unit.PERCENT), reference=0.0)
    assert classify_margin(z) is MC.COMFORTABLE
    assert relative_margin(z) is None
    with pytest.raises(ValueError, match="narrow_fraction"):
        classify_margin(m, narrow_fraction=-0.1)
    with pytest.raises(ValueError, match="time_resolution_s"):
        classify_margin(m, time_resolution_s=float("nan"))


def test_time_resolution_only_applies_to_durations_and_only_tightens() -> None:
    dur = OperationalMargin(
        margin_id="d",
        related_constraint=C.MAX_CONTINUOUS_DARKNESS,
        reference=3.5 * H,
        value=Metric.known(0.5 * H, Unit.SECONDS),  # 0.5 / 3.5 = 14 % of the limit
        description="t",
    )
    assert classify_margin(dur) is MC.COMFORTABLE
    assert classify_margin(dur, time_resolution_s=H) is MC.NARROW  # below one hourly sample spacing
    assert classify_margin(dur, time_resolution_s=0.5 * H) is MC.COMFORTABLE  # equal to it: resolved
    pct = handmade(Metric.known(20.0, Unit.PERCENT))
    assert classify_margin(pct, time_resolution_s=1e9) is MC.COMFORTABLE  # not a duration


def test_relative_margin_divides_by_positive_reference_only() -> None:
    assert relative_margin(handmade(Metric.known(12.5, Unit.PERCENT))) == Metric.known(0.25, Unit.FRACTION)
    r = relative_margin(handmade(Metric.bounded(-10.0, 20.0, Unit.PERCENT, "why")))
    assert r == Metric.bounded(-0.2, 0.4, Unit.FRACTION, "why")
    assert relative_margin(handmade(Metric.known(1.0, Unit.DEGREES), reference=-2.0)) is None
    assert relative_margin(handmade(Metric.not_applicable(Unit.PERCENT), reference=None)) is None
    assert relative_margin(handmade(Metric.unavailable(Unit.DEGREES, "x"), reference=2.0)) is None


def test_margin_bounds() -> None:
    assert margin_bounds(handmade(Metric.known(3.0, Unit.PERCENT))) == (3.0, 3.0)
    assert margin_bounds(handmade(Metric.bounded(-1.0, 2.0, Unit.PERCENT))) == (-1.0, 2.0)
    assert margin_bounds(handmade(Metric.unavailable(Unit.PERCENT, "x"))) is None


# --- 1-5, 10-11: every supported constraint on synthetic data ----------------------------------


@pytest.mark.parametrize(
    ("limit_h", "margin_h", "status", "cls"),
    [
        (5.0, 2.0, PASS, MC.COMFORTABLE),  # longest dark 3 h; 2 h >= 0.5 h band and >= 1 h spacing
        (3.0, 0.0, PASS, MC.AT_THRESHOLD),
        (2.0, -1.0, FAIL, MC.NEGATIVE),
        (3.25, 0.25, PASS, MC.NARROW),  # 0.25 h < 10 % of 3.25 h
        (3.5, 0.5, PASS, MC.NARROW),  # 14 % of the limit, but below the 1 h sample spacing
    ],
)
def test_max_continuous_darkness(limit_h: float, margin_h: float, status: ConstraintStatus, cls: MarginClass) -> None:
    m = margin_of(hourly(SUN10), 10, C.MAX_CONTINUOUS_DARKNESS, dark_h=limit_h)
    assert known(m) == margin_h * H
    assert (m.constraint_status, m.classification, m.basis) == (status, cls, MarginBasis.MEASURED)
    assert m.margin.reference == limit_h * H and m.margin.value.unit is Unit.SECONDS
    assert m.relative == Metric.known(margin_h / limit_h, Unit.FRACTION)
    assert m.time_resolution_s == H


@pytest.mark.parametrize(("limit_h", "margin_h"), [(3.0, 1.0), (2.0, 0.0), (1.0, -1.0)])
def test_max_communication_blackout(limit_h: float, margin_h: float) -> None:
    m = margin_of(hourly(SUN10, EARTH10), 10, C.MAX_COMMUNICATION_BLACKOUT, blackout_h=limit_h)
    assert known(m) == margin_h * H  # longest blackout 6-8 h = 2 h


@pytest.mark.parametrize(
    ("required", "margin_pp", "cls"),
    [(50.0, 20.0, MC.COMFORTABLE), (65.0, 5.0, MC.NARROW), (70.0, 0.0, MC.AT_THRESHOLD), (80.0, -10.0, MC.NEGATIVE)],
)
def test_min_sunlight_percent(required: float, margin_pp: float, cls: MarginClass) -> None:
    m = margin_of(hourly(SUN10), 10, C.MIN_SUNLIGHT_PERCENT, min_sunlight_percent=required)
    assert known(m) == pytest.approx(margin_pp, abs=1e-12)  # 70 % measured; unit: percentage points
    assert m.margin.value.unit is Unit.PERCENT and m.classification is cls


def test_min_earth_visibility_percent() -> None:
    m = margin_of(hourly(SUN10, EARTH10), 10, C.MIN_EARTH_VISIBILITY_PERCENT, min_earth_visibility_percent=60.0)
    assert known(m) == pytest.approx(20.0, abs=1e-12)  # 80 - 60


def test_min_simultaneous_percent() -> None:
    # Power-lit (= direct, no threshold) and Earth visible only in hour 0: 25 %.
    s = hourly(["V", "V", "N", "N"], ["V", "N", "V", "N"])
    assert known(margin_of(s, 4, C.MIN_SIMULTANEOUS_PERCENT, min_simultaneous_percent=20.0)) == pytest.approx(5.0)
    assert known(margin_of(s, 4, C.MIN_SIMULTANEOUS_PERCENT, min_simultaneous_percent=30.0)) == pytest.approx(-5.0)


def test_min_mean_solar_disk_fraction_keeps_fraction_unit() -> None:
    s = hourly(["V", 0.5, "N", "V"])  # mean fraction (1 + 0.5 + 0 + 1) / 4 = 0.625
    m = margin_of(s, 4, C.MIN_MEAN_SOLAR_DISK_FRACTION, min_mean_solar_disk_fraction=0.5)
    assert known(m) == pytest.approx(0.125, abs=1e-12)
    assert m.margin.value.unit is Unit.FRACTION
    assert m.relative is not None and m.relative.value == pytest.approx(0.25)


@pytest.mark.parametrize(("required_h", "margin_h"), [(3.0, 1.0), (4.0, 0.0), (6.0, -2.0)])
def test_min_initial_sunlight(required_h: float, margin_h: float) -> None:
    s = hourly(["V"] * 4 + ["N"] * 6)  # 4 h power-lit from landing
    assert known(margin_of(s, 10, C.MIN_INITIAL_SUNLIGHT, min_initial_sunlight_s=required_h * H)) == margin_h * H


def test_min_initial_sunlight_uses_panel_threshold() -> None:
    # 0.2 of the disk at hours 2-3: direct sunlight, but power-dark for a 0.25 panel threshold.
    s = hourly(["V", "V", 0.2, 0.2, "V", "V"])
    no_panel = margin_of(s, 6, C.MIN_INITIAL_SUNLIGHT, min_initial_sunlight_s=3 * H)
    panel = margin_of(s, 6, C.MIN_INITIAL_SUNLIGHT, min_initial_sunlight_s=3 * H, threshold=0.25)
    assert known(no_panel) == 3 * H  # direct sunlight 6 h from landing
    assert known(panel) == -1 * H  # power-lit only 2 h


def test_min_initial_earth_visibility() -> None:
    s = hourly(["V"] * 6, ["V", "V", "N", "V", "V", "V"])
    m = margin_of(s, 6, C.MIN_INITIAL_EARTH_VISIBILITY, min_initial_earth_visibility_s=1.5 * H)
    assert known(m) == 0.5 * H


def test_different_units_are_never_mixed() -> None:
    a = assessed(
        hourly(SUN10, EARTH10),
        10,
        dark_h=5.0,
        min_sunlight_percent=50.0,
        min_mean_solar_disk_fraction=0.5,
        min_earth_clearance_deg=1.0,
    )
    units = {m.constraint_id: m.margin.value.unit for m in assess_margins(a)}
    expected = {c.constraint_id: c.unit for c in a.constraints}
    assert units == expected
    assert units[C.MAX_CONTINUOUS_DARKNESS] is Unit.SECONDS
    assert units[C.MIN_SUNLIGHT_PERCENT] is Unit.PERCENT
    assert units[C.MIN_MEAN_SOLAR_DISK_FRACTION] is Unit.FRACTION
    assert units[C.MIN_EARTH_CLEARANCE] is Unit.DEGREES


# --- 6-9: bounds propagation, partially and completely unknown data -----------------------------

GAPPY = ["V", "V", "U", "U", "V", "V", "V", "V", "V", "V"]  # direct sunlight in [80, 100] %, dark in [0, 2] h


@pytest.mark.parametrize(
    ("required", "expected", "status", "cls"),
    [
        (70.0, (10.0, 30.0), PASS, MC.COMFORTABLE),
        (80.0, (0.0, 20.0), PASS, MC.AT_THRESHOLD),
        (85.0, (-5.0, 15.0), UNKNOWN, MC.UNCERTAIN),  # bounds cross zero
        (100.0, (-20.0, 0.0), UNKNOWN, MC.UNCERTAIN),
    ],
)
def test_bounded_minimum_margin(
    required: float, expected: tuple[float, float], status: ConstraintStatus, cls: MarginClass
) -> None:
    m = margin_of(hourly(GAPPY), 10, C.MIN_SUNLIGHT_PERCENT, min_sunlight_percent=required)
    assert bounds(m) == pytest.approx(expected, abs=1e-12)
    assert (m.constraint_status, m.classification, m.basis) == (status, cls, MarginBasis.BOUNDED)
    assert m.worst_case == pytest.approx(expected[0], abs=1e-12)
    assert m.best_case == pytest.approx(expected[1], abs=1e-12)
    assert m.margin.value.reason  # the metric's reason for the bounds is carried over


@pytest.mark.parametrize(
    ("limit_h", "expected_h", "status", "cls"),
    [
        (5.0, (3.0, 5.0), PASS, MC.COMFORTABLE),  # [t - U, t - L] = [5 - 2, 5 - 0]
        (2.0, (0.0, 2.0), PASS, MC.AT_THRESHOLD),
        (1.0, (-1.0, 1.0), UNKNOWN, MC.UNCERTAIN),
    ],
)
def test_bounded_maximum_margin_flips_bounds(
    limit_h: float, expected_h: tuple[float, float], status: ConstraintStatus, cls: MarginClass
) -> None:
    m = margin_of(hourly(GAPPY), 10, C.MAX_CONTINUOUS_DARKNESS, dark_h=limit_h)
    assert bounds(m) == (expected_h[0] * H, expected_h[1] * H)
    assert (m.constraint_status, m.classification) == (status, cls)
    r = m.relative
    assert r is not None and (r.lower, r.upper) == pytest.approx((expected_h[0] / limit_h, expected_h[1] / limit_h))


def test_bounds_prove_a_negative_margin() -> None:
    s = hourly(["N", "N", "N", "U", "N", "N", "N", "N", "N", "N"])  # dark in [6, 10] h, sun in [0, 10] %
    dark = margin_of(s, 10, C.MAX_CONTINUOUS_DARKNESS, dark_h=5.0)
    assert bounds(dark) == (-5 * H, -1 * H) and dark.classification is MC.NEGATIVE
    sun = margin_of(s, 10, C.MIN_SUNLIGHT_PERCENT, min_sunlight_percent=20.0)
    assert bounds(sun) == pytest.approx((-20.0, -10.0)) and sun.constraint_status is FAIL


def test_unknown_earth_widens_blackout_margin_instead_of_counting_as_blackout() -> None:
    s = hourly(["V"] * 6, ["V", "U", "U", "U", "V", "V"])  # confirmed blackout 0 h, possible 3 h
    m = margin_of(s, 6, C.MAX_COMMUNICATION_BLACKOUT, blackout_h=2.0)
    assert bounds(m) == (-1 * H, 2 * H) and m.classification is MC.UNCERTAIN


ALL_UNKNOWN = ["X"] * 10


@pytest.mark.parametrize(
    ("cid", "kw", "expected", "cls"),
    [
        (C.MIN_SUNLIGHT_PERCENT, {"min_sunlight_percent": 10.0}, (-10.0, 90.0), MC.UNCERTAIN),
        (C.MIN_SUNLIGHT_PERCENT, {"min_sunlight_percent": 0.0}, (0.0, 100.0), MC.AT_THRESHOLD),
        (C.MAX_CONTINUOUS_DARKNESS, {"dark_h": 9.0}, (-1 * H, 9 * H), MC.UNCERTAIN),
        (C.MAX_CONTINUOUS_DARKNESS, {"dark_h": 10.0}, (0.0, 10 * H), MC.AT_THRESHOLD),
        (C.MAX_CONTINUOUS_DARKNESS, {"dark_h": 12.0}, (2 * H, 12 * H), MC.COMFORTABLE),
        (C.MIN_INITIAL_SUNLIGHT, {"min_initial_sunlight_s": 11 * H}, (-11 * H, -1 * H), MC.NEGATIVE),
        (C.MIN_MEAN_SOLAR_DISK_FRACTION, {"min_mean_solar_disk_fraction": 0.1}, (-0.1, 0.9), MC.UNCERTAIN),
    ],
)
def test_completely_unknown_metric_gives_admissible_range_margin_never_a_point(
    cid: ConstraintId, kw: dict[str, Any], expected: tuple[float, float], cls: MarginClass
) -> None:
    m = margin_of(hourly(ALL_UNKNOWN), 10, cid, **kw)
    assert m.basis is MarginBasis.ADMISSIBLE_RANGE
    assert m.margin.value.status is MetricStatus.BOUNDED  # never KNOWN from unknown data
    assert bounds(m) == pytest.approx(expected)
    assert m.classification is cls
    assert m.margin.value.reason is not None and "admissible range" in m.margin.value.reason
    assert "not observations" in m.margin.description


def test_fully_unknown_data_never_yields_a_negative_margin_by_assumption() -> None:
    s = hourly(ALL_UNKNOWN, ["U"] * 10)
    a = assessed(s, 10, dark_h=5.0, blackout_h=5.0, min_sunlight_percent=50.0, min_earth_visibility_percent=1.0)
    ms = [m for m in assess_margins(a) if m.constraint_status is not NA]
    assert ms and all(m.classification is MC.UNCERTAIN for m in ms)
    assert all(m.best_case is not None and m.best_case >= 0.0 for m in ms)


# --- 12-14: zero thresholds, missing optional constraints, unsupported requirements ------------


def test_zero_thresholds() -> None:
    s = hourly(["N"] + ["V"] * 9)
    pct = margin_of(s, 10, C.MIN_SUNLIGHT_PERCENT, min_sunlight_percent=0.0)
    assert known(pct) == pytest.approx(90.0) and pct.relative is None and pct.classification is MC.COMFORTABLE
    init = margin_of(s, 10, C.MIN_INITIAL_SUNLIGHT, min_initial_sunlight_s=0.0)
    assert known(init) == 0.0 and init.classification is MC.AT_THRESHOLD and init.relative is None
    frac = margin_of(s, 10, C.MIN_MEAN_SOLAR_DISK_FRACTION, min_mean_solar_disk_fraction=0.0)
    assert known(frac) == pytest.approx(0.9) and frac.relative is None


def test_unconfigured_constraints_stay_not_applicable() -> None:
    s = hourly(SUN10)
    ms = assess_margins(assessed(s, 10))
    assert [m.constraint_id for m in ms] == list(ConstraintId)  # one per constraint, enum order
    for m in ms:
        assert m.constraint_status is NA and m.classification is MC.NOT_APPLICABLE
        assert m.margin.value == Metric.not_applicable(m.margin.value.unit)
        assert m.margin.reference is None and m.relative is None and m.basis is MarginBasis.NONE
        assert m.worst_case is None and m.best_case is None


def test_only_configured_constraints_get_numeric_margins() -> None:
    ms = assess_margins(assessed(hourly(SUN10), 10, dark_h=5.0))
    numeric = {m.constraint_id for m in ms if m.worst_case is not None}
    assert numeric == {C.MAX_CONTINUOUS_DARKNESS}


@pytest.mark.parametrize(
    ("cid", "field", "value"),
    [
        (C.MIN_SUN_CLEARANCE, "min_sun_clearance_deg", 2.0),
        (C.MIN_EARTH_CLEARANCE, "min_earth_clearance_deg", 2.0),
        (C.MIN_EARTH_CLEARANCE, "min_earth_clearance_deg", -1.0),
        (C.MIN_SUN_CLEARANCE, "min_sun_clearance_deg", 0.0),
    ],
)
def test_unsupported_clearance_has_no_computed_margin(cid: ConstraintId, field: str, value: float) -> None:
    s = hourly(["V"] * 4)  # mean clearance is known (+1 deg Sun, +2 deg Earth) but is not used
    a = assessed(s, 4, **{field: value})
    assert a.environment.metrics.mean_sun_clearance.status is MetricStatus.KNOWN
    [m] = [m for m in assess_margins(a) if m.constraint_id is cid]
    assert m.constraint_status is UNKNOWN and m.classification is MC.UNSUPPORTED
    assert m.margin.value.status is MetricStatus.UNAVAILABLE
    assert m.margin.value.reason is not None and m.margin.value.reason.startswith("unsupported")
    assert m.margin.reference == value and m.relative is None and m.basis is MarginBasis.NONE
    assert m.worst_case is None


# --- 15-16: mission clipping and dataset coverage -----------------------------------------------


def test_darkness_spanning_landing_is_mission_scoped_and_flagged() -> None:
    s = hourly(["N", "N", "N", "V", "V", "V"])  # dark 0-3 h; landing at 1 h sees 2 h of it
    m = margin_of(s, 4, C.MAX_CONTINUOUS_DARKNESS, start_h=1.0, dark_h=3.0)
    assert known(m) == 1 * H
    assert m.clipped_at_mission_start and not m.clipped_at_mission_end


def test_outage_through_mission_end_is_mission_scoped_and_flagged() -> None:
    s = hourly(["V"] * 7 + ["N"] * 4 + ["V"])  # dark 7-11 h; a 10 h mission sees 3 h
    m = margin_of(s, 10, C.MAX_CONTINUOUS_DARKNESS, dark_h=4.0)
    assert known(m) == 1 * H
    assert m.clipped_at_mission_end and not m.clipped_at_mission_start


def test_unclipped_outage_is_not_flagged() -> None:
    m = margin_of(hourly(SUN10), 10, C.MAX_CONTINUOUS_DARKNESS, dark_h=5.0)
    assert not m.clipped_at_mission_start and not m.clipped_at_mission_end


def test_initial_requirement_longer_than_the_mission() -> None:
    m = margin_of(hourly(["V"] * 10), 10, C.MIN_INITIAL_SUNLIGHT, min_initial_sunlight_s=11 * H)
    assert known(m) == -1 * H and m.constraint_status is FAIL
    assert m.clipped_at_mission_end  # lit through mission end: the metric is limited by the mission
    assert "exceeds the mission duration" in m.margin.description


def test_mission_partially_beyond_dataset_coverage() -> None:
    s = hourly(["V"] * 10)  # 10 h of data, 14 h mission: 4 h unknown
    ms = {m.constraint_id: m for m in assess_margins(assessed(s, 14, dark_h=4.0, min_sunlight_percent=70.0))}
    sun = ms[C.MIN_SUNLIGHT_PERCENT]
    assert bounds(sun) == pytest.approx((100 * 10 / 14 - 70.0, 30.0))  # [1.43, 30] pp
    assert sun.classification is MC.NARROW  # proven 1.43 pp < 7 pp band
    dark = ms[C.MAX_CONTINUOUS_DARKNESS]
    assert bounds(dark) == (0.0, 4 * H) and dark.classification is MC.AT_THRESHOLD
    shorter = margin_of(s, 14, C.MAX_CONTINUOUS_DARKNESS, dark_h=3.0)
    assert bounds(shorter) == (-1 * H, 3 * H) and shorter.classification is MC.UNCERTAIN


def test_mission_entirely_outside_coverage() -> None:
    s = hourly(["V"] * 10)
    a = assessed(s, 10, start_h=20.0, min_sunlight_percent=50.0, dark_h=5.0)
    assert a.environment.data_quality.uncovered_duration_s == 10 * H
    for m in assess_margins(a):
        if m.constraint_status is not NA:
            assert m.basis is MarginBasis.ADMISSIBLE_RANGE and m.classification is MC.UNCERTAIN
    assert bounds(margin_of(s, 10, C.MAX_CONTINUOUS_DARKNESS, start_h=20.0, dark_h=5.0)) == (-5 * H, 5 * H)


# --- 17: deterministic serialisation ------------------------------------------------------------


def test_margins_serialise_deterministically_and_round_trip() -> None:
    def run() -> tuple[str, str]:
        a = assessed(hourly(GAPPY), 10, dark_h=1.0, min_sunlight_percent=85.0, min_earth_clearance_deg=1.0)
        margins = margins_from_assessment(a)
        payload = json.dumps([m.model_dump(mode="json") for m in margins], sort_keys=True)
        rich = json.dumps([m.model_dump(mode="json") for m in assess_margins(a)], sort_keys=True)
        return payload, rich

    first, second = run(), run()
    assert first == second
    margins = margins_from_assessment(
        assessed(hourly(GAPPY), 10, dark_h=1.0, min_sunlight_percent=85.0, min_earth_clearance_deg=1.0)
    )
    for m in margins:
        assert OperationalMargin.model_validate_json(m.model_dump_json()) == m
    for ma in assess_margins(assessed(hourly(GAPPY), 10, dark_h=1.0)):
        assert MarginAssessment.model_validate_json(ma.model_dump_json()) == ma
    # Enum values serialise as stable lowercase strings.
    dumped = json.loads(first[1])
    assert {d["classification"] for d in dumped} <= {c.value for c in MarginClass}


# --- 18: margins never change verdicts or eligibility -------------------------------------------


def test_margins_do_not_mutate_the_assessment() -> None:
    a = assessed(hourly(GAPPY), 10, dark_h=1.0, min_sunlight_percent=80.0, min_earth_clearance_deg=1.0)
    before = a.model_dump_json()
    ms = assess_margins(a)
    margins_from_assessment(a)
    assert a.model_dump_json() == before
    assert a.eligibility is Eligibility.UNKNOWN
    assert [m.constraint_status for m in ms] == [c.status for c in a.constraints]


def test_small_margin_pass_is_still_pass_and_negative_fail_is_still_fail() -> None:
    narrow = margin_of(hourly(SUN10), 10, C.MAX_CONTINUOUS_DARKNESS, dark_h=3.25)
    assert narrow.classification is MC.NARROW and narrow.constraint_status is PASS
    neg = margin_of(hourly(SUN10), 10, C.MAX_CONTINUOUS_DARKNESS, dark_h=2.0)
    assert neg.classification is MC.NEGATIVE and neg.constraint_status is FAIL


def test_margin_assessment_rejects_a_classification_contradicting_the_verdict() -> None:
    good = margin_of(hourly(SUN10), 10, C.MAX_CONTINUOUS_DARKNESS, dark_h=5.0)
    data = good.model_dump()
    data["classification"] = MC.NEGATIVE  # contradicts PASS
    with pytest.raises(ValidationError, match="contradicts verdict"):
        MarginAssessment.model_validate(data)


def test_inconsistent_evaluation_is_refused_not_redecided() -> None:
    e = ConstraintEvaluation(
        constraint_id=C.MIN_SUNLIGHT_PERCENT,
        status=PASS,  # but 40 % < 50 %
        threshold=50.0,
        unit=Unit.PERCENT,
        measured=Metric.known(40.0, Unit.PERCENT),
        message="hand-made",
    )
    with pytest.raises(ValueError, match="margin implies 'fail'"):
        operational_margin(e, 10 * H)
    wrong_direction = e.model_copy(update={"comparison": AT_MOST, "status": FAIL})
    with pytest.raises(ValueError, match="contradicts the constraint definition"):
        operational_margin(wrong_direction, 10 * H)


@pytest.mark.parametrize(("cid", "status"), [(C.MIN_SUNLIGHT_PERCENT, PASS), (C.MIN_SIMULTANEOUS_PERCENT, PASS)])
def test_representation_error_at_threshold_gives_exact_zero_through_the_pipeline(
    cid: ConstraintId, status: ConstraintStatus
) -> None:
    # Phase 3 passes 55.00000000000001 % against 55 % (and would for 54.99999999999999 %): the
    # margin must be exactly 0, never a tiny negative number next to a PASS verdict.
    for measured in (0.55 * 100, 55.0 * (1 - 2e-16)):
        e = ConstraintEvaluation(
            constraint_id=cid,
            status=status,
            threshold=55.0,
            unit=Unit.PERCENT,
            measured=Metric.known(measured, Unit.PERCENT),
            message="hand-made",
        )
        ma = assess_margin(e, 10 * H)
        assert ma.margin.value == Metric.known(0.0, Unit.PERCENT)
        assert ma.classification is MC.AT_THRESHOLD


@pytest.mark.parametrize("bad", [0.0, -1.0, float("inf"), float("nan")])
def test_invalid_duration_is_rejected(bad: float) -> None:
    with pytest.raises(ValueError, match="duration"):
        operational_margin(constraint(C.MAX_CONTINUOUS_DARKNESS, PASS), bad)


def test_duplicate_constraints_are_rejected() -> None:
    e = constraint(C.MAX_CONTINUOUS_DARKNESS, PASS)
    with pytest.raises(ValueError, match="at most once"):
        margins_from_constraints([e, e], 10 * H)


# --- 19: compatibility with Phase 1-3 outputs ---------------------------------------------------


def test_phase1_style_evaluations_without_evidence_fields_are_supported() -> None:
    # tests/viability/helpers.constraint: no comparison/metric_field (Phase 1 constructor).
    p = operational_margin(constraint(C.MAX_CONTINUOUS_DARKNESS, PASS), 100.0)  # limit 20 - measured 10
    assert p.value == Metric.known(10.0, Unit.SECONDS)
    u = operational_margin(constraint(C.MAX_CONTINUOUS_DARKNESS, UNKNOWN), 100.0)  # 20 - [10, 30]
    assert (u.value.lower, u.value.upper) == (-10.0, 10.0)
    na = operational_margin(constraint(C.MIN_SUN_CLEARANCE, NA), 100.0)
    assert na.value.status is MetricStatus.NOT_APPLICABLE and na.reference is None


def test_margin_identity_matches_constraints() -> None:
    a = assessed(hourly(SUN10, EARTH10), 10, dark_h=5.0, blackout_h=3.0, min_sunlight_percent=50.0)
    for m, c in zip(margins_from_assessment(a), a.constraints, strict=True):
        assert m.margin_id == c.constraint_id.value
        assert m.related_constraint is c.constraint_id
        assert m.reference == c.threshold
        assert m.value.unit is c.unit


SWEEP_SERIES = {
    "known": (SUN10, EARTH10),
    "gappy": (GAPPY, ["V", "U", "U", "V", "N", "N", "V", "V", "V", "V"]),
    "unknown": (ALL_UNKNOWN, ["U"] * 10),
}


@pytest.mark.parametrize("name", list(SWEEP_SERIES))
@pytest.mark.parametrize("hours", [10.0, 14.0])
@pytest.mark.parametrize("threshold", [None, 0.25])
def test_compute_margins_equals_margins_from_assessment(name: str, hours: float, threshold: float | None) -> None:
    sun, earth = SWEEP_SERIES[name]
    s = hourly(sun, earth)
    sc = scenario(
        s,
        hours,
        dark_h=2.0,
        blackout_h=2.0,
        threshold=threshold,
        min_sunlight_percent=75.0,
        min_earth_visibility_percent=50.0,
        min_simultaneous_percent=40.0,
        min_mean_solar_disk_fraction=0.6,
        min_initial_sunlight_s=2 * H,
        min_initial_earth_visibility_s=1 * H,
        min_sun_clearance_deg=1.0,
    )
    via_metrics = compute_margins(sc, analyze_scenario(sc, s).metrics, s)
    via_assessment = margins_from_assessment(assess_constraints(sc, s))
    assert via_metrics == via_assessment
    assert len(via_metrics) == len(ConstraintId)


@pytest.mark.parametrize("name", list(SWEEP_SERIES))
def test_margin_sign_agrees_with_every_phase3_verdict(name: str) -> None:
    """Across a sweep of thresholds, the margin sign reproduces the Phase 3 verdict exactly."""
    sun, earth = SWEEP_SERIES[name]
    s = hourly(sun, earth)
    for limit_h in [0.5, 1.0, 2.0, 3.0, 9.0, 10.0, 11.0]:
        for pct in [0.0, 10.0, 50.0, 70.0, 80.0, 90.0, 100.0]:
            a = assessed(
                s,
                10,
                dark_h=limit_h,
                blackout_h=limit_h,
                min_sunlight_percent=pct,
                min_earth_visibility_percent=pct,
                min_initial_sunlight_s=limit_h * H,
            )
            for m in assess_margins(a):
                lo, hi = m.worst_case, m.best_case
                if m.constraint_status is PASS:
                    assert lo is not None and lo >= 0.0
                elif m.constraint_status is FAIL:
                    assert hi is not None and hi < 0.0
                elif m.constraint_status is UNKNOWN:
                    assert lo is not None and hi is not None and lo < 0.0 <= hi


def test_compute_margins_refuses_another_site() -> None:
    s = hourly(SUN10)
    sc = scenario(s, 10, dark_h=5.0).model_copy(update={"site": s.site.model_copy(update={"id": "another-site"})})
    with pytest.raises(ValueError, match="site"):
        compute_margins(sc, analyze_scenario(scenario(s, 10), s).metrics, s)


def test_default_time_resolution_comes_from_data_quality_and_can_be_disabled() -> None:
    a = assessed(hourly(SUN10), 10, dark_h=3.5)
    [m] = [m for m in assess_margins(a) if m.constraint_id is C.MAX_CONTINUOUS_DARKNESS]
    assert m.time_resolution_s == a.environment.data_quality.largest_sample_gap_s == H
    assert m.classification is MC.NARROW
    [off] = [m for m in assess_margins(a, time_resolution_s=0.0) if m.constraint_id is C.MAX_CONTINUOUS_DARKNESS]
    assert off.classification is MC.COMFORTABLE
    assert assess_margin(a.constraint(C.MAX_CONTINUOUS_DARKNESS), 10 * H).time_resolution_s is None
    assert m.narrow_fraction == NARROW_MARGIN_FRACTION


def test_reason_codes_survive_for_unknown_margins() -> None:
    a = assessed(hourly(GAPPY), 10, min_sunlight_percent=85.0)
    c = a.constraint(C.MIN_SUNLIGHT_PERCENT)
    assert c.unknown_reason is UnknownReason.INCOMPLETE_DATA
    [m] = [m for m in assess_margins(a) if m.constraint_id is C.MIN_SUNLIGHT_PERCENT]
    assert m.margin.value.reason == c.measured.reason


# --- 20: real NASA-derived site files (independent NumPy expectations) -------------------------

SITES_DIR = Path(__file__).resolve().parents[3] / "data" / "sites"
SITES = ("connecting-ridge", "malapert-massif", "peak-near-shackleton", "shackleton-floor")
T0 = datetime(2027, 1, 1, tzinfo=UTC)
COVERAGE_END = datetime(2029, 1, 1, tzinfo=UTC)
N_HOURS = 17544
TYPICAL: dict[str, float] = {
    "dark_h": 50.0,
    "blackout_h": 96.0,
    "min_sunlight_percent": 50.0,
    "min_earth_visibility_percent": 40.0,
    "min_simultaneous_percent": 30.0,
    "min_mean_solar_disk_fraction": 0.5,
    "min_initial_sunlight_s": 24 * H,
    "min_initial_earth_visibility_s": 12 * H,
}
PANEL = 0.25


@pytest.fixture(scope="module")
def raw() -> dict[str, dict[str, Any]]:
    return {s: json.loads((SITES_DIR / f"{s}.json").read_text(encoding="utf-8"))["timeline"] for s in SITES}


@pytest.fixture(scope="module")
def prepared() -> dict[str, PreparedSeries]:
    return {s: prepare_series(load_site_file(SITES_DIR / f"{s}.json")) for s in SITES}


def real_mission(p: PreparedSeries, start: datetime, end: datetime, cfg: dict[str, float]) -> MissionScenario:
    req: dict[str, Any] = {k: v for k, v in cfg.items() if k not in ("dark_h", "blackout_h")}
    return MissionScenario(
        scenario_id="real-phase4-margins",
        site=p.series.site,
        mission_start_utc=start,
        mission_end_utc=end,
        spacecraft=SpacecraftConfiguration(
            name="Solar DTE lander",
            power_source=PowerSource.SOLAR,
            communication_mode=CommunicationMode.DIRECT_TO_EARTH,
            max_continuous_darkness_s=cfg["dark_h"] * H,
            max_communication_blackout_s=cfg["blackout_h"] * H,
            solar_power_min_disk_fraction=PANEL,
        ),
        requirements=MissionRequirements(**req),
    )


def _longest(mask: np.ndarray, value: bool) -> int:
    best = cur = 0
    for x in mask:
        cur = cur + 1 if bool(x) is value else 0
        best = max(best, cur)
    return best


def _leading(mask: np.ndarray) -> int:
    off = np.flatnonzero(~mask)
    return int(off[0]) if off.size else int(mask.size)


def independent_margins(tl: dict[str, Any], first: int, n: int, cfg: dict[str, float]) -> dict[ConstraintId, float]:
    """Hourly bins [first, first + n) from the raw columns; sample i covers hour i (sample-and-hold)."""
    sl = slice(first, first + n)
    frac = np.asarray(tl["sun_visible_fraction"][sl], dtype=float)
    sun = np.asarray(tl["sun_visible"][sl], dtype=bool)
    earth = np.asarray(tl["earth_visible"][sl], dtype=bool)
    lit = sun & (frac >= PANEL)
    return {
        C.MAX_CONTINUOUS_DARKNESS: (cfg["dark_h"] - _longest(lit, False)) * H,
        C.MAX_COMMUNICATION_BLACKOUT: (cfg["blackout_h"] - _longest(earth, False)) * H,
        C.MIN_SUNLIGHT_PERCENT: 100.0 * sun.sum() / n - cfg["min_sunlight_percent"],
        C.MIN_EARTH_VISIBILITY_PERCENT: 100.0 * earth.sum() / n - cfg["min_earth_visibility_percent"],
        C.MIN_SIMULTANEOUS_PERCENT: 100.0 * (lit & earth).sum() / n - cfg["min_simultaneous_percent"],
        C.MIN_MEAN_SOLAR_DISK_FRACTION: float(frac.mean()) - cfg["min_mean_solar_disk_fraction"],
        C.MIN_INITIAL_SUNLIGHT: _leading(lit) * H - cfg["min_initial_sunlight_s"],
        C.MIN_INITIAL_EARTH_VISIBILITY: _leading(earth) * H - cfg["min_initial_earth_visibility_s"],
    }


@pytest.mark.parametrize("site", SITES)
@pytest.mark.parametrize("day", [0, 35, 61, 200, 333, 512, 700])
def test_real_two_week_margins_match_independent_computation(
    site: str, day: int, raw: dict[str, dict[str, Any]], prepared: dict[str, PreparedSeries]
) -> None:
    start = T0 + timedelta(days=day)
    a = assess_constraints(real_mission(prepared[site], start, start + timedelta(days=14), TYPICAL), prepared[site])
    expected = independent_margins(raw[site], day * 24, 14 * 24, TYPICAL)
    got = {m.constraint_id: m for m in assess_margins(a)}
    for cid, value in expected.items():
        m = got[cid]
        assert m.basis is MarginBasis.MEASURED
        if m.margin.value.unit is Unit.SECONDS:
            assert known(m) == value  # whole hours: exact
        else:
            assert known(m) == pytest.approx(value, rel=1e-12, abs=1e-12)
        assert (m.constraint_status is FAIL) == (value < 0.0) and m.constraint_status is not UNKNOWN
    assert got[C.MIN_SUN_CLEARANCE].classification is MC.NOT_APPLICABLE
    assert a.eligibility is (Eligibility.FAIL if any(v < 0 for v in expected.values()) else Eligibility.PASS)


# Two-year longest power-dark (>= 0.25) and Earth blackout in hours (docs section 5b).
OUTAGES_H = {
    "connecting-ridge": (492, 352),
    "malapert-massif": (266, 17),
    "peak-near-shackleton": (2802, 347),
    "shackleton-floor": (N_HOURS, N_HOURS),
}


@pytest.mark.parametrize("site", SITES)
@pytest.mark.parametrize(("extra_h", "cls"), [(10, MC.NARROW), (0, MC.AT_THRESHOLD), (-1, MC.NEGATIVE)])
def test_real_two_year_outage_margins(
    site: str, extra_h: int, cls: MarginClass, prepared: dict[str, PreparedSeries]
) -> None:
    dark, blackout = OUTAGES_H[site]
    cfg = {"dark_h": float(dark + extra_h), "blackout_h": float(blackout + extra_h)}
    a = assess_constraints(real_mission(prepared[site], T0, COVERAGE_END, cfg), prepared[site])
    ms = {m.constraint_id: m for m in assess_margins(a)}
    for cid, limit_h in (
        (C.MAX_CONTINUOUS_DARKNESS, dark + extra_h),
        (C.MAX_COMMUNICATION_BLACKOUT, blackout + extra_h),
    ):
        m = ms[cid]
        assert known(m) == extra_h * H
        expected_cls = cls
        if extra_h == 10 and 10 >= NARROW_MARGIN_FRACTION * limit_h:
            expected_cls = MC.COMFORTABLE  # Malapert blackout: 10 h is 37 % of a 27 h limit
        assert m.classification is expected_cls
        assert m.relative == Metric.known(extra_h / limit_h, Unit.FRACTION)


def test_real_malapert_lit_season_has_comfortable_margins(prepared: dict[str, PreparedSeries]) -> None:
    p = prepared["malapert-massif"]
    start = datetime(2027, 7, 20, tzinfo=UTC)
    a = assess_constraints(real_mission(p, start, start + timedelta(days=14), TYPICAL), p)
    assert a.eligibility is Eligibility.PASS
    ms = [m for m in assess_margins(a) if m.constraint_status is not NA]
    assert ms and all(m.classification is MC.COMFORTABLE for m in ms)


def test_real_mission_inside_polar_night_is_negative_and_clipped(prepared: dict[str, PreparedSeries]) -> None:
    # PNS 2027-04-01 + 14 d lies inside its 2,802 h power-dark period (docs section 5c).
    p = prepared["peak-near-shackleton"]
    start = datetime(2027, 4, 1, tzinfo=UTC)
    a = assess_constraints(real_mission(p, start, start + timedelta(days=14), TYPICAL), p)
    ms = {m.constraint_id: m for m in assess_margins(a)}
    dark = ms[C.MAX_CONTINUOUS_DARKNESS]
    assert known(dark) == (50 - 336) * H and dark.classification is MC.NEGATIVE
    assert dark.clipped_at_mission_start and dark.clipped_at_mission_end
    assert known(ms[C.MIN_INITIAL_SUNLIGHT]) == -24 * H


def test_real_mission_straddling_dataset_end(
    raw: dict[str, dict[str, Any]], prepared: dict[str, PreparedSeries]
) -> None:
    # 2028-12-25 -> 2029-01-08: last 168 covered hours, then 168 h beyond coverage (unknown).
    p, tl = prepared["malapert-massif"], raw["malapert-massif"]
    start, end = datetime(2028, 12, 25, tzinfo=UTC), datetime(2029, 1, 8, tzinfo=UTC)
    a = assess_constraints(real_mission(p, start, end, TYPICAL), p)
    ms = {m.constraint_id: m for m in assess_margins(a)}
    first = N_HOURS - 168
    earth = np.asarray(tl["earth_visible"][first:N_HOURS], dtype=bool)
    lo_pct, hi_pct = 100.0 * earth.sum() / 336, 100.0 * (earth.sum() + 168) / 336
    e = ms[C.MIN_EARTH_VISIBILITY_PERCENT]
    assert bounds(e) == pytest.approx((lo_pct - 40.0, hi_pct - 40.0), rel=1e-12)
    assert e.basis is MarginBasis.BOUNDED and e.constraint_status is PASS  # proven by the covered week
    # Longest outage: lower = longest confirmed run (unknown breaks runs); upper = the unknown
    # 168 h merged with the outage run ending the covered week, if longer.
    frac = np.asarray(tl["sun_visible_fraction"][first:N_HOURS], dtype=float)
    lit = np.asarray(tl["sun_visible"][first:N_HOURS], dtype=bool) & (frac >= PANEL)
    for cid, ok, limit_h in ((C.MAX_CONTINUOUS_DARKNESS, lit, 50), (C.MAX_COMMUNICATION_BLACKOUT, earth, 96)):
        trailing = _leading(~ok[::-1])  # outage hours at the end of the covered week
        longest_lo = _longest(ok, False)
        longest_hi = max(longest_lo, trailing + 168)
        assert bounds(ms[cid]) == ((limit_h - longest_hi) * H, (limit_h - longest_lo) * H)
        assert ms[cid].classification is MC.UNCERTAIN and ms[cid].basis is MarginBasis.BOUNDED
    assert a.eligibility is Eligibility.UNKNOWN


def test_real_mission_after_dataset_end_uses_admissible_ranges_only(prepared: dict[str, PreparedSeries]) -> None:
    p = prepared["connecting-ridge"]
    start = datetime(2029, 2, 1, tzinfo=UTC)
    a = assess_constraints(real_mission(p, start, start + timedelta(days=14), TYPICAL), p)
    ms = {m.constraint_id: m for m in assess_margins(a)}
    for m in ms.values():
        if m.constraint_status is not NA:
            assert m.basis is MarginBasis.ADMISSIBLE_RANGE
    assert bounds(ms[C.MIN_SUNLIGHT_PERCENT]) == (-50.0, 50.0)
    assert bounds(ms[C.MAX_CONTINUOUS_DARKNESS]) == ((50 - 336) * H, 50 * H)
    assert bounds(ms[C.MIN_INITIAL_SUNLIGHT]) == (-24 * H, (336 - 24) * H)
    assert all(m.classification is MC.UNCERTAIN for m in ms.values() if m.constraint_status is not NA)
    assert a.eligibility is Eligibility.UNKNOWN


def test_real_shackleton_floor_control_is_negative_everywhere(prepared: dict[str, PreparedSeries]) -> None:
    p = prepared["shackleton-floor"]
    a = assess_constraints(real_mission(p, T0, T0 + timedelta(days=30), TYPICAL), p)
    ms = {m.constraint_id: m for m in assess_margins(a)}
    configured = [m for m in ms.values() if m.constraint_status is not NA]
    assert len(configured) == 8 and all(m.classification is MC.NEGATIVE for m in configured)
    assert known(ms[C.MIN_SUNLIGHT_PERCENT]) == -50.0
    assert known(ms[C.MAX_CONTINUOUS_DARKNESS]) == (50 - 720) * H
    assert known(ms[C.MIN_MEAN_SOLAR_DISK_FRACTION]) == -0.5
