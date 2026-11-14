"""Phase 5 contract (C0): score status and bounds, comparability metadata, data basis, policies.

Contract-level tests only; no scoring or ranking algorithm exists yet (Phases 5A / 5B).
All data here is SYNTHETIC. See docs/viability-engine.md §5e.
"""

from __future__ import annotations

import json
import re
from datetime import timedelta
from fractions import Fraction as Rational
from typing import Any

import pytest
from pydantic import ValidationError

from app.viability import (
    ComparabilityPolicy,
    DataBasis,
    ScoreComponent,
    ScoreComponentResult,
    ScoreComponentStatus,
    ScoreStatus,
)
from app.viability.enums import CalculationBasis, ConstraintStatus, Eligibility, MetricStatus, RiskLevel, Unit
from app.viability.mission import (
    UNSUPPORTED_SCORE_COMPONENTS,
    MissionScenario,
    RankingPreferences,
)
from app.viability.outputs import (
    Metric,
    RankedScenario,
    RankingResult,
    ScoreBreakdown,
    ViabilityAssessment,
)

from .helpers import assessment_kwargs

A = ScoreComponentStatus.ACTIVE
Z = ScoreComponentStatus.ZERO_WEIGHT
NC = ScoreComponentStatus.NOT_CONFIGURED
U = ScoreComponentStatus.UNSUPPORTED
SUN, EARTH, SIM, DARK, BLACK, CLEAR = list(ScoreComponent)

KEY = "sha256:" + "a" * 64
OTHER_KEY = "sha256:" + "b" * 64
KEY_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


def known(v: float) -> Metric:
    return Metric.known(v, Unit.FRACTION)


def bounded(lo: float, hi: float) -> Metric:
    return Metric.bounded(lo, hi, Unit.FRACTION)


def comp(
    component: ScoreComponent,
    status: ScoreComponentStatus,
    declared: float,
    weight: float = 0.0,
    normalized: Metric | None = None,
) -> ScoreComponentResult:
    exact = normalized is not None and normalized.status is MetricStatus.KNOWN
    value = normalized.value if exact and normalized is not None else None
    return ScoreComponentResult(
        component=component,
        weight=weight,
        normalized_value=value,
        contribution=weight * value * 100.0 if value is not None else None,
        status=status,
        declared_weight=declared,
        normalized=normalized,
    )


def default_components(values: dict[ScoreComponent, Metric] | None = None) -> list[ScoreComponentResult]:
    """Default preferences with both outage limits set: four ACTIVE components at 1/4 each."""
    v: dict[ScoreComponent, Metric] = values or {}
    return [
        comp(SUN, A, 1.0, 0.25, v.get(SUN)),
        comp(EARTH, A, 1.0, 0.25, v.get(EARTH)),
        comp(SIM, Z, 0.0),
        comp(DARK, A, 1.0, 0.25, v.get(DARK)),
        comp(BLACK, A, 1.0, 0.25, v.get(BLACK)),
        comp(CLEAR, U, 0.0),
    ]


KNOWN_VALUES = {SUN: known(0.8), EARTH: known(0.6), DARK: known(0.4), BLACK: known(1.0)}  # 25 * 2.8 = 70
BOUNDED_VALUES = {**KNOWN_VALUES, SUN: bounded(0.5, 0.9)}  # [25 * 2.5, 25 * 2.9] = [62.5, 72.5]


def known_score(rank_eligible: bool = True) -> ScoreBreakdown:
    return ScoreBreakdown(
        method_version="test-score",
        score=70.0,
        rank_eligible=rank_eligible,
        components=default_components(KNOWN_VALUES),
        status=ScoreStatus.KNOWN,
        score_bounds=Metric.known(70.0, Unit.PERCENT),
        configuration_key=KEY,
    )


def bounded_score(rank_eligible: bool = True) -> ScoreBreakdown:
    return ScoreBreakdown(
        method_version="test-score",
        score=None,
        rank_eligible=rank_eligible,
        components=default_components(BOUNDED_VALUES),
        status=ScoreStatus.BOUNDED,
        score_bounds=Metric.bounded(62.5, 72.5, Unit.PERCENT),
        configuration_key=KEY,
    )


def unknown_eligibility_score() -> ScoreBreakdown:
    return ScoreBreakdown(
        method_version="test-score",
        score=None,
        rank_eligible=False,
        components=default_components(),
        status=ScoreStatus.ELIGIBILITY_UNKNOWN,
        configuration_key=KEY,
    )


