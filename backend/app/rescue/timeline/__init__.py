from .base import Timeline, TimelineProvider, solar_disk_fraction
from .precomputed import PrecomputedTimelineProvider
from .synthetic import SyntheticTimelineProvider

__all__ = ["Timeline", "TimelineProvider", "solar_disk_fraction", "PrecomputedTimelineProvider",
           "SyntheticTimelineProvider", "default_provider"]


def default_provider() -> TimelineProvider:
    """Precomputed data where it exists, synthetic placeholder everywhere else."""
    return PrecomputedTimelineProvider(fallback=SyntheticTimelineProvider())
