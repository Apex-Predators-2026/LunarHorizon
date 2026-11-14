"""Rescue on the canonical viability engine (Member 2's findings, docs/viability-engine.md §5g).

1. A missing score is never ranked as 0: unscored passes rank after scored ones.
2. Real and synthetic candidates are never ranked together: real data first.
2b. A simulation batch that crosses the dataset end keeps covered starts on real data.
3. Coverage ends at the last sample: a mission must end by it (no extra final hour).
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.models import Scenario, ViabilityMetrics, ViabilityResult
from app.rescue import Evaluator, rescue, sensitivity
from app.rescue.catalog import get_site
from app.rescue.engine import is_real
from app.rescue.schemas import PlanChange, RescueRequest, SearchOptions, SensitivityRequest
from app.rescue.timeline import SyntheticTimelineProvider
from app.rescue.timeline.precomputed import DEFAULT_DATA_DIR
from tests.data_range import data_range

UTC = timezone.utc
needs_data = pytest.mark.skipif(not (DEFAULT_DATA_DIR / "malapert-massif.json").exists(),
                                reason="precomputed site files not present")
METRICS = ViabilityMetrics(sunlight_fraction=1, equivalent_sun_hours=1, longest_dark_gap_hours=0,
                           earth_visibility_fraction=1, longest_comms_gap_hours=0, initial_sun_hours=1,
                           initial_comms_hours=1, hours_to_first_sunset=None, hours_to_first_earthset=None,
                           mean_sun_clearance_deg=1, mean_earth_clearance_deg=1, mean_solar_elevation_deg=1)


def test_rescue_uses_the_canonical_engine_by_default():
    from app.rescue.viability import CHECK_BY_CONSTRAINT, evaluate_timeline
    assert evaluate_timeline.__module__ == "app.viability.compat.rescue"
    assert "battery_hours" in CHECK_BY_CONSTRAINT  # loosening table kept


@needs_data
def test_real_results_come_from_the_canonical_engine():
    r = Evaluator().evaluate(Scenario(site=get_site("malapert-massif").to_site(),
                                      landing_utc=datetime(2027, 3, 1, tzinfo=UTC)))
    assert r.source.startswith("viability-engine/") and is_real(r)


@needs_data
def test_coverage_ends_at_the_last_sample():
    ev = Evaluator()
    site = get_site("peak-near-shackleton").to_site()
    # A 7-day mission must end by the data's last sample (read from the file, not hard-coded).
    _, end = data_range("peak-near-shackleton")
    ok = ev.evaluate(Scenario(site=site, landing_utc=end - timedelta(hours=168)))
    late = ev.evaluate(Scenario(site=site, landing_utc=end - timedelta(hours=167)))
    assert is_real(ok) and ok.verdict in ("pass", "fail")
    assert late.verdict == "unknown" and late.violations[0].constraint == "data_coverage"
    assert late.violations[0].actual == pytest.approx(167.0)  # hours covered, not 168


@needs_data
def test_simulation_batch_crossing_the_data_end_keeps_covered_starts_real():
    ev = Evaluator()
    site = get_site("malapert-massif").to_site()
    _, end = data_range("malapert-massif")
    covered, uncovered = end - timedelta(days=20), end - timedelta(days=5)  # 14-day missions
    req = Scenario(site=site, landing_utc=covered).requirements
    a, b = ev.evaluate_many(site, [covered, uncovered], 14, req, simulation=True)
    assert is_real(a)
    assert b.data_source == "synthetic-placeholder"
    assert a.model_dump() == ev.evaluate(Scenario(site=site, landing_utc=covered, duration_days=14)).model_dump()


@needs_data
def test_simulation_mode_ranks_real_candidates_before_synthetic_ones():
    plan = Scenario(site=get_site("peak-near-shackleton").to_site(), landing_utc=datetime(2027, 3, 1, tzinfo=UTC),
                    duration_days=3)
    r = rescue(RescueRequest(original=plan, change=PlanChange(launch_delay_days=1),
                             search=SearchOptions(include_synthetic=True, date_window_days=6, top_n=8,
                                                  robustness_check=False)), Evaluator())
    real = [is_real(a.viability) for a in r.alternatives]
    assert real == sorted(real, reverse=True), real  # every real option comes before any synthetic one


def _fake(score_for):
    def evaluate(sc: Scenario, tl) -> ViabilityResult:
        score = score_for(sc)
        return ViabilityResult(scenario=sc, passes=True, eligibility="pass", score=score, metrics=METRICS,
                               violations=[], source="fake", data_source="fake")
    return evaluate


def test_unscored_passes_rank_after_scored_ones_never_as_zero():
    # Malapert passes without a score; Connecting Ridge passes with a low score of 20.
    def score_for(sc):
        return None if sc.site.id == "malapert-massif" else 20.0
    ev = Evaluator(provider=SyntheticTimelineProvider(), evaluate=_fake(score_for), simulation=True)
    plan = Scenario(site=get_site("peak-near-shackleton").to_site(), landing_utc=datetime(2027, 3, 1, tzinfo=UTC))
    opts = SearchOptions(candidate_site_ids=["malapert-massif", "connecting-ridge"], include_nearby_points=False,
                         date_window_days=0, robustness_check=False, top_n=5)
    r = rescue(RescueRequest(original=plan, change=PlanChange(launch_delay_days=1), search=opts), ev)
    ids = [a.scenario.site.id for a in r.alternatives]
    assert "malapert-massif" in ids
    scored = [a for a in r.alternatives if a.viability.score is not None]
    unscored = [a for a in r.alternatives if a.viability.score is None]
    assert scored and unscored
    assert max(r.alternatives.index(a) for a in scored) < min(r.alternatives.index(a) for a in unscored)
    # No invented number: an unscored option has no rank score (previously 0 minus penalties, e.g. -0.5).
    assert all(a.rank_score is None for a in unscored) and all(a.rank_score is not None for a in scored)


def test_sensitivity_keeps_missing_scores_missing():
    ev = Evaluator(provider=SyntheticTimelineProvider(), evaluate=_fake(lambda sc: None), simulation=True)
    plan = Scenario(site=get_site("malapert-massif").to_site(), landing_utc=datetime(2027, 3, 1, tzinfo=UTC))
    s = sensitivity(SensitivityRequest(scenario=plan, date_offsets_hours=[24], position_offsets_km=[]), ev)
    assert all(p.score is None for p in s.points)
    assert s.score_min is None and s.score_max is None


def test_timedelta_import_used():  # keeps the import list honest for linters
    assert timedelta(hours=1).total_seconds() == 3600
