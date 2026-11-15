"""Canonical ranking for the comparison (Member 4).

The comparison does not rank anything itself. It hands the canonical ``ViabilityAssessment`` of every
scenario to the viability engine's own ranking (Member 2, ``app/viability/ranking.py``) and reports what
that returns:

* ``partition_comparable`` splits the scenarios into groups that may share one ranking (same data basis,
  scoring method and weights, and under the default STRICT policy the same requirements and duration);
* ``rank_assessments`` orders each group: PASS first with ranks 1..n, then UNKNOWN, then FAIL, unranked;
* ``ranking_explanations`` gives the reason for each place or absence of rank;
* ``comparability_issues`` says why a group could not join the primary group.

Contract kept here: only PASS entries carry a rank, a missing score stays ``None`` (never 0), UNKNOWN stays
UNKNOWN, and ranks are only meaningful inside their own group.
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from ..viability.enums import ComparabilityPolicy, MetricStatus
from ..viability.outputs import ViabilityAssessment
from ..viability.ranking import (
    RankingComparabilityError,
    comparability_issues,
    partition_comparable,
    rank_assessments,
    ranking_explanations,
)
from ..viability.ranking_evidence import compare_scenarios
from .schemas import ComponentAdvantage, PairEvidence, RankingGroup, RankingInfo, ScoreDifferenceInfo

POLICY = ComparabilityPolicy.STRICT


@dataclass(frozen=True)
class Assessed:
    """One scenario of the request that has a canonical assessment."""

    key: str  # the client's scenario key
    assessment: ViabilityAssessment


def _unique_ids(items: Sequence[Assessed]) -> list[tuple[str, ViabilityAssessment]]:
    """Assessments with unique ``scenario_id``s (two scenarios at the same site and time share the
    canonical id). The id is the ranking's final, preference-free tie-break, so it stays the canonical one
    and only repeats get a suffix."""
    seen: dict[str, int] = {}
    out = []
    for it in items:
        base = it.assessment.scenario_id
        n = seen.get(base, 0) + 1
        seen[base] = n
        sid = base if n == 1 else f"{base[:60]}-{n}"
        a = it.assessment if sid == base else it.assessment.model_copy(update={"scenario_id": sid})
        out.append((it.key, a))
    return out


def _score_fields(a: ViabilityAssessment) -> dict:
    s = a.score
    lower = upper = None
    if s.score_bounds is not None and s.score_bounds.status is MetricStatus.BOUNDED:
        lower, upper = s.score_bounds.lower, s.score_bounds.upper
    elif s.score is not None:
        lower = upper = s.score
    return {
        "score_status": s.status.value if s.status is not None else None,
        "score": s.score,  # exact score only; None is never 0
        "score_lower": lower,
        "score_upper": upper,
    }


def rank_comparison(items: Sequence[Assessed]) -> tuple[dict[str, RankingInfo], list[RankingGroup], str | None]:
    """Canonical ranking info per scenario key, the comparable groups, and the ranking method version."""
    if not items:
        return {}, [], None
    pairs = _unique_ids(items)
    key_of = {a.scenario_id: key for key, a in pairs}
    order = {key: i for i, (key, _) in enumerate(pairs)}  # request order, for stable group order
    assessments = [a for _, a in pairs]

    try:
        groups = partition_comparable(assessments, POLICY)
    except RankingComparabilityError as exc:  # e.g. a score without ranking metadata: refuse, never guess
        info = {
            key: RankingInfo(
                eligibility=a.eligibility.value, rank=None, group=None, group_size=0, ranked_in_group=0,
                explanation=f"Not ranked: the viability engine refused to rank these results ({exc}).",
                overall_risk=a.overall_risk.value, data_basis=a.data_basis.value, **_score_fields(a),
            )
            for key, a in pairs
        }
        return info, [], None

    # Primary group = the largest; ties go to the group holding the earliest-selected scenario.
    groups.sort(key=lambda g: (-len(g), min(order[key_of[a.scenario_id]] for a in g)))
    primary_ref = groups[0][0]

    info: dict[str, RankingInfo] = {}
    out_groups: list[RankingGroup] = []
    method = None
    for gi, members in enumerate(groups):
        gid = f"G{gi + 1}"
        result = rank_assessments(members, POLICY)
        method = method or result.method_version
        texts = ranking_explanations(members, result)
        separate = None if gi == 0 else "; ".join(comparability_issues(primary_ref, members[0], POLICY))
        ranked = sum(1 for e in result.entries if e.rank is not None)
        by_id = {a.scenario_id: a for a in members}
        for e in result.entries:
            a = by_id[e.scenario_id]
            info[key_of[e.scenario_id]] = RankingInfo(
                eligibility=e.eligibility.value,
                rank=e.rank,
                group=gid,
                group_size=len(members),
                ranked_in_group=ranked,
                explanation=texts.get(e.scenario_id, ""),
                overall_risk=e.overall_risk.value,
                data_basis=a.data_basis.value,
                **_score_fields(a),
            )
        out_groups.append(RankingGroup(
            id=gid,
            primary=gi == 0,
            keys=[key_of[e.scenario_id] for e in result.entries],  # canonical order
            ranked_keys=[key_of[e.scenario_id] for e in result.entries if e.rank is not None],
            data_basis=result.data_basis.value if result.data_basis else None,
            policy=result.policy.value if result.policy else POLICY.value,
            method_version=result.method_version,
            separate_reason=separate,
        ))
    return info, out_groups, method


# Ranking-key positions that are policy tie-breaks rather than measured differences (consumer handoff §8).
TIE_BREAKS = {"exact_before_bounded", "overall_risk", "min_coverage", "scenario_id"}


def pairwise_evidence(items: Sequence[Assessed]) -> list[PairEvidence]:
    """The engine's ``compare_scenarios`` for every pair of assessed scenarios. Pairs inside one comparable group
    use that group's ranking (so ranks and the deciding criterion are the ranking's own); pairs across groups are
    reported as not comparable, with the engine's reasons, and get no order or score difference."""
    if len(items) < 2:
        return []
    pairs = _unique_ids(items)
    key_of = {a.scenario_id: key for key, a in pairs}
    assessments = [a for _, a in pairs]
    try:
        groups = partition_comparable(assessments, POLICY)
    except RankingComparabilityError:
        return []
    group_of: dict[str, int] = {}
    rankings = []
    order: dict[str, int] = {}
    for gi, members in enumerate(groups):
        result = rank_assessments(members, POLICY)
        rankings.append(result)
        for pos, e in enumerate(result.entries):
            group_of[e.scenario_id] = gi
            order[e.scenario_id] = gi * 1000 + pos
    ordered = sorted(assessments, key=lambda a: order[a.scenario_id])
    out: list[PairEvidence] = []
    for i, a in enumerate(ordered):
        for b in ordered[i + 1:]:
            same = group_of[a.scenario_id] == group_of[b.scenario_id]
            ev = compare_scenarios(a, b, policy=POLICY, ranking=rankings[group_of[a.scenario_id]] if same else None)
            sd = ev.score_difference
            crit = ev.deciding_criterion.value if ev.deciding_criterion is not None else None
            out.append(PairEvidence(
                selected=key_of[a.scenario_id], competitor=key_of[b.scenario_id],
                selected_id=a.scenario_id, competitor_id=b.scenario_id,
                comparable=ev.comparable, comparability_issues=list(ev.comparability_issues),
                higher=key_of[ev.higher_id] if ev.higher_id else None,
                deciding_criterion=crit, deciding_detail=ev.deciding_detail,
                policy_tie_break=crit in TIE_BREAKS,
                score_difference=ScoreDifferenceInfo(
                    status=sd.status.value,
                    lower=sd.interval.lower if sd.interval else None,
                    upper=sd.interval.upper if sd.interval else None,
                    both_exact=sd.both_exact, statement=sd.statement,
                ),
                components=[ComponentAdvantage(component=c.component.value, label=c.label, advantage=c.advantage.value)
                            for c in ev.components],
                limitations=list(ev.limitations), explanation=ev.explanation,
            ))
    return out
