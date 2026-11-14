"""Sensitivity analysis: does a plan survive small date slips and landing-position errors?

When the plan has real (precomputed) data, points that only have synthetic placeholder data
are left out rather than mixed in. Today that means landing-position checks are skipped for
real sites: the data engine only precomputes the curated site itself, not points around it.
"""
from __future__ import annotations

from collections import Counter
from datetime import timedelta

from ..models import Scenario
from .catalog import custom_site
from .engine import Evaluator, resolve_simulation
from .geo import destination
from .schemas import Robustness, SensitivityPoint, SensitivityRequest, SensitivityResponse


def _sentence(text: str) -> str:
    return text[:1].upper() + text[1:]


def _verdict(rate: float) -> str:
    return "robust" if rate >= 0.85 else "sensitive" if rate >= 0.5 else "fragile"


def _point(r, h: float, dist: float, bearing: float | None, lat: float, lon: float) -> SensitivityPoint:
    return SensitivityPoint(date_offset_hours=h, distance_km=dist, bearing_deg=bearing, lat=lat, lon=lon,
                            passes=r.passes, score=r.score, failing_constraints=[v.constraint for v in r.violations])


def analyse(req: SensitivityRequest, ev: Evaluator) -> SensitivityResponse:
    sc = req.scenario
    sim = resolve_simulation(req.include_synthetic, ev)
    base = ev.evaluate(sc, simulation=sim)
    n_requested = len(set(req.date_offsets_hours) - {0.0}) + len(req.position_offsets_km) * req.bearings
    if base.verdict == "unknown":
        return SensitivityResponse(
            base=base, points=[], date_pass_rate=None, position_pass_rate=None, safe_date_window_hours=None,
            score_min=None, score_max=None, most_sensitive_constraint=None, skipped_points=n_requested,
            verdict="unknown",
            explanation="No real data covers this plan, so its sensitivity can't be checked. "
                        + _sentence(base.violations[0].message.removeprefix("UNKNOWN: ")))
    points: list[SensitivityPoint] = []
    skipped = 0

    # Date slips at the same spot (one timeline fetch for all of them).
    offsets = sorted(set(req.date_offsets_hours) - {0.0})
    times = [sc.landing_utc + timedelta(hours=h) for h in offsets]
    for h, r in zip(offsets, ev.evaluate_many(sc.site, times, sc.duration_days, sc.requirements, simulation=sim)):
        if r.verdict == "unknown":  # slips outside the real data can't be judged
            skipped += 1
            continue
        points.append(_point(r, h, 0.0, None, sc.site.lat, sc.site.lon))

    # Landing-position errors at the planned time (custom points: synthetic data only, for now).
    for dist in req.position_offsets_km:
        for j in range(req.bearings):
            b = 360.0 * j / req.bearings
            lat, lon = destination(sc.site.lat, sc.site.lon, b, dist)
            site = custom_site(f"{sc.site.name} +{dist:g} km @ {b:.0f}°", lat, lon)
            if not sim and not ev.has_real_data(site):
                skipped += 1
                continue
            r = ev.evaluate(Scenario(site=site, landing_utc=sc.landing_utc, duration_days=sc.duration_days,
                                     requirements=sc.requirements), simulation=sim)
            points.append(_point(r, 0.0, dist, b, lat, lon))

    date_pts = [p for p in points if p.distance_km == 0]
    pos_pts = [p for p in points if p.distance_km > 0]
    rate = lambda ps: sum(p.passes for p in ps) / len(ps) if ps else None  # noqa: E731
    date_rate, pos_rate = rate(date_pts), rate(pos_pts)
    overall = rate(points)

    window = None
    if base.passes:
        by_off = {p.date_offset_hours: p.passes for p in date_pts}
        lo = hi = 0.0
        for h in sorted((h for h in by_off if h < 0), reverse=True):
            if not by_off[h]:
                break
            lo = h
        for h in sorted(h for h in by_off if h > 0):
            if not by_off[h]:
                break
            hi = h
        window = (lo, hi)

    fails = Counter(c for p in points for c in p.failing_constraints)
    most = fails.most_common(1)[0][0] if fails else None
    scores = [s for s in [p.score for p in points] + [base.score] if s is not None]

    parts = []
    if date_rate is not None:
        parts.append(f"{date_rate:.0%} of tested date slips")
    if pos_rate is not None:
        parts.append(f"{pos_rate:.0%} of tested landing-position errors")
    tested = " and ".join(parts) if parts else "no nearby points"

    if not base.passes:
        verdict = "fails"
        expl = f"The plan itself fails ({', '.join(v.constraint for v in base.violations)}). "
        if overall is not None:
            expl += f"{overall:.0%} of nearby dates/positions pass."
    else:
        verdict = _verdict(1.0 if overall is None else overall)
        expl = f"{tested.capitalize()} still pass. Safe window: {window[0]:+.0f} h to {window[1]:+.0f} h."
        if most:
            expl += f" The requirement that breaks first is '{most}'."
    if skipped:
        expl += (f" {skipped} point(s) skipped: no real data there"
                 + (" (landing-position checks need terrain for points around the site)." if pos_rate is None else "."))
    return SensitivityResponse(base=base, points=points, date_pass_rate=date_rate, position_pass_rate=pos_rate,
                               safe_date_window_hours=window, score_min=min(scores, default=None), score_max=max(scores, default=None),
                               most_sensitive_constraint=most, skipped_points=skipped, verdict=verdict,
                               explanation=expl)


def quick_robustness(sc: Scenario, ev: Evaluator, include_synthetic: bool | None = None) -> Robustness:
    """Cheap check used when ranking rescue alternatives: +/-12 h, +/-24 h, and (when data allows)
    1 km x 4 directions."""
    res = analyse(SensitivityRequest(scenario=sc, date_offsets_hours=[-24, -12, 12, 24], position_offsets_km=[1.0],
                                     bearings=4, include_synthetic=include_synthetic), ev)
    n = len(res.points)
    passing = sum(p.passes for p in res.points)
    r = passing / n if n else 1.0
    bad = [p for p in res.points if not p.passes]
    checked = "±1 day slip" + (" or a 1 km landing error" if res.position_pass_rate is not None else "")
    if not bad:
        note = f"Still passes with a {checked}."
    else:
        what = sorted({f"{p.date_offset_hours:+.0f} h" if p.distance_km == 0 else f"{p.distance_km:g} km off"
                       for p in bad})
        note = f"Fails at: {', '.join(what)}."
    if res.position_pass_rate is None and res.skipped_points:
        note += " (Landing-position error not checked: no real data around the site.)"
    return Robustness(checked_points=n, passing_points=passing, pass_rate=r,
                      worst_score=min((p.score for p in res.points if p.score is not None), default=res.base.score),
                      verdict=_verdict(r), note=note)