def no_components_score(rank_eligible: bool = True) -> ScoreBreakdown:
    return ScoreBreakdown(
        method_version="test-score",
        score=None,
        rank_eligible=rank_eligible,
        components=[comp(c, U if c is CLEAR else Z, 1.0 if c is CLEAR else 0.0) for c in ScoreComponent],
        status=ScoreStatus.NO_SCORABLE_COMPONENTS,
        configuration_key=KEY,
    )


def assessment(eligibility: Eligibility, score: ScoreBreakdown) -> ViabilityAssessment:
    statuses = {
        Eligibility.PASS: (ConstraintStatus.PASS,),
        Eligibility.UNKNOWN: (ConstraintStatus.UNKNOWN,),
        Eligibility.FAIL: (ConstraintStatus.FAIL,),
    }[eligibility]
    kwargs = assessment_kwargs(eligibility, statuses)
    kwargs["score"] = score
    return ViabilityAssessment(**kwargs)


def scenario(scenario_dict: dict[str, Any], **changes: Any) -> MissionScenario:
    d = json.loads(json.dumps(scenario_dict))
    for path, value in changes.items():
        *parents, leaf = path.split("__")
        target = d
        for p in parents:
            target = target.setdefault(p, {})
        if value is _DELETE:
            target.pop(leaf, None)
        else:
            target[leaf] = value
    return MissionScenario.model_validate(d)


_DELETE = object()


# --- enums -----------------------------------------------------------------------------------


def test_new_enum_values_are_stable_strings() -> None:
    assert [s.value for s in ScoreStatus] == ["known", "bounded", "eligibility_unknown", "no_scorable_components"]
    assert [s.value for s in ScoreComponentStatus] == ["active", "zero_weight", "not_configured", "unsupported"]
    assert [b.value for b in DataBasis] == ["real_terrain_aware", "real_geometric_only", "synthetic"]
    assert [p.value for p in ComparabilityPolicy] == ["strict", "same_method_and_weights"]


# --- default weights and configuration-only normalisation ------------------------------------


def test_default_weights() -> None:
    assert RankingPreferences().weights() == {SUN: 1.0, EARTH: 1.0, SIM: 0.0, DARK: 1.0, BLACK: 1.0, CLEAR: 0.0}


def test_user_specified_clearance_weight_is_preserved_but_unsupported(scenario_dict: dict[str, Any]) -> None:
    s = scenario(scenario_dict, preferences__clearance_margin_weight=0.5)
    assert s.preferences.clearance_margin_weight == 0.5
    assert s.score_component_status(CLEAR) is U
    assert s.effective_score_weights()[CLEAR] == 0.0
    assert UNSUPPORTED_SCORE_COMPONENTS == frozenset({CLEAR})


def test_effective_weights_with_defaults(scenario_dict: dict[str, Any]) -> None:
    s = scenario(scenario_dict)
    assert [s.score_component_status(c) for c in ScoreComponent] == [A, A, Z, A, A, U]
    w = s.effective_score_weights()
    assert list(w) == list(ScoreComponent)
    assert w == {SUN: 0.25, EARTH: 0.25, SIM: 0.0, DARK: 0.25, BLACK: 0.25, CLEAR: 0.0}


def test_missing_outage_limit_is_not_configured(scenario_dict: dict[str, Any]) -> None:
    s = scenario(scenario_dict, spacecraft__max_continuous_darkness_s=_DELETE)
    assert s.score_component_status(DARK) is NC
    w = s.effective_score_weights()
    assert w[DARK] == 0.0 and w[SUN] == w[EARTH] == w[BLACK] == pytest.approx(1 / 3)


def test_status_precedence(scenario_dict: dict[str, Any]) -> None:
    s = scenario(
        scenario_dict,
        spacecraft__max_communication_blackout_s=_DELETE,
        preferences__blackout_margin_weight=0.0,
        preferences__clearance_margin_weight=0.0,
    )
    assert s.score_component_status(BLACK) is NC  # not configured wins over zero weight
    assert s.score_component_status(CLEAR) is U  # unsupported wins over zero weight


def test_user_weights_are_used_proportionally(scenario_dict: dict[str, Any]) -> None:
    s = scenario(scenario_dict, preferences__sunlight_weight=3.0, preferences__simultaneous_weight=2.0)
    w = s.effective_score_weights()
    assert w[SUN] == pytest.approx(3 / 8) and w[SIM] == pytest.approx(2 / 8) and w[EARTH] == pytest.approx(1 / 8)


def test_no_active_component_gives_all_zero_weights(scenario_dict: dict[str, Any]) -> None:
    prefs = {f"preferences__{c.value}_weight": 0.0 for c in ScoreComponent if c is not CLEAR}
    s = scenario(scenario_dict, preferences__clearance_margin_weight=1.0, **prefs)
    assert set(s.effective_score_weights().values()) == {0.0}


