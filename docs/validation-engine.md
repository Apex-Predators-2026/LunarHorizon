# Data engine validation (Phase 6)

What was checked about the data engine (Andrew), how, and what it means. This is the input for the
team's validation work (Member 6); it covers the engine's science, not the viability rules or UI.

- **Reproduce:** `cd backend` then `.venv\Scripts\python.exe scripts\validate_engine.py` (a few minutes;
  downloads ~25 MB of JPL kernels and LROC data on first run, cached in `data/cache/` and `data/raw/`).
- **Raw results:** `data/validation/engine_validation.json`.
- **Data checked:** all 24 curated site files `data/sites/*.json` (9 Artemis candidates + control, 15 past
  landings), generator version 1.2.

## Summary (generator 1.2, all 24 sites)

| Check | Reference | Result | Verdict |
|---|---|---|---|
| 1. Sun / Earth positions | Skyfield + JPL **DE421** + Moon ME frame (independent software and ephemeris) | Max difference **0.00071°** for Sun and Earth at all 24 sites, every 6 h over 2 years | ✅ Matches (difference = our 0.001° file rounding) |
| 1b. Visible/blocked verdicts | Same positions, run through our horizon | **0 of 140,400** sampled verdicts differ | ✅ |
| 2. Horizon geometry | Independent geometry on the same elevation data: straight lines in the polar map plane + central-angle formula (the engine's original method) | Max difference **0.001–0.046°** over all 720 directions at the 12 south-polar sites | ✅ Matches (largest furthest from the pole, where the flat-map method's own approximation grows) |
| 2b. Azimuth convention | Same, with our horizon mirrored east↔west | A mirror would be off by **1.5–30°** | ✅ Convention confirmed |
| 3. Illumination, area average | LROC WAC time-weighted illumination map (observed, 2010–11) | Mean bias **−3.9** (Connecting Ridge), **−0.5** (Peak Near Shackleton), **+0.7** (de Gerlache Rim) points over 121 points; r = 0.66–0.88 | ✅ No systematic bias |
| 3b. Illumination, single site pixel | Same | Shackleton floor 0% vs 0% ✅; de Gerlache Rim 12.3% vs 11.5% ✅; Peak Near Shackleton 12.2% vs 7.1% (neighbours 7.1–12.6%) ✅; Connecting Ridge 42.8% vs 8.7% (neighbours 7.9–30.1%) ⚠️ | ⚠️ Point values are not reliable on sharp light/dark edges |
| 4. Physical sanity, past landings | Known geometry | All 6 Apollo sites, SLIM, Blue Ghost, Chang'e 3/5, Chandrayaan-3, IM-1: Earth in view 100% of the time; Chang'e 4 and 6 (far side): Earth **never** in view (33–52° below the horizon); Sun up 47–50% at low latitudes | ✅ |

The geometry check needs the south-polar map projection, so it covers the 12 sites south of 60°S; the 12 others
rely on the same great-circle code, plus unit tests at equatorial positions (bare sphere, ridge in a known direction).

### What changed from generator 1.1
The engine now samples a whole-Moon elevation registry with great circles (so it works anywhere). For the original
sites the horizons moved by up to 0.2–0.4° (Connecting Ridge, Peak Near Shackleton), and at **Malapert** by up to
1.6°: Malapert lies outside the 5 m product (87.5°S), and its near field now comes from the finer **20 m** product
instead of the 30 m one. With 20 m detail, the flat summit top within ~100 m of a 2 m mast blocks a very low Sun,
so Malapert's sunlight went from **82.6% to 77.1%** (Earth: 99.9% to 100%). The finer data is the better source.
Other summaries changed by ≤ 0.3 points.

**Bottom line:** the geometry and ephemeris are verified to about 0.001°, far below anything that changes a
result. Sunlight percentages agree with orbital observations on average. Single-point values on a
light/dark boundary can differ a lot from a 100 m camera pixel, so **don't quote a site's sunlight % to
better than about ±10 percentage points**, and prefer area or margin-based reasoning near edges.

## 1. Sun and Earth positions vs an independent ephemeris

- **Ours:** JPL Horizons API, DE441, apparent azimuth/elevation from a `coord@301` site (Mean-Earth frame).
- **Reference:** Skyfield 1.55 with JPL DE421 and the Moon's Mean-Earth frame `MOON_ME_DE421`
  (`moon_080317.tf`, `moon_pa_de421_1900-2050.bpc`), apparent positions (light-time and aberration).
  Different software and a different ephemeris; only the frame definition is shared.
