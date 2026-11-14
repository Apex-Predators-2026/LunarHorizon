from __future__ import annotations

import json
from itertools import pairwise

import pytest

from app.viability.enums import CalculationBasis, VisibilityState
from app.viability.fixtures import FIXTURE_DIR, FIXTURE_NAMES, build_fixture, example_scenario, load_fixture
from app.viability.fixtures.builders import SUN_RADIUS_DEG, disk_fraction
from app.viability.inputs import ScientificTimeSeries

V, PART, NV, UNK = (
    VisibilityState.VISIBLE,
    VisibilityState.PARTIAL,
    VisibilityState.NOT_VISIBLE,
    VisibilityState.UNKNOWN,
)

REQUIRED = {
    "continuous_sunlight",
    "continuous_darkness",
    "intermittent_sunlight",
    "continuous_earth_visibility",
    "intermittent_blackouts",
    "simultaneous_sun_earth",
    "missing_samples",
    "unknown_terrain",
    "irregular_sampling",
    "mission_boundary",
    "geometric_only",
}


def _states(s: ScientificTimeSeries, body: str) -> list[VisibilityState]:
    return [getattr(x, body).state for x in s.samples]


def test_required_fixtures_exist() -> None:
    assert set(FIXTURE_NAMES) >= REQUIRED
    assert {p.stem for p in FIXTURE_DIR.glob("*.json")} == set(FIXTURE_NAMES)


@pytest.mark.parametrize("name", FIXTURE_NAMES)
def test_fixture_json_matches_builder(name: str) -> None:
    # Guards against hand edits / stale files. Regenerate: python -m app.viability.fixtures
    assert load_fixture(name) == build_fixture(name)


@pytest.mark.parametrize("name", FIXTURE_NAMES)
def test_fixture_marked_synthetic(name: str) -> None:
    s = load_fixture(name)
    assert s.provenance.is_synthetic is True
    assert "SYNTHETIC" in s.provenance.ephemeris_source
    assert s.provenance.notes is not None and s.provenance.notes.startswith("SYNTHETIC FIXTURE - NOT REAL DATA")
    assert s.site.id.startswith("synthetic-")


@pytest.mark.parametrize("name", FIXTURE_NAMES)
def test_fixture_raw_json_uses_wire_conventions(name: str) -> None:
    raw = json.loads((FIXTURE_DIR / f"{name}.json").read_text(encoding="utf-8"))
    assert raw["samples"][0]["time_utc"].endswith("Z")
    assert all(
        v in {"visible", "partial", "not_visible", "unknown"}
        for x in raw["samples"]
        for v in (x["sun"]["state"], x["earth"]["state"])
    )


@pytest.mark.parametrize("name", FIXTURE_NAMES)
def test_example_scenario_compatible(name: str) -> None:
    s = load_fixture(name)
    sc = example_scenario(s)
    assert sc.site == s.site
    assert sc.mission_start_utc == s.coverage_start_utc and sc.mission_end_utc == s.coverage_end_utc


def test_continuous_sunlight() -> None:
    s = load_fixture("continuous_sunlight")
    assert set(_states(s, "sun")) == {V} and set(_states(s, "earth")) == {NV}


def test_continuous_darkness() -> None:
    s = load_fixture("continuous_darkness")
    assert set(_states(s, "sun")) == {NV} and set(_states(s, "earth")) == {V}


def test_intermittent_sunlight_has_all_disk_states() -> None:
    sun = load_fixture("intermittent_sunlight").samples
    assert {x.sun.state for x in sun} == {V, PART, NV}
    assert all(0.0 < x.sun.visible_fraction < 1.0 for x in sun if x.sun.state is PART)  # type: ignore[operator]


def test_continuous_earth_visibility() -> None:
    s = load_fixture("continuous_earth_visibility")
    assert set(_states(s, "earth")) == {V}
    assert s.sampling.nominal_interval_s == 7200.0


def test_intermittent_blackouts() -> None:
    assert set(_states(load_fixture("intermittent_blackouts"), "earth")) == {V, NV}


def test_simultaneous_sun_earth_overlaps_partially() -> None:
    pairs = {(x.sun.state, x.earth.state) for x in load_fixture("simultaneous_sun_earth").samples}
    assert (V, V) in pairs
    assert any(sun is V and earth is NV for sun, earth in pairs)
    assert any(sun is NV and earth is V for sun, earth in pairs)


def test_missing_samples_distinguishes_gap_from_unknown_and_darkness() -> None:
    s = load_fixture("missing_samples")
    gaps = [(b.time_utc - a.time_utc).total_seconds() for a, b in pairwise(s.samples)]
    assert max(gaps) > s.sampling.max_gap_s  # absent samples -> coverage gap
    unknown = [x for x in s.samples if x.sun.state is UNK]
    assert unknown and all(x.sun.elevation_deg is None for x in unknown)
    assert NV not in _states(s, "sun")  # nothing in this fixture is actually dark
    assert _states(s, "earth").count(UNK) == 3


def test_unknown_terrain_is_unknown_not_dark() -> None:
    s = load_fixture("unknown_terrain")
    assert s.horizon_profile is not None and None in s.horizon_profile.horizon_deg
    sun = _states(s, "sun")
    first_unknown = sun.index(UNK)
    assert first_unknown >= 5 and set(sun[:first_unknown]) == {V}, "known terrain first, then unknown"
    assert set(sun[first_unknown:]) == {UNK}
    unknown = [x.sun for x in s.samples if x.sun.state is UNK]
    assert all(o.elevation_deg is not None and o.horizon_deg is None for o in unknown)
    assert NV not in _states(s, "sun")


def test_irregular_sampling() -> None:
    s = load_fixture("irregular_sampling")
    gaps = {(b.time_utc - a.time_utc).total_seconds() for a, b in pairwise(s.samples)}
    assert s.sampling.nominal_interval_s is None
    assert len(gaps) > 3 and min(gaps) < 600.0
    assert {V, PART, NV} <= set(_states(s, "sun"))


def test_mission_boundary() -> None:
    s = load_fixture("mission_boundary")
    assert s.samples[0].time_utc == s.coverage_start_utc and s.samples[-1].time_utc == s.coverage_end_utc
    assert s.samples[0].sun.state is NV and s.samples[-1].sun.state is NV
    noon = s.samples[12].earth
    assert noon.elevation_deg == noon.horizon_deg and noon.state is NV


def test_geometric_only() -> None:
    s = load_fixture("geometric_only")
    assert s.calculation_basis is CalculationBasis.GEOMETRIC_ONLY
    assert s.provenance.terrain_source is None
    assert all(x.sun.horizon_deg is None and x.earth.horizon_deg is None for x in s.samples)


def test_disk_fraction_geometry() -> None:
    r = SUN_RADIUS_DEG
    assert disk_fraction(0.0) == pytest.approx(0.5)
    assert disk_fraction(r) == 1.0 and disk_fraction(-r) == 0.0
    assert disk_fraction(0.1) == pytest.approx(1.0 - disk_fraction(-0.1))
    xs = [-r + i * (2 * r / 20) for i in range(21)]
    fs = [disk_fraction(x) for x in xs]
    assert fs == sorted(fs)
