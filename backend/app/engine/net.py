"""Cached HTTP downloads, and the offline switch.

Set LUNAR_OFFLINE=1 to forbid every download (Moon Trek, JPL Horizons, NAIF): data already in the caches is still
served, anything else fails at once with OfflineError (an OSError, so the API answers 502 as for an outage). Used
to prove a demo runs entirely from the warmed caches (docs/demo-setup.md).
"""

import os
import urllib.request
from pathlib import Path

import truststore

# Use the OS certificate store (works behind antivirus/proxy HTTPS inspection).
truststore.inject_into_ssl()

DATA_DIR = Path(__file__).resolve().parents[3] / "data"
CACHE_DIR = DATA_DIR / "cache"
RAW_DIR = DATA_DIR / "raw"


class OfflineError(OSError):
    """A download was needed while LUNAR_OFFLINE is set (the data isn't in the cache)."""


def offline() -> bool:
    return os.environ.get("LUNAR_OFFLINE", "").strip() not in ("", "0")


def require_online(url: str) -> None:
    """Call right before any download: raises OfflineError in offline mode."""
    if offline():
        raise OfflineError(f"offline mode (LUNAR_OFFLINE=1), not in the cache: {url}")


def fetch_cached(url: str, dest: Path, timeout: int = 300) -> Path:
    """Download `url` to `dest` once; later calls reuse the file."""
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    require_online(url)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=timeout) as r:
        tmp.write_bytes(r.read())
    tmp.replace(dest)
    return dest
