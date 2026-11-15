"""Capture the real API responses of the guided mission story as frontend test fixtures.

    python scripts/make_mission_fixtures.py

Writes frontend/src/features/guide/__fixtures__/{assess-original,assess-disrupted,assess-recovery,rescue,compare}.json
from the committed site files, through the same endpoints the browser calls, for the definition in
frontend/src/features/guide/missions/pns-launch-delay.json. Re-run when the API contract changes.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient

from app.main import app
from app.mission_story import MISSIONS_DIR, disrupted_scenario, load_definition, original_scenario

OUT = MISSIONS_DIR.parent / "__fixtures__"


def main() -> None:
    d = load_definition(MISSIONS_DIR / "pns-launch-delay.json")
    c = TestClient(app)
    o, dis = original_scenario(d), disrupted_scenario(d)

    def assess(sc):
        r = c.post("/api/viability/assess-scenario", json={"scenario": sc, "include_explanation_details": True})
        r.raise_for_status()
        return r.json()

    rescue = c.post("/api/rescue", json={"original": o, "change": {"launch_delay_days": d["disruption"]["launch_delay_days"],
                                                                    "reason": d["disruption"]["reason"]}, "search": d["search"]}).json()
    rec = rescue["alternatives"][0]["scenario"]
    cmp_ = c.post("/api/compare", json={"scenarios": [{"key": "original", "scenario": o}, {"key": "disrupted", "scenario": dis},
                                                       {"key": "recovery", "scenario": rec}]}).json()
    OUT.mkdir(exist_ok=True)
    for name, body in [("assess-original", assess(o)), ("assess-disrupted", assess(dis)), ("assess-recovery", assess(rec)),
                       ("rescue", rescue), ("compare", cmp_)]:
        (OUT / f"{name}.json").write_text(json.dumps(body, indent=1) + "\n", encoding="utf-8")
        print("wrote", OUT / f"{name}.json")


if __name__ == "__main__":
    main()
