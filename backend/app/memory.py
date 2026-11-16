"""Cache sizes for small servers.

The in-memory caches are sized for a laptop. On a 512 MB host (Heroku Basic, Render free) they can grow past the
memory limit when several people browse at once, and the host kills the process. LOW_MEMORY=1 in the environment
shrinks them all to fit; results are the same, only repeated requests are recomputed more often.
"""

import os


def low_memory() -> bool:
    return os.environ.get("LOW_MEMORY", "").strip().lower() not in ("", "0", "false", "no")


def cache_size(normal: int, low: int) -> int:
    """`normal` entries, or `low` when LOW_MEMORY is set."""
    return low if low_memory() else normal
