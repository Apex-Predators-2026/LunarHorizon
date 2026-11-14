"""Phase 6: validate the data engine against independent references.

Run from backend/:  .venv\\Scripts\\python.exe scripts\\validate_engine.py
Writes data/validation/engine_validation.json; results are written up in docs/validation-engine.md.

1. Sun/Earth positions: our site files (JPL Horizons, DE441) vs an independent computation with
   Skyfield + JPL DE421 + the Moon's Mean-Earth frame (MOON_ME_DE421). Also counts how many hours
   would change their visible/blocked verdict if the reference positions were used instead.
2. Illumination: our modelled "% of time sunlit" vs the LROC WAC time-weighted illumination map
   (WAC_POLE_ILL_TWI_SOUTH_100M, 88-90 S), measured from ~3,800 orbital images taken
   2010-02-15 .. 2011-02-05. For a fair comparison the model is re-run for that same period with
   the sensor at the surface (0 m), since LROC sees the ground.
3. Spatial pattern: model vs LROC over an 11x11 grid around each site (one point can sit on a
   sharp light/dark edge). Note: yearly totals cannot detect an east/west azimuth flip.
4. Horizon geometry: the file's horizon vs an independent recomputation (great circles, PROJ,
   3D vectors) direction by direction, which does detect an azimuth flip.
"""

import json
import sys
import urllib.request
from pathlib import Path

import numpy as np
import rasterio

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engine.ephemeris import fetch_ephemeris  # noqa: E402
from app.engine.geo import latlon_to_xy  # noqa: E402
from app.engine.horizon import compute_horizon  # noqa: E402
from app.engine.net import CACHE_DIR, DATA_DIR, RAW_DIR, fetch_cached  # noqa: E402  (also enables truststore)
from app.engine.sites import SITES  # noqa: E402
from app.engine.terrain import load_terrain  # noqa: E402
from app.engine.visibility import build_timeline, disk_fraction_visible  # noqa: E402

OUT = DATA_DIR / "validation" / "engine_validation.json"
SAMPLE_EVERY_H = 6  # ephemeris comparison stride

NAIF = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels"
KERNELS = {  # NAIF moves superseded kernels to a_old_versions/; DE421 matches the moon_pa_de421 frame
    "moon_080317.tf": f"{NAIF}/fk/satellites/moon_080317.tf",
    "pck00008.tpc": f"{NAIF}/pck/a_old_versions/pck00008.tpc",
    "moon_pa_de421_1900-2050.bpc": f"{NAIF}/pck/moon_pa_de421_1900-2050.bpc",
    "de421.bsp": "https://ssd.jpl.nasa.gov/ftp/eph/planets/bsp/de421.bsp",
}
LROC_IMG = (
    "https://pds.lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/DATA/BDR/WAC_POLE/"
    "WAC_POLE_ILL_TWI_SOUTH/WAC_POLE_ILL_TWI_SOUTH_100M.IMG"
)
LROC_START, LROC_STOP = "2010-02-15", "2011-02-05"


# ---------------------------------------------------------------- helpers

def wrap180(d):
    return (np.asarray(d) + 180.0) % 360.0 - 180.0


def separation_deg(az1, el1, az2, el2):
    """Great-circle angle between two sky directions (deg)."""
    a1, e1, a2, e2 = (np.radians(v) for v in (az1, el1, az2, el2))
    c = np.sin(e1) * np.sin(e2) + np.cos(e1) * np.cos(e2) * np.cos(a1 - a2)
    return np.degrees(np.arccos(np.clip(c, -1, 1)))


def horizon_at(az_grid, el_grid, az):
    """Same circular interpolation as HorizonMask.at."""
    azg = np.concatenate([az_grid, [az_grid[0] + 360]])
    elg = np.concatenate([el_grid, [el_grid[0]]])
    return np.interp(np.asarray(az) % 360, azg, elg)


def stats(x):
    x = np.abs(np.asarray(x, dtype=float))
    return {"max": round(float(x.max()), 5), "rms": round(float(np.sqrt(np.mean(x * x))), 5),
            "p99": round(float(np.percentile(x, 99)), 5)}


# ---------------------------------------------------------------- 1. ephemeris cross-check

def skyfield_setup():
    from skyfield.api import Loader
    from skyfield.planetarylib import PlanetaryConstants

    kdir = CACHE_DIR / "kernels"
    paths = {name: fetch_cached(url, kdir / name, timeout=900) for name, url in KERNELS.items()}
    load = Loader(str(kdir))
    eph = load(str(paths["de421.bsp"]))
    pc = PlanetaryConstants()
    pc.read_text(load(str(paths["moon_080317.tf"])))
    pc.read_text(load(str(paths["pck00008.tpc"])))
    pc.read_binary(load(str(paths["moon_pa_de421_1900-2050.bpc"])))
    frame = pc.build_frame_named("MOON_ME_DE421")
    ts = load.timescale(builtin=True)
    return eph, pc, frame, ts