def test_huge_declared_weights_do_not_overflow(scenario_dict: dict[str, Any]) -> None:
    prefs = {f"preferences__{c.value}_weight": 1e308 for c in (SUN, EARTH, DARK, BLACK)}
    w = scenario(scenario_dict, **prefs).effective_score_weights()
    assert [w[c] for c in (SUN, EARTH, DARK, BLACK)] == [0.25] * 4


def test_weights_do_not_depend_on_site_time_or_identity(scenario_dict: dict[str, Any]) -> None:
    a = scenario(scenario_dict)
    b = scenario(
        scenario_dict,
        scenario_id="other",
        site__lat=-85.0,
        mission_start_utc="2028-06-01T00:00:00Z",
        mission_end_utc="2028-06-15T00:00:00Z",
    )
    assert a.effective_score_weights() == b.effective_score_weights()


# --- configuration key -----------------------------------------------------------------------


def test_configuration_key_format_and_determinism(scenario_dict: dict[str, Any]) -> None:
    s = scenario(scenario_dict)
    key = s.configuration_key()
    assert KEY_RE.match(key)
    assert MissionScenario.model_validate_json(s.model_dump_json()).configuration_key() == key


def test_configuration_key_ignores_identity_site_start_and_preferences(scenario_dict: dict[str, Any]) -> None:
    base = scenario(scenario_dict).configuration_key()
    same = scenario(
        scenario_dict,
        scenario_id="renamed",
        name="Another name",
        site__id="site-2",
        site__lat=-88.0,
        mission_start_utc="2028-03-01T00:00:00Z",
        mission_end_utc="2028-03-15T00:00:00Z",  # same 14-day duration
        spacecraft__name="Another lander",
        preferences__sunlight_weight=5.0,
        requirements__unknown_data_policy="worst_case",  # inert (docs §5c)
    ).configuration_key()
    assert same == base


def test_configuration_key_normalises_integers_and_negative_zero(scenario_dict: dict[str, Any]) -> None:
    base = scenario(scenario_dict, requirements__min_initial_sunlight_s=0.0).configuration_key()
    assert scenario(scenario_dict, requirements__min_initial_sunlight_s=-0.0).configuration_key() == base
    try:
        as_int = scenario(scenario_dict, requirements__min_initial_sunlight_s=0)
    except ValidationError:  # pragma: no cover - only if strict floats ever reject ints
        return
    assert as_int.configuration_key() == base


@pytest.mark.parametrize(
    "changes",
    [
        {"mission_end_utc": "2027-01-15T01:00:00Z"},  # duration
        {"spacecraft__max_continuous_darkness_s": 50 * 3600.0},
        {"spacecraft__max_communication_blackout_s": _DELETE},
        {"spacecraft__solar_power_min_disk_fraction": 0.25},
        {"spacecraft__power_source": "radioisotope"},
        {"spacecraft__communication_mode": "relay"},
        {"requirements__min_sunlight_percent": 61.0},
        {"requirements__min_simultaneous_percent": 10.0},
        {"requirements__min_mean_solar_disk_fraction": 0.5},
        {"requirements__min_earth_clearance_deg": 2.0},
    ],
)
def test_configuration_key_changes_with_configuration(scenario_dict: dict[str, Any], changes: dict[str, Any]) -> None:
    assert scenario(scenario_dict, **changes).configuration_key() != scenario(scenario_dict).configuration_key()


# --- ScoreComponentResult --------------------------------------------------------------------


def test_legacy_component_still_valid() -> None:
    c = ScoreComponentResult(component=SUN, weight=0.5, normalized_value=0.4, contribution=20.0)
    assert c.status is None and c.normalized is None


def test_phase5_component_fields_require_status() -> None:
    with pytest.raises(ValidationError, match="require status"):
        ScoreComponentResult(component=SUN, weight=0.5, normalized_value=None, contribution=None, declared_weight=1.0)


@pytest.mark.parametrize(
    ("kwargs", "match"),
    [
        ({"status": A, "declared_weight": 1.0, "weight": 0.0}, "active component needs weight > 0"),
        ({"status": A, "declared_weight": 0.0, "weight": 0.5}, "active component needs weight > 0"),
        ({"status": Z, "declared_weight": 1.0, "weight": 0.0}, "declared_weight 0"),
        ({"status": NC, "declared_weight": 1.0, "weight": 0.5}, "weight 0 and no normalized"),
        ({"status": U, "declared_weight": 1.0, "weight": 0.0, "normalized": known(0.5)}, "weight 0 and no normalized"),
        ({"status": A, "weight": 0.5}, "declared_weight is required"),
    ],
)
def test_component_status_rules(kwargs: dict[str, Any], match: str) -> None:
    base: dict[str, Any] = {"component": SUN, "normalized_value": None, "contribution": None}
    with pytest.raises(ValidationError, match=match):
        ScoreComponentResult(**{**base, **kwargs})


