"""Regenerate the frontend's real /api/compare fixture (frontend/src/features/compare/__fixtures__/compare-response.json).

The fixture is the API's actual response for five scenarios on the committed site files (Horizons + LOLA data, the
canonical viability engine), so the frontend tests read exactly what the backend sends. Run from backend/ whenever the
comparison contract changes:

    python scripts/make_compare_fixture.py

Scenarios (same requirements and spacecraft: 400 W panel, 150 W load, 7.5 kWh battery; 7-day missions landing 2027-01-15 00:00 UTC unless noted):
  A Peak Near Shackleton (FAILs)  B Malapert Massif  C Connecting Ridge
  D Malapert 2035 (outside the data: unavailable)  E Malapert, 3-day mission (separate ranking group)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient

from app.main import app

OUT = Path(__file__).resolve().parents[2] / "frontend" / "src" / "features" / "compare" / "__fixtures__" / "compare-response.json"

REQUIREMENTS = {
    "min_sunlight_fraction": 0.5, "battery_hours": 100, "panel_threshold": 0.25,
    "min_earth_visibility_fraction": 0.3, "max_comms_gap_hours": 150,
    "min_initial_sun_hours": 0, "min_initial_comms_hours": 0,
}
SPACECRAFT = {"panel_mode": "vertical_sun_tracking", "panel_rated_power_w": 400, "average_load_w": 150,
              "battery_capacity_wh": 7500}
SITES = {
    "peak-near-shackleton": {"id": "peak-near-shackleton", "name": "Peak Near Shackleton", "lat": -89.01701, "lon": 126.27302},
    "malapert-massif": {"id": "malapert-massif", "name": "Malapert Massif", "lat": -85.9635, "lon": 357.6326},
    "connecting-ridge": {"id": "connecting-ridge", "name": "Connecting Ridge", "lat": -89.53432, "lon": 209.94767},
}


def scenario(key: str, site: str, landing: str, days: float) -> dict:
    return {"key": key, "scenario": {"site": SITES[site], "landing_utc": landing, "duration_days": days,
                                     "requirements": REQUIREMENTS}, "spacecraft": SPACECRAFT}


def main() -> None:
    body = {"scenarios": [
        scenario("A", "peak-near-shackleton", "2027-01-15T00:00:00Z", 7),
        scenario("B", "malapert-massif", "2027-01-15T00:00:00Z", 7),
        scenario("C", "connecting-ridge", "2027-01-15T00:00:00Z", 7),
        scenario("D", "malapert-massif", "2035-01-15T00:00:00Z", 7),
        scenario("E", "malapert-massif", "2027-01-15T00:00:00Z", 3),
    ]}
    res = TestClient(app).post("/api/compare", json=body)
    res.raise_for_status()
    OUT.write_text(json.dumps(res.json(), separators=(",", ":"), allow_nan=False), encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
