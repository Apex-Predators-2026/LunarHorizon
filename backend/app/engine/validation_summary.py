"""The validation report's headline numbers, derived from the stored per-site results.

`scripts/validate_engine.py` writes `data/validation/engine_validation.json` (per-site results plus a `run`
block: when, which code, which site data). Everything the app or the docs show is computed here from that
file, never typed in by hand, so a re-run can't leave stale numbers behind. The results are kept in separate
kinds, each with its scope, date, reference and limitation:

  * ephemeris_agreement   our Sun/Earth positions vs an independent ephemeris (software agreement)
  * horizon_method        our horizon vs an independent geometry on the same elevation data (method agreement)
  * illumination_observed our sunlight % vs LROC orbital images (comparison with observations)

Software testing (unit tests) is a fourth kind, documented in docs/validation-engine.md; it isn't part of
this report. No result here is a formal uncertainty: they are agreement measures with stated scope.
"""

from __future__ import annotations

from typing import Any


def _max(values: list[float]) -> float | None:
    return max(values) if values else None


def summarize(report: dict[str, Any]) -> dict[str, Any]:
    sites: dict[str, Any] = report["sites"]
    run: dict[str, Any] = report.get("run") or {}
    ref: dict[str, Any] = report.get("reference") or {}
    date = run.get("run_utc")

    # Ephemeris agreement: every sample of both bodies at every site.
    checks = changed = 0
    seps: list[float] = []
    rms: list[float] = []
    samples_per_body: set[int] = set()
    for s in sites.values():
        for body in ("sun", "earth"):
            e = s["ephemeris"][body]
            checks += e["samples"]
            changed += e["verdict_changes"]
            seps.append(e["separation_deg"]["max"])
            rms.append(e["separation_deg"]["rms"])
            samples_per_body.add(e["samples"])
    ephemeris = {
        "kind": "Software agreement (independent ephemeris)",
        "date": date,
        "sites": len(sites),
        "scope": f"{len(sites)} sites, Sun and Earth, every {ref.get('ephemeris_sample_every_hours')} h over the "
        f"site files' data range ({run.get('data_range', 'see the site files')})",
        "reference": ref.get("ephemeris"),
        "max_separation_deg": _max(seps),
        "max_rms_deg": _max(rms),
        "verdict_checks": checks,
        "verdict_changes": changed,
        "limitation": "Compares two computations (JPL Horizons DE441 vs Skyfield DE421), not observations. The "
        "differences are mostly the 0.001 deg rounding of the stored angles. Verdict changes count sampled "
        "visible/blocked verdicts that flip when the reference positions are run through our horizon.",
    }

    # Horizon method agreement: only where the flat-map method applies (south-polar sites).
    geo = {sid: s["horizon_geometry"] for sid, s in sites.items() if s["horizon_geometry"].get("applicable")}
    maxes = {sid: g["file_vs_independent_deg"]["max"] for sid, g in geo.items()}
    mirrored = [g["mirrored_vs_independent_deg"]["max"] for g in geo.values()]
    worst = max(maxes, key=lambda k: maxes[k]) if maxes else None
    horizon = {
        "kind": "Method agreement (independent geometry, same elevation data)",
        "date": date,
        "scope": f"{len(geo)} of {len(sites)} sites (those the south-polar map plane covers), "
        f"{next(iter(geo.values()))['directions'] if geo else 0} directions each",
        "reference": "Straight lines in the polar map plane + central-angle formula (the engine's original method)",
        "max_difference_deg": {"min": min(maxes.values()) if maxes else None, "max": maxes[worst] if worst else None,
                               "site": worst},
        "per_site_max_deg": maxes,
        "mirrored_max_deg": {"min": min(mirrored) if mirrored else None, "max": _max(mirrored)},
        "limitation": "Tests the geometry only: both methods read the same LOLA elevation data, so errors in the "
        "terrain data itself are not tested. The differences grow away from the pole, where the flat-map "
        "method's straight-line approximation is weakest.",
    }

    # Comparison with observations (LROC), where the map covers the site.
    points, areas = {}, {}
    for sid, s in sites.items():
        ill = s["illumination"]
        if ill.get("covered"):
            points[sid] = {"model_any_sun_pct": ill["model_any_sun_pct"], "lroc_pct": ill["lroc_pct_at_pixel"],
                           "lroc_3x3_pct": [ill["lroc_pct_3x3_min"], ill["lroc_pct_3x3_max"]]}
        sp = s.get("spatial")
        if sp:
            areas[sid] = {"points": sp["points"], "grid": sp["grid"], "pearson_r": sp["ours"]["pearson_r"],
                          "mean_bias_pct": sp["ours"]["mean_bias_pct"], "mean_abs_diff_pct": sp["ours"]["mean_abs_diff_pct"],
                          "lroc_mean_pct": sp["lroc_mean_pct"]}
    worst_point = max(points, key=lambda k: abs(points[k]["model_any_sun_pct"] - points[k]["lroc_pct"])) if points else None
    illumination = {
        "kind": "Comparison with observations (LROC orbital images)",
        "date": date,
        "scope": f"{len(points)} of {len(sites)} sites inside the LROC map (88-90 S); model re-run for the "
        "map's period with the sensor at the surface",
        "reference": ref.get("illumination"),
        "site_pixel": points,
        "area": areas,
        "largest_point_difference": None if not worst_point else {
            "site": worst_point,
            "points_pct": round(abs(points[worst_point]["model_any_sun_pct"] - points[worst_point]["lroc_pct"]), 1)},
        "limitation": "Yearly totals from 2010-11, not the mission dates; a 100 m camera pixel vs a point model. "
        "On sharp light/dark edges single points can differ by tens of percentage points; these are observed "
        "discrepancies, not a confidence interval.",
    }
    return {"run": run, "ephemeris_agreement": ephemeris, "horizon_method": horizon, "illumination_observed": illumination}