def test_known_component_values_must_agree() -> None:
    base: dict[str, Any] = {"component": SUN, "weight": 0.5, "status": A, "declared_weight": 1.0}
    ScoreComponentResult(**base, normalized_value=0.4, contribution=20.0, normalized=known(0.4))
    with pytest.raises(ValidationError, match="normalized_value must equal"):
        ScoreComponentResult(**base, normalized_value=0.5, contribution=25.0, normalized=known(0.4))
    with pytest.raises(ValidationError, match="contribution must equal"):
        ScoreComponentResult(**base, normalized_value=0.4, contribution=21.0, normalized=known(0.4))
    with pytest.raises(ValidationError, match="require a normalized value"):
        ScoreComponentResult(**base, normalized_value=0.4, contribution=20.0)


@pytest.mark.parametrize(
    ("normalized", "value", "match"),
    [
        (bounded(0.2, 0.6), 0.2, "leave normalized_value and contribution null"),
        (bounded(0.4, 0.4), None, "lower < upper"),
        (bounded(-0.1, 0.6), None, r"within \[0, 1\]"),
        (bounded(0.2, 1.2), None, r"within \[0, 1\]"),
        (Metric.known(0.4, Unit.PERCENT), None, "unit 'fraction'"),
        (Metric.unavailable(Unit.FRACTION, "no data"), None, "known or bounded"),
    ],
)
def test_component_bounds_rules(normalized: Metric, value: float | None, match: str) -> None:
    with pytest.raises(ValidationError, match=match):
        ScoreComponentResult(
            component=SUN,
            weight=0.5,
            normalized_value=value,
            contribution=None,
            status=A,
            declared_weight=1.0,
            normalized=normalized,
        )


# --- ScoreBreakdown: the four states ---------------------------------------------------------


def test_legacy_breakdown_still_valid() -> None:
    s = ScoreBreakdown(method_version="t", score=55.0, rank_eligible=True)
    assert s.status is None and s.score_bounds is None and s.lower_bound is None
    assert s.weights_signature() is None


def test_legacy_breakdown_cannot_carry_phase5_fields() -> None:
    with pytest.raises(ValidationError, match="require status"):
        ScoreBreakdown(method_version="t", score=None, rank_eligible=True, score_bounds=Metric.known(1.0, Unit.PERCENT))
    with pytest.raises(ValidationError, match="require status"):
        ScoreBreakdown(method_version="t", score=None, rank_eligible=True, configuration_key=KEY)


def test_known_score() -> None:
    s = known_score()
    assert s.score == 70.0 and s.lower_bound == 70.0
    assert s.score_bounds == Metric.known(70.0, Unit.PERCENT)


def test_bounded_score_keeps_score_null() -> None:
    s = bounded_score()
    assert s.score is None
    assert s.score_bounds is not None and (s.score_bounds.lower, s.score_bounds.upper) == (62.5, 72.5)
    assert s.lower_bound == 62.5  # ordering only, never a displayed score
    assert json.loads(s.model_dump_json())["score"] is None


def test_unscored_states_are_null_not_zero() -> None:
    for s in (unknown_eligibility_score(), no_components_score()):
        dumped = json.loads(s.model_dump_json())
        assert dumped["score"] is None and dumped["score_bounds"] is None
        assert s.lower_bound is None


def _known_kwargs() -> dict[str, Any]:
    return known_score().model_dump()


def _rebuild(base: ScoreBreakdown, **changes: Any) -> ScoreBreakdown:
    data = base.model_dump()
    data.update(changes)
    return ScoreBreakdown.model_validate(data)


@pytest.mark.parametrize(
    ("changes", "match"),
    [
        ({"score": 71.0, "score_bounds": Metric.known(71.0, Unit.PERCENT).model_dump()}, "score must equal 100"),
        ({"score_bounds": None}, "known score_bounds with the same value"),
        ({"score_bounds": Metric.known(69.0, Unit.PERCENT).model_dump()}, "known score_bounds with the same value"),
        ({"score_bounds": Metric.known(70.0, Unit.FRACTION).model_dump()}, "unit 'percent'"),
        ({"configuration_key": None}, "configuration_key is required"),
        ({"configuration_key": "md5:abc"}, "configuration_key"),
        ({"status": ScoreStatus.BOUNDED}, "lower bound is not an exact score"),
    ],
)
def test_known_score_validation(changes: dict[str, Any], match: str) -> None:
    with pytest.raises(ValidationError, match=match):
        _rebuild(known_score(), **changes)


