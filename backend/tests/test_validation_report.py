"""The validation results shown in the docs and served by the API come from the stored report, not by hand."""

import json

from fastapi.testclient import TestClient

from app.engine.net import DATA_DIR
from app.engine.sites import ALL_SITES
from app.engine.validation_summary import DOC_BEGIN, DOC_END, render_markdown, summarize
from app.main import app

REPORT = json.loads((DATA_DIR / "validation" / "engine_validation.json").read_text())
DOC = (DATA_DIR.parent / "docs" / "validation-engine.md").read_text(encoding="utf-8")


def test_summary_counts_add_up_from_the_per_site_results():
    s = summarize(REPORT)
    sites = REPORT["sites"]
    e = s["ephemeris_agreement"]
    assert e["verdict_checks"] == sum(v["ephemeris"][b]["samples"] for v in sites.values() for b in ("sun", "earth"))
    assert e["verdict_changes"] == sum(v["ephemeris"][b]["verdict_changes"] for v in sites.values() for b in ("sun", "earth"))
    h = s["horizon_method"]
    applicable = [v for v in sites.values() if v["horizon_geometry"].get("applicable")]
    assert len(h["per_site_max_deg"]) == len(applicable)
    assert h["max_difference_deg"]["max"] == max(v["horizon_geometry"]["file_vs_independent_deg"]["max"] for v in applicable)
    for kind in ("ephemeris_agreement", "horizon_method", "illumination_observed"):
        assert {"kind", "scope", "reference", "limitation", "date"} <= set(s[kind])  # every result says what it covers


def test_the_docs_results_section_matches_the_stored_report():
    # If this fails: run `scripts/validate_engine.py --doc-only` (or the full script) to regenerate it.
    names = {x["id"]: x["name"] for x in ALL_SITES}
    stored = DOC[DOC.index(DOC_BEGIN): DOC.index(DOC_END) + len(DOC_END)]
    assert stored.replace("\r\n", "\n") == render_markdown(summarize(REPORT), names)


def test_superseded_numbers_are_marked_not_quoted_as_current():
    current = DOC[: DOC.index("## Earlier runs (superseded)")]
    assert "23,400" not in current
    assert "about 0.001°" not in current and "±10 percentage points" not in current


def test_api_serves_the_summary_with_the_report():
    r = TestClient(app).get("/api/validation")
    assert r.status_code == 200
    body = r.json()
    assert body["summary"] == summarize(REPORT)