# ---------------------------------------------------------------- the docs' results section

DOC_BEGIN = "<!-- validation-results:begin (generated by scripts/validate_engine.py from the stored report; don't edit by hand) -->"
DOC_END = "<!-- validation-results:end -->"


def _deg(x: float | None, digits: int = 4) -> str:
    return "n/a" if x is None else f"{x:.{digits}f}°"


def _name(site_id: str, names: dict[str, str]) -> str:
    return names.get(site_id, site_id)


def render_markdown(summary: dict[str, Any], names: dict[str, str]) -> str:
    run, e, h, i = summary["run"], summary["ephemeris_agreement"], summary["horizon_method"], summary["illumination_observed"]
    lines = [DOC_BEGIN, ""]
    when = run.get("run_utc", "not recorded")
    code = run.get("code_commit", "not recorded")
    lines += [
        f"**Run:** {when} · code {code} · site data generator {', '.join(run.get('site_generator_versions', [])) or 'not recorded'}"
        f" · data range {run.get('data_range', 'not recorded')} · {e['sites']} sites",
        "",
        "| Kind | What was compared | Scope | Result | Limitation |",
        "|---|---|---|---|---|",
        f"| {e['kind']} | Our Sun/Earth positions vs {e['reference']} | {e['scope']} | Max separation {_deg(e['max_separation_deg'], 5)}; "
        f"{e['verdict_changes']:,} of {e['verdict_checks']:,} sampled visible/blocked verdicts change | {e['limitation']} |",
        f"| {h['kind']} | Our horizon vs {h['reference'].lower()} | {h['scope']} | Max difference per site "
        f"{_deg(h['max_difference_deg']['min'], 3)} to {_deg(h['max_difference_deg']['max'], 3)} "
        f"(largest: {_name(h['max_difference_deg']['site'] or '', names)}); an east-west mirror would be off by "
        f"{_deg(h['mirrored_max_deg']['min'], 1)} to {_deg(h['mirrored_max_deg']['max'], 1)} | {h['limitation']} |",
    ]
    lp = i["largest_point_difference"]
    area_txt = "; ".join(
        f"{_name(sid, names)} bias {a['mean_bias_pct']:+.1f} pts, r = {'n/a' if a['pearson_r'] is None else f'{a['pearson_r']:.2f}'}"
        for sid, a in i["area"].items())
    lines.append(
        f"| {i['kind']} | Our sunlight % vs {i['reference']} | {i['scope']} | Area averages ({next(iter(i['area'].values()))['grid'] if i['area'] else ''}): "
        f"{area_txt}. Largest single-point difference: {lp['points_pct'] if lp else 'n/a'} pts ({_name(lp['site'], names) if lp else ''}) | {i['limitation']} |")
    lines += ["", "Horizon method agreement, per site (max difference over all directions):", "",
              "| Site | Max difference |", "|---|---|"]
    lines += [f"| {_name(sid, names)} | {_deg(v, 3)} |" for sid, v in h["per_site_max_deg"].items()]
    lines += ["", "Sunlight vs LROC at the site's own pixel (LROC 3×3 neighbourhood for context):", "",
              "| Site | Model (any Sun) | LROC pixel | LROC 3×3 |", "|---|---|---|---|"]
    lines += [f"| {_name(sid, names)} | {p['model_any_sun_pct']:.1f}% | {p['lroc_pct']:.1f}% | {p['lroc_3x3_pct'][0]:.1f}–{p['lroc_3x3_pct'][1]:.1f}% |"
              for sid, p in i["site_pixel"].items()]
    lines += ["", "Sunlight vs LROC over the area around the site:", "",
              "| Site | Points | Correlation r | Mean bias (model − LROC) | Mean abs. difference | LROC mean |", "|---|---|---|---|---|---|"]
    lines += [f"| {_name(sid, names)} | {a['points']} | {'n/a (all dark)' if a['pearson_r'] is None else f'{a['pearson_r']:.2f}'} | "
              f"{a['mean_bias_pct']:+.1f} pts | {a['mean_abs_diff_pct']:.1f} pts | {a['lroc_mean_pct']:.1f}% |"
              for sid, a in i["area"].items()]
    lines += ["", DOC_END]
    return "\n".join(lines)


def replace_doc_section(doc: str, section: str) -> str:
    """Put `section` (render_markdown) between the markers in the doc text."""
    a, b = doc.index(DOC_BEGIN), doc.index(DOC_END) + len(DOC_END)
    return doc[:a] + section + doc[b:]