@pytest.mark.parametrize(
    ("changes", "match"),
    [
        ({"score": 62.5}, "lower bound is not an exact score"),
        ({"score_bounds": Metric.bounded(63.0, 72.5, Unit.PERCENT).model_dump()}, "lower sum, rounded down"),
        ({"score_bounds": Metric.bounded(62.5, 72.0, Unit.PERCENT).model_dump()}, "upper sum, rounded up"),
        ({"score_bounds": Metric.bounded(62.5, 100.5, Unit.PERCENT).model_dump()}, r"within \[0, 100\]"),
        ({"score_bounds": Metric.known(62.5, Unit.PERCENT).model_dump()}, "bounded score needs bounded score_bounds"),
    ],
)
def test_bounded_score_validation(changes: dict[str, Any], match: str) -> None:
    with pytest.raises(ValidationError, match=match):
        _rebuild(bounded_score(), **changes)


def test_bounded_status_needs_a_bounded_component() -> None:
    with pytest.raises(ValidationError, match="at least one bounded component"):
        _rebuild(
            known_score(), score=None, status=ScoreStatus.BOUNDED, score_bounds=Metric.bounded(69.0, 71.0, Unit.PERCENT)
        )


def test_bounds_may_be_rounded_outward_by_one_microunit() -> None:
    _rebuild(bounded_score(), score_bounds=Metric.bounded(62.499999, 72.500001, Unit.PERCENT).model_dump())


def test_eligibility_unknown_rules() -> None:
    with pytest.raises(ValidationError, match="cannot be rank-eligible"):
        _rebuild(unknown_eligibility_score(), rank_eligible=True)
    with pytest.raises(ValidationError, match="must leave score and score_bounds null"):
        _rebuild(unknown_eligibility_score(), score=70.0)
    with pytest.raises(ValidationError, match="must not carry normalized component values"):
        _rebuild(unknown_eligibility_score(), components=[c.model_dump() for c in default_components(KNOWN_VALUES)])


def test_no_scorable_components_rules() -> None:
    with pytest.raises(ValidationError, match="no component is active"):
        _rebuild(no_components_score(), components=[c.model_dump() for c in default_components()])
    with pytest.raises(ValidationError, match="needs at least one active component"):
        _rebuild(
            no_components_score(), status=ScoreStatus.KNOWN, score=0.0, score_bounds=Metric.known(0.0, Unit.PERCENT)
        )


def test_components_must_be_complete_and_ordered() -> None:
    comps = [c.model_dump() for c in default_components(KNOWN_VALUES)]
    with pytest.raises(ValidationError, match="every score component once"):
        _rebuild(known_score(), components=comps[::-1])
    with pytest.raises(ValidationError, match="every score component once"):
        _rebuild(known_score(), components=comps[:-1])


def test_effective_weights_must_follow_declared_weights() -> None:
    comps = default_components(KNOWN_VALUES)
    comps[0] = comp(SUN, A, 2.0, 0.25, known(0.8))  # declared 2 of 5 should weigh 0.4
    with pytest.raises(ValidationError, match="declared_weight / sum"):
        _rebuild(known_score(), components=[c.model_dump() for c in comps])


def test_weights_signature_is_exact_and_scale_invariant() -> None:
    doubled = [
        comp(c.component, c.status or A, 2 * (c.declared_weight or 0.0), c.weight, c.normalized)
        for c in default_components(KNOWN_VALUES)
    ]
    sig = known_score().weights_signature()
    assert sig == _rebuild(known_score(), components=[c.model_dump() for c in doubled]).weights_signature()
    assert sig is not None and dict(sig) == {
        SUN: Rational(1, 4),
        EARTH: Rational(1, 4),
        SIM: Rational(0),
        DARK: Rational(1, 4),
        BLACK: Rational(1, 4),
        CLEAR: Rational(0),
    }


@pytest.mark.parametrize("factory", [known_score, bounded_score, unknown_eligibility_score, no_components_score])
def test_breakdown_json_round_trip(factory: Any) -> None:
    s = factory()
    assert ScoreBreakdown.model_validate_json(s.model_dump_json()) == s


# --- ViabilityAssessment: D4 and eligibility independence ------------------------------------


