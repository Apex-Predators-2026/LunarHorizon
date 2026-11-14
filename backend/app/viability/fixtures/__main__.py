"""Regenerate the synthetic fixture JSON files: ``cd backend && python -m app.viability.fixtures``."""

from . import write_fixtures

for path in write_fixtures():
    print(f"wrote {path}")