- **Sampling:** every 6 hours, 2027-01-01 to 2029-01-01, all 4 sites: 2,925 samples per body per site.

| Body | Max separation | RMS | Max elevation difference |
|---|---|---|---|
| Sun | 0.0007° | 0.0004° | 0.0005° |
| Earth | 0.0007° | 0.0004° | 0.0005° |

The differences are the same at every site because they come from our file rounding (angles are stored to
0.001°, so up to 0.0005° per axis, about 0.0007° combined). The true difference between the two
ephemerides is smaller than that.

**Verdict impact:** feeding the reference positions through our horizon changed **1 of 23,400** visible/blocked
verdicts: Connecting Ridge, 2027-06-29 18:00 UTC, where the Sun's top edge clears the skyline by 0.00002°
in the reference and sits just below it in ours.

This check also confirms our parsing, time handling (UTC), azimuth convention and frame choice end to end.

## 2. Horizon geometry vs an independent method

Since generator 1.2 the engine walks true great circles from the site and computes elevation angles from 3D
Moon-fixed vectors (`compute_horizon_latlon` in `app/engine/horizon.py`), so it works anywhere on the Moon. The
check recomputes the horizon with the engine's **original** method: straight lines in the south-polar map plane
and a central-angle formula (`compute_horizon`), fed the **same** elevation data at the same spacing
(`_SameDataPlane` in the script). That isolates the geometry: the two share no geometric code. All 720 directions
(every 0.5°) are compared. Bearings follow Horizons' azimuth convention ("North(0) → East(90) → South(180) →
West(270)").

| Site | Max difference | If east↔west were mirrored |
|---|---|---|
| Connecting Ridge | 0.006° | 6.49° |
| Peak Near Shackleton | 0.002° | 1.66° |
| Malapert Massif | 0.024° | 2.46° |
| de Gerlache Rim | 0.010° | 11.06° |
| Haworth Rim | 0.006° | 8.23° |
| Nobile Rim 1 | 0.046° | 30.08° |
| Mons Mouton | 0.014° | 7.92° |
| Faustini Rim A | 0.005° | 14.95° |
| Shackleton crater floor (control) | 0.001° | 2.12° |
| IM-1 Odysseus (2024) | 0.006° | 8.91° |
| IM-2 Athena (2025) | 0.007° | 4.04° |
| Chandrayaan-3 (Shiv Shakti Point) | 0.030° | 1.51° |

The differences grow with distance from the pole (Nobile Rim 1, Chandrayaan-3), where the flat-map method's
straight-line approximation is weakest; the great-circle method has no such approximation. Sites north of 60°S
can't use the polar map plane, so this check doesn't apply to them.

## 3. Sunlight vs LROC orbital observations

- **Reference:** LROC `WAC_POLE_ILL_TWI_SOUTH_100M` (Speyerer & Robinson 2013, Icarus 222, 122–136): the
  percentage of time each 100 m pixel was seen lit in ~3,800 Wide-Angle Camera images,
  2010-02-15 to 2011-02-05, covering 88–90°S. This is the downloadable version of Quickmap's illumination layer.
  Its map projection matches ours to 0.1 m.
- **Fair comparison:** the model is re-run for **the same period** with the sensor **at the surface** (LROC sees
  the ground; our site files use 2 m).

### Single site pixel

| Site | LROC at pixel | LROC 3×3 neighbours | Model: any Sun | Model: ≥ half disk |
|---|---|---|---|---|
| Connecting Ridge | 8.7% | 7.9–30.1% | 42.8% | 37.1% |
| Peak Near Shackleton | 7.1% | 7.1–12.6% | 12.2% | 9.0% |
| Shackleton floor | 0.0% | 0.0–0.0% | 0.0% | 0.0% |
| Malapert Massif | outside map (86°S) | | | |

### Area around each site (11×11 grid, 400 m spacing, ±2 km)

| Site | Correlation r | Mean bias (model − LROC) | Mean abs. difference | LROC mean |
|---|---|---|---|---|
| Connecting Ridge | 0.68 | −3.9 pts | 5.9 pts | 25.4% |
| Peak Near Shackleton | 0.66 | −0.5 pts | 5.1 pts | 11.2% |

