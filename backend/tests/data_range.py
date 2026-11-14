"""The real data's time range, read from the committed site files (not hard-coded).

The data engine extends the range from time to time (2027-2028, then 2026-2030), so tests about
the edges of the data use these values instead of fixed dates.
"""
from datetime import datetime, timezone

import numpy as np

from app.rescue import Evaluator
from app.rescue.catalog import get_site


def _to_utc(t: np.datetime64) -> datetime:
    return datetime.fromisoformat(str(t.astype("datetime64[s]"))).replace(tzinfo=timezone.utc)


def data_range(site_id: str = "peak-near-shackleton") -> tuple[datetime, datetime]:
    """(first sample, last sample) of the site's real data, as UTC datetimes."""
    cov = Evaluator().coverage(get_site(site_id).to_site())
    if cov is None:
        raise RuntimeError(f"no real data for {site_id}")
    return _to_utc(cov[0]), _to_utc(cov[1])


def day(t: datetime) -> str:
    return t.strftime("%Y-%m-%d")
