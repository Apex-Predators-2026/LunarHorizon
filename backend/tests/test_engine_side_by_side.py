"""Side-by-side check before switching rescue to the canonical viability engine.

Runs rescue's placeholder and the canonical engine (through Brandon's compatibility layer,
app/viability/compat/rescue.py) on the same real timelines and compares verdicts and key
metrics. Agreed rule: switch the import in app/rescue/viability/__init__.py only once this
passes, or once every difference it reports is explained (and the tolerances below updated).

Skipped while the canonical engine is not implemented yet (it raises NotImplementedError).
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.models import Scenario
from app.rescue import Evaluator
from app.rescue.catalog import get_site
from app.rescue.timeline.precomputed import DEFAULT_DATA_DIR
from app.rescue.viability.placeholder import evaluate_timeline as placeholder_evaluate

compat = pytest.importorskip("app.viability.compat.rescue")

SITES = ["peak-near-shackleton", "connecting-ridge", "malapert-massif"]
STARTS = [datetime(2027, 1, 1, tzinfo=timezone.utc) + timedelta(days=d) for d in range(0, 700, 35)]
# Allowed differences (absolute). Tighten or explain as Phase 2+ semantics are confirmed.
TOL = {"sunlight_fraction": 0.01, "earth_visibility_fraction": 0.01,
       "longest_dark_gap_hours": 1.0, "longest_comms_gap_hours": 1.0,
       "initial_sun_hours": 1.0, "initial_comms_hours": 1.0}

pytestmark = pytest.mark.skipif(not all((DEFAULT_DATA_DIR / f"{s}.json").exists() for s in SITES),
                                reason="precomputed site files not present")


def _engine_ready() -> bool:
    ev = Evaluator()
    site = get_site("malapert-massif").to_site()
    sc = Scenario(site=site, landing_utc=STARTS[0])
    tl = ev.provider.timeline(site, sc.landing_utc, sc.landing_utc + timedelta(days=sc.duration_days), 1.0)
    try:
        compat.evaluate_timeline(sc, tl)
    except NotImplementedError:
        return False
    return True


def test_canonical_engine_matches_placeholder_on_real_data():
    if not _engine_ready():
        pytest.skip("canonical viability engine not implemented yet (Phases 2-6)")
    ev = Evaluator()
    differences = []
    for sid in SITES:
        site = get_site(sid).to_site()
        for t in STARTS:
            sc = Scenario(site=site, landing_utc=t)
            n = int(sc.duration_days * 24)
            tl = ev.provider.timeline(site, t, t + timedelta(hours=n - 1), 1.0)
            assert tl.source.startswith("precomputed"), "comparison must run on real data"
            old, new = placeholder_evaluate(sc, tl), compat.evaluate_timeline(sc, tl)
            if old.verdict != new.verdict:
                differences.append(f"{sid} {t:%Y-%m-%d}: verdict {old.verdict} -> {new.verdict}")
            for field, tol in TOL.items():
                a, b = getattr(old.metrics, field), getattr(new.metrics, field)
                if abs(a - b) > tol:
                    differences.append(f"{sid} {t:%Y-%m-%d}: {field} {a:.3f} -> {b:.3f}")
    assert not differences, "Placeholder and canonical engine disagree:\n" + "\n".join(differences[:40])
