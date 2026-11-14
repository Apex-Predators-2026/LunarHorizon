"""Permanently shadowed regions (PSRs) and surface-ice detections near the south pole, from Moon Trek.

Moon Trek publishes both as points, not outlines:
  * PSR_SP: 164 PSRs (centre, area km2, ID, LRO imaging notes), 80-90 S.
  * SP_IceLoc_280m: 1,119 surface water-ice detection points (280 m cells).
The layer caps each query at 1,000 records and rejects pagination, so we fetch in FID ranges.
"""

import json
import urllib.parse
import urllib.request
from functools import lru_cache

from .net import CACHE_DIR, require_online

TREK_MAP = "https://trek.nasa.gov/moon/trekarcgis/rest/services"
CACHE = CACHE_DIR / "psr"
PAGE = 1000


def _query(service: str) -> list[dict]:
    """All features of layer 0 as GeoJSON features, fetched in FID ranges, cached on disk."""
    path = CACHE / f"{service}.json"
    if path.exists():
        return json.loads(path.read_text())
    feats: list[dict] = []
    start = 0
    while True:
        params = {"where": f"FID >= {start} AND FID < {start + PAGE}", "outFields": "*", "f": "geojson"}
        url = f"{TREK_MAP}/{service}/MapServer/0/query?" + urllib.parse.urlencode(params)
        require_online(url)
        with urllib.request.urlopen(url, timeout=120) as r:
            page = json.loads(r.read())["features"]
        if not page:
            break
        feats += page
        start += PAGE
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(feats))
    return feats


OUTLINE_POINTS = 48
HEIGHT_SPACING_M = 200  # terrain detail used to place overlays on the surface (cached by the tile prefetch)


@lru_cache(maxsize=1)
def load() -> dict:
    """PSRs (with an approximate outline: a circle of the same area, on the terrain) and ice points,
    each with terrain heights so the 3D view can draw them on the surface."""
    import numpy as np

    from .dem import sample_latlon
    from .geo import destination

    psrs = []
    for f in _query("PSR_SP"):
        p = f["properties"]
        note = (p.get("Features_o") or "").strip()
        psrs.append({
            "id": p["PSR_ID"],
            "lat": round(float(p["Cent__Lat_"]), 4),
            "lon": round(float(p["Cent__Long"]) % 360, 4),
            "area_km2": round(float(p["Area__km2_"]), 2),
            "note": note or None,
        })
    ice_ll = []
    for f in _query("SP_IceLoc_280m"):
        lon, lat = f["geometry"]["coordinates"][:2]
        ice_ll.append((float(lat), float(lon) % 360))

    # Outlines: circle of equal area around each centre, with terrain heights.
    az = np.linspace(0, 360, OUTLINE_POINTS, endpoint=False)
    for p in psrs:
        r = float(np.sqrt(p["area_km2"] * 1e6 / np.pi))
        lat, lon = destination(p["lat"], p["lon"], az, np.full(az.shape, r))
        h = sample_latlon(lat, lon, HEIGHT_SPACING_M)
        p["radius_m"] = round(r)
        p["outline"] = [[round(float(a), 5), round(float(b), 5), None if np.isnan(c) else round(float(c))]
                        for a, b, c in zip(lat, lon, h)]
    ice = []
    if ice_ll:
        lat, lon = (np.array(v) for v in zip(*ice_ll))
        h = sample_latlon(lat, lon, HEIGHT_SPACING_M)
        ice = [[round(float(a), 4), round(float(b), 4), None if np.isnan(c) else round(float(c))]
               for a, b, c in zip(lat, lon, h)]
    return {
        "psrs": psrs,
        "ice": ice,  # [lat, lon, height_m]
        "source": "NASA Moon Trek layers PSR_SP (PSR centres and areas) and SP_IceLoc_280m (surface ice detections); "
                  "heights from Moon Trek LOLA",
        "note": "Moon Trek provides PSRs as points with an area, not outlines. Outlines here are circles of the "
                "same area, for orientation only.",
    }