def test_unknown_eligibility_rejects_any_score() -> None:
    legacy = ScoreBreakdown(method_version="t", score=70.0, rank_eligible=False)
    with pytest.raises(ValidationError, match="must not carry a score"):
        assessment(Eligibility.UNKNOWN, legacy)
    with pytest.raises(ValidationError, match="must not carry a score"):
        assessment(Eligibility.UNKNOWN, known_score(rank_eligible=False))
    with pytest.raises(ValidationError, match="eligibility_unknown"):
        assessment(Eligibility.UNKNOWN, no_components_score(rank_eligible=False))
    a = assessment(Eligibility.UNKNOWN, unknown_eligibility_score())
    assert a.score.score is None and a.eligibility is Eligibility.UNKNOWN


def test_unknown_legacy_null_score_still_valid() -> None:
    a = assessment(Eligibility.UNKNOWN, ScoreBreakdown(method_version="t", score=None, rank_eligible=False))
    assert a.score.status is None


@pytest.mark.parametrize("eligibility", [Eligibility.PASS, Eligibility.FAIL])
def test_eligibility_unknown_status_requires_unknown_eligibility(eligibility: Eligibility) -> None:
    # PASS is already rejected by ScoreBreakdown (a withheld score cannot be rank-eligible).
    with pytest.raises(ValidationError, match="requires eligibility UNKNOWN|cannot be rank-eligible"):
        assessment(eligibility, _rebuild(unknown_eligibility_score(), rank_eligible=eligibility is Eligibility.PASS))


def test_pass_with_bounded_or_unscored_result_has_no_artificial_number() -> None:
    for s in (bounded_score(), no_components_score()):
        a = assessment(Eligibility.PASS, s)
        assert a.eligibility is Eligibility.PASS and a.score.rank_eligible
        assert json.loads(a.model_dump_json())["score"]["score"] is None


def test_fail_may_carry_a_descriptive_score_but_is_never_rank_eligible() -> None:
    a = assessment(Eligibility.FAIL, known_score(rank_eligible=False))
    assert a.eligibility is Eligibility.FAIL and a.score.score == 70.0
    with pytest.raises(ValidationError, match="rank_eligible"):
        assessment(Eligibility.FAIL, known_score(rank_eligible=True))


def test_score_cannot_change_eligibility() -> None:
    # Eligibility is still derived from the constraints, whatever the score says.
    kwargs = assessment_kwargs(Eligibility.PASS, (ConstraintStatus.FAIL,))
    kwargs["score"] = known_score()
    with pytest.raises(ValidationError, match="contradicts constraint results"):
        ViabilityAssessment(**kwargs)


# --- data basis and comparability ------------------------------------------------------------


def _with_basis(a: ViabilityAssessment, basis: DataBasis) -> ViabilityAssessment:
    dq = a.data_quality
    prov = dq.provenance.model_copy(update={"is_synthetic": basis is DataBasis.SYNTHETIC})
    calc = CalculationBasis.GEOMETRIC_ONLY if basis is DataBasis.REAL_GEOMETRIC_ONLY else CalculationBasis.TERRAIN_AWARE
    return a.model_copy(update={"data_quality": dq.model_copy(update={"provenance": prov, "calculation_basis": calc})})


@pytest.mark.parametrize("basis", list(DataBasis))
def test_data_basis_is_derived_from_data_quality(basis: DataBasis) -> None:
    a = _with_basis(assessment(Eligibility.PASS, known_score()), basis)
    assert a.data_basis is basis and a.data_quality.data_basis is basis


def test_synthetic_wins_over_calculation_basis() -> None:
    a = assessment(Eligibility.PASS, known_score())
    dq = a.data_quality
    geometric_synthetic = dq.model_copy(
        update={
            "provenance": dq.provenance.model_copy(update={"is_synthetic": True}),
            "calculation_basis": CalculationBasis.GEOMETRIC_ONLY,
        }
    )
    assert geometric_synthetic.data_basis is DataBasis.SYNTHETIC


def test_comparability_key_requires_phase5_metadata() -> None:
    legacy = assessment(Eligibility.PASS, ScoreBreakdown(method_version="t", score=50.0, rank_eligible=True))
    with pytest.raises(ValueError, match="no Phase 5 metadata"):
        legacy.comparability_key()


