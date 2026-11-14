from datetime import datetime, timezone

import pytest

from app.rescue import Evaluator
from app.models import Scenario
from app.rescue.catalog import get_site
from app.rescue.timeline import SyntheticTimelineProvider


@pytest.fixture
def ev() -> Evaluator:
    # Synthetic only, so tests never depend on whatever is in data/sites/.
    return Evaluator(provider=SyntheticTimelineProvider(), simulation=True)


@pytest.fixture
def pns_scenario() -> Scenario:
    """Peak Near Shackleton, a 7-day mission that passes with the synthetic data."""
    return Scenario(site=get_site("peak-near-shackleton").to_site(),
                    landing_utc=datetime(2027, 1, 7, tzinfo=timezone.utc))
