"""Phase 1 data check: prove JPL Horizons and Moon Trek terrain both work for one site.

Run from backend/:  .venv\\Scripts\\python.exe scripts\\phase1_check.py

Downloads go to data/cache (Horizons) and data/raw (Moon Trek), both git-ignored.
"""

import csv
import io
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
import truststore
from rasterio.warp import transform

# Use the OS certificate store (works behind antivirus/proxy HTTPS inspection).
truststore.inject_into_ssl()

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "data" / "cache"
RAW = ROOT / "data" / "raw"

# TEST POINT ONLY - Shackleton crater centre (approx). Real landing-site
# coordinates still need to come from NASA's Artemis III region list.
SITE = {"name": "Shackleton (test point)", "lat": -89.67, "lon": 129.78}
START, STOP, STEP = "2027-01-01", "2029-01-01", "1h"  # ~2 years hourly

HORIZONS_API = "https://ssd.jpl.nasa.gov/api/horizons.api"
TREK = "https://trek.nasa.gov/moon/trekarcgis/rest/services"
DEMS = {
    # name: (Moon Trek ImageServer, metres per pixel, half-width of crop in metres)
    "near_5m": ("LRO_LOLA_DEM_SPole875_5mp_v04", 5, 5_000),
    "far_100m": ("LRO_LOLA_DEM_SPole45_100mp_v04", 100, 150_000),
}
MOON_GEOG = (
    'GEOGCS["GCS_Moon",DATUM["D_Moon_2000",SPHEROID["Moon_2000_IAU_IAG",1737400.0,0.0]],'
    'PRIMEM["Reference_Meridian",0.0],UNIT["Degree",0.0174532925199433]]'
)
MOON_SPOLE = (
    'PROJCS["Moon2000_spole",' + MOON_GEOG + ',PROJECTION["Stereographic_South_Pole"],'
    'PARAMETER["false_easting",0.0],PARAMETER["false_northing",0.0],'
    'PARAMETER["central_meridian",0.0],PARAMETER["standard_parallel_1",-90.0],UNIT["Meter",1.0]]'
)


def fetch(url: str, dest: Path) -> Path:
    if dest.exists():
        print(f"  cached: {dest.relative_to(ROOT)}")
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  downloading -> {dest.relative_to(ROOT)}")
    with urllib.request.urlopen(url, timeout=300) as r:
        dest.write_bytes(r.read())
    return dest


def horizons(body: str, label: str) -> list[dict]:
    """Apparent azimuth/elevation of `body` seen from SITE (no atmosphere on the Moon)."""
    params = {
        "format": "text",
        "COMMAND": f"'{body}'",
        "OBJ_DATA": "'NO'",
        "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'OBSERVER'",
        "CENTER": "'coord@301'",  # 301 = Moon
        "COORD_TYPE": "'GEODETIC'",
        "SITE_COORD": f"'{SITE['lon']},{SITE['lat']},0'",  # E-lon deg, lat deg, alt km
        "START_TIME": f"'{START}'",
        "STOP_TIME": f"'{STOP}'",
        "STEP_SIZE": f"'{STEP}'",
        "QUANTITIES": "'4'",  # apparent azimuth & elevation
        "ANG_FORMAT": "'DEG'",
        "CSV_FORMAT": "'YES'",
    }
    url = HORIZONS_API + "?" + urllib.parse.urlencode(params)
    text = fetch(url, CACHE / f"horizons_{label}_{START}_{STOP}_{STEP}.txt").read_text()
    if "$$SOE" not in text:
        sys.exit(f"Horizons returned no ephemeris for {label}:\n{text[:2000]}")

    header_line = text.split("$$SOE")[0].strip().splitlines()[-2]
    header = [h.strip() for h in header_line.split(",")]
    body_rows = text.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines()
    az_i = next(i for i, h in enumerate(header) if h.startswith("Azi"))
    el_i = next(i for i, h in enumerate(header) if h.startswith("Elev"))
    rows = []
    for rec in csv.reader(io.StringIO("\n".join(body_rows))):
        rows.append({"time": rec[0].strip(), "az": float(rec[az_i]), "el": float(rec[el_i])})
    return rows


def site_xy() -> tuple[float, float]:
    xs, ys = transform(MOON_GEOG, MOON_SPOLE, [SITE["lon"]], [SITE["lat"]])
    return xs[0], ys[0]


def moon_trek_dem(key: str) -> Path:
    service, res, half = DEMS[key]
    x, y = site_xy()
    n = int(2 * half / res)
    params = {
        "bbox": f"{x - half},{y - half},{x + half},{y + half}",
        "size": f"{n},{n}",
        "format": "tiff",
        "pixelType": "F32",
        "interpolation": "RSP_BilinearInterpolation",
        "f": "image",
    }
    url = f"{TREK}/{service}/ImageServer/exportImage?" + urllib.parse.urlencode(params)
    return fetch(url, RAW / f"{key}_{SITE['lat']}_{SITE['lon']}.tif")


def main() -> None:
    print(f"Site: {SITE}")

    print("\n[1] JPL Horizons")
    sun = horizons("10", "sun")
    earth = horizons("399", "earth")
    for name, rows in (("Sun", sun), ("Earth", earth)):
        el = np.array([r["el"] for r in rows])
        print(
            f"  {name}: {len(rows)} rows, {rows[0]['time']} -> {rows[-1]['time']}, "
            f"elevation {el.min():.2f} to {el.max():.2f} deg, above 0 deg {100 * (el > 0).mean():.1f}% of the time"
        )
    print(f"  first sample: Sun az {sun[0]['az']:.2f} el {sun[0]['el']:.3f} | "
          f"Earth az {earth[0]['az']:.2f} el {earth[0]['el']:.3f}")

    print("\n[2] Moon Trek terrain")
    x, y = site_xy()
    print(f"  site in south polar stereographic: x={x:.0f} m, y={y:.0f} m")
    for key in DEMS:
        path = moon_trek_dem(key)
        with rasterio.open(path) as ds:
            z = ds.read(1, masked=True)
            row, col = ds.index(x, y)
            print(
                f"  {key}: {ds.width}x{ds.height} px, {ds.res[0]:.1f} m/px, CRS ok={ds.crs is not None}, "
                f"height range {float(z.min()):.0f} to {float(z.max()):.0f} m, "
                f"height at site {float(z[row, col]):.0f} m"
            )

    print("\nPhase 1 exit check passed: Sun elevation and terrain height both available.")


if __name__ == "__main__":
    main()