def test_comparability_policies() -> None:
    a = _with_basis(assessment(Eligibility.PASS, known_score()), DataBasis.REAL_TERRAIN_AWARE)
    b = _with_basis(
        assessment(Eligibility.PASS, _rebuild(known_score(), configuration_key=OTHER_KEY)), DataBasis.REAL_TERRAIN_AWARE
    )
    assert a.comparability_key() == a.comparability_key(ComparabilityPolicy.STRICT)
    assert a.comparability_key() != b.comparability_key()  # strict: requirements / duration differ
    relaxed = ComparabilityPolicy.SAME_METHOD_AND_WEIGHTS
    assert a.comparability_key(relaxed) == b.comparability_key(relaxed)


def test_unknown_and_scored_entries_share_a_strict_key() -> None:
    scored = assessment(Eligibility.PASS, known_score())
    withheld = assessment(Eligibility.UNKNOWN, unknown_eligibility_score())
    assert scored.comparability_key() == withheld.comparability_key()


@pytest.mark.parametrize("policy", list(ComparabilityPolicy))
def test_data_bases_are_never_comparable(policy: ComparabilityPolicy) -> None:
    base = assessment(Eligibility.PASS, known_score())
    keys = {_with_basis(base, b).comparability_key(policy) for b in DataBasis}
    assert len(keys) == len(DataBasis)


def test_method_and_weights_always_matter() -> None:
    a = assessment(Eligibility.PASS, known_score())
    other_method = assessment(Eligibility.PASS, _rebuild(known_score(), method_version="other"))
    for policy in ComparabilityPolicy:
        assert a.comparability_key(policy) != other_method.comparability_key(policy)


# --- RankedScenario / RankingResult ----------------------------------------------------------


def entry(
    sid: str,
    eligibility: Eligibility,
    rank: int | None,
    status: ScoreStatus,
    score: float | None = None,
    bounds: tuple[float, float] | None = None,
    basis: DataBasis = DataBasis.REAL_TERRAIN_AWARE,
) -> RankedScenario:
    if status is ScoreStatus.KNOWN:
        assert score is not None
        sb: Metric | None = Metric.known(score, Unit.PERCENT)
    elif status is ScoreStatus.BOUNDED:
        assert bounds is not None
        sb = Metric.bounded(*bounds, Unit.PERCENT)
    else:
        sb = None
    return RankedScenario(
        rank=rank,
        scenario_id=sid,
        eligibility=eligibility,
        score=score,
        overall_risk=RiskLevel.LOW,
        score_status=status,
        score_bounds=sb,
        data_basis=basis,
    )


def ranking(entries: list[RankedScenario], basis: DataBasis = DataBasis.REAL_TERRAIN_AWARE) -> RankingResult:
    return RankingResult(
        method_version="test-rank", entries=entries, data_basis=basis, policy=ComparabilityPolicy.STRICT
    )


def valid_entries() -> list[RankedScenario]:
    return [
        entry("a", Eligibility.PASS, 1, ScoreStatus.KNOWN, score=70.0),
        entry("b", Eligibility.PASS, 2, ScoreStatus.BOUNDED, bounds=(62.5, 72.5)),
        entry("c", Eligibility.PASS, 3, ScoreStatus.NO_SCORABLE_COMPONENTS),
        entry("d", Eligibility.UNKNOWN, None, ScoreStatus.ELIGIBILITY_UNKNOWN),
        entry("e", Eligibility.FAIL, None, ScoreStatus.KNOWN, score=99.0),
    ]


def test_phase5_ranking_valid_and_round_trips() -> None:
    r = ranking(valid_entries())
    assert [e.lower_bound for e in r.entries] == [70.0, 62.5, None, None, 99.0]
    assert RankingResult.model_validate_json(r.model_dump_json()) == r
    dumped = json.loads(r.model_dump_json())
    assert dumped["data_basis"] == "real_terrain_aware" and dumped["policy"] == "strict"
    assert dumped["entries"][1]["score"] is None  # bounded: no exact score shown


def test_pass_order_follows_lower_bound() -> None:
    es = valid_entries()
    swapped = [
        entry("b", Eligibility.PASS, 1, ScoreStatus.BOUNDED, bounds=(62.5, 72.5)),
        entry("a", Eligibility.PASS, 2, ScoreStatus.KNOWN, score=70.0),
        *es[2:],
    ]
    with pytest.raises(ValidationError, match="ordered by score lower bound"):
        ranking(swapped)


def test_unscored_pass_entries_come_last() -> None:
    with pytest.raises(ValidationError, match="unscored last"):
        ranking(
            [
                entry("c", Eligibility.PASS, 1, ScoreStatus.NO_SCORABLE_COMPONENTS),
                entry("a", Eligibility.PASS, 2, ScoreStatus.KNOWN, score=10.0),
            ]
        )


