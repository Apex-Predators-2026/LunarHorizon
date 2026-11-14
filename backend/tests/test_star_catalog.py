"""The star catalogue builder (scripts/build_star_catalog.py): parsing VizieR's table and the file layout."""

import importlib.util
import struct
from pathlib import Path

spec = importlib.util.spec_from_file_location("build_star_catalog", Path(__file__).resolve().parents[1] / "scripts" / "build_star_catalog.py")
bsc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bsc)

TSV = """#
# VizieR answer (shortened)
RAICRS\tDEICRS\tVmag\tB-V
deg\tdeg\tmag\tmag
------------\t------------\t-----\t------
101.28715533\t-16.71611582\t-1.44\t 0.009
088.79287161\t+07.40703634\t 0.45\t 1.500
279.23410832\t+38.78299311\t 0.03\t
"""


def test_parses_the_table_and_fills_missing_colours():
    stars = bsc.parse(TSV)
    assert len(stars) == 3
    assert stars[0] == (101.28715533, -16.71611582, -1.44, 0.009)  # Sirius
    assert stars[2][3] == bsc.DEFAULT_BV  # no B-V given


def test_layout_matches_the_frontend_reader():
    stars = bsc.parse(TSV)
    data = bsc.pack(stars)
    assert data[:4] == b"LSC1" and struct.unpack_from("<I", data, 4) == (3,)
    assert len(data) == 8 + 3 * 16
    ra, dec, mag, bv = struct.unpack_from("<ffff", data, 8)
    assert abs(ra - 101.287) < 1e-3 and abs(mag + 1.44) < 1e-6
