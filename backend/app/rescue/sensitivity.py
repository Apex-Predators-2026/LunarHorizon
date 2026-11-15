"""Sensitivity analysis: does a plan survive small date slips and landing-position errors?

Every requested point appears in the result with an explicit status:
  pass / fail        evaluated and decided
  unknown            evaluated, but real data does not fully cover it (never counted as a pass or a fail)
  not_evaluated      skipped, e.g. no terrain around the site for landing-position errors

When the plan has real (precomputed) data, points that only have synthetic placeholder data
are not evaluated rather than mixed in. Today that means landing-position checks are skipped for
real sites: the data engine only precomputes the curated site itself, not points around it.
"""
from __future__ import annotations

from collections import Counter
from datetime import timedelta

from ..models import Scenario
from .catalog import custom_site
from .engine import Evaluator, resolve_simulation
from .explain import short_label
from .geo import destination
from .schemas import Robustness, SensitivityCounts, SensitivityPoint, SensitivityRequest, SensitivityResponse


def _sentence(text: str) -> str:
    return text[:1].upper() + text[1:]


def _verdict(rate: float) -> str:
    return "robust" if rate >= 0.85 else "sensitive" if rate >= 0.5 else "fragile"


def _off(h: float) -> str:
    return "0 h" if h == 0 else f"{h:+.0f} h".replace("-", "−")


def _point(r, h: float, dist: float, bearing: float | None, lat: float, lon: float) -> SensitivityPoint:
    status = r.verdict if r.verdict in ("pass", "fail", "unknown") else ("pass" if r.passes else "fail")
    return SensitivityPoint(date_offset_hours=h, distance_km=dist, bearing_deg=bearing, lat=lat, lon=lon,
                            passes=status == "pass", score=r.score, status=status,
                            failing_constraints=[v.constraint for v in r.violations] if status == "fail" else [])


def _skipped(h: float, dist: float, bearing: float | None, lat: float, lon: float) -> SensitivityPoint:
    return SensitivityPoint(date_offset_hours=h, distance_km=dist, bearing_deg=bearing, lat=lat, lon=lon,
                            passes=False, score=None, failing_constraints=[], status="not_evaluated")


def _counts(points: list[SensitivityPoint]) -> SensitivityCounts:
    n = Counter(p.status for p in points)
    skipped = n["not_evaluated"]
    return SensitivityCounts(requested=len(points), evaluated=len(points) - skipped, skipped=skipped,
                             passed=n["pass"], failed=n["fail"], unknown=n["unknown"])


def _position_sites(sc: Scenario, req: SensitivityRequest):
    for dist in req.position_offsets_km:
        for j in range(req.bearings):
            b = 360.0 * j / req.bearings
            lat, lon = destination(sc.site.lat, sc.site.lon, b, dist)
            yield dist, b, lat, lon


def _decided(ps: list[SensitivityPoint]) -> list[SensitivityPoint]:
    return [p for p in ps if p.status in ("pass", "fail")]


def _rate(ps: list[SensitivityPoint]) -> float | None:
    d = _decided(ps)
    return sum(p.passes for p in d) / len(d) if d else None


