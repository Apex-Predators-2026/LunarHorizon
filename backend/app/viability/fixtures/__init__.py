"""SYNTHETIC scientific fixtures (not NASA-derived) in the real input schema.

``load_fixture(name)`` reads the committed JSON in ``synthetic/``; ``build_fixture(name)``
regenerates it in memory from ``builders.py``. Regenerate the JSON files with::

    cd backend && python -m app.viability.fixtures
"""

from __future__ import annotations

from pathlib import Path

from ..inputs import ScientificTimeSeries
from .builders import FIXTURE_BUILDERS, example_scenario

FIXTURE_DIR = Path(__file__).parent / "synthetic"
FIXTURE_NAMES: tuple[str, ...] = tuple(FIXTURE_BUILDERS)

__all__ = ["FIXTURE_DIR", "FIXTURE_NAMES", "build_fixture", "example_scenario", "load_fixture", "write_fixtures"]


def _check(name: str) -> None:
    if name not in FIXTURE_BUILDERS:
        raise KeyError(f"unknown fixture {name!r}; available: {', '.join(FIXTURE_NAMES)}")


def build_fixture(name: str) -> ScientificTimeSeries:
    _check(name)
    return FIXTURE_BUILDERS[name]()


def load_fixture(name: str) -> ScientificTimeSeries:
    _check(name)
    return ScientificTimeSeries.model_validate_json((FIXTURE_DIR / f"{name}.json").read_text(encoding="utf-8"))


def write_fixtures(directory: Path = FIXTURE_DIR) -> list[Path]:
    directory.mkdir(parents=True, exist_ok=True)
    paths = []
    for name in FIXTURE_NAMES:
        path = directory / f"{name}.json"
        path.write_text(build_fixture(name).model_dump_json(indent=2) + "\n", encoding="utf-8", newline="\n")
        paths.append(path)
    return paths
