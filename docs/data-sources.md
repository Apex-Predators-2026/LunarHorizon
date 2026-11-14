# Data Sources (verified in Phase 1)

Check script: `backend/scripts/phase1_check.py`

## JPL Horizons: Sun/Earth positions
- API: `https://ssd.jpl.nasa.gov/api/horizons.api`
- Key params: `CENTER='coord@301'` (Moon), `COORD_TYPE='GEODETIC'`, `SITE_COORD='<E-lon deg>,<lat deg>,<alt km>'`,
  `COMMAND='10'` (Sun) or `'399'` (Earth), `QUANTITIES='4'` (apparent azimuth/elevation), `ANG_FORMAT='DEG'`, `CSV_FORMAT='YES'`.
- 2 years hourly = 17,545 rows per body in one request. Works.
- Elevations are relative to the flat (sphere) horizon. Terrain blocking is our job.

## Lunar coordinate frame (checked)
Everything is in the Moon's **Mean-Earth/polar-axis (ME)** frame on the 1737.4 km sphere, so no conversion is needed:
- **Horizons:** the response header for a `coord@301` site says `Center pole/equ : MEAN_ME (high precision)`.
  `app/engine/ephemeris.py` checks this line and refuses any other frame.
- **LOLA terrain (Moon Trek):** LOLA products are in MOON_ME (the PGDA polar DEMs state "MOON_ME reference frame of DE421").
- **Site coordinates:** from LOLA/LROC-based sources (Quickmap), also ME.
- Why it matters: the principal-axis (PA) frame differs from ME by ~0.9 km on the surface. Near the pole that shift
  can rotate the local north direction by degrees, which would misalign Sun/Earth azimuths with the horizon mask.
- Residual: Horizons' ME comes from DE441 and LOLA's from DE421. The two ME realisations differ by metres, which is
  negligible here.
- Horizons places the site on the sphere (altitude 0), not at its true height (up to ~5 km). The parallax this causes
  is < 0.001° for the Sun and Earth, so it is ignored.

## Moon Trek: LOLA terrain (south pole)
ArcGIS ImageServers, all in Moon2000 south polar stereographic (metres, central meridian 0):

| Service | Resolution | Coverage | Use |
|---|---|---|---|
| `LRO_LOLA_DEM_SPole875_5mp_v04` | 5 m | 87.5°S to pole | near-field terrain, 3D view |
| `ldem_85s_20m_Spole_float_SP` | 20 m | 85°S to pole | mid-range |
| `LRO_LOLA_DEM_SPole75_30mp_v04` | 30 m | 75°S to pole | mid-range |
| `LRO_LOLA_DEM_SPole45_100mp_v04` | 100 m | 45°S to pole | distant horizon |