**Interpretation:**
- **No systematic error.** Over the area the model is not biased high or low, and the patterns correlate.
- **The Connecting Ridge site sits on a light/dark edge.** Its own LROC pixel says 8.7% while a neighbour
  100 m away says 30.1%. A point model and a 100 m camera pixel can't agree on such an edge.
  The likely causes are WAC geolocation (tens of metres), the camera's conservative "lit" threshold
  (grazing light on slopes can read as dark), and pixel averaging.
- **Yearly totals can't test the azimuth convention.** Our horizon, a mirrored one and a 180°-rotated one score
  almost the same (r = 0.66–0.71), because over a year the Sun passes every azimuth and the
  pattern around the pole is mirror-symmetric. That's why check 2 exists.

## 3D view and charts use the same numbers

The 3D view, strip chart, sky plot and info panel all read the same backend timeline and horizon.
Nothing is recalculated in the browser except placing objects at the given azimuth and elevation
(`frontend/src/viz/geometry.ts`, unit-tested). Spot-checked in screenshots: at Connecting Ridge on
2027-01-12 03:00 UTC Earth sits 1.08° above the drawn skyline, the margin the panel reports.

## Assumptions and limitations

| Assumption | Effect | Size / status |
|---|---|---|
| No atmosphere: geometric line of sight, no refraction | None; the Moon has no atmosphere | Exact |
| Frame: everything in Mean-Earth (ME) | Checked: Horizons header and LOLA docs | Guarded in code |
| Earth's libration (its wobble in the lunar sky) | Included: Horizons gives the apparent direction from the site in the Moon-fixed frame, so the Moon's physical and optical libration move Earth about ±7–8° around its mean position each month (in our data its elevation swings 13.5° at Connecting Ridge, −7.4° to +6.1°, and 15.2° at Apollo 11). This is why Earth rises and sets at the south pole | Exact (part of the ephemeris) |
| Terrain: LOLA via Moon Trek at 5 m (to 5 km), 30 m (to 45 km), 200 m resampled (to ~294 km) | Small features below the resolution are smoothed | Coarser tiers matter most at grazing angles |
| Terrain beyond ~294 km ignored | The Moon's curvature drops it ≥ 25 km below the eye line | Negligible |
| Horizon every 0.5° of azimuth, linear between | Narrow notches or peaks can be missed | ≤ 0.25° in azimuth |
| Horizon rays along great circles (since 1.2; earlier versions used straight lines on the polar map) | The old method agrees to 0.001–0.046° at 12 polar sites (check 2) | Exact geometry |
| One sensor height, 2 m above ground | Real panels and antennas sit higher or lower | Use the same height everywhere until a mission config needs more |
| Solar disk vs a flat skyline across its 0.53° width | Disk fraction slightly off when the skyline is steep under the Sun | Small; only affects partial-Sun hours |
| Earth = its centre point (visible if the centre clears the terrain) | Earth is ~1.9° wide; partly visible Earth counts as blocked or visible by its centre | Margin column lets users add their own buffer |
| Horizons places the site on the 1737.4 km sphere, not at its true height | Parallax | < 0.001° |
| Hourly samples | Rise/set times known to ±30 min | Fine for planning; finer steps on request |
| Data covers 2027-01-01 to 2029-01-01 | Dates outside this range have no real data | Other dates need a re-run of `precompute.py` |
| Unknown terrain (custom sites only) is `null`, never guessed | Some hours can be "unknown" | Curated sites: 0% unknown |
| 3D view: by default terrain casts shadows only within ~6 km of the lander (one shadow map; none in the Low graphics setting). The "Far shadows" option (cascaded shadow maps) extends them to everything on screen | Without it, distant ground can look lit when it is in shadow. With it, only terrain that is drawn casts shadows, so a mountain off screen or behind the camera can't shadow the view | Display only: the numbers, the lander's lighting and the skyline use the engine's full 300 km horizon |
| Sunlight % at one point | Sharp edges make single points sensitive to tens of metres | See check 3: quote to about ±10 points |

## Suggested follow-ups (for the validation member)

- **Time-resolved illumination:** LROC's sub-solar-longitude mosaics (`NAC_POLE_SOUTH_CM_*`) or the WAC
  illumination movie would test individual lit/dark moments, which yearly totals can't.
- **Earth visibility reference:** no observed product exists; a cross-check against another horizon model
  (e.g. PGDA's LOLA-based polar illumination and Earth-visibility products) would be the next step.
- **Sensitivity to sensor height:** re-run with 0, 2 and 10 m to show how much a mast helps at each site.