def analyse(req: SensitivityRequest, ev: Evaluator) -> SensitivityResponse:
    sc = req.scenario
    sim = resolve_simulation(req.include_synthetic, ev)
    base = ev.evaluate(sc, simulation=sim)
    offsets = sorted(set(req.date_offsets_hours) - {0.0})
    if base.verdict == "unknown":
        pts = [_skipped(h, 0.0, None, sc.site.lat, sc.site.lon) for h in offsets]
        pts += [_skipped(0.0, d, b, lat, lon) for d, b, lat, lon in _position_sites(sc, req)]
        return SensitivityResponse(
            base=base, points=pts, counts=_counts(pts), date_pass_rate=None, position_pass_rate=None,
            safe_date_window_hours=None, score_min=None, score_max=None, most_sensitive_constraint=None,
            skipped_points=len(pts), verdict="unknown",
            explanation="No real data covers this plan, so its sensitivity can't be checked. "
                        + _sentence(base.violations[0].message.removeprefix("UNKNOWN: ")))
    points: list[SensitivityPoint] = []

    # Date slips at the same spot (one timeline fetch for all of them). Slips outside the real data come
    # back unknown: they stay in the list with that status.
    times = [sc.landing_utc + timedelta(hours=h) for h in offsets]
    for h, r in zip(offsets, ev.evaluate_many(sc.site, times, sc.duration_days, sc.requirements, simulation=sim)):
        points.append(_point(r, h, 0.0, None, sc.site.lat, sc.site.lon))

    # Landing-position errors at the planned time (custom points: synthetic data only, for now).
    for dist, b, lat, lon in _position_sites(sc, req):
        site = custom_site(f"{sc.site.name} +{dist:g} km @ {b:.0f}°", lat, lon)
        if not sim and not ev.has_real_data(site):
            points.append(_skipped(0.0, dist, b, lat, lon))
            continue
        r = ev.evaluate(Scenario(site=site, landing_utc=sc.landing_utc, duration_days=sc.duration_days,
                                 requirements=sc.requirements), simulation=sim)
        points.append(_point(r, 0.0, dist, b, lat, lon))

    counts = _counts(points)
    date_pts = [p for p in points if p.distance_km == 0]
    pos_pts = [p for p in points if p.distance_km > 0]
    date_rate, pos_rate, overall = _rate(date_pts), _rate(pos_pts), _rate(points)

    # Safe window: the contiguous run of TESTED offsets around 0 that pass. A failing, unknown or skipped
    # point ends the run, so the window never bridges one.
    window = None
    n_in_window = 0
    if base.passes and _decided(date_pts):
        by_off = {p.date_offset_hours: p.status for p in date_pts}
        lo = hi = 0.0
        for h in sorted((h for h in by_off if h < 0), reverse=True):
            if by_off[h] != "pass":
                break
            lo = h
            n_in_window += 1
        for h in sorted(h for h in by_off if h > 0):
            if by_off[h] != "pass":
                break
            hi = h
            n_in_window += 1
        window = (lo, hi)

    fails = Counter(c for p in points for c in p.failing_constraints)
    most = fails.most_common(1)[0][0] if fails else None
    scores = [s for s in [p.score for p in points] + [base.score] if s is not None]

    parts = []
    if date_rate is not None:
        parts.append(f"{sum(p.passes for p in date_pts)} of {len(_decided(date_pts))} tested date slips "
                     f"({date_rate:.0%})")
    if pos_rate is not None:
        parts.append(f"{sum(p.passes for p in pos_pts)} of {len(_decided(pos_pts))} tested landing-position "
                     f"errors ({pos_rate:.0%})")

    if not base.passes:
        verdict = "fails"
        expl = f"The plan itself fails ({', '.join(short_label(v.constraint) for v in base.violations)}). "
        if overall is not None:
            expl += f"{overall:.0%} of the {len(_decided(points))} nearby dates/positions that could be tested pass."
    elif overall is None:
        verdict = "not_assessed"
        expl = ("Not assessed: no neighbouring date or landing position could be evaluated, so this screening "
                "result says nothing about how the plan holds up to date slips or landing-position error. "
                "The planned date itself passes.")
    else:
        verdict = _verdict(overall)
        expl = f"Model screening result: {' and '.join(parts)} pass."
        if window is not None:
            if n_in_window:
                expl += (f" Passes at every tested slip from {_off(window[0])} to {_off(window[1])} "
                         f"({n_in_window} tested); this is not a guarantee for offsets between or beyond them.")
            else:
                expl += " No tested date slip next to the planned date passes."
        if most:
            expl += f" The requirement that breaks first is '{short_label(most)}'."
    if pos_pts and not _decided(pos_pts):
        expl += (f" Landing-position error was not checked ({len(pos_pts)} points skipped: no real terrain data "
                 "around the site), so passing date slips does not show robustness to landing-position error.")
    elif not pos_pts and verdict != "fails":
        expl += " Landing-position error was not requested, so these date results do not show robustness to it."
    elif counts.skipped:
        expl += f" {counts.skipped} landing-position point(s) were skipped."
    if counts.unknown:
        expl += f" {counts.unknown} point(s) could not be judged because real data does not fully cover them."
    return SensitivityResponse(base=base, points=points, counts=counts, date_pass_rate=date_rate,
                               position_pass_rate=pos_rate, safe_date_window_hours=window,
                               safe_date_window_tested=n_in_window, score_min=min(scores, default=None),
                               score_max=max(scores, default=None), most_sensitive_constraint=most,
                               skipped_points=counts.unknown + counts.skipped, verdict=verdict, explanation=expl)


def quick_robustness(sc: Scenario, ev: Evaluator, include_synthetic: bool | None = None) -> Robustness:
    """Cheap check used when ranking rescue alternatives: +/-12 h, +/-24 h, and (when data allows)
    1 km x 4 directions. Only points with a pass/fail answer count as checks."""
    res = analyse(SensitivityRequest(scenario=sc, date_offsets_hours=[-24, -12, 12, 24], position_offsets_km=[1.0],
                                     bearings=4, include_synthetic=include_synthetic), ev)
    checked_pts = _decided(res.points)
    n = len(checked_pts)
    passing = sum(p.passes for p in checked_pts)
    r = passing / n if n else None  # nothing checked: no pass rate, and no claim of robustness
    bad = [p for p in checked_pts if not p.passes]
    if r is None:
        return Robustness(checked_points=0, passing_points=0, pass_rate=None, worst_score=res.base.score,
                          verdict="unchecked", note="Robustness not checked: no real data around this date or site.")
    tested = sorted(p.date_offset_hours for p in checked_pts if p.distance_km == 0)
    what_tested = []
    if tested:
        what_tested.append("date slips of " + ", ".join(_off(h) for h in tested))
    if res.position_pass_rate is not None:
        what_tested.append("a 1 km landing error")
    if not bad:
        note = f"Still passes at the tested {' and '.join(what_tested)}."
    else:
        what = sorted({f"{p.date_offset_hours:+.0f} h" if p.distance_km == 0 else f"{p.distance_km:g} km off"
                       for p in bad})
        note = f"Fails at: {', '.join(what)}."
    if res.position_pass_rate is None and res.skipped_points:
        note += " (Landing-position error not checked: no real data around the site.)"
    return Robustness(checked_points=n, passing_points=passing, pass_rate=r,
                      worst_score=min((p.score for p in checked_pts if p.score is not None), default=res.base.score),
                      verdict=_verdict(r), note=note)
