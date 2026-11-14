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

## Validation-only references
Used by `backend/scripts/validate_engine.py` (results: `docs/validation-engine.md`), not by the app.
- **Independent ephemeris:** Skyfield + JPL DE421 (`https://ssd.jpl.nasa.gov/ftp/eph/planets/bsp/de421.bsp`) and the
  Moon ME frame kernels from NAIF (`fk/satellites/moon_080317.tf`, `pck/moon_pa_de421_1900-2050.bpc`,
  `pck/a_old_versions/pck00008.tpc` under `https://naif.jpl.nasa.gov/pub/naif/generic_kernels/`).
- **Observed illumination:** LROC `WAC_POLE_ILL_TWI_SOUTH_100M.IMG` (32-bit % sunlit, 88–90°S, 100 m/px,
  2010-02-15 to 2011-02-05), from
  `https://pds.lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/DATA/BDR/WAC_POLE/WAC_POLE_ILL_TWI_SOUTH/`.
  Use the `.IMG`; the `.TIF` next to it is an 8-bit display stretch with no stated scaling.

## Network note
On machines with HTTPS inspection (antivirus/proxy), Python needs `truststore.inject_into_ssl()` to use the OS certificate store.