def ephemeris_check(site, record, sky):
    eph, pc, frame, ts = sky
    tl = record["timeline"]
    idx = np.arange(0, len(tl["time_utc"]), SAMPLE_EVERY_H)
    times = np.array([tl["time_utc"][i].rstrip("Z") for i in idx], dtype="datetime64[m]")
    parts = [times.astype(f"datetime64[{u}]") for u in ("Y", "M", "D", "h", "m")]
    y = parts[0].astype(int) + 1970
    mo = (parts[1] - parts[0].astype("datetime64[M]")).astype(int) + 1
    d = (parts[2] - parts[1].astype("datetime64[D]")).astype(int) + 1
    h = (parts[3] - parts[2].astype("datetime64[h]")).astype(int)
    mi = (parts[4] - parts[3].astype("datetime64[m]")).astype(int)
    t = ts.utc(y, mo, d, h, mi)

    place = eph["moon"] + pc.build_latlon_degrees(frame, site["lat"], site["lon"])
    col = lambda k: np.array([tl[k][i] for i in idx], dtype=float)  # noqa: E731
    hz = record["horizon"]
    az_grid = np.array(hz["azimuth_deg"], dtype=float)
    el_grid = np.array([np.nan if v is None else v for v in hz["elevation_deg"]], dtype=float)

    out = {}
    for body, target in (("sun", eph["sun"]), ("earth", eph["earth"])):
        alt, az, _ = place.at(t).observe(target).apparent().altaz()
        ref_el, ref_az = alt.degrees, az.degrees
        ours_el, ours_az = col(f"{body}_elevation_deg"), col(f"{body}_azimuth_deg")
        res = {
            "samples": int(len(idx)),
            "elevation_diff_deg": stats(ours_el - ref_el),
            "azimuth_diff_deg": stats(wrap180(ours_az - ref_az)),
            "separation_deg": stats(separation_deg(ours_az, ours_el, ref_az, ref_el)),
        }
        # Would the independent positions change any visible/blocked verdict?
        h_ref = horizon_at(az_grid, el_grid, ref_az)
        if body == "sun":
            radius = col("sun_angular_radius_deg") if "sun_angular_radius_deg" in tl else np.full(len(idx), 0.2666)
            ref_vis = disk_fraction_visible(ref_el - h_ref, radius) > 0
            ours_vis = np.array([bool(tl["sun_visible"][i]) for i in idx])
        else:
            ref_vis = ref_el - h_ref > 0
            ours_vis = np.array([bool(tl["earth_visible"][i]) for i in idx])
        res["verdict_changes"] = int(np.count_nonzero(ref_vis != ours_vis))
        out[body] = res
    return out


# ---------------------------------------------------------------- 2. illumination vs LROC

