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
from .engine import NO_DATA_SOURCE, Evaluator, resolve_simulation
from .explain import short_label
from .geo import destination
from .schemas import DateSlipCheck, Robustness, SensitivityCounts, SensitivityPoint, SensitivityRequest, SensitivityResponse


def _sentence(text: str) -> str:
    return text[:1].upper() + text[1:]


def _verdict(rate: float) -> str:
    return "robust" if rate >= 0.85 else "sensitive" if rate >= 0.5 else "fragile"


def _off(h: float) -> str:
    return "0 h" if h == 0 else f"{h:+.0f} h".replace("-", "−")


def _metric_bound(m) -> float | None:
    if m is None:
        return None
    val = m.margin
    if val.status == "known" and val.value is not None:
        return val.value
    if val.status == "bounded" and val.lower is not None:
        return val.lower
    return None


def _headroom_fields(r) -> tuple[float | None, float | None, str | None, str | None, str | None]:
    hr = getattr(r, "headroom", None)
    if hr is None:
        return (None, None, None, None, None)
    dark_h = _metric_bound(hr.darkness)
    comms_h = _metric_bound(hr.communication_blackout)
    closest_label = hr.closest_constraint.label if hr.closest_constraint else None
    closest_text = hr.closest_constraint.headroom_text if hr.closest_constraint else None
    return (dark_h, comms_h, closest_label, closest_text, hr.status)


def _undecided_reason(r, has_coverage: bool) -> str:
    """Why an UNKNOWN result has no answer: no real data at all, real data but not for these dates, or real
    data with missing samples (a gap, or the mission runs past the end of the data)."""
    if r.data_source == NO_DATA_SOURCE:
        return "outside_coverage" if has_coverage else "no_real_data"
    return "incomplete_data"


def _point(r, h: float, dist: float, bearing: float | None, lat: float, lon: float,
           has_coverage: bool = True) -> SensitivityPoint:
    status = r.verdict if r.verdict in ("pass", "fail", "unknown") else ("pass" if r.passes else "fail")
    dark_h, comms_h, closest_label, closest_text, hr_status = _headroom_fields(r)
    undecided = [v.constraint for v in r.violations if v.is_unknown] if status in ("fail", "unknown") else []
    return SensitivityPoint(date_offset_hours=h, distance_km=dist, bearing_deg=bearing, lat=lat, lon=lon,
                            passes=status == "pass", score=r.score, status=status,
                            failing_constraints=[v.constraint for v in r.violations] if status == "fail" else [],
                            darkness_headroom_h=dark_h, comms_headroom_h=comms_h,
                            closest_label=closest_label, closest_headroom_text=closest_text,
                            headroom_status=hr_status,
                            reason=_undecided_reason(r, has_coverage) if status == "unknown" else None,
                            undecided_constraints=undecided)


def _skipped(h: float, dist: float, bearing: float | None, lat: float, lon: float,
             reason: str = "position_unsupported") -> SensitivityPoint:
    return SensitivityPoint(date_offset_hours=h, distance_km=dist, bearing_deg=bearing, lat=lat, lon=lon,
                            passes=False, score=None, failing_constraints=[], status="not_evaluated", reason=reason)


def _counts(points: list[SensitivityPoint]) -> SensitivityCounts:
    n = Counter(p.status for p in points)
    skipped = n["not_evaluated"]
    reasons = Counter(p.reason for p in points if p.status in ("unknown", "not_evaluated") and p.reason)
    return SensitivityCounts(requested=len(points), evaluated=len(points) - skipped, skipped=skipped,
                             passed=n["pass"], failed=n["fail"], unknown=n["unknown"], by_reason=dict(reasons))


_REASON_TEXT = {
    "incomplete_data": "real data has missing samples (a gap, or the mission runs past the end of the data)",
    "outside_coverage": "the site's real data does not cover the mission's dates",
    "no_real_data": "the site has no real data",
}