def test_exact_before_bounded_at_equal_lower_bound() -> None:
    k = entry("k", Eligibility.PASS, 1, ScoreStatus.KNOWN, score=60.0)
    b = entry("b", Eligibility.PASS, 2, ScoreStatus.BOUNDED, bounds=(60.0, 80.0))
    ranking([k, b])
    with pytest.raises(ValidationError, match="exact scores before bounded"):
        ranking([b.model_copy(update={"rank": 1}), k.model_copy(update={"rank": 2})])


def test_non_pass_entries_are_not_order_checked_by_score() -> None:
    ranking(
        [
            entry("f1", Eligibility.FAIL, None, ScoreStatus.KNOWN, score=10.0),
            entry("f2", Eligibility.FAIL, None, ScoreStatus.KNOWN, score=90.0),
        ]
    )


def test_data_bases_never_share_a_ranking() -> None:
    mixed = [
        entry("real", Eligibility.PASS, 1, ScoreStatus.KNOWN, score=70.0),
        entry("synthetic", Eligibility.PASS, 2, ScoreStatus.KNOWN, score=60.0, basis=DataBasis.SYNTHETIC),
    ]
    with pytest.raises(ValidationError, match="never ranked together"):
        ranking(mixed)
    synthetic_only = [
        entry("s1", Eligibility.PASS, 1, ScoreStatus.KNOWN, score=70.0, basis=DataBasis.SYNTHETIC),
        entry("s2", Eligibility.PASS, 2, ScoreStatus.KNOWN, score=60.0, basis=DataBasis.SYNTHETIC),
    ]
    assert ranking(synthetic_only, DataBasis.SYNTHETIC).data_basis is DataBasis.SYNTHETIC


def test_phase5_ranking_metadata_rules() -> None:
    with pytest.raises(ValidationError, match="set together"):
        RankingResult(method_version="t", entries=[], data_basis=DataBasis.SYNTHETIC)
    with pytest.raises(ValidationError, match="need a ranking with data_basis"):
        RankingResult(method_version="t", entries=valid_entries()[:1])
    legacy_entry = RankedScenario(
        rank=1, scenario_id="x", eligibility=Eligibility.PASS, score=50.0, overall_risk=RiskLevel.LOW
    )
    with pytest.raises(ValidationError, match="never ranked together"):
        ranking([legacy_entry])


def test_ranked_scenario_rules() -> None:
    with pytest.raises(ValidationError, match="require score_status"):
        RankedScenario(
            scenario_id="x",
            eligibility=Eligibility.FAIL,
            score=None,
            overall_risk=RiskLevel.LOW,
            data_basis=DataBasis.SYNTHETIC,
        )
    with pytest.raises(ValidationError, match="data_basis is required"):
        RankedScenario(
            scenario_id="x",
            eligibility=Eligibility.FAIL,
            score=None,
            overall_risk=RiskLevel.LOW,
            score_status=ScoreStatus.NO_SCORABLE_COMPONENTS,
        )
    with pytest.raises(ValidationError, match="lower bound is not an exact score"):
        RankedScenario(
            scenario_id="x",
            eligibility=Eligibility.FAIL,
            score=62.5,
            overall_risk=RiskLevel.LOW,
            score_status=ScoreStatus.BOUNDED,
            score_bounds=Metric.bounded(62.5, 72.5, Unit.PERCENT),
            data_basis=DataBasis.REAL_TERRAIN_AWARE,
        )
    with pytest.raises(ValidationError, match="exactly when eligibility is UNKNOWN"):
        entry("u", Eligibility.UNKNOWN, None, ScoreStatus.NO_SCORABLE_COMPONENTS)
    with pytest.raises(ValidationError, match="exactly when eligibility is UNKNOWN"):
        entry("p", Eligibility.PASS, 1, ScoreStatus.ELIGIBILITY_UNKNOWN)


def test_legacy_ranking_still_valid() -> None:
    r = RankingResult(
        method_version="t",
        entries=[
            RankedScenario(
                rank=1, scenario_id="a", eligibility=Eligibility.PASS, score=None, overall_risk=RiskLevel.LOW
            ),
            RankedScenario(
                scenario_id="b", eligibility=Eligibility.UNKNOWN, score=None, overall_risk=RiskLevel.UNKNOWN
            ),
        ],
    )
    assert r.data_basis is None and r.policy is None


def test_mission_duration_is_part_of_the_configuration_key(scenario_dict: dict[str, Any]) -> None:
    s = scenario(scenario_dict)
    shifted = s.model_copy(update={"mission_end_utc": s.mission_end_utc + timedelta(microseconds=1)})
    assert shifted.configuration_key() != s.configuration_key()
