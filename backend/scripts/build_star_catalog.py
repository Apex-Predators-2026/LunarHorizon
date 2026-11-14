"""Build the star catalogue for the 3D view's sky (frontend/public/sky/stars.bin): every star of the
Hipparcos catalogue (ESA, via the CDS VizieR service, table I/239/hip_main) down to magnitude 6.5,
about the naked-eye limit: ~8,800 stars with their true positions (ICRS), brightness and colour.

Run from backend/ (the output is committed, so only when changing the magnitude limit):
    .venv\\Scripts\\python.exe scripts\\build_star_catalog.py [--max-mag 6.5]

Format (little-endian), read by frontend/src/viz/sky/stars.ts:
    header: b"LSC1", uint32 star count
    per star: float32 RA (deg), float32 Dec (deg), float32 V magnitude, float32 B-V colour index
"""

import argparse
import struct
import urllib.parse
import urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / "frontend" / "public" / "sky" / "stars.bin"
MIRRORS = ["vizier.cds.unistra.fr", "vizier.cfa.harvard.edu", "vizier.iucaa.in"]
DEFAULT_BV = 0.65  # a Sun-like colour for the few stars without a measured B-V


def fetch(max_mag: float) -> str:
    query = urllib.parse.urlencode(
        [("-source", "I/239/hip_main"), ("-out", "RAICRS"), ("-out", "DEICRS"), ("-out", "Vmag"), ("-out", "B-V"),
         ("Vmag", f"<{max_mag}"), ("-out.max", "50000")]
    )
    errors = []
    for host in MIRRORS:
        try:
            with urllib.request.urlopen(f"https://{host}/viz-bin/asu-tsv?{query}", timeout=90) as r:
                text = r.read().decode("utf-8", "replace")
            if "\n------" in text:
                return text
            errors.append(f"{host}: no table in the answer")
        except OSError as e:
            errors.append(f"{host}: {e}")
    raise RuntimeError("VizieR unavailable: " + "; ".join(errors))


def parse(tsv: str) -> list[tuple[float, float, float, float]]:
    stars = []
    started = False
    for line in tsv.splitlines():
        if line.startswith("------"):
            started = True
            continue
        if not started or not line.strip() or line.startswith("#"):
            continue
        cols = [c.strip() for c in line.split("\t")]
        if len(cols) < 4 or not cols[0] or not cols[1] or not cols[2]:
            continue
        bv = float(cols[3]) if cols[3] else DEFAULT_BV
        stars.append((float(cols[0]), float(cols[1]), float(cols[2]), bv))
    return stars


def pack(stars: list[tuple[float, float, float, float]]) -> bytes:
    return b"LSC1" + struct.pack("<I", len(stars)) + b"".join(struct.pack("<ffff", *s) for s in stars)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-mag", type=float, default=6.5)
    args = ap.parse_args()
    stars = parse(fetch(args.max_mag))
    stars.sort(key=lambda s: s[2])  # brightest first
    data = pack(stars)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(data)
    print(f"wrote {OUT}: {len(stars)} stars to magnitude {args.max_mag} ({len(data) / 1e3:.0f} kB)")


if __name__ == "__main__":
    main()
