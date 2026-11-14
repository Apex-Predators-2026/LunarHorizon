"""Decision-evidence demonstration on two real landing candidates (Member 2 Part 2, hackathon demo).

Malapert Massif vs Connecting Ridge (both south-polar Artemis candidate regions), the same 14-day mission from
2027-12-03T00:00Z, the standard solar direct-to-Earth lander. Every number is computed here, through the canonical
engine, on Member 1's committed site files (JPL Horizons + LOLA terrain); nothing is typed in by hand.

Run from ``backend/``::

    python -m app.viability.validation.demo                 # prints the demo text
    python -m app.viability.validation.demo --out demo.json # also writes the JSON payload (sorted keys)

The committed snapshot ``docs/member2-part2-demo.json`` records the sha256 of each site file it was built from;
``tests/viability/test_part2_validation.py`` regenerates it and requires an identical result while those files are
unchanged.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Final

from ..engine import evaluate_scenario
from ..enums import ConstraintStatus, RiskLevel, ScoreComponent
from ..outputs import Metric, ViabilityAssessment
from ..ranking import rank_assessments, ranking_explanations
from ..ranking_evidence import Advantage, PairwiseEvidence, compare_scenarios
from ..sampling_sensitivity import SamplingSensitivityReport, prepare_policy_series, sampling_sensitivity_report
from .suite import STANDARD_LANDER, Dataset, dataset_identity, load_datasets, mission, versions

__all__ = ["CANDIDATES", "DEMO_VERSION", "DURATION", "LANDING", "build_demo", "demo_json", "demo_text"]

DEMO_VERSION: Final = "member2-part2-demo-v1"
CANDIDATES: Final = ("malapert-massif", "connecting-ridge")
LANDING: Final = datetime(2027, 12, 3, tzinfo=UTC)
DURATION: Final = timedelta(days=14)
H: Final = 3600.0

# The scientific measurement behind each score component (docs/viability-engine.md §5f).
_COMPONENT_MEASUREMENT: Final = {
    ScoreComponent.SUNLIGHT: ("mean_solar_disk_fraction", "mean visible fraction of the solar disk"),
    ScoreComponent.EARTH_VISIBILITY: ("earth_visible_percent", "share of time Earth is in line of sight"),
    ScoreComponent.SIMULTANEOUS: ("simultaneous_percent", "share of time power-lit and Earth-visible together"),
    ScoreComponent.DARKNESS_MARGIN: ("longest_continuous_darkness", "longest period below the panel threshold"),
    ScoreComponent.BLACKOUT_MARGIN: ("longest_communication_blackout", "longest period without Earth line of sight"),
    ScoreComponent.CLEARANCE_MARGIN: ("mean_earth_clearance", "mean Earth clearance above the terrain"),
}


def _metric(m: Metric) -> dict[str, Any]:
    unit = m.unit.value
    scale, shown = (1 / H, "h") if unit == "s" else (1.0, unit)

    def v(x: float | None) -> float | None:
        return None if x is None else round(x * scale, 6)

    return {"status": m.status.value, "value": v(m.value), "lower": v(m.lower), "upper": v(m.upper), "unit": shown}


def _candidate(a: ViabilityAssessment) -> dict[str, Any]:
    s = a.score
    b = s.score_bounds
    return {
        "site": {"id": a.site.id, "name": a.site.name, "lat": a.site.lat, "lon": a.site.lon},
        "eligibility": a.eligibility.value,
        "requirements": [
            {
                "constraint": c.constraint_id.value,
                "name": c.name,
                "comparison": None if c.comparison is None else c.comparison.value,
                "threshold": round(c.threshold / H, 6)
                if c.unit.value == "s" and c.threshold is not None
                else c.threshold,
                "measured": _metric(c.measured),
                "status": c.status.value,
            }
            for c in a.constraints
            if c.status is not ConstraintStatus.NOT_APPLICABLE
        ],
        "margins": [
            {
                "margin": m.margin_id,
                "constraint": None if m.related_constraint is None else m.related_constraint.value,
                "value": _metric(m.value),
            }
            for m in a.margins
        ],
        "overall_risk": a.overall_risk.value,
        "risk_indicators": [
            {"code": r.code, "level": r.level.value, "message": r.message}
            for r in a.risks
            if r.level is not RiskLevel.LOW
        ],
        "score": {
            "status": None if s.status is None else s.status.value,
            "score": s.score,
            "bounds": None
            if b is None
            else [b.value if b.lower is None else b.lower, b.value if b.upper is None else b.upper],
            "method": s.method_version,
            "components": [
                {
                    "component": c.component.value,
                    "weight": c.weight,
                    "normalized": c.normalized_value,
                    "contribution_points": c.contribution,
                }
                for c in s.components
                if c.weight > 0
            ],
        },
        "coverage": {
            "sun_percent": a.data_quality.sun_coverage_percent,
            "earth_percent": a.data_quality.earth_coverage_percent,
            "uncovered_h": a.data_quality.uncovered_duration_s / H,
        },
        "data_basis": a.data_basis.value,
        "dataset_id": a.data_quality.dataset_id,
        "explanation_summary": [e.message for e in a.explanations if e.category.value == "summary"],
    }


def _measurements(ev: PairwiseEvidence, a: ViabilityAssessment, b: ViabilityAssessment) -> list[dict[str, Any]]:
    """For every active score component: the underlying measurement at both sites and what the evidence says."""
    out = []
    for c in ev.components:
        field, meaning = _COMPONENT_MEASUREMENT[c.component]
        ma, mb = getattr(a.metrics, field), getattr(b.metrics, field)
        diff = c.contribution_difference
        out.append(
            {
                "component": c.component.value,
                "measurement": field,
                "meaning": meaning,
                a.site.id: _metric(ma),
                b.site.id: _metric(mb),
                "weight": c.weight,
                "contribution_difference_points": None if diff is None else [diff.lower, diff.upper],
                "advantage": c.advantage.value,
                "established": c.advantage in (Advantage.SELECTED, Advantage.COMPETITOR),
            }
        )
    return out


def _sensitivity(r: SamplingSensitivityReport) -> dict[str, Any]:
    return {
        "verdict": r.verdict.value,
        "summary": r.summary,
        "eligibility": [r.baseline.assessment.eligibility.value, r.alternate.assessment.eligibility.value],
        "changed_constraints": [c.value for c in r.changed_constraints],
        "outages_h": {
            m.name: [
                None if m.baseline.value is None else m.baseline.value / H,
                None if m.alternate.value is None else m.alternate.value / H,
            ]
            for m in r.outages
        },
        "score": [r.score.baseline_score, r.score.alternate_score],
        "overall_risk": [r.risk.baseline_overall.value, r.risk.alternate_overall.value],
    }


def build_demo(datasets: dict[str, Dataset] | None = None) -> dict[str, Any]:
    d = datasets if datasets is not None else load_datasets(CANDIDATES)
    assessed = [evaluate_scenario(mission(d[s], LANDING, DURATION, scenario_id=s), d[s].prepared) for s in CANDIDATES]
    ranking = rank_assessments(assessed)
    by_id = {a.scenario_id: a for a in assessed}
    first, second = (by_id[e.scenario_id] for e in ranking.entries[:2])
    ev = compare_scenarios(first, second, ranking=ranking)
    sd = ev.score_difference
    sens = {
        s: sampling_sensitivity_report(
            mission(d[s], LANDING, DURATION, scenario_id=s), prepare_policy_series(d[s].series)
        )
        for s in CANDIDATES
    }
    limitations = list(
        dict.fromkeys(
            ev.limitations
            + [x for x in first.limitations]
            + [sens[CANDIDATES[0]].limitations[0], sens[CANDIDATES[0]].limitations[1]]
        )
    )
    return {
        "demo_version": DEMO_VERSION,
        "versions": versions(),
        "mission": {
            "landing_utc": LANDING.isoformat().replace("+00:00", "Z"),
            "end_utc": (LANDING + DURATION).isoformat().replace("+00:00", "Z"),
            "duration_days": DURATION.days,
            "lander": STANDARD_LANDER.to_json(),
        },
        "datasets": [dataset_identity(d[s]) for s in CANDIDATES],
        "candidates": {a.scenario_id: _candidate(a) for a in assessed},
        "ranking": [
            {"rank": e.rank, "scenario_id": e.scenario_id, "score": e.score, "lower_bound": e.lower_bound}
            for e in ranking.entries
        ],
        "ranking_explanations": ranking_explanations(assessed, ranking),
        "why_first": {
            "first": first.scenario_id,
            "deciding_criterion": None if ev.deciding_criterion is None else ev.deciding_criterion.value,
            "deciding_detail": ev.deciding_detail,
            "score_difference_status": sd.status.value,
            "score_difference_points": None if sd.interval is None else [sd.interval.lower, sd.interval.upper],
            "clearly_established": sd.status.value == "selected_higher",
            "statement": sd.statement,
            "explanation": ev.explanation,
        },
        "measurements": _measurements(ev, first, second),
        "sampling_sensitivity": {s: _sensitivity(r) for s, r in sens.items()},
        "limitations": limitations,
    }


def demo_json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def _fmt_metric(m: dict[str, Any]) -> str:
    if m["status"] == "known":
        return f"{m['value']:g} {m['unit']}"
    if m["status"] == "bounded":
        return f"{m['lower']:g}..{m['upper']:g} {m['unit']}"
    return str(m["status"])


def _pts(x: list[float] | None) -> str:
    return "n/a" if x is None else f"[{x[0]:+.6f}, {x[1]:+.6f}]"


def demo_text(p: dict[str, Any]) -> str:
    m = p["mission"]
    lines = [
        f"Decision evidence: {' vs '.join(c['site']['name'] for c in p['candidates'].values())}",
        (
            f"Mission: land {m['landing_utc']}, {m['duration_days']} days (to {m['end_utc']}); solar direct-to-Earth "
            f"lander (engine {p['versions']['engine']}, score {p['versions']['scoring_method']})"
        ),
    ]
    for sid, c in p["candidates"].items():
        sc = c["score"]
        score = f"{sc['score']:.2f}" if sc["score"] is not None else f"bounded {sc['bounds']}"
        lines.append(
            f"- {c['site']['name']}: {c['eligibility'].upper()}, score {score}, screening risk "
            f"{c['overall_risk']}"
            + (f" ({', '.join(r['code'] for r in c['risk_indicators'])})" if c["risk_indicators"] else "")
        )
        for r in c["requirements"]:
            lines.append(
                f"    {r['status']:>4}  {r['name'] or r['constraint']}: {_fmt_metric(r['measured'])} "
                f"({'<=' if r['comparison'] == 'at_most' else '>='} {r['threshold']:g})"
            )
    w = p["why_first"]
    lines += [
        f"Ranked first: {w['first']} (criterion: {w['deciding_criterion']}).",
        (
            f"Score advantage clearly established: {'yes' if w['clearly_established'] else 'no'} "
            f"({w['score_difference_status']}, difference {_pts(w['score_difference_points'])} points)."
        ),
        "Measurements behind the difference:",
    ]
    for x in p["measurements"]:
        ids = [k for k in x if k in p["candidates"]]
        vals = ", ".join(f"{k} {_fmt_metric(x[k])}" for k in ids)
        lines.append(
            f"    {x['component']}: {vals}; contribution difference {_pts(x['contribution_difference_points'])} "
            f"points, advantage {x['advantage']}{' (established)' if x['established'] else ''}"
        )
    lines.append("Sampling sensitivity (sample-and-hold vs nearest-sample):")
    for sid, s in p["sampling_sensitivity"].items():
        lines.append(f"    {sid}: {s['verdict']}: {s['summary']}")
    lines.append("Limitations:")
    lines += [f"    - {x}" for x in p["limitations"]]
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(prog="python -m app.viability.validation.demo", description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, help="write the JSON payload here")
    args = ap.parse_args(argv)
    payload = build_demo()
    if args.out:
        args.out.write_text(demo_json(payload), encoding="utf-8", newline="\n")
    print(demo_text(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
