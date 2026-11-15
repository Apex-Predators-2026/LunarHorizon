# Asset provenance and licensing review

Reviewed 2026-11-15 on branch `recovery/workflows-remaining` (from `main` at `2f9c124`). This replaces the
unintegrated review in MDR commit `3aa7e30`, which is not available in the shared repository, so it was redone from
the files themselves.

Method:

- Each bundled asset was traced through its embedded metadata (the glTF `asset` block, the font `name` table, image
  metadata), its git history (who added it, in which commit) and any credit shown in the app.
- Nothing below asserts ownership, attribution or permission that this evidence does not show.
- "Unresolved" means a decision or a confirmation is still needed. It does not mean the asset is unlicensed, only
  that we cannot show it is cleared.

## 1. Repository licence: **unresolved (team decision)**

- There is no `LICENSE`, `COPYING` or `NOTICE` file, and no licence field in `frontend/package.json` or the backend.
- No licence choice is recorded anywhere in the repository. `CurrentPriorities.md` lists "LICENSE missing" as open
  and warns against applying MIT to third-party assets without checking their rights.
- The Space Apps rules expect a public repository with a clear open-source licence (see
  [`judging-and-submission.md`](judging-and-submission.md), §4).

**Decision needed:**

1. Choose a licence for the team's own source code (for example MIT or Apache-2.0), agreed by every contributor
   (`git shortlog -sn` lists six author identities).
2. State in the `LICENSE` or `README` that third-party assets keep their own terms (table below), and that the code
   licence does not cover them.

No `LICENSE` file was added in this pass, because there is no established choice to preserve.

## 2. Bundled assets