def lroc_check(site, lroc):
    x, y = (float(v) for v in latlon_to_xy(site["lat"], site["lon"]))
    data, tr = lroc
    col = int((x - tr.c) // tr.a)
    row = int((tr.f - y) // -tr.e)
    if not (1 <= row < data.shape[0] - 1 and 1 <= col < data.shape[1] - 1):
        return {"covered": False, "note": "outside the LROC map (88-90 S)"}
    win = data[row - 1: row + 2, col - 1: col + 2]
    if np.ma.is_masked(data[row, col]):
        return {"covered": False, "note": "no LROC value at this pixel"}

    # Model for the same period, sensor at the surface (LROC sees the ground).
    terrain = load_terrain(x, y)
    mask = compute_horizon(terrain, x, y, observer_height_m=0.0)
    sun = fetch_ephemeris("sun", site["lat"], site["lon"], LROC_START, LROC_STOP, "1h")
    tl = build_timeline(sun, sun, mask)  # earth unused here
    lit = tl.sunlit[tl.sun_known]
    frac = tl.sun_fraction[tl.sun_known]
    return {
        "covered": True,
        "lroc_pct_at_pixel": round(float(data[row, col]), 1),
        "lroc_pct_3x3_min": round(float(win.min()), 1),
        "lroc_pct_3x3_max": round(float(win.max()), 1),
        "model_period": f"{LROC_START} .. {LROC_STOP}",
        "model_any_sun_pct": round(100 * float(lit.mean()), 1),
        "model_half_disk_pct": round(100 * float((frac >= 0.5).mean()), 1),
        "model_mean_fraction_pct": round(100 * float(frac.mean()), 1),
        "model_hours": int(lit.size),
    }


# ---------------------------------------------------------------- 3. spatial pattern vs LROC

GRID_HALF_M, GRID_STEP_M = 2000, 400  # 11 x 11 points around the site
SPATIAL_EVERY_H = 3


def spatial_check(site, lroc, sky):
    """Model vs LROC over a grid of points, plus deliberately wrong azimuth conventions.

    A single point can sit on a sharp light/dark edge, so compare the spatial pattern instead.
    If our azimuth convention is right, it should match LROC better than a mirrored (E<->W) or
    rotated (180 deg) horizon. Sun positions come from Skyfield (validated above against Horizons).
    """
    from app.engine.geo import xy_to_latlon

    eph, pc, frame, ts = sky
    data, tr = lroc
    x0, y0 = (float(v) for v in latlon_to_xy(site["lat"], site["lon"]))
    terrain = load_terrain(x0, y0)
    hours = np.arange(0, int((np.datetime64(LROC_STOP) - np.datetime64(LROC_START)) / np.timedelta64(1, "h")),
                      SPATIAL_EVERY_H)
    t = ts.utc(2010, 2, 15, hours)

    offs = np.arange(-GRID_HALF_M, GRID_HALF_M + 1, GRID_STEP_M)
    rows = []
    for dy in offs:
        for dx in offs:
            x, y = x0 + dx, y0 + dy
            col, row = int((x - tr.c) // tr.a), int((tr.f - y) // -tr.e)
            if np.ma.is_masked(data[row, col]):
                continue
            lat, lon = (float(v) for v in xy_to_latlon(x, y))
            mask = compute_horizon(terrain, x, y, observer_height_m=0.0)
            alt, az, _ = (eph["moon"] + pc.build_latlon_degrees(frame, lat, lon)).at(t).observe(eph["sun"]).apparent().altaz()
            el, a = alt.degrees, az.degrees
            pct = {}
            for name, az_used in (("ours", a), ("mirrored_EW", -a), ("rotated_180", a + 180)):
                h = horizon_at(mask.azimuth_deg, mask.elevation_deg, az_used)
                pct[name] = 100 * float((disk_fraction_visible(el - h, 0.2666) > 0).mean())
            rows.append({"lroc": float(data[row, col]), **pct})

    lroc_v = np.array([r["lroc"] for r in rows])
    out = {"points": len(rows), "grid": f"{len(offs)}x{len(offs)} at {GRID_STEP_M} m"}
    for name in ("ours", "mirrored_EW", "rotated_180"):
        m = np.array([r[name] for r in rows])
        out[name] = {
            "pearson_r": round(float(np.corrcoef(m, lroc_v)[0, 1]), 3) if m.std() > 0 and lroc_v.std() > 0 else None,
            "mean_bias_pct": round(float((m - lroc_v).mean()), 1),
            "mean_abs_diff_pct": round(float(np.abs(m - lroc_v).mean()), 1),
        }
    out["lroc_mean_pct"] = round(float(lroc_v.mean()), 1)
    out["model_mean_pct"] = round(float(np.mean([r["ours"] for r in rows])), 1)
    return out


# ---------------------------------------------------------------- 4. independent horizon geometry

CHECK_AZ_STEP = 10  # degrees between checked directions


def independent_horizon(site, record):
    """Recompute the horizon with independent geometry and compare it to the site file.

    Same LOLA terrain, but every geometric step is done differently from app/engine/horizon.py:
      * points along each direction follow the true great circle (spherical destination formula
        with a bearing clockwise from north, Horizons' azimuth convention) instead of a straight
        line in the map plane;
      * lat/lon -> map metres via PROJ (rasterio) instead of our projection formulas;
      * elevation angle from 3D Moon-fixed vectors instead of the central-angle formula.
    Also compares against the file's horizon mirrored east<->west, to show the check would catch
    a flipped azimuth convention (which yearly illumination totals cannot).
    """
    from rasterio.warp import transform

    from app.engine.geo import MOON_GEOG_WKT, MOON_RADIUS_M, MOON_SPOLE_WKT
    from app.engine.horizon import sample_distances

    lat1, lon1 = np.radians(site["lat"]), np.radians(site["lon"])
    xs, ys = transform(MOON_GEOG_WKT, MOON_SPOLE_WKT, [site["lon"]], [site["lat"]])
    terrain = load_terrain(xs[0], ys[0])
    h0 = float(terrain.sample(np.array(xs), np.array(ys))[0])
    eye = MOON_RADIUS_M + h0 + record["site"]["observer_height_m"]

    def unit(lat, lon):
        return np.stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)], axis=-1)

    o = eye * unit(lat1, lon1)
    up = unit(lat1, lon1)
    d = sample_distances(terrain)
    delta = d / MOON_RADIUS_M

    file_az = np.array(record["horizon"]["azimuth_deg"], dtype=float)
    file_el = np.array([np.nan if v is None else v for v in record["horizon"]["elevation_deg"]], dtype=float)
    ours, mirrored, ind = [], [], []
    for a_deg in range(0, 360, CHECK_AZ_STEP):
        a = np.radians(a_deg)
        lat2 = np.arcsin(np.sin(lat1) * np.cos(delta) + np.cos(lat1) * np.sin(delta) * np.cos(a))
        lon2 = lon1 + np.arctan2(np.sin(a) * np.sin(delta) * np.cos(lat1), np.cos(delta) - np.sin(lat1) * np.sin(lat2))
        px, py = transform(MOON_GEOG_WKT, MOON_SPOLE_WKT, np.degrees(lon2).tolist(), np.degrees(lat2).tolist())
        h = terrain.sample(np.array(px), np.array(py))
        p = (MOON_RADIUS_M + h)[:, None] * unit(lat2, lon2)
        v = p - o
        el = np.degrees(np.arcsin((v @ up) / np.linalg.norm(v, axis=1)))
        ind.append(np.nan if np.isnan(el).any() else float(el.max()))
        ours.append(horizon_at(file_az, file_el, a_deg))
        mirrored.append(horizon_at(file_az, file_el, (360 - a_deg) % 360))

    ind, ours, mirrored = (np.array(v, dtype=float) for v in (ind, ours, mirrored))
    return {
        "directions": len(ind),
        "file_vs_independent_deg": stats(ours - ind),
        "mirrored_vs_independent_deg": stats(mirrored - ind),
        "horizon_range_deg": [round(float(np.nanmin(ind)), 2), round(float(np.nanmax(ind)), 2)],
    }


