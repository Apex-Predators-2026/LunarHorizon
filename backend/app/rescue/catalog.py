"""Landing sites and permanently shadowed regions (PSRs) that rescue searches.

Sites come from two places:

1. The data engine's curated list (app/engine/sites.py, Andrew). These have sourced
   coordinates and, once precomputed, real Horizons + LOLA timelines in data/sites/.
   Validation controls (e.g. the permanently dark Shackleton floor) are not landing
   candidates and are skipped.
2. EXTRA_SITES below: more candidate regions with APPROXIMATE coordinates (~0.1-0.5 deg)
   and no real data yet. They only ever get synthetic timelines, and rescue leaves them out
   by default whenever the plan being rescued has real data.

`horizon_base_deg` / `horizon_roughness_deg` only feed the synthetic timeline provider.
"""
from __future__ import annotations

from dataclasses import dataclass

from ..engine.sites import SITES as ENGINE_SITES
from ..models import Site
from .geo import distance_km


@dataclass(frozen=True)
class CatalogSite:
    id: str
    name: str
    lat: float
    lon: float
    description: str
    horizon_base_deg: float  # synthetic only: mean terrain horizon height
    horizon_roughness_deg: float  # synthetic only: how bumpy the horizon is
    source: str = ""
    approximate: bool = False  # True = placeholder coordinates, no real data

    def to_site(self) -> Site:
        return Site(id=self.id, name=self.name, lat=self.lat, lon=self.lon)


@dataclass(frozen=True)
class PSR:
    id: str
    name: str
    lat: float
    lon: float
    radius_km: float
    ice_interest: float  # 0-1, rough science value


# Engine sites that are validation controls, not places to land.
NOT_LANDING_SITES = {"shackleton-floor"}

# Synthetic-fallback shape and a short description for engine sites (by id).
_ENGINE_EXTRAS: dict[str, tuple[float, float, str]] = {
    "peak-near-shackleton": (-1.3, 0.7, "Elevated peak beside Shackleton crater, close to its permanently shadowed floor."),
    "connecting-ridge": (-1.1, 0.8, "Ridge linking Shackleton and de Gerlache craters; some of the best-lit terrain at the pole."),
    "malapert-massif": (-1.6, 0.6, "Tall massif facing Earth: near-constant direct-to-Earth contact, but real lunar nights."),
}

EXTRA_SITES: list[CatalogSite] = [
    CatalogSite("de-gerlache-rim", "de Gerlache Rim (approx.)", -89.05, 280.00,
                "Rim of de Gerlache crater, next to a large PSR.", -0.5, 0.9, approximate=True),
    CatalogSite("haworth-rim", "Haworth Rim (approx.)", -86.60, 350.00,
                "Rim of Haworth crater, close to a large PSR.", -0.7, 0.9, approximate=True),
    CatalogSite("nobile-rim-1", "Nobile Rim 1 (approx.)", -85.40, 38.00,
                "Rim of Nobile crater (VIPER's former target region).", -0.6, 0.8, approximate=True),
    CatalogSite("mons-mouton", "Mons Mouton (approx.)", -84.60, 31.00,
                "Broad high plateau; gentle slopes, strong Earth view.", -1.8, 0.5, approximate=True),
    CatalogSite("faustini-rim-a", "Faustini Rim A (approx.)", -86.95, 92.00,
                "Rim of Faustini crater, beside a PSR with likely ice.", -0.5, 1.0, approximate=True),
]

_EXTRA_BY_ID = {x.id: x for x in EXTRA_SITES}


def _from_engine(e: dict) -> CatalogSite:
    """Engine site -> rescue catalog entry. Sites the engine marks as approximate (its source starts
    with "Approximate", e.g. points first estimated for this catalog) keep the "(approx.)" label."""
    approx = e.get("source", "").startswith("Approximate")
    mine = _EXTRA_BY_ID.get(e["id"])
    base, rough, desc = _ENGINE_EXTRAS.get(e["id"], (
        mine.horizon_base_deg if mine else -0.8, mine.horizon_roughness_deg if mine else 0.8,
        mine.description if mine else e["name"]))
    name = e["name"] if not approx or e["name"].endswith("(approx.)") else f"{e['name']} (approx.)"
    return CatalogSite(e["id"], name, e["lat"], e["lon"], desc, base, rough, source=e.get("source", ""),
                       approximate=approx)


ENGINE_CATALOG: list[CatalogSite] = [_from_engine(e) for e in ENGINE_SITES if e["id"] not in NOT_LANDING_SITES]

_engine_ids = {s.id for s in ENGINE_CATALOG}
SITES: list[CatalogSite] = ENGINE_CATALOG + [s for s in EXTRA_SITES if s.id not in _engine_ids]

PSRS: list[PSR] = [
    PSR("shackleton-psr", "Shackleton crater floor", -89.67, 129.8, 10.5, 0.9),
    PSR("de-gerlache-psr", "de Gerlache crater floor", -88.50, 272.9, 16.0, 0.8),
    PSR("haworth-psr", "Haworth crater floor", -87.45, 355.0, 25.5, 0.9),
    PSR("faustini-psr", "Faustini crater floor", -87.30, 77.0, 20.5, 1.0),
    PSR("nobile-psr", "Nobile crater floor", -85.20, 53.5, 36.0, 0.7),
]

SITES_BY_ID = {s.id: s for s in SITES}
PSRS_BY_ID = {p.id: p for p in PSRS}


CUSTOM_PREFIX = "custom:"


def custom_site(name: str, lat: float, lon: float) -> Site:
    """A non-catalog point. The team's Site model needs an id, so encode the coordinates."""
    return Site(id=f"{CUSTOM_PREFIX}{lat:.5f},{lon % 360:.5f}", name=name, lat=lat, lon=lon % 360)


def is_catalog(site: Site) -> bool:
    return site.id in SITES_BY_ID


def get_site(site_id: str) -> CatalogSite:
    try:
        return SITES_BY_ID[site_id]
    except KeyError:
        raise KeyError(f"Unknown site id '{site_id}'. Known: {', '.join(SITES_BY_ID)}") from None


def nearest_catalog_site(lat: float, lon: float) -> tuple[CatalogSite, float]:
    best = min(SITES, key=lambda s: distance_km(lat, lon, s.lat, s.lon))
    return best, distance_km(lat, lon, best.lat, best.lon)


def nearest_psr_edge_km(lat: float, lon: float) -> tuple[PSR, float]:
    """Nearest PSR and the distance from (lat, lon) to its edge (0 if inside)."""
    best, best_d = PSRS[0], float("inf")
    for p in PSRS:
        d = max(0.0, distance_km(lat, lon, p.lat, p.lon) - p.radius_km)
        if d < best_d:
            best, best_d = p, d
    return best, best_d