def _unknown_sentence(counts: SensitivityCounts) -> str:
    """One sentence per undecided reason, e.g. '2 point(s) could not be judged: the site's real data ...'."""
    out = []
    for reason in ("incomplete_data", "outside_coverage", "no_real_data"):
        k = counts.by_reason.get(reason, 0)
        if k:
            out.append(f" {k} point(s) could not be judged: {_REASON_TEXT[reason]}.")
    return "".join(out)


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
    base_unknown = base.verdict == "unknown"
    has_cov = sim or ev.coverage(sc.site) is not None
    offsets = sorted(set(req.date_offsets_hours) - {0.0})
    points: list[SensitivityPoint] = []

    # Date slips at the same spot (one timeline fetch for all of them). Each slip is its own mission and is
    # judged on its own data, also when the planned date itself is UNKNOWN: a gap or the end of the data
    # can leave the planned date undecided while earlier slips are fully covered. Slips outside the real
    # data come back unknown and stay in the list with that status and the reason.
    times = [sc.landing_utc + timedelta(hours=h) for h in offsets]
    for h, r in zip(offsets, ev.evaluate_many(sc.site, times, sc.duration_days, sc.requirements, simulation=sim)):
        points.append(_point(r, h, 0.0, None, sc.site.lat, sc.site.lon, has_cov))

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

    if base_unknown:
        # The planned mission itself is undecided, so there is no robustness verdict around it. Neighbouring
        # slips are reported as what they are: separate missions, decided or not on their own data.
        verdict = "unknown"
        base_reason = _undecided_reason(base, has_cov)
        detail = next((v.message for v in base.violations if v.is_unknown and v.message), "")
        expl = f"The planned date can't be judged: {_REASON_TEXT[base_reason]}."
        if detail:
            expl += " " + _sentence(detail.removeprefix("UNKNOWN: ")).rstrip()
            if not expl.endswith("."):
                expl += "."
        decided_dates = _decided(date_pts)
        if decided_dates:
            n_pass = sum(p.passes for p in decided_dates)
            expl += (f" Of the {len(decided_dates)} neighbouring date slip(s) that could be judged, {n_pass} pass and "
                     f"{len(decided_dates) - n_pass} fail. Each slip is a separate mission: this says nothing "
                     "about whether the planned date passes.")
        elif date_pts:
            expl += " No neighbouring date slip could be judged either."
    elif not base.passes:
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
    elif not pos_pts and verdict not in ("fails", "unknown"):
        expl += " Landing-position error was not requested, so these date results do not show robustness to it."
    elif counts.skipped:
        expl += f" {counts.skipped} landing-position point(s) were skipped."
    if counts.unknown:
        expl += _unknown_sentence(counts)

    limited_date_offsets = sorted(
        p.date_offset_hours for p in date_pts if p.passes and p.headroom_status in ("limited", "at_threshold")
    )
    passing_pts = [p for p in points if p.passes and p.closest_headroom_text]
    tightest_desc: str | None = None
    if passing_pts:
        def _pt_tightness(p: SensitivityPoint) -> tuple[int, float, float]:
            tier = 0 if p.headroom_status == "at_threshold" else 1 if p.headroom_status == "limited" else 2
            min_h = min(x for x in (p.darkness_headroom_h, p.comms_headroom_h) if x is not None) if any(
                x is not None for x in (p.darkness_headroom_h, p.comms_headroom_h)
            ) else 999999.0
            return (tier, min_h, abs(p.date_offset_hours) + p.distance_km)

        tightest_pt = min(passing_pts, key=_pt_tightness)
        loc_tag = _off(tightest_pt.date_offset_hours) if tightest_pt.distance_km == 0 else f"{tightest_pt.distance_km:g} km offset"
        tightest_desc = f"{loc_tag}: {tightest_pt.closest_label} ({tightest_pt.closest_headroom_text})"
    elif base.passes and getattr(base, "headroom", None) and base.headroom.closest_constraint:
        tightest_desc = f"Planned date: {base.headroom.closest_constraint.summary_text}"

    return SensitivityResponse(base=base, points=points, counts=counts, date_pass_rate=date_rate,
                               position_pass_rate=pos_rate, safe_date_window_hours=window,
                               safe_date_window_tested=n_in_window, score_min=min(scores, default=None),
                               score_max=max(scores, default=None), most_sensitive_constraint=most,
                               skipped_points=counts.unknown + counts.skipped, verdict=verdict, explanation=expl,
                               date_limited_offsets_hours=limited_date_offsets,
                               tightest_passing_headroom=tightest_desc)


def quick_robustness(sc: Scenario, ev: Evaluator, include_synthetic: bool | None = None) -> Robustness:
    """Cheap check used when ranking rescue alternatives: +/-12 h, +/-24 h, and (when data allows)
    1 km x 4 directions. Only points with a pass/fail answer count as checks."""
    res = analyse(SensitivityRequest(scenario=sc, date_offsets_hours=[-24, -12, 12, 24], position_offsets_km=[1.0],
                                     bearings=4, include_synthetic=include_synthetic), ev)
    date_pts = [p for p in res.points if p.distance_km == 0]
    date_checks = [
        DateSlipCheck(
            date_offset_hours=p.date_offset_hours,
            status=p.status,
            passes=p.passes,
            darkness_headroom_h=p.darkness_headroom_h,
            comms_headroom_h=p.comms_headroom_h,
            closest_label=p.closest_label,
            closest_headroom_text=p.closest_headroom_text,
            headroom_status=p.headroom_status,
            failing_constraints=p.failing_constraints,
            reason=p.reason if p.status == "unknown" else None,
        )
        for p in sorted(date_pts, key=lambda x: x.date_offset_hours)
    ]
    date_decided = [c for c in date_checks if c.status in ("pass", "fail")]
    date_passing = sum(1 for c in date_decided if c.passes)
    date_checked = len(date_decided)
    if date_checked:
        offsets_str = ", ".join(_off(c.date_offset_hours) for c in date_decided)
        lim = [c for c in date_decided if c.passes and c.headroom_status in ("limited", "at_threshold")]
        date_note = f"{date_passing}/{date_checked} tested date slips pass ({offsets_str})."
        if lim:
            date_note += f" Limited margin at {', '.join(_off(c.date_offset_hours) for c in lim)}."
    else:
        date_note = "Date-slip checks could not be evaluated on covered data."

    checked_pts = _decided(res.points)
    n = len(checked_pts)
    passing = sum(p.passes for p in checked_pts)
    r = passing / n if n else None  # nothing checked: no pass rate, and no claim of robustness
    bad = [p for p in checked_pts if not p.passes]
    if r is None:
        return Robustness(checked_points=0, passing_points=0, pass_rate=None, worst_score=res.base.score,
                          verdict="unchecked", note="Robustness not checked: no real data around this date or site.",
                          date_checks=date_checks, date_passing=date_passing, date_checked=date_checked, date_note=date_note)
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
                      verdict=_verdict(r), note=note,
                      date_checks=date_checks, date_passing=date_passing, date_checked=date_checked, date_note=date_note)
