"""Cached HTTP downloads."""

import urllib.request
from pathlib import Path

import truststore

# Use the OS certificate store (works behind antivirus/proxy HTTPS inspection).
truststore.inject_into_ssl()

DATA_DIR = Path(__file__).resolve().parents[3] / "data"
CACHE_DIR = DATA_DIR / "cache"
RAW_DIR = DATA_DIR / "raw"


def fetch_cached(url: str, dest: Path, timeout: int = 300) -> Path:
    """Download `url` to `dest` once; later calls reuse the file."""
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=timeout) as r:
        tmp.write_bytes(r.read())
    tmp.replace(dest)
    return dest
