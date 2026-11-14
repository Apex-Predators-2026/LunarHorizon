"""Precompute horizon masks and 5-year hourly (2026-2030) visibility timelines for all curated sites
(landing candidates and reference landings, app/engine/sites.py ALL_SITES).

Run from backend/:  .venv\\Scripts\\python.exe scripts\\precompute.py [site-id ...]
Writes data/sites/<id>.json (format: docs/interfaces.md).
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engine.net import DATA_DIR  # noqa: E402
from app.engine.pipeline import analyze_site  # noqa: E402
from app.engine.sites import ALL_SITES  # noqa: E402

OUT_DIR = DATA_DIR / "sites"


def main(ids: list[str]) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for site in ALL_SITES:
        if ids and site["id"] not in ids:
            continue
        result = analyze_site(site)
        path = OUT_DIR / f"{site['id']}.json"
        path.write_text(json.dumps(result, separators=(",", ":")))
        print(f"  wrote {path.relative_to(DATA_DIR.parent)} ({path.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main(sys.argv[1:])