| Asset | Used for | Evidence | Status |
|---|---|---|---|
| `frontend/public/models/rover.glb` (10.9 MB), and an identical copy `Rover(1).glb` at the repo root | 3D rover at the landing site ("detailed" graphics) | Exported with "Khronos glTF Blender I/O v5.0.21". The root node is named **`MSL`** (Mars Science Laboratory, i.e. NASA's *Curiosity* rover); textures `tex_01`–`tex_05`, `parts_AO`. Added in `6bb7f4f` ("Add LRO imagery layer, rover model & CSM shadows"). `Lander.tsx` calls it "the team's rover model". No source URL, author or licence is recorded. | **Unresolved (blocking for a licence statement).** The `MSL` node suggests it derives from a NASA Curiosity model. NASA's 3D resources are generally free to use under NASA media guidelines, but that origin is not documented, and a Blender re-export may include third-party work. **Needed:** the source URL and its terms from whoever added it. If none can be found, set the default graphics to the built-in primitive lander (`detailed={false}`) or replace the model. Also delete the duplicate root `Rover(1).glb` (tracked in git, unused). |
| `frontend/public/fonts/BabyDoll.ttf` | "Baby Doll" font on the rover flag label (`viz/RoverFlag.tsx`) | Font `name` table: "Denne Baby Doll © (Denise Bentulan). 2011. **All Rights Reserved**", vendor URL dafont.com/denise-bentulan.d2156. Licence string: **"Free for personal use ONLY, for commercial use, contact the designer"**. | **Unresolved: restrictive.** "Personal use only, all rights reserved" does not clearly allow redistributing the font file in a public, openly licensed repository. **Needed:** written permission from the designer, or replace it with an SIL OFL font and remove the file from the repository. |
| `frontend/public/landing/moon.jpg` | Landing-page hero photo | No embedded metadata. Added in `3eb0493` (landing page, "real app screenshots and NASA data credits"). The page credits "Image: NASA", linking https://science.nasa.gov/moon/ (a portal, not the specific image). | **Partly resolved.** The NASA credit is shown, and NASA imagery is generally not copyrighted, but the exact source image is not identified. **Needed:** the specific NASA image page (ID or URL) in the credit, to confirm it is a NASA image (not a third-party photo hosted by NASA) and that the credit is right. |
| `frontend/public/landing/rocket-launch.webp` | Background of the landing page's closing section (`landing.css`) | No embedded metadata. Added in `f248d66` ("Refresh landing page hero and CTA"). No credit in the app. | **Unresolved.** Origin unknown. **Needed:** source and licence from the author of `f248d66`; if it's a NASA launch photo, a credit like the hero's; otherwise replace it. |
| `frontend/public/landing/compare.jpg`, `planner.jpg`, `rescue.jpg`, `sky.jpg`, `mission-planner-preview.png` | Landing-page pictures of the app | Screenshots of this app (captions describe its views; added with the landing page as "real app screenshots"). The 3D views inside them render NASA data. | **Resolved: team's own work** (screenshots of the project), showing NASA data credited on the page. |
| `frontend/public/rover-sprites.svg`, `rover-talking.svg` | Rover mascot of the Mission Assistant (`ui/RoverMascot.tsx`) | Plain SVG paths, no metadata or comments. Added in `39af0e4` ("Add rover assistant streaming UX"). | **Needs confirmation.** Nothing points to a third-party source, but authorship is not stated. **Needed:** the author of `39af0e4` confirms they drew or generated them, and how (if an AI image tool was used, disclose it; see `submission.md`). |
| `frontend/public/favicon.svg` | Browser tab icon | Same path and colour (`#863bff`) as the default Vite logo from the `create-vite` template. | **Resolved but should be replaced:** it is the Vite project's logo, not a project mark (Vite is MIT-licensed). Replace it with a project icon before submission. |
| `frontend/public/sky/earth.jpg` | Earth's face in the sky | Documented in [`data-sources.md`](data-sources.md): NASA Goddard / Visible Earth "Blue Marble: Land Surface, Shallow Water, and Shaded Topography" (Wikimedia Commons copy). | **Resolved: NASA, public domain.** Credit NASA Goddard / Visible Earth. |
| `frontend/public/sky/stars.bin` | Star positions and brightness | Built by `backend/scripts/build_star_catalog.py` from the Hipparcos catalogue (ESA) via CDS VizieR `I/239/hip_main`. | **Resolved with attribution.** Cite ESA Hipparcos (ESA 1997, SP-1200) and the CDS VizieR service, as the README does. |
| `frontend/public/terrain/base.bin`, `frontend/public/imagery/base.bin` | First view of the whole Moon (coarsest terrain and LRO WAC imagery) | Built by `backend/scripts/build_base_pack.py` from Moon Trek LOLA and LRO WAC products. | **Resolved: NASA data**, credited as NASA Moon Trek / LRO LOLA / LRO WAC. |
| `data/sites/*.json` | The 24 precomputed site timelines | Generated by `backend/scripts/precompute.py` from JPL Horizons and Moon Trek LOLA. Provenance is recorded in each file. | **Resolved: derived from NASA data**, credited in README and Methodology. |
| UI typefaces (Inter, etc.) | Interface text | Loaded from Google Fonts at runtime, not bundled. | Resolved (Google Fonts are SIL OFL or Apache). |
| Code dependencies | — | npm and PyPI packages under their own licences, installed from the lockfile and `requirements.txt`, not vendored. | Resolved. A licence report (for example `npx license-checker`) can be attached if judges ask. |

## 3. Assets deliberately not used

- Quickmap's lander and rover models (`VIPER.glb`, `orion_moon_lander.glb` from `files.actgate.com`) have unknown
  terms and are **not** used ([`data-sources.md`](data-sources.md), *LROC Quickmap*).

## 4. Open items, in order

1. **Code licence:** team decision and the `LICENSE` file (§1).
2. **`BabyDoll.ttf`:** permission or replacement. Restrictive terms are stated in the file itself.
3. **`rover.glb`:** source and terms, or switch to the primitive lander. Remove the duplicate `Rover(1).glb`.
4. **`rocket-launch.webp`:** source and terms, or replacement.
5. **`moon.jpg`:** specific NASA image reference in the credit.
6. **Rover mascot SVGs:** author confirmation (and AI-tool disclosure if one was used).
7. **`favicon.svg`:** replace the Vite logo.

When an item is resolved, record the evidence here: link, licence text or permission, and the date.
