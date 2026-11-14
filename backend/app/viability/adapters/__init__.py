"""Adapters from external scientific formats into the viability input contract.

Kept separate from the core models: adapters may know about other teams' file layouts;
the core contract does not.
"""

from .site_file import (
    ADAPTER_VERSION,
    SiteFileError,
    load_site_file,
    normalize_azimuth_deg,
    normalize_longitude_deg,
    site_file_to_series,
)

__all__ = [
    "ADAPTER_VERSION",
    "SiteFileError",
    "load_site_file",
    "normalize_azimuth_deg",
    "normalize_longitude_deg",
    "site_file_to_series",
]
