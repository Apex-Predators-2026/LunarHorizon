"""Tests for the Member 1 site-file adapter.

Real-file tests read the committed data/sites/*.json produced by Andrew's engine.
Unit tests use small SYNTHETIC site-file dicts (not NASA data) in the same layout.
"""

from __future__ import annotations

import copy
import json
import math
import re
from datetime import UTC, datetime
from functools import cache
from pathlib import Path
from typing import Any

import pytest

from app.viability.adapters import (
    ADAPTER_VERSION,
    SiteFileError,
    load_site_file,
    normalize_azimuth_deg,
    normalize_longitude_deg,
    site_file_to_series,
)
from app.viability.adapters.site_file import parse_step_s
from app.viability.enums import AngleType, CalculationBasis, VisibilityCriterion, VisibilityState
from app.viability.inputs import ScientificTimeSeries
from app.viability.mission import MissionScenario

SITES_DIR = Path(__file__).resolve().parents[3] / "data" / "sites"
REAL_SITES = ("connecting-ridge", "malapert-massif", "peak-near-shackleton", "shackleton-floor")
V, P, NV, U = VisibilityState.VISIBLE, VisibilityState.PARTIAL, VisibilityState.NOT_VISIBLE, VisibilityState.UNKNOWN


@cache
def _raw(site: str) -> dict[str, Any]:
    return json.loads((SITES_DIR / f"{site}.json").read_text(encoding="utf-8"))  # type: ignore[no-any-return]


@cache
def _real(site: str) -> ScientificTimeSeries:
    return load_site_file(SITES_DIR / f"{site}.json")


def _mini() -> dict[str, Any]:
    """SYNTHETIC 3-sample site file in Andrew's layout. Sun: full / half / none."""
    return {
        "site": {
            "id": "synthetic-site",
            "name": "Synthetic site (test only)",
            "lat": -89.5,
            "lon": 209.5,
            "source": "SYNTHETIC test data",
            "x_m": 1.0,
            "y_m": 2.0,
            "ground_height_m": 1500.0,
            "observer_height_m": 2.0,
        },
        "meta": {
            "start_utc": "2027-01-01",
            "stop_utc": "2027-01-01",
            "step": "1h",
            "ephemeris": "SYNTHETIC, apparent az/el",
            "terrain": ["SYNTHETIC terrain tier A", "SYNTHETIC terrain tier B"],
        },
        "summary": {},
        "horizon": {"azimuth_deg": [0.0, 90.0, 180.0, 270.0], "elevation_deg": [1.0, 1.0, 1.0, 1.0]},
        "timeline": {
            "time_utc": ["2027-01-01T00:00Z", "2027-01-01T01:00Z", "2027-01-01T02:00Z"],
            "sun_azimuth_deg": [100.0, 100.5, 101.0],
            "sun_elevation_deg": [1.5, 1.0, 0.5],
            "sun_horizon_deg": [1.0, 1.0, 1.0],
            "sun_visible_fraction": [1.0, 0.5, 0.0],
            "earth_azimuth_deg": [359.5, 360.0, 0.5],
            "earth_elevation_deg": [3.0, 3.0, 0.5],
            "earth_horizon_deg": [1.0, 1.0, 1.0],
            "earth_margin_deg": [2.0, 2.0, -0.5],
            "earth_visible": [True, True, False],
        },
    }


@pytest.fixture
def mini() -> dict[str, Any]:
    return copy.deepcopy(_mini())


def _convert(d: dict[str, Any]) -> ScientificTimeSeries:
    return site_file_to_series(d, source="mini.json")


# --- all four real site files -------------------------------------------------------------


def test_all_real_site_files_present() -> None:
    # The four sites Member 2 validated against are always present; Member 1's catalog may hold more
    # (generator 1.2 publishes 24), and those convert too (see test_every_published_site_file_converts).
    assert set(REAL_SITES) <= {p.stem for p in SITES_DIR.glob("*.json")}