# ---------------------------------------------------------------- main

def main():
    print("Loading Skyfield kernels (DE421 + Moon ME frame)...", flush=True)
    sky = skyfield_setup()
    img = fetch_cached(LROC_IMG, RAW_DIR / "lroc" / "WAC_POLE_ILL_TWI_SOUTH_100M.IMG", timeout=900)
    with rasterio.open(img) as ds:
        lroc = (ds.read(1, masked=True), ds.transform)

    report = {"reference": {
        "ephemeris": "Skyfield + JPL DE421 + MOON_ME_DE421 frame (moon_080317.tf, moon_pa_de421_1900-2050.bpc)",
        "illumination": "LROC WAC_POLE_ILL_TWI_SOUTH_100M (Speyerer & Robinson 2013), 2010-02-15..2011-02-05",
        "ephemeris_sample_every_hours": SAMPLE_EVERY_H,
    }, "sites": {}}

    for site in SITES:
        record = json.loads((DATA_DIR / "sites" / f"{site['id']}.json").read_text())
        print(f"\n== {site['name']}")
        eph = ephemeris_check(site, record, sky)
        for body in ("sun", "earth"):
            r = eph[body]
            print(f"  {body:5} vs Skyfield: separation max {r['separation_deg']['max']:.4f} deg "
                  f"(rms {r['separation_deg']['rms']:.4f}), elevation max {r['elevation_diff_deg']['max']:.4f}, "
                  f"verdict changes {r['verdict_changes']}/{r['samples']}")
        ill = lroc_check(site, lroc)
        spatial = None
        if ill["covered"]:
            print(f"  LROC observed {ill['lroc_pct_at_pixel']}% sunlit (3x3: {ill['lroc_pct_3x3_min']}-{ill['lroc_pct_3x3_max']}) | "
                  f"model same period, surface: any sun {ill['model_any_sun_pct']}%, >=half disk {ill['model_half_disk_pct']}%, "
                  f"mean disk {ill['model_mean_fraction_pct']}%")
            print("  spatial pattern vs LROC (grid around the site)...", flush=True)
            spatial = spatial_check(site, lroc, sky)
            for name in ("ours", "mirrored_EW", "rotated_180"):
                r = spatial[name]
                print(f"    {name:12} r={r['pearson_r']}  bias {r['mean_bias_pct']:+.1f}  |diff| {r['mean_abs_diff_pct']:.1f}  "
                      f"({spatial['points']} points; LROC mean {spatial['lroc_mean_pct']}%)")
        else:
            print(f"  LROC: {ill['note']}")
        geom = independent_horizon(site, record)
        print(f"  horizon vs independent geometry ({geom['directions']} directions): "
              f"max diff {geom['file_vs_independent_deg']['max']:.3f} deg (rms {geom['file_vs_independent_deg']['rms']:.3f}); "
              f"if E/W were mirrored: max {geom['mirrored_vs_independent_deg']['max']:.2f} deg "
              f"(rms {geom['mirrored_vs_independent_deg']['rms']:.2f})")
        report["sites"][site["id"]] = {"ephemeris": eph, "illumination": ill, "spatial": spatial, "horizon_geometry": geom}

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2))
    print(f"\nwrote {OUT.relative_to(DATA_DIR.parent)}")


if __name__ == "__main__":
    main()
