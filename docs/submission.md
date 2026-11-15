# Submission drafts (Space Apps 2026: Lunar Landing Site Navigator)

Drafts for the Project Submission page and the demo. The rules and the checklist are in
[`judging-and-submission.md`](judging-and-submission.md). The MDR submission kit (commits `3aa7e30`, `efac9bf`) was
never integrated and isn't in the shared repository, so these drafts were rewritten against what this branch does.

Labels used below:

- **[implemented]**: on `main` and checked for this draft (command or file named).
- **[future]**: described in planning or on an unmerged branch, **not in the app**. Leave it out of the submission,
  or keep the label, until it is integrated.

Deadline: **Sunday 2026-11-15, 23:59 local time.** Press *Submit for Judging*; a saved draft does not count.

## 1. High-level summary (draft)

> Landing near the Moon's south pole means choosing a spot and a date where the Sun keeps the solar panels lit and
> Earth stays above the horizon for direct radio contact. At the pole both skim the horizon, so a crater rim or a
> slipped launch can end a mission. Lunar Landing Site Navigator turns NASA JPL Horizons ephemerides and LRO LOLA
> terrain from NASA Moon Trek into an hour-by-hour answer for 24 sites from 2026 to 2031. It shows every
> requirement's verdict (PASS, FAIL, or UNKNOWN when the data can't decide), why, and the terrain responsible in a
> 3D view. When a launch slips, Mission Rescue finds dates and sites that still work. Every result can be checked:
> the app shows its data sources, its validation against independent references and LROC observations, and its
> limitations.

Claims checked:

- 24 sites, hourly 2026–2031: `data/sites/` and the viability validation report's 24 dataset hashes.
- "The terrain responsible": the 3D blocker lines and the evidence links ("Show in 3D").
- Rescue: `backend/tests/test_rescue_real_data.py::test_demo_scenario_transition` (passes).

## 2. Detailed description (draft)

**What it does** [implemented]:

- **Mission Planner:** a whole-Moon 3D globe (LOLA terrain, live sunlight and shadows, LRO WAC imagery zoomed
  out), curated Artemis III and historical sites, custom pins, a time strip and a sky plot. Saved plans carry the
  canonical verdict and a full assessment: each requirement's measured value or proven range, margin, evidence
  windows ("Show in 3D"), data provenance and limitations.
- **Mission Rescue:** re-plans after a launch delay or a requirement change.
- **Scenario Comparison:** synchronized timelines, metrics, trade-offs and the canonical ranking. Only PASS plans
  are ranked; real and demonstration data never compete; unknown data stays unknown. CSV/JSON export.
- **Feasibility Atlas:** landing date × mission length for one site.
- **Validation & Methodology:** the data sources, the independent scientific checks, the viability engine's
  software-verification report, and the limitations.
- **Guided Mission Briefing:** a 9-step tutorial.

**How it works** [implemented]:

1. JPL Horizons gives the Sun and Earth direction from each site (`CENTER='coord@301'`, Moon ME frame), hourly.
2. Moon Trek LOLA DEMs in three tiers (5 m to 5 km, 30 m to 45 km, 200 m to ~294 km) give a 720-direction horizon
   mask with exact 3D geometry (the Moon's curvature included).
3. The Sun is treated as a 0.53° disk (partial Sun counts partially); Earth by its centre.
4. One canonical viability engine checks each mission against the spacecraft's requirements and returns
   verdicts, metrics, margins, screening risks, a score and evidence windows. Every view asks this same engine on
   the same hourly grid.

**Example mission** [implemented; preset `backend/app/rescue/demo_scenario.json`, re-run for this draft]:

- Connecting Ridge, landing 2027-02-08 00:00 UTC, 7 days: **PASS** (score 100).
- Launch slips 5 days: **FAIL**, because the longest power darkness is 63 h against a 50 h battery limit.
- Mission Rescue's top alternative: Malapert Massif, 2027-02-16 12:00 UTC, **PASS** (score 100).

**Tech stack** [implemented]:

- **Frontend:** React 19, TypeScript, Vite, Three.js / React Three Fiber, Zustand, Tailwind, Recharts, OpenLayers.
- **Backend:** Python, FastAPI, numpy, rasterio, astroquery, Skyfield (validation only).

**Not in this submission** [future], until integrated:

- The one-click guided mission journey ("Explore a mission").
- The printable mission decision report.
- DSN ground-station windows, battery simulation in watts and watt-hours, landing-error Monte Carlo, and mast-height
  optimisation (`CurrentPriorities.md` defers these).

## 3. NASA data and references (mandatory section; use as is)

- NASA JPL Horizons System: https://ssd.jpl.nasa.gov/horizons/ (`CENTER='coord@301'`)
- NASA Moon Trek, LRO LOLA DEMs and PSR / surface-ice layers, LRO WAC mosaics: https://trek.nasa.gov/moon/
- NASA LROC QuickMap: https://quickmap.lroc.asu.edu/ (used for manual cross-checks)
- LROC `WAC_POLE_ILL_TWI_SOUTH` illumination product:
  https://data.lroc.im-ldi.com/lroc/view_rdr/WAC_POLE_ILL_TWI_SOUTH. Speyerer, E. J. & Robinson, M. S. (2013),
  *Icarus* 222, 122–136, https://doi.org/10.1016/j.icarus.2012.10.010
- JPL DE421 and NAIF Moon frame kernels (independent ephemeris check, via Skyfield)
- NASA, "NASA Provides Update on Artemis III Moon Landing Regions" (2024-10-28); George et al., "Artemis III Site
  Selection Update", LPSC 2026 (NTRS 20250011660)
- Gracy & Lee (2024), LPSC 55, abstract 1695: source of the Connecting Ridge and Peak Near Shackleton coordinates
  (`backend/app/engine/sites.py`, recorded in each site file)
- Display only: NASA Visible Earth "Blue Marble" (Earth's appearance); ESA Hipparcos catalogue via CDS VizieR
  `I/239` (stars)
- Canadian Space Agency, Moon Exploration: https://www.asc-csa.gc.ca/eng/astronomy/moon-exploration/ (context)

**Wording to keep accurate:** `CLAUDE.md` and `judging-and-submission.md` describe Gracy & Lee as a *validation*
reference ("illumination thresholds"). In the code it is the **coordinate source** for two sites. The implemented
illumination validation ([`validation-engine.md`](validation-engine.md)) compares with LROC, not with that paper.
Cite it as above, not as a validation result.

## 4. AI / synthetic-intelligence disclosure (draft; **each member must confirm their own line**)

> **In the product.** The optional Mission Assistant in Scenario Comparison sends the comparison's own computed
> results to a large language model through OpenRouter (default `openai/gpt-4o-mini`), only when the server is
> configured with an API key. It explains results in plain language; it never computes verdicts, scores or rankings,
> which come from the deterministic viability engine.
>
> **In development.** The team used AI coding assistants, including Anthropic's Claude (Claude Code), for code,
> tests, debugging and documentation. Team members reviewed, tested and integrated the output. [Members: add other
> tools used, e.g. for images, slides or video.]

| Member (git identity) | Tools used, and for what | Confirmed |
|---|---|---|
| AndrewH234567 | Claude Code (code, tests, debugging, documentation) | [ ] |
| XxHuanghoidSlayerxX | | [ ] |
| bryanjietang-boop | (also: how the rover mascot SVGs were made; see [`assets-and-licensing.md`](assets-and-licensing.md)) | [ ] |
| FRCJavisT | | [ ] |
| Vision for Change | | [ ] |
| Arush Shrivastava | | [ ] |

What the repository shows: 13 of 387 commits carry a `Co-Authored-By: Claude …` trailer. That is a lower bound:
assistants don't always leave a trailer.

## 5. Demo (choose a slide deck or a video)

Use **real screenshots or recordings** of the app, never illustrative images.

**Video (≤ 30 s)**, following the storyboard in [`judging-and-submission.md`](judging-and-submission.md):

| Time | Show | Source in the app |
|---|---|---|
| 0:00–0:02 | Team name | - |
| 0:02–0:05 | The problem: the Sun and Earth skim the polar horizon | Planner, Sun eye view at Connecting Ridge |
| 0:05–0:10 | Name and hook | Landing page |
| 0:10–0:20 | The example mission: PASS → 5-day slip → FAIL (63 h dark) → "Show in 3D" → Rescue picks Malapert | Planner (plan card, Full assessment), Rescue |
| 0:20–0:30 | The evidence and who it helps | Methodology (validation numbers, sources), Comparison |

**Slides (≤ 7)**:

1. The problem.
2. The data (JPL Horizons, LOLA, LROC).
3. The 3D view and the time strip.
4. The example mission and Rescue.
5. Comparison and the Atlas.
6. Validation and limitations (numbers from the Methodology view).
7. Impact and the team.

## 6. Open before submitting

- [ ] Licence decision and the asset items in [`assets-and-licensing.md`](assets-and-licensing.md) §4
      (font, rover model, landing images, favicon).
- [ ] Every member confirms their AI-disclosure line (§4).
- [ ] Keep Gracy & Lee cited as a coordinate source, not a validation result (§3).
- [ ] Public repository link and a public deployment (if any) accessible without sign-in.
- [ ] Final README pass ([`../README.md`](../README.md), *To verify…*) if the journey or the report gets merged
      before the deadline.
- [ ] Record a full `node scripts/release-gate.mjs --full` pass on the submitted commit. The latest recorded run
      covers only the production and offline checks.