def test_every_published_site_file_converts() -> None:
    for path in sorted(SITES_DIR.glob("*.json")):
        s = load_site_file(path)
        assert s.provenance.is_synthetic is False and s.fraction_decimals == 6, path.stem


@pytest.mark.parametrize("site", REAL_SITES)
def test_real_site_file_converts(site: str) -> None:
    raw, s = _raw(site), _real(site)
    n = len(raw["timeline"]["time_utc"])
    assert len(s.samples) == n
    assert s.site.id == raw["site"]["id"] and s.site.name == raw["site"]["name"]
    assert s.site.lat == raw["site"]["lat"]
    assert s.coverage_start_utc == s.samples[0].time_utc and s.coverage_end_utc == s.samples[-1].time_utc
    assert s.calculation_basis is CalculationBasis.TERRAIN_AWARE
    assert s.angle_type is AngleType.APPARENT
    assert s.sun_criterion is VisibilityCriterion.APPARENT_DISK and s.earth_criterion is VisibilityCriterion.CENTER
    assert s.sampling.nominal_interval_s == 3600.0
    assert s.horizon_profile is not None and len(s.horizon_profile.azimuths_deg) == 720


@pytest.mark.parametrize("site", REAL_SITES)
def test_real_site_provenance_preserved(site: str) -> None:
    raw, s = _raw(site), _real(site)
    prov = s.provenance
    assert prov.is_synthetic is False
    assert prov.ephemeris_source == raw["meta"]["ephemeris"]
    assert all(t in (prov.terrain_source or "") for t in raw["meta"]["terrain"])
    assert prov.references == [raw["site"]["source"]]
    # Format 1.1 records when the file was generated: carried exactly, as UTC (never back-filled).
    generated = datetime.strptime(raw["meta"]["generated_utc"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    assert prov.generated_at_utc == generated and prov.generated_at_utc.tzinfo is UTC
    assert raw["meta"]["generator_version"] in prov.generator
    # The frame is recorded as Member 1's statement, explicitly not as an independent verification.
    assert prov.coordinate_frame is not None and prov.coordinate_frame == raw["meta"]["frame"]
    assert "MEAN_ME" in prov.coordinate_frame
    assert prov.notes is not None and "not independently verified" in prov.notes
    assert s.fraction_decimals == 6
    assert prov.horizon_azimuth_step_deg == 0.5
    assert prov.notes is not None and ADAPTER_VERSION in prov.notes and str(raw["site"]["lon"]) in prov.notes
    assert s.observer_height_m == raw["site"]["observer_height_m"]
    assert s.site.surface_height_m == raw["site"]["ground_height_m"]


@pytest.mark.parametrize("site", REAL_SITES)
def test_real_site_angles_and_partial_disk_preserved(site: str) -> None:
    tl, s = _raw(site)["timeline"], _real(site)
    for i in (0, len(s.samples) // 2, len(s.samples) - 1):
        sun, earth = s.samples[i].sun, s.samples[i].earth
        assert sun.elevation_deg == tl["sun_elevation_deg"][i] and sun.horizon_deg == tl["sun_horizon_deg"][i]
        assert sun.azimuth_deg == normalize_azimuth_deg(tl["sun_azimuth_deg"][i])
        assert earth.elevation_deg == tl["earth_elevation_deg"][i]
    fractions = [x.sun.visible_fraction for x in s.samples]
    assert fractions == tl["sun_visible_fraction"]  # every fractional value kept as-is
    # Partial = some disk visible (authoritative sun_visible) but not the whole disk.
    partial_in_file = sum(1 for f, v in zip(tl["sun_visible_fraction"], tl["sun_visible"], strict=True) if v and f < 1)
    assert [x.sun.state for x in s.samples].count(P) == partial_in_file
    assert U not in {x.sun.state for x in s.samples} | {x.earth.state for x in s.samples}


@pytest.mark.parametrize("site", REAL_SITES)
def test_real_site_matches_andrews_own_summary(site: str) -> None:
    raw, s = _raw(site), _real(site)
    summary, tl = raw["summary"], raw["timeline"]
    n = len(s.samples)
    sunlit = 100 * sum(x.sun.state in (V, P) for x in s.samples) / n
    earth = 100 * sum(x.earth.state is V for x in s.samples) / n
    # Exact agreement with the file's authoritative column (format 1.1).
    assert sunlit == 100 * sum(bool(v) for v in tl["sun_visible"]) / n
    assert earth == pytest.approx(summary["earth_visible_pct"], abs=0.05)  # summary rounded to 0.1
    # His sunlit_pct is computed from the same flag, so only its 0.1 % display rounding differs.
    assert sunlit == pytest.approx(summary["sunlit_pct"], abs=0.05)
    # Slivers below the 6-decimal rounding (sun_visible true, fraction written as 0.0) are kept as
    # partial with the written 0.0. Their number depends on the terrain generation (1.1: one hour at PNS,
    # 1.2: none), so it is discovered, not pinned.
    slivers = [
        i for i, (f, v) in enumerate(zip(tl["sun_visible_fraction"], tl["sun_visible"], strict=True)) if v and f == 0.0
    ]
    for i in slivers:
        assert s.samples[i].sun.state is P and s.samples[i].sun.visible_fraction == 0.0


def test_shackleton_floor_control_is_permanently_dark() -> None:
    assert {x.sun.state for x in _real("shackleton-floor").samples} == {NV}


def test_real_series_round_trips_through_json() -> None:
    s = _real("peak-near-shackleton")
    assert ScientificTimeSeries.model_validate_json(s.model_dump_json()) == s


@pytest.mark.parametrize("site", REAL_SITES)
def test_real_site_usable_in_mission_scenario(site: str) -> None:
    s = _real(site)
    scenario = MissionScenario.model_validate(
        {
            "scenario_id": f"{site}-check",
            "site": s.site.model_dump(),
            "mission_start_utc": s.coverage_start_utc,
            "mission_end_utc": s.coverage_end_utc,
            "spacecraft": {"name": "x", "power_source": "solar", "communication_mode": "direct_to_earth"},
        }
    )
    assert scenario.site == s.site


# --- longitude normalisation --------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (209.94767, 209.94767 - 360.0),  # Connecting Ridge
        (357.6326, 357.6326 - 360.0),  # Malapert Massif
        (126.27302, 126.27302),  # Peak Near Shackleton: unchanged
        (180.0, 180.0),
        (180.0001, 180.0001 - 360.0),
        (0.0, 0.0),
        (-45.0, -45.0),  # already in contract range
        (-180.0, -180.0),
    ],
)
def test_longitude_normalization(raw: float, expected: float) -> None:
    assert normalize_longitude_deg(raw) == pytest.approx(expected, abs=1e-12)


@pytest.mark.parametrize("raw", [360.0, 400.0, -180.5, math.nan, math.inf, True, "209.9"])
def test_longitude_out_of_range_or_malformed_rejected(raw: Any) -> None:
    with pytest.raises(SiteFileError):
        normalize_longitude_deg(raw)


def test_real_east_longitudes_normalized_in_series() -> None:
    assert _real("connecting-ridge").site.lon == pytest.approx(-150.05233)
    assert _real("malapert-massif").site.lon == pytest.approx(-2.3674)


# --- azimuth wraparound -------------------------------------------------------------------


@pytest.mark.parametrize(("raw", "expected"), [(360.0, 0.0), (359.999, 359.999), (0.0, 0.0), (180.0, 180.0)])
def test_azimuth_normalization(raw: float, expected: float) -> None:
    assert normalize_azimuth_deg(raw) == expected


def test_negative_zero_azimuth_becomes_positive_zero() -> None:
    assert math.copysign(1.0, normalize_azimuth_deg(-0.0)) == 1.0


@pytest.mark.parametrize("raw", [360.0001, -0.1, 720.0])
def test_azimuth_outside_circle_rejected(raw: float) -> None:
    with pytest.raises(SiteFileError, match="outside"):
        normalize_azimuth_deg(raw)


def test_rounded_360_azimuth_wrapped_at_boundary(mini: dict[str, Any]) -> None:
    s = _convert(mini)
    assert [x.earth.azimuth_deg for x in s.samples] == [359.5, 0.0, 0.5]


def test_horizon_profile_azimuth_out_of_range_rejected(mini: dict[str, Any]) -> None:
    mini["horizon"]["azimuth_deg"][-1] = 361.0
    with pytest.raises(SiteFileError, match=r"horizon\.azimuth_deg\[3\]"):
        _convert(mini)


# --- column-array conversion and partial disk ---------------------------------------------


def test_column_arrays_become_samples(mini: dict[str, Any]) -> None:
    s = _convert(mini)
    assert [x.time_utc for x in s.samples] == [datetime(2027, 1, 1, h, tzinfo=UTC) for h in range(3)]
    assert [x.sun.state for x in s.samples] == [V, P, NV]
    assert [x.sun.visible_fraction for x in s.samples] == [1.0, 0.5, 0.0]
    assert [x.earth.state for x in s.samples] == [V, V, NV]
    assert all(x.earth.visible_fraction is None for x in s.samples)
    assert s.samples[1].sun.horizon_deg == 1.0 and s.samples[1].sun.elevation_deg == 1.0


def test_four_sun_categories_distinguished(mini: dict[str, Any]) -> None:
    mini["timeline"]["sun_visible_fraction"][2] = None  # unknown
    states = [x.sun.state for x in _convert(mini).samples]
    assert states == [V, P, U]
    mini2 = _mini()
    assert [x.sun.state for x in _convert(mini2).samples] == [V, P, NV]


def test_angular_radius_preserved_when_present(mini: dict[str, Any]) -> None:
    mini["timeline"]["sun_angular_radius_deg"] = [0.2671, 0.2671, 0.2670]
    s = _convert(mini)
    assert [x.sun.angular_radius_deg for x in s.samples] == [0.2671, 0.2671, 0.2670]
    assert all(x.earth.angular_radius_deg is None for x in s.samples)


def test_angular_radius_absent_stays_unknown(mini: dict[str, Any]) -> None:
    assert all(x.sun.angular_radius_deg is None for x in _convert(mini).samples)


# --- missing and inconsistent scientific data ---------------------------------------------


@pytest.mark.parametrize("column", ["sun_horizon_deg", "earth_visible", "time_utc", "sun_visible_fraction"])
def test_missing_required_column_rejected(mini: dict[str, Any], column: str) -> None:
    del mini["timeline"][column]
    with pytest.raises(SiteFileError, match=column):
        _convert(mini)


@pytest.mark.parametrize(("block", "key"), [("site", "lon"), ("site", "id"), ("meta", "terrain"), ("meta", "step")])
def test_missing_metadata_rejected(mini: dict[str, Any], block: str, key: str) -> None:
    del mini[block][key]
    with pytest.raises(SiteFileError, match=re.escape(f"{block}.{key}")):
        _convert(mini)


def test_empty_terrain_source_rejected(mini: dict[str, Any]) -> None:
    mini["meta"]["terrain"] = []
    with pytest.raises(SiteFileError, match="terrain"):
        _convert(mini)


def test_unstated_angle_type_rejected(mini: dict[str, Any]) -> None:
    mini["meta"]["ephemeris"] = "JPL Horizons az/el"
    with pytest.raises(SiteFileError, match="apparent"):
        _convert(mini)


def test_missing_horizon_element_becomes_unknown_not_clear(mini: dict[str, Any]) -> None:
    mini["timeline"]["sun_horizon_deg"][0] = None
    mini["timeline"]["sun_visible_fraction"][0] = None
    sun = _convert(mini).samples[0].sun
    assert sun.state is U and sun.horizon_deg is None and sun.visible_fraction is None
    assert sun.elevation_deg == 1.5  # known values kept


def test_fraction_without_its_horizon_rejected(mini: dict[str, Any]) -> None:
    mini["timeline"]["sun_horizon_deg"][0] = None  # fraction 1.0 still present
    with pytest.raises(SiteFileError, match="inconsistent"):
        _convert(mini)


def test_earth_flag_without_its_angles_rejected(mini: dict[str, Any]) -> None:
    mini["timeline"]["earth_elevation_deg"][0] = None
    with pytest.raises(SiteFileError, match="inconsistent"):
        _convert(mini)


def test_missing_earth_flag_becomes_unknown(mini: dict[str, Any]) -> None:
    mini["timeline"]["earth_visible"][0] = None
    assert _convert(mini).samples[0].earth.state is U


def test_nan_token_is_missing_and_infinity_rejected(tmp_path: Path, mini: dict[str, Any]) -> None:
    mini["timeline"]["sun_horizon_deg"][0] = math.nan
    mini["timeline"]["sun_visible_fraction"][0] = math.nan
    path = tmp_path / "nan.json"
    path.write_text(json.dumps(mini), encoding="utf-8")  # writes the NaN token
    assert load_site_file(path).samples[0].sun.state is U
    path.write_text(json.dumps(mini).replace("NaN", "Infinity", 1), encoding="utf-8")
    with pytest.raises(SiteFileError, match="Infinity"):
        load_site_file(path)


def test_invalid_json_rejected(tmp_path: Path) -> None:
    path = tmp_path / "broken.json"
    path.write_text("{not json", encoding="utf-8")
    with pytest.raises(SiteFileError, match="invalid JSON"):
        load_site_file(path)


@pytest.mark.parametrize("value", [1.2, -0.1])
def test_fraction_out_of_range_rejected(mini: dict[str, Any], value: float) -> None:
    mini["timeline"]["sun_visible_fraction"][1] = value
    with pytest.raises(SiteFileError, match="outside"):
        _convert(mini)


def test_non_boolean_earth_flag_rejected(mini: dict[str, Any]) -> None:
    mini["timeline"]["earth_visible"][0] = 1
    with pytest.raises(SiteFileError, match="true/false/null"):
        _convert(mini)


@pytest.mark.parametrize("value", ["1.5", True])
def test_non_numeric_angle_rejected(mini: dict[str, Any], value: Any) -> None:
    mini["timeline"]["sun_elevation_deg"][0] = value
    with pytest.raises(SiteFileError, match=r"sun_elevation_deg\[0\]"):
        _convert(mini)


def test_earth_margin_disagreeing_with_angles_rejected(mini: dict[str, Any]) -> None:
    mini["timeline"]["earth_margin_deg"][0] = 5.0
    with pytest.raises(SiteFileError, match="disagrees"):
        _convert(mini)


def test_earth_flag_contradicting_margin_rejected(mini: dict[str, Any]) -> None:
    mini["timeline"]["earth_visible"][0] = False
    with pytest.raises(SiteFileError, match="contradicts"):
        _convert(mini)


def test_state_contradicting_angles_rejected_by_core_contract(mini: dict[str, Any]) -> None:
    mini["timeline"]["sun_elevation_deg"][2] = 2.0  # centre well above horizon, fraction says 0
    with pytest.raises(SiteFileError, match="violates the viability input contract") as info:
        _convert(mini)
    assert info.value.__cause__ is not None  # pydantic detail preserved


# --- timestamps and array shape -----------------------------------------------------------


@pytest.mark.parametrize("bad", ["2027-01-01T01:00", "2027-01-01T06:00+05:00", "yesterday", 1798765200])
def test_malformed_timestamp_rejected(mini: dict[str, Any], bad: Any) -> None:
    mini["timeline"]["time_utc"][1] = bad
    with pytest.raises(SiteFileError, match=r"time_utc\[1\]"):
        _convert(mini)


def test_inconsistent_array_lengths_rejected(mini: dict[str, Any]) -> None:
    mini["timeline"]["earth_margin_deg"].append(1.0)
    with pytest.raises(SiteFileError, match="inconsistent lengths"):
        _convert(mini)


def test_unsorted_timestamps_rejected(mini: dict[str, Any]) -> None:
    t = mini["timeline"]["time_utc"]
    t[0], t[1] = t[1], t[0]
    with pytest.raises(SiteFileError):
        _convert(mini)


def test_spacing_finer_than_declared_step_rejected(mini: dict[str, Any]) -> None:
    mini["timeline"]["time_utc"][1] = "2027-01-01T00:30Z"
    with pytest.raises(SiteFileError, match=r"meta\.step"):
        _convert(mini)


def test_gap_larger_than_step_is_kept_as_gap(mini: dict[str, Any]) -> None:
    mini["timeline"]["time_utc"][2] = "2027-01-01T05:00Z"
    s = _convert(mini)
    gap = (s.samples[2].time_utc - s.samples[1].time_utc).total_seconds()
    assert gap > s.sampling.max_gap_s  # Phase 2 will treat it as unknown coverage


def test_single_sample_rejected(mini: dict[str, Any]) -> None:
    for col in mini["timeline"].values():
        del col[1:]
    with pytest.raises(SiteFileError, match="at least 2 samples"):
        _convert(mini)


@pytest.mark.parametrize(("step", "seconds"), [("1h", 3600.0), ("30m", 1800.0), ("10 min", 600.0), ("1d", 86400.0)])
def test_step_parsing(step: str, seconds: float) -> None:
    assert parse_step_s(step) == seconds


@pytest.mark.parametrize("step", ["1 hour", "", "0h", "-1h", "1y"])
def test_bad_step_rejected(step: str) -> None:
    with pytest.raises(SiteFileError):
        parse_step_s(step)


# --- provenance details -------------------------------------------------------------------


def test_generation_time_preserved_when_recorded(mini: dict[str, Any]) -> None:
    mini["meta"]["generated_utc"] = "2026-11-13T22:00:00Z"
    assert _convert(mini).provenance.generated_at_utc == datetime(2026, 11, 13, 22, tzinfo=UTC)


def test_unknown_columns_recorded_not_silently_dropped(mini: dict[str, Any]) -> None:
    mini["timeline"]["sun_power_w"] = [1.0, 2.0, 3.0]
    notes = _convert(mini).provenance.notes or ""
    assert "Ignored timeline columns: sun_power_w" in notes


def test_adapter_does_not_mutate_input(mini: dict[str, Any]) -> None:
    before = copy.deepcopy(mini)
    _convert(mini)
    assert mini == before


# --- format 1.1: sun_visible, frame, generator version (SYNTHETIC site files) --------------


def _v11(mini: dict[str, Any], fractions: list[Any], flags: list[Any]) -> dict[str, Any]:
    mini["meta"].update(generator_version="1.1", frame="SYNTHETIC frame statement")
    mini["timeline"]["sun_visible_fraction"] = fractions
    mini["timeline"]["sun_visible"] = flags
    return mini


def test_sun_visible_agreeing_with_fractions(mini: dict[str, Any]) -> None:
    s = _convert(_v11(mini, [1.0, 0.5, 0.0], [True, True, False]))
    assert [x.sun.state for x in s.samples] == [V, P, NV]
    assert [x.sun.visible_fraction for x in s.samples] == [1.0, 0.5, 0.0]
    assert s.fraction_decimals == 6 and "sun_visible" not in (s.provenance.notes or "")


def test_sub_precision_sliver_is_partial_with_written_fraction(mini: dict[str, Any]) -> None:
    s = _convert(_v11(mini, [1.0, 0.0, 0.0], [True, True, False]))
    assert s.samples[1].sun.state is P and s.samples[1].sun.visible_fraction == 0.0  # not rounded up, not dropped


def test_sliver_rejected_when_rounding_is_not_declared(mini: dict[str, Any]) -> None:
    d = _v11(mini, [1.0, 0.0, 0.0], [True, True, False])
    del d["meta"]["generator_version"]  # unknown format: precision unknown -> strict contract applies
    with pytest.raises(SiteFileError, match="not_visible"):
        _convert(d)


@pytest.mark.parametrize(
    ("fractions", "flags", "match"),
    [
        ([1.0, 0.5, 0.0], [True, False, False], "contradicts"),
        ([1.0, 0.5, 0.0], [True, None, False], "null"),
        ([1.0, 0.5, 0.0], [True, "yes", False], "true/false/null"),
    ],
)
def test_inconsistent_sun_visible_rejected(
    mini: dict[str, Any], fractions: list[Any], flags: list[Any], match: str
) -> None:
    with pytest.raises(SiteFileError, match=match):
        _convert(_v11(mini, fractions, flags))


def test_sun_visible_without_its_values_rejected(mini: dict[str, Any]) -> None:
    d = _v11(mini, [1.0, None, 0.0], [True, True, False])
    d["timeline"]["sun_horizon_deg"][1] = None  # unknown terrain, as format 1.1 writes it
    with pytest.raises(SiteFileError, match="values it depends on"):
        _convert(d)


def test_null_sun_visible_with_null_values_is_unknown(mini: dict[str, Any]) -> None:
    d = _v11(mini, [1.0, None, 0.0], [True, None, False])
    d["timeline"]["sun_horizon_deg"][1] = None
    obs = _convert(d).samples[1].sun
    assert obs.state is U and obs.visible_fraction is None and obs.horizon_deg is None


def test_frame_recorded_as_statement(mini: dict[str, Any]) -> None:
    s = _convert(_v11(mini, [1.0, 0.5, 0.0], [True, True, False]))
    assert s.provenance.coordinate_frame == "SYNTHETIC frame statement"
    assert "not independently verified" in (s.provenance.notes or "")
    assert "generator_version 1.1" in s.provenance.generator


def test_missing_frame_is_not_assumed(mini: dict[str, Any]) -> None:
    s = _convert(mini)
    assert s.provenance.coordinate_frame is None and s.fraction_decimals is None
    assert "not stated" in (s.provenance.notes or "") and "NOT verified" in (s.provenance.notes or "")


@pytest.mark.parametrize(("key", "value"), [("frame", ""), ("frame", 7), ("generator_version", 1.1)])
def test_invalid_format_11_metadata_rejected(mini: dict[str, Any], key: str, value: object) -> None:
    mini["meta"][key] = value
    with pytest.raises(SiteFileError, match=key):
        _convert(mini)


# --- fraction precision per generator version (SYNTHETIC site files) ----------------------------


@pytest.mark.parametrize(("version", "decimals"), [("1.0", 3), ("1.1", 6), ("1.2", 6), ("9.9", None)])
def test_fraction_precision_is_taken_from_generator_version(
    mini: dict[str, Any], version: str, decimals: int | None
) -> None:
    """Generator 1.2 (whole-Moon pipeline) still writes 6-decimal fractions; an unknown version declares nothing.

    Explicit ``meta.fraction_decimals`` is not published by Member 1 yet (docs follow-up), so it is not read here.
    """
    mini["meta"]["generator_version"] = version
    if version == "1.0":  # 3-decimal files must really be 3-decimal
        mini["timeline"]["sun_visible_fraction"] = [1.0, 0.5, 0.0]
    assert _convert(mini).fraction_decimals == decimals


def test_unpublished_precision_metadata_is_ignored_not_trusted(mini: dict[str, Any]) -> None:
    mini["meta"].update(generator_version="1.2", fraction_decimals=3, angle_decimals=2)
    assert _convert(mini).fraction_decimals == 6  # until Member 1 publishes and documents the fields
