"""Member 2 Part 2 validation package (Work Package E) and the decision-evidence demonstration.

* ``suite``: reproducible validation of the viability engine on all committed curated lunar datasets
  (smoke coverage), representative deep cases, scientific invariants and timing.
  Run: ``cd backend && python -m app.viability.validation [--out report.json] [--quick]``.
* ``demo``: a small decision-evidence example on two real landing candidates for the hackathon demonstration.
  Run: ``cd backend && python -m app.viability.validation.demo [--out demo.json]``.

Both read Member 1's committed site files only and compute every number through the canonical engine; nothing
is pinned or hand-written. See docs/member2-part2-validation.md.
"""
