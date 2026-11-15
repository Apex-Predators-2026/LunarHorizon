"""Verification of the guided "Try a mission" story against the live engine.

The mission definition is a small versioned JSON file shared with the frontend
(``frontend/src/features/guide/missions/*.json``). It declares the plan, the disruption, the search options and the
outcome that was verified when the file was written. This module replays the story through the same HTTP endpoints
the browser uses (canonical assessment, Mission Rescue, comparison) and reports, check by check, whether the current
data and engine still produce it. Nothing is computed here that the UI does not compute: it is a regression baseline,
not a second evaluator.

Two kinds of expectation are kept apart:

* **stable** - scientific statements the story depends on (verdicts, the failing requirement, the evidence interval,
  that Rescue finds a passing recovery with the same duration and requirements, the comparison's recommendation).
  If any of these no longer holds the story is outdated and the UI must not narrate it.
* **incidental** - details that may change without invalidating the story (scores, the exact recovery Rescue ranks
  first, generated keys, rounding). They are reported but never fail verification.

Run ``python scripts/verify_mission_story.py`` from ``backend/`` (``--write-provenance`` refreshes the dataset hashes
and method versions recorded in the definition after a deliberate data or engine update).
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
MISSIONS_DIR = REPO / "frontend" / "src" / "features" / "guide" / "missions"
DEFINITION_SCHEMA = "mission-story-v1"
_H = 3600.0


def load_definition(path: Path) -> dict[str, Any]:
    d = json.loads(path.read_text(encoding="utf-8"))
    if d.get("schema") != DEFINITION_SCHEMA:
        raise ValueError(f"{path.name}: schema {d.get('schema')!r}, expected {DEFINITION_SCHEMA!r}")
    return d


def definitions() -> list[Path]:
    return sorted(MISSIONS_DIR.glob("*.json"))


def _parse(t: str) -> datetime:
    return datetime.fromisoformat(t).astimezone(UTC)  # Python 3.11+ reads a trailing Z


def _iso(t: datetime) -> str:
    return t.astimezone(UTC).isoformat().replace("+00:00", "Z")


def original_scenario(d: dict[str, Any]) -> dict[str, Any]:
    return dict(d["original"]["scenario"])


def disrupted_scenario(d: dict[str, Any]) -> dict[str, Any]:
    """The plan after the declared disruption, exactly as Mission Rescue builds it (app/rescue/search.py
    ``changed_scenario``): the landing moves by the delay; duration and requirements are unchanged."""
    o, dis = original_scenario(d), d["disruption"]
    if dis["kind"] != "launch_delay":
        raise ValueError(f"unsupported disruption {dis['kind']!r}")
    return {**o, "landing_utc": _iso(_parse(o["landing_utc"]) + timedelta(days=dis["launch_delay_days"]))}


@dataclass
class Check:
    name: str
    ok: bool
    detail: str
    stable: bool = True


@dataclass
class Report:
    mission_id: str
    version: int
    checks: list[Check] = field(default_factory=list)
    observed: dict[str, Any] = field(default_factory=dict)
    provenance: dict[str, Any] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return all(c.ok for c in self.checks if c.stable)

    def add(self, name: str, ok: bool, detail: str, stable: bool = True) -> bool:
        self.checks.append(Check(name, bool(ok), detail, stable))
        return bool(ok)

    def text(self) -> str:
        lines = [f"Mission story {self.mission_id} v{self.version}: {'VERIFIED' if self.ok else 'NOT REPRODUCED'}"]
        for c in self.checks:
            tag = "PASS" if c.ok else ("FAIL" if c.stable else "note")
            lines.append(f"  {tag:4}  {'' if c.stable else '(incidental) '}{c.name}: {c.detail}")
        return "\n".join(lines)


def _constraints(assess: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {c["constraint_id"]: c for c in assess["assessment"]["constraints"]}


def _hours(c: dict[str, Any], key: str = "value") -> float | None:
    m = c["measured"]
    v = m.get(key)
    if v is None:
        return None
    return v / _H if m["unit"] == "s" else v


def _margin_rows(assess: dict[str, Any], ids: list[str]) -> list[dict[str, Any]]:
    out = []
    for cid, c in _constraints(assess).items():
        if cid not in ids:
            continue
        unit = c["unit"]
        scale = 1 / _H if unit == "s" else 1.0
        out.append({
            "constraint": cid, "status": c["status"], "comparison": c["comparison"],
            "threshold": None if c["threshold"] is None else round(c["threshold"] * scale, 6),
            "measured": None if c["measured"]["value"] is None else round(c["measured"]["value"] * scale, 6),
            "unit": "h" if unit == "s" else unit,
        })
    return out


def verify(d: dict[str, Any], client: Any | None = None) -> Report:
    """Replay the story through the HTTP API (FastAPI TestClient by default) and check every expectation."""
    if client is None:
        from fastapi.testclient import TestClient

        from .main import app

        client = TestClient(app)

    exp = d["expected"]
    rep = Report(d["id"], d["version"])
    o_sc, d_sc = original_scenario(d), disrupted_scenario(d)

    def assess(sc: dict[str, Any]) -> dict[str, Any] | None:
        r = client.post("/api/viability/assess-scenario", json={"scenario": sc, "include_explanation_details": False})
        if r.status_code != 200:
            rep.add(f"assessment of {sc['site']['id']} {sc['landing_utc']}", False, f"HTTP {r.status_code}: {r.text[:200]}")
            return None
        return r.json()

    # 1. Original plan
    oa = assess(o_sc)
    if oa is None:
        return rep
    o_el = oa["assessment"]["eligibility"]
    rep.add("original verdict", o_el == exp["original"]["eligibility"], f"{o_el.upper()} (expected {exp['original']['eligibility'].upper()})")
    rep.observed["original"] = {"eligibility": o_el, "score": oa["assessment"]["score"].get("score"),
                                "margins": _margin_rows(oa, exp["original"].get("margin_constraints", []))}

    # 2. Disrupted plan
    da = assess(d_sc)
    if da is None:
        return rep
    d_el = da["assessment"]["eligibility"]
    rep.add("disrupted verdict", d_el == exp["disrupted"]["eligibility"], f"{d_el.upper()} (expected {exp['disrupted']['eligibility'].upper()})")
    failing = sorted(cid for cid, c in _constraints(da).items() if c["status"] == "fail")
    rep.add("failing requirements", failing == sorted(exp["disrupted"]["failing"]), f"{failing} (expected {sorted(exp['disrupted']['failing'])})")
    unknown = sorted(cid for cid, c in _constraints(da).items() if c["status"] == "unknown")
    rep.add("no undecided requirement after the delay", not unknown, f"undecided: {unknown or 'none'}")
    rep.observed["disrupted"] = {"eligibility": d_el, "failing": failing, "score": da["assessment"]["score"].get("score"),
                                 "margins": _margin_rows(da, exp["original"].get("margin_constraints", []))}

    # Status changes between the two plans (what the "What changed" stage highlights)
    oc, dc = _constraints(oa), _constraints(da)
    changes = sorted(cid for cid in oc if cid in dc and oc[cid]["status"] != dc[cid]["status"])
    rep.observed["status_changes"] = changes
    rep.add("requirements that change status", changes == sorted(exp["disrupted"]["failing"]), f"{changes}")

    # Margin over the limit: the story must not hinge on a threshold graze.
    for row in exp["disrupted"].get("min_exceedance", []):
        c = dc.get(row["constraint"])
        meas = None if c is None else _hours(c)
        thr = None if c is None or c["threshold"] is None else (c["threshold"] / _H if c["unit"] == "s" else c["threshold"])
        over = None if meas is None or thr is None else (meas - thr if c["comparison"] == "at_most" else thr - meas)
        rep.add(f"{row['constraint']} exceeds its limit by >= {row['hours']} h", over is not None and over >= row["hours"],
                f"measured {meas} h vs limit {thr} h (over by {over} h)")

    # 3. Evidence interval
    ev = exp["evidence"]
    windows = dc.get(ev["constraint"], {}).get("evidence_windows", [])
    w = windows[0] if windows else None
    rep.observed["evidence"] = w
    rep.add("evidence window", bool(w) and w["kind"] == ev["kind"] and w["start_utc"] == ev["start_utc"] and w["end_utc"] == ev["end_utc"]
            and w["clipped_at_end"] == ev["clipped_at_end"],
            f"{w and (w['kind'], w['start_utc'], w['end_utc'], w['duration_s'] / _H, 'clipped at end' if w['clipped_at_end'] else '')}")

    # 4. Mission Rescue with the declared search scope
    rr = client.post("/api/rescue", json={"original": o_sc, "change": {"launch_delay_days": d["disruption"]["launch_delay_days"],
                                                                         "reason": d["disruption"]["reason"]},
                                          "search": d["search"]})
    if rr.status_code != 200:
        rep.add("Mission Rescue", False, f"HTTP {rr.status_code}: {rr.text[:200]}")
        return rep
    res = rr.json()
    same_changed = (_parse(res["changed"]["scenario"]["landing_utc"]) == _parse(d_sc["landing_utc"])
                    and res["changed"]["scenario"]["duration_days"] == d_sc["duration_days"])
    rep.add("Rescue re-plans the same disrupted mission", same_changed, f"Rescue's changed plan lands {res['changed']['scenario']['landing_utc']}")
    crit = exp["recovery"]["criteria"]
    recov = [a for a in res["alternatives"] if a["viability"].get("eligibility", "pass" if a["viability"]["passes"] else "fail") == "pass"
             and (not crit["same_duration"] or a["scenario"]["duration_days"] == d_sc["duration_days"])
             and (not crit["same_requirements"] or a["scenario"]["requirements"] == res["changed"]["scenario"]["requirements"])
             and "synthetic" not in a["viability"]["data_source"].lower()]
    rep.add("Rescue finds a passing recovery (same duration and requirements, real data)", bool(recov),
            f"status {res['status']}, {len(res['alternatives'])} alternatives, {len(recov)} meet the criteria")
    if not recov:
        return rep
    pick = recov[0]
    ef = exp["recovery"].get("expected_first")
    rep.observed["recovery"] = {"site_id": pick["scenario"]["site"]["id"], "landing_utc": pick["scenario"]["landing_utc"],
                                "kind": pick["kind"], "rank": pick["rank"], "score": pick["viability"].get("score")}
    if ef:
        rep.add("recovery Rescue ranks first", pick["scenario"]["site"]["id"] == ef["site_id"]
                and _parse(pick["scenario"]["landing_utc"]) == _parse(ef["landing_utc"]) and pick["kind"] == ef["kind"],
                f"{pick['kind']} {pick['scenario']['site']['id']} {pick['scenario']['landing_utc']} (recorded {ef['kind']} {ef['site_id']} {ef['landing_utc']})",
                stable=False)

    # The canonical engine itself agrees on the recovery (Rescue's fast path must not be the only witness).
    ra = assess(pick["scenario"])
    if ra is None:
        return rep
    rep.add("recovery verdict (canonical assessment)", ra["assessment"]["eligibility"] == "pass", ra["assessment"]["eligibility"].upper())

    # 5. Comparison of the three plans
    cr = client.post("/api/compare", json={"scenarios": [
        {"key": "original", "scenario": o_sc}, {"key": "disrupted", "scenario": d_sc}, {"key": "recovery", "scenario": pick["scenario"]}]})
    if cr.status_code != 200:
        rep.add("comparison", False, f"HTTP {cr.status_code}")
        return rep
    cmp_ = cr.json()
    by = {r["key"]: r for r in cmp_["results"]}
    verdicts = {k: by[k]["ranking"]["eligibility"] for k in by}
    rep.observed["comparison"] = {"verdicts": verdicts, "groups": [(g["id"], g["ranked_keys"]) for g in cmp_["ranking_groups"]]}
    rep.add("comparison re-assessment agrees", verdicts == {"original": o_el, "disrupted": d_el, "recovery": "pass"}, f"{verdicts}")
    primary = next((g for g in cmp_["ranking_groups"] if g["primary"]), None)
    top = primary["ranked_keys"][0] if primary and primary["ranked_keys"] else None
    rep.add("comparison ranks the recovery first among passing plans", top == exp["comparison"]["ranked_first"],
            f"primary group {primary and primary['id']} ranked {primary and primary['ranked_keys']}")
    rep.add("one comparability group (same requirements and duration)", len(cmp_["ranking_groups"]) == 1, f"{len(cmp_['ranking_groups'])} group(s)")

    # 6. Provenance
    datasets = {}
    for a in (oa, ra):
        ds = a["input_dataset"]
        datasets[ds["site_file"]] = {"site_file": ds["site_file"], "sha256": ds["sha256"], "dataset_id": ds["dataset_id"],
                                     "generator": ds["provenance"].get("generator")}
    rep.provenance = {"datasets": sorted(datasets.values(), key=lambda x: x["site_file"]), "methods": oa["methods"]}
    recorded = {x["site_file"]: x["sha256"] for x in d.get("provenance", {}).get("datasets", [])}
    for f, x in datasets.items():
        if f in recorded:
            rep.add(f"dataset hash {f}", recorded[f] == x["sha256"], "unchanged" if recorded[f] == x["sha256"]
                    else f"changed: recorded {recorded[f][:12]}…, now {x['sha256'][:12]}…", stable=False)
    rec_methods = d.get("provenance", {}).get("methods")
    if rec_methods:
        rep.add("engine and method versions", rec_methods == oa["methods"], f"{oa['methods']}", stable=False)
    return rep
