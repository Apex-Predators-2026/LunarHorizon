"""Replay the guided "Try a mission" story(s) through the API and check them against their verified baseline.

    python scripts/verify_mission_story.py                     # verify every definition; exit 1 if one is outdated
    python scripts/verify_mission_story.py --json              # machine-readable report
    python scripts/verify_mission_story.py --write-provenance  # record dataset hashes, method versions, date

Definitions live in frontend/src/features/guide/missions/*.json (see app/mission_story.py). --write-provenance only
writes values the API reports for the files actually evaluated; it refuses to write while a stable check fails.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.mission_story import definitions, load_definition, verify


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--write-provenance", action="store_true")
    args = ap.parse_args()
    ok_all = True
    out = []
    for path in definitions():
        d = load_definition(path)
        rep = verify(d)
        ok_all &= rep.ok
        if args.json:
            out.append({"file": path.name, "ok": rep.ok, "checks": [c.__dict__ for c in rep.checks],
                        "observed": rep.observed, "provenance": rep.provenance})
        else:
            print(rep.text())
            print(f"  observed: {json.dumps(rep.observed, default=str)}")
        if args.write_provenance:
            if not rep.ok:
                print(f"  not writing provenance for {path.name}: the story is not reproduced", file=sys.stderr)
                continue
            d["provenance"] = {"verified_utc": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"), **rep.provenance}
            path.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            print(f"  provenance written to {path}")
    if args.json:
        print(json.dumps(out, indent=2, default=str))
    return 0 if ok_all else 1


if __name__ == "__main__":
    raise SystemExit(main())
