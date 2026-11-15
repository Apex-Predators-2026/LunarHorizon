"""The guided "Try a mission" story still reproduces on the committed data (app/mission_story.py).

If a stable check fails after a data or engine change, the frontend shows the example as outdated instead of
narrating it; re-verify with ``python scripts/verify_mission_story.py`` and update the definition deliberately.
"""
from __future__ import annotations

import pytest

from app.mission_story import definitions, disrupted_scenario, load_definition, original_scenario, verify

PATHS = definitions()


def test_at_least_one_mission_definition():
    assert PATHS, "frontend/src/features/guide/missions/ has no mission definition"


@pytest.mark.parametrize("path", PATHS, ids=[p.stem for p in PATHS])
def test_definition_is_self_consistent(path):
    d = load_definition(path)
    assert d["id"] and isinstance(d["version"], int) and d["title"] and d["objective"]
    o, dis = original_scenario(d), disrupted_scenario(d)
    # The disruption is a date shift only: duration and requirements stay unchanged.
    assert dis["duration_days"] == o["duration_days"] and dis["requirements"] == o["requirements"]
    assert dis["landing_utc"] != o["landing_utc"]
    assert d["data_mode"]["allow_demo_data"] is False and d["data_mode"]["include_synthetic"] is False
    assert d["expected"]["recovery"]["criteria"]["same_duration"] and d["expected"]["recovery"]["criteria"]["same_requirements"]
    assert d["provenance"]["datasets"], "run scripts/verify_mission_story.py --write-provenance"


@pytest.mark.parametrize("path", PATHS, ids=[p.stem for p in PATHS])
def test_story_reproduces(path):
    d = load_definition(path)
    rep = verify(d)
    assert rep.ok, rep.text()
    # Recorded dataset hashes match the files the API evaluated (else the baseline needs re-verification).
    stale = [c for c in rep.checks if c.name.startswith("dataset hash") and not c.ok]
    assert not stale, rep.text()