- Base URL: `https://trek.nasa.gov/moon/trekarcgis/rest/services/<Service>/ImageServer`
- Download a GeoTIFF crop:
  `exportImage?bbox=xmin,ymin,xmax,ymax&size=W,H&format=tiff&pixelType=F32&f=image`
  (bbox in the service's polar-stereographic metres; max size 15000 × 4100 px).
- Heights are metres relative to the 1737.4 km reference sphere.
- Also there: `PSR_SP` (permanently shadowed regions, MapServer), `LRO_LOLA_Shade_SPolar875_10m` (hillshade),
  `LRO_WAC_Mosaic_SPole60_100m_v02` (imagery for the 3D surface).
- Moon Trek service config (all endpoints): `https://trek.nasa.gov/moon/jpl/config/config.json`

## Moon Trek: whole-Moon elevation registry (`backend/app/engine/dem.py`)
Since generator 1.2 the engine and the 3D terrain sample all of these through one registry, at any latitude/longitude:

| Name | Service | Resolution | Coverage |
|---|---|---|---|
| sp5 / sp20 / sp30 / sp100 | south-pole products above | 5 / 20 / 30 / 100 m | to 87.5 / 85 / 75 / 45°S |
| np5 / np30 / np100 | `LRO_LOLA_DEM_NPole875_5mp_v04`, `..NPole75_30mp_v04`, `..NPole45_100mp_v04` (north polar stereographic) | 5 / 30 / 100 m | from 87.5 / 75 / 45°N |
| global | `LRO_LOLA_DEM_Global_256ppd_v06` (lon/lat, 1/256°) | ~118 m | whole Moon |

- Poleward of 60° the polar products are used (the global grid is a last resort there); elsewhere the global one.
- Each lookup uses the coarsest product (and power-of-two downsampling) that is still at least as fine as the
  spacing asked for, so zoomed-out views don't download 5 m data.
- Data is fetched with `exportImage` in blocks of up to 1024 × 1024 px and cached as `.npy` in `data/cache/dem/`
  (git-ignored). `scripts/prefetch_tiles.py` warms the globe, the polar region and each curated site.
- **Moon Trek quirks:**
  - The global server answers HTTP 502 when one request spans more than ~32° (whatever the output size), so coarse
    global blocks use fewer pixels.
  - It occasionally returns 500/502 for a request that works moments later, so downloads retry 3 times.
- **Not used:** Moon Trek's Cesium terrain (`marshub.s3.amazonaws.com/moon_v14/`): whole Moon only to level 9
  (~165 m) and no extra detail below 80°S, coarser than the polar products.

## Moon Trek: LRO WAC imagery, optional 3D layer (`backend/app/engine/imagery.py`)
The "LRO imagery" toggle drapes Lunar Reconnaissance Orbiter Wide Angle Camera mosaics over the terrain.

| Service | Resolution | Projection | Used |
|---|---|---|---|
| `LRO_WAC_Mosaic_SPole60_100m_v02` | 100 m | south polar stereographic (same as the LOLA products: 1737.4 km sphere, central meridian 0) | poleward of 60°S |
| `LRO_WAC_Mosaic_NPole60_100m_v02` | 100 m | north polar stereographic | poleward of 60°N |
| `LRO_WAC_Mosaic_Global_303ppd_v02` | 303.23 px/deg (~100 m) | lon/lat | everywhere else |

- Fetched and cached exactly like the elevation data (exportImage blocks, `data/cache/imagery/`, git-ignored).
  `pixelType=U8`; 0 means no data (real pixels are ≥ 1), so the 180° edge of the global mosaic doesn't show as a line.
- `/api/imagery/tile/{face}/{z}/{x}/{y}`: a 256 × 256 grayscale PNG per tile for levels 0–7 (~83 m/px at level 7,
  about the mosaics' resolution). Deeper tiles show their level-7 ancestor's image.
- **Not the selected time:** the mosaics are photographs, so their shadows are from when they were taken. Near the
  pole most of the mosaic is in shadow. The layer helps recognise places; nothing is calculated from it.

## Moon Trek: permanently shadowed regions and surface ice (`backend/app/engine/psr.py`)
- `PSR_SP/MapServer/0`: 164 south-polar PSRs as **points** (centre, area 10–1,075 km², ID, LRO imaging notes),
  80–90°S. Moon Trek has no PSR outlines, so the app draws a circle of the same area, labelled approximate.
- `SP_IceLoc_280m/MapServer/0`: 1,119 surface water-ice detection points (280 m cells).
- Query: `.../MapServer/0/query?where=FID >= a AND FID < b&outFields=*&f=geojson`. The layers cap a query at 1,000
  records and reject pagination parameters, so fetch in FID ranges.

## LROC Quickmap
- Web app (React + OpenLayers + Cesium). **No documented public API.** Its layers come from undocumented tile
  servers (`lroc-tiles.actgate.com/tiles`, terrain `dem-tiles.b-cdn.net/lunar/qts_demstack/`), so don't build on them.
- Use it **in the browser** to cross-check each site: shadowed regions, illumination, slopes.
- The downloadable version of its south-pole illumination layers is LROC's own archive (same team):
  - `WAC_POLE_ILL_TWI_SOUTH`: time-weighted % of time sunlit, 88–90°S, 100 m/px, polar stereographic, 8-bit GeoTIFF.
    Built from 3,807 WAC images (Feb 2010 – Feb 2011). Product page: https://data.lroc.im-ldi.com/lroc/view_rdr/WAC_POLE_ILL_TWI_SOUTH
  - `WAC_POLE_ILL_PCT_SOUTH`: same without interpolation.
  - **Validation use:** our computed "% of time sunlit" per site should roughly match these maps.
- Quickmap's 3D view loads lander/rover models (e.g. `VIPER.glb`, `orion_moon_lander.glb`) from `files.actgate.com`.
  License unknown; don't reuse without checking.

## MCP servers listed in the challenge
Useful for asking an AI assistant questions while developing. **Not for the app itself.**

| Repo | What it is | Verdict |
|---|---|---|
| [pipeworx-io/mcp-horizons-nasa](https://github.com/pipeworx-io/mcp-horizons-nasa) | Unofficial Horizons wrapper (`lookup`, `ephemeris`, `observers`, `vectors`), proxied via a hosted gateway. 50 calls/day anonymous, 200 with free key. MIT. | Skip in the app: rate-limited third-party proxy. We call the Horizons API directly. |
| [ProgramComputer/NASA-MCP-server](https://github.com/ProgramComputer/NASA-MCP-server) | Unofficial wrapper over many NASA APIs, including Horizons and Trek WMTS tiles. `npx -y @programcomputer/nasa-mcp-server@latest`, Node 22+. ISC. | Optional dev helper for exploring APIs. Adds nothing we don't already reach directly. |
| [NASA-PDS/pds-mcp-server](https://github.com/NASA-PDS/pds-mcp-server) | Official NASA-PDS natural-language search of the PDS Registry (missions, instruments, collections, products). Python/FastMCP. MIT. | Good for finding LRO dataset IDs and citations for the validation write-up. Doesn't download data. |

## CSA Moon Exploration portal
https://www.asc-csa.gc.ca/eng/astronomy/moon-exploration/
- Background only: Artemis, Gateway/Canadarm3, Canadian utility rover, LEAP program, infographics.
- **No datasets or APIs.** Useful for the educational/explanation text and presentation context.

## Validation references (and the local ephemeris for custom sites)
Used by `backend/scripts/validate_engine.py` (results: `docs/validation-engine.md`). Since generator 1.2 the same
Skyfield setup (`backend/app/engine/ephem_local.py`) also computes Sun/Earth positions for **custom sites**, so a
dropped pin doesn't need two Horizons round trips; it matches our Horizons data to 0.00001°.
- **Independent ephemeris:** Skyfield + JPL DE421 (`https://ssd.jpl.nasa.gov/ftp/eph/planets/bsp/de421.bsp`) and the
  Moon ME frame kernels from NAIF (`fk/satellites/moon_080317.tf`, `pck/moon_pa_de421_1900-2050.bpc`,
  `pck/a_old_versions/pck00008.tpc` under `https://naif.jpl.nasa.gov/pub/naif/generic_kernels/`).
- **Observed illumination:** LROC `WAC_POLE_ILL_TWI_SOUTH_100M.IMG` (32-bit % sunlit, 88–90°S, 100 m/px,
  2010-02-15 to 2011-02-05), from
  `https://pds.lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/DATA/BDR/WAC_POLE/WAC_POLE_ILL_TWI_SOUTH/`.
  Use the `.IMG`; the `.TIF` next to it is an 8-bit display stretch with no stated scaling.

## Network note
On machines with HTTPS inspection (antivirus/proxy), Python needs `truststore.inject_into_ssl()` to use the OS certificate store.
