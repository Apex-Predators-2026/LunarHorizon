# UI Design Prompt: Lunar Landing Site Navigator

> **Who this is for:** any coding CLI or engineer (Claude Code, Codex, Gemini CLI, a teammate) asked to add, change
> or polish UI in this repository. Read it fully before touching `frontend/`. It tells you the product's visual
> language, the rules behind it, where every reusable piece lives, how to verify your work and which mistakes have
> already been made once. Follow it unless the user explicitly says otherwise.
>
> **Hard constraints (never break these):**
> 1. Do **not** change the backend (`backend/`), the 3D simulation logic (terrain, shadows, ephemeris, camera maths) or any engine result. UI work only displays what the engine says.
> 2. Do **not** add dependencies. Everything is React 19 + TypeScript + Vite + Tailwind v4 + zustand + three.js/R3F + OpenLayers. (The team's own `@react-pdf/renderer` is already there for the report; do not add more.)
> 3. Keep every existing function. A redesign moves and restyles; it never silently deletes a capability. If a feature moves, it must be reachable in its new place (and any deep link, tour step or test that pointed at it must be updated).
> 4. Never show a bare number without context (see "Explainability" below). This is a judged requirement (NASA Space Apps: Validity, Presentation).

---

## 0. The product in one paragraph

A web app for choosing a Moon landing site and date at the lunar south pole. A full-screen **3D Moon** (Mission
Planner) shows terrain, shadows, the Sun and Earth for any hour from 2026 to 2031 using NASA JPL Horizons
ephemerides and Moon Trek / LOLA terrain. Users build **plans** (site + landing date + requirements), compare them
in **Scenario Comparison**, ask **Mission Rescue** for alternatives when a plan breaks, and ask the **Rover** AI
assistant to explain results. Two audiences use it at once: mission engineers (want exact numbers, margins, evidence)
and educators / the public (want a clear story, plain English, friendly visuals). The UI must satisfy both without
dumbing down the numbers or burying the story.

The judging criteria (see `CLAUDE.md`) are Impact, Creativity, Validity, Relevance, Presentation. UI decisions should
visibly serve: **explainability** (why a site passes or fails), **attribution** (NASA JPL Horizons, Moon Trek / LOLA,
LROC Quickmap, Gracy & Lee 2024 are named in the UI), **zero-crash polish** (a judge may click anything) and a
**memorable look** (this is where Creativity and Presentation are won).

---

## 1. Two visual worlds, one language

The app deliberately has two surfaces. Know which one you are in before choosing classes.

| World | Where | Look | Scope classes |
|---|---|---|---|
| **A. Floating planner UI** | `viz/*`, the sidebar (`features/plans`, `features/rescue`), toolbar, minimap, timeline panel, snackbars, dialogs | Light Opaline/Calcite panels floating over a **full-screen black 3D Moon**. Material Design 3 shapes, motion and state layers. Coral/mango accents. | `lp-light` (light panels), `md-host` (M3 button/ripple behaviour), `ui-chrome` (fades when "Hide all UI") |
| **B. Page UI** | Scenario Comparison (`features/compare`), Landing (`features/landing`), Atlas, Methodology | Light, calm, document-like pages. Same palette and M3 spacing, more text, charts and tables. | `cmp-page lp-light md-host` on the page root; landing has its own `lnd-*` classes |

The old dark "flight-software" tokens (`canvas`, `surface`, `raised`, `ink`, `accent`...) in `index.css` `@theme` and
`docs/design-system.md` still exist and are used by some data components, but **the current product direction is the
Calcite/Opaline + mango look described here**. `docs/design-system.md` is partly historical: its rules about
status-never-colour-alone, missing-data-is-never-zero and source-on-every-number still apply; its "no gradients, no
glass, no pills" rules do **not** apply to the planner and landing surfaces any more.

### 1.1 Inside `lp-light`, Tailwind's dark `slate-*` classes are re-pointed

Much of the older code was written with dark-theme palette classes (`text-slate-100`, `bg-slate-950`,
`text-emerald-300`, `bg-red-950`, `text-sky-300`). `index.css` re-defines those colour variables inside `.lp-light`
(and again for `.lp-dark .lp-light:not(.cmp-page)`) so the same markup renders correctly on light surfaces:
`slate-100` becomes near-black text, `slate-950` becomes white, `sky-*` becomes coral/red, `emerald-*` dark green,
`amber-*` dark amber. Consequences:

- **Never hard-code hex colours in a component** to "fix" contrast. Use the semantic classes below and let the scope remap them. If you must add a colour, add a variable to the `.lp-light` block (and its dark counterpart).
- When you write **new** UI inside these scopes prefer the semantic tokens: `text-calcite-ink`, `bg-opal-50`, `border-opal-300`, `text-coral`, `text-ink-2/3/4` (page scope), not new slate shades.
- If you render something in a portal (`createPortal(..., document.body)`), it escapes the scope: wrap it in an element with `lp-light` (see `AssessmentDialog`, `MissionAssistant`'s `SCOPE`).
- Dark mode is `html.lp-dark`: it only restyles the planner's panels (`.lp-light:not(.cmp-page)`); Scenario Comparison stays light. Test planner changes in both.

---

## 2. Design tokens (source of truth: `frontend/src/index.css`)

### 2.1 Palette (never invent new brand colours)

| Token / Tailwind class | Hex | Use |
|---|---|---|
| `opal-50` (`bg-opal-50`) | `#F5F5F7` | Default floating panel / card surface |
| `opal-100` | `#E8E8E8` | Secondary surface, inset wells |
| `opal-300` | `#D3D3D5` | Borders, dividers, disabled tracks |
| `calcite-grey` | `#DDDCDB` | Neutral chrome |
| `calcite-ink` (`text-calcite-ink`) | `#3C4044` | Primary text on light surfaces |
| `calcite-peach` | `#EDBF9B` | Soft warm accent, hover tints |
| `calcite-orange` | `#FD7B41` | Warm accent |
| `coral` (`text-coral`, `bg-coral`, `border-coral`) | `#FF634A` | **The** accent: selected state, primary action, focus, links |
| mango mesh | `#FFB08C` ↔ `#FF634A` | Hero/identity texture (section 5) |
| Moon/space | black `#000`, canvas `#070b14` | Behind the planner UI |

Data colours are **fixed meaning everywhere** (charts, timeline, 3D overlays): Sun `#e8b84a` (`--color-sun`), Earth
`#5aa9f0` (`--color-earth`), night `#111a2e`, blackout/violation `#d03b3b`. Scenario A-D identity comes from
`ui/tokens.ts` `series` + `seriesDash` and `features/compare/palette.ts`, **always with the scenario letter and a dash
pattern** so identity never relies on colour alone. Do not reuse coral for data; coral means "interaction/selection".

Status colours (pass / caution / fail / unknown) are shown **with an icon and a word** (`EligibilityBadge`,
`ReqIcon`, `StatusBadge`, `PassHeadroomBadge`). Never colour alone (colour-blind users, print, screenshots).

### 2.2 Typography

- Body and UI text in light worlds: **Inter** (`font-inter`, loaded in `index.html` with weights 300-700; `.lp-light` sets it). Use weight 300 only for very large decorative text, 400 body, 500 labels, 600 buttons/headings.
- Display / titles: **Helvetica** stack (`font-display`) for the wordmark-style headings and the underlined clickable time readout.
- **Baby Doll** (`public/fonts/BabyDoll.ttf`, family `'Baby Doll'`) is Rover's voice only: the "Your rover" flag tag, the Mission Assistant title "Rover" and the "Rover says..." label (`.cmp-ai-babydoll`). Its licence is personal-use-only: flag this to the user before final submission, do not spread it to other UI.
- Sizes (page): `text-label` 11, `text-body` 13, `text-title` 14, `text-heading` 18, `text-figure` 22. Floating planner UI often uses `text-xs` (12) and `text-sm` (14). Minimum readable size is 11 px; never go below 10 px (`text-micro`) except decorative.
- Numbers that sit in columns or change live: `tabular-nums` (Tailwind) or the `nums` utility. Timestamps in UTC with the word UTC.

### 2.3 Shape, spacing, elevation (Material Design 3)

Follow https://m3.material.io/styles/spacing and https://m3.material.io/foundations/layout :

- **8 dp grid** (4 dp for small steps). Touch targets **48 dp**: controls are 40 dp tall with an 8 dp surrounding gap (`.md-btn`, `.md-compact`, `ToolButton` `h-10 w-10`).
- Buttons: 40 dp tall, 24 dp side padding, **pill (20 px radius)**, 14 px / 600 / 0.1 px tracking (`.md-btn`). Compact: `.md-compact`.
- Cards / panels: large radius (`rounded-2xl` 16, `rounded-[22px]`, `rounded-[28px]` for dialogs). FAB: `rounded-[20%]` of a square. Pills for chips and toggles. Avoid 3-4 px "flight software" corners on new UI.
- Elevation: soft shadows, not borders only: `shadow-lg shadow-black/30` floating panels over the Moon, `shadow-xl shadow-black/40` for menus, `shadow-2xl shadow-black/50` for dialogs. On the light page world use 1 px `border-line`/`border-opal-300` and little shadow.
- Page gutters: 16 px (`px-4`) phone, 24-32 px desktop. Max content width 1500 px on Scenario Comparison. Layouts must work at phone width (no horizontal page scroll).

---

## 3. Material Design 3 rules as applied here

Always consult the primary source before inventing behaviour: https://m3.material.io (Components, Styles, Foundations).
The sections you will use most: *Motion* (easing and duration), *Interaction states*, *Buttons*, *FAB*, *Switch*,
*Text fields*, *Date pickers*, *Menus*, *Snackbar*, *Tooltips*, *Loading indicator*, *Toolbars*, *Navigation*, *Layout*.
Do not copy M3 literally where this app has already decided otherwise (the palette and Inter are ours); copy its
**structure, states and motion**.

### 3.1 Motion tokens (already defined on `:root`; use them, do not hard-code)

```
--md-ease-standard        cubic-bezier(0.2, 0, 0, 1)        state changes, hover, selection
--md-ease-standard-decel  cubic-bezier(0, 0, 0, 1)
--md-ease-standard-accel  cubic-bezier(0.3, 0, 1, 1)
--md-ease-emph-decel      cubic-bezier(0.05, 0.7, 0.1, 1)    things ENTERING (panels, menus, dialogs, FAB, snackbars)
--md-ease-emph-accel      cubic-bezier(0.3, 0, 0.8, 0.15)    things LEAVING
--md-dur-short2/3/4       100 / 150 / 200 ms                 hover, small fades, tooltips
--md-dur-medium1/2/4      250 / 300 / 400 ms                 enter/leave of panels, menus, geometry changes
```

Rules:
- **Enter with emphasized-decelerate, leave with emphasized-accelerate and shorter** (e.g. dialog in 300 ms, out 150 ms: `.md-dialog-in` / `.md-dialog-out`, `.md-menu` / `.md-menu-out`, `.md-snack-in` / `.md-snack-out`, `.md-reveal`, `.md-pop`, `.md-pop-fab`, `.md-fade-through`).
- Inside `.lp-light` / `.md-host`, Tailwind's `transition` utilities already use `--default-transition-duration: 200ms` and the standard easing, so a plain `transition-colors` is correctly timed. Do not override unless you need an enter/exit curve.
- **Animate only `transform` and `opacity`** (compositor properties). Exceptions that exist and are acceptable: the Mission Assistant panel animates `left/top/width/height` in px because its layouts (side / full / minimized) must morph; large lists and the 3D canvas must never animate layout properties.
- Two things that appear together must **share duration and easing** (the FAB and the timeline panel slide together: 400 ms in, 250 ms out, same curves). Check this whenever you add a second moving element near an existing one.
- Honour `prefers-reduced-motion`: the global rule in `index.css` shortens animations to ~0; for animation that is *content* (Rover, poof, peek, bounce, mango drift) gate with `@media (prefers-reduced-motion: no-preference)` and give a static fallback.
- No decorative motion that delays an action. A click must give feedback in under 100 ms (state layer + ripple), results can animate in after.

### 3.2 Interaction states (state layers)

Every interactive element has the M3 state layer: hover **8 %**, focus **10 %**, pressed **10 %** of the content colour,
plus a press **ripple** (`ui`/`viz/materialMotion.ts` installs it for `.md-host`/`.lp-light` buttons; opt out with
`data-no-ripple`). `index.css` adds the `::before` state layer to every `button` inside those scopes automatically; so
**use real `<button>` elements**, not clickable `<div>`s. Selected = coral tint (`bg-coral/10 text-coral`, or
`bg-coral/15 font-semibold` in menus). Disabled = `opacity-40` and no state layer. Pressed buttons scale to 0.98: for
buttons that sit in a clipping container or are very wide (bars, sidebar drag handle) add the `no-press` class, which
removes the shrink and avoids 1 px "white borders" at the edges.

Focus: one visible ring everywhere (`:focus-visible`, 2 px; coral inside `lp-light`). Never `outline: none` without a
replacement. (The Rover composer textarea removes its orange box on purpose and darkens its container border
instead: `.cmp-ai-composer:focus-within`.)

### 3.3 Components that already exist: reuse before you build

| Need | Use (file) | Notes |
|---|---|---|
| Text / select / date input | `ui/MdFields.tsx` `TextField`, `SelectField`, `DateField` | M3 outlined fields with floating label, `tip` prop adds the tooltip. `.md-field*` CSS. Never use a raw `<input>` in the planner. |
| Date picking | `viz/DatePopup.tsx` | Modal M3 date picker, draggable, used by the time readout and plans |
| Switch | `.md-switch` + `.md-switch-handle`, wrapped in a `role="switch"` `button.md-row` (see Layers menu in `viz/MapTools.tsx`) | Whole row clickable, handle grows on press |
| Toolbar tool | `ToolButton` and `ToolMenu` in `viz/MapTools.tsx` | One tool at a time; menus mutually exclusive via `openMenu`; menus pop **above** the toolbar (`bottom-full`), hover menus for Camera; selected tools show their glyph cut out of the mango mesh (`LitIcon`) |
| Tooltips | `data-tip="..."` attribute (rendered by `viz/TooltipHost.tsx`) | M3 plain tooltip, follows the cursor; **do not** use the native `title=` in new work. Put the *why* in the tip, not a repeat of the label |
| Snackbar | `showSnackbar(text, 'info'\|'success'\|'error')` from `viz/snackbarStore.ts` | For confirmations of actions with no other feedback ("Camera: Site", "Running Plan 1") |
| FAB | `PlanFab` in `features/plans/PlansPanel.tsx`; pattern: white `bg-opal-50` rounded-[20%] square, glyph cut from the mango mesh, `md-pop-fab` entrance | The plus creates a plan; independent of the sidebar |
| Draggable floating panel | `viz/useDraggable.ts`, `viz/FloatingSidebar.tsx`, `MiniMapPanel`, `MeasureCard`, `JplHorizonsCard` | Coral drag bar with the mango mesh, 8-way edge/corner resize, minimise; pointer capture only **after** a drag threshold so clicks inside cards still work; whole-pixel sizes to avoid sub-pixel fringes |
| Loading | `ui/LoadingIndicator.tsx` (M3 morphing shape) | No background pill behind "Loading moon" / "Loading terrain" text |
| Frosted surfaces | `ui/GlassSurface.tsx` (`GlassSurface`, `GlassToolbar`, `GlassDefs`) + `.glass-on` | Used for the Scenario Comparison section bar and demo. Backdrop-filter is **expensive**: few, small surfaces only |
| Mango mesh | `ui/InteractiveGrainGradient.tsx` + `ui/mangoShader.ts` | See section 5 |
| Sliders | `ui/MangoRange.tsx` (flat coral fill now) + `.lp-light input[type=range]` styles | 16 px track, 34 px thumb. The mesh was removed from sliders by request |
| Rover mascot | `ui/RoverMascot.tsx` (+ `roverMascot.css`), `PoofRover` in `features/compare/assistant/MissionAssistant.tsx` | See section 6 |
| Page sections | `features/compare/ui.tsx` `Section`, `features/compare/disclosure.tsx` `Disclosure`, `Tabs`, `TabPanel`, `useReveal` | A section has an `id`, registered in `features/compare/sections.ts` so deep links, the tour and the Rover assistant can find it |
| Badges | `EligibilityBadge`, `ReqIcon`, `ScenarioChip`, `PassHeadroomBadge` / `PassHeadroom` | Status always icon + word |
| Empty / loading / error | `Empty` (compare/ui), `Callout` (ui/primitives), `role="alert"` for errors | Never a blank panel |

If a component you need does not exist, build it **in the matching folder** (`ui/` for generic, `viz/` for planner
floating UI, `features/<area>/` for domain UI), export it, give it the M3 states, and add a test if it has logic.

---

## 4. Layout and information architecture (current, after the sidebar renovation)

### 4.1 Mission Planner (3D view)

Full-screen black Moon. Everything else floats and is `ui-chrome` (hides with "Hide all UI", Esc restores):

- **Top-left:** title, then the info readout (clickable underlined Helvetica **time** that opens the draggable calendar; terrain detail; Sun / Earth state; next events) in white Inter, then the colour key (small, white) for switched-on layers. Camera readout (distance, lat/lon, scale bar, compass) bottom-right.
- **Top-right:** the **minimap** (draggable, text appears on hover), the **sidebar**.
- **Sidebar (deliberately simple):** a draggable, resizable floating panel that holds **only the user's plans** (`PlansPanel`: list, run, edit, tick to compare, "Full assessment in Comparison" link) and **Mission rescue** (`RescuePanel`: inputs + "Find alternatives"). Nothing else belongs here. Anything big, analytical or read-only goes to Scenario Comparison. "Find alternatives" does not render results in the sidebar: it runs the search, imports the original, changed plan and alternatives into the comparison and navigates to `#app/compare/cmp-rescue`.
- **Bottom centre:** the toolbar (M3 floating toolbar): Play/Pause, Play mission, | **Select site** (menu of all sites), Camera (hover menu; click flies there), Top-down, Layers (switches), Drop pin, Measure, Verify with JPL | More (graphics quality, far shadows, dark mode, guided tour, hide all UI). One tool active at a time; menus never overlap.
- **Below the toolbar:** the timeline panel (slides off with a button; a white chevron reappears it; the FAB and toolbar slide in step with it).
- **FAB (+):** new plan, white rounded square with the plus cut from the mango mesh, 32 px above the timeline panel near its right edge, drops to the corner when the panel is hidden.
- **Overlays:** snackbars (bottom), JPL result card, measure card, evidence banner (when "Show why" evidence is active).

### 4.2 Scenario Comparison (page world)

`ComparisonDashboard` = header, scenario strip, a sticky glass section bar (Overview / Evidence / Detailed analysis), then one tab's sections:

- **Overview:** At a glance, decision, **Mission Rescue story** (`cmp-rescue`, target of "Find alternatives"), decision and trade-offs.
- **Evidence:** Key metrics, **Mission assessment** (`cmp-assessment`), sync timeline, ranking/availability/outages.
- **Detailed analysis:** elevation charts, terrain horizon, trade-off analysis, **Science vs engineering** (`cmp-science`), **Data, assumptions and limitations** (`cmp-assumptions`).
- The three analysis blocks live in `features/compare/PlanAnalysis.tsx` and share one **plan picker** (chips with scenario colour + letter) so the user chooses the plan once.
- A footer "Data sources and assumptions" and the Rover launcher ("Ask Rover") complete the page.

**Placing a new feature:** decide the audience and the time of use. *Quick, spatial, "while looking at the Moon"* → toolbar tool or small floating card. *Analytical, read-and-compare, needs width* → a Comparison section. *A persistent user-owned object* (plans) → the sidebar. Never add a new sidebar section without being asked; the user explicitly simplified it.

### 4.3 Landing page

Hero uses a NASA Moon photo (`public/landing/moon.jpg`, credit "Image: NASA", link science.nasa.gov/moon) with the headline "Finding the Right Place. At the Right Time." Then story sections, "Meet Rover" (mascot + CTA that opens the assistant), data credits, team. Landing classes are `lnd-*` in `features/landing/landing.css`. The scroll-film carousel was removed on purpose.

### 4.4 Registering a new Comparison section (checklist)

1. Add `['cmp-yourid', 'Label']` to `COMPARE_SECTIONS` and map it to a tab in `SECTION_TAB` (`features/compare/sections.ts`).
2. Render it with `<Section id="cmp-yourid" ...>` or `<Disclosure id="cmp-yourid" card lazy level={2} ...>` inside the right `TabPanel` in `ComparisonDashboard.tsx`.
3. Navigate to it with `window.location.hash = routeHash('compare', 'cmp-yourid')` (from `appRoute.ts`). The dashboard reveals the tab and block, then keeps the section scrolled into view while results load (up to 40 s, cancelled by any user scroll/click/key).
4. Tests that enumerate sections (`compare.test.tsx`, assistant and tour tests) may need the new id.

---

## 5. The mango mesh (identity texture): usage rules

A WebGL fragment shader (`ui/mangoShader.ts`) draws domain-warped value-noise fbm in peach `#FFB08C` and coral
`#FF634A`, with film grain, slow ambient drift and pointer "liquid" disturbance (coordinate push/swirl). Wrapped by
`<InteractiveGrainGradient fill strength patternScale grain speed maxDpr />`.

**Where it appears** (and only there): drag bars of floating panels, the sidebar bar, the plus of the FAB, lit toolbar
icons, the Rover title bar, the "Ask Rover" launcher text, the minimised-dock handle, the landing "Open the navigator"
button. It was **removed** from the Scenario Comparison page chrome and from sliders on request: do not re-add it
there. Never use it as a large page background and never behind body text.

**Technique for lettering/icons:** cut the glyph out of the mesh with a CSS mask: `maskImage` = an SVG (icons) or a
canvas-drawn PNG (text in Inter; see `useAskMask`), `maskSize: 100% 100%`, over a white `bg-opal-50` button. This is
the "white button, mango glyph" look.

**Rules (hard-won):**
- `fill` makes it `position:absolute; inset:0` of the nearest positioned parent; without it it is `relative` and flows in layout. An inline `position: relative` on the wrapper once collapsed the sidebar bar: use `fill`.
- Each instance owns a WebGL context. Use as few as possible, keep them small, and let the component pause off-screen (IntersectionObserver) and when the tab is hidden. It already throttles to ~15 fps when nothing is near the pointer and caches layout reads: **do not add per-frame `getBoundingClientRect` calls or per-event layout reads**.
- React StrictMode double-mounts: dispose with `loseContext=false` or the second mount falls back to a CSS gradient.
- Reduced motion: a single still frame, no loop, no pointer response. WebGL unavailable: CSS gradient fallback (`MANGO_FALLBACK_CSS`).
- Do not shrink the element on press (`no-press`), or the mesh edge shows as a white hairline.
- Colour chunks: bars and sliders use a larger `patternScale` (0.45) so you see distinct peach/coral regions; small glyphs use the automatic scale.
- A prompt for re-implementing the shader from scratch is in `~/Downloads/codex-prompt-mango-mesh.md` if it was saved; the source of truth is the code.

---

## 6. Rover, the mascot (character UI)

Rover is the AI assistant's face: `ui/RoverMascot.tsx` renders a cropped frame of a baked sprite sheet
(`public/rover-sprites.svg`, `rover-talking.svg`, 505x330) in an `<svg viewBox>`; props `facing`, `size`, `animated`,
`state: 'idle' | 'talking'`. Behaviours already implemented (extend, do not duplicate):
- Random **blink** frames while idle; **talking** frames while the assistant is typing.
- **Eyes follow the cursor** slightly (covers the baked eyes with the face colour and draws moving copies; one rAF per pointer-move batch; stops when settled). Only on the open-eye frame.
- **Click boing:** squash-and-stretch of the inner `<g>` via Web Animations (no layout, no jump).
- 22 sprite units of **headroom** above the sprite so squash/stretch never crops his head; negative margin keeps layout size unchanged.
- `Bounce` (assistant): talking = squash/stretch in place (not a hop).
- `PoofRover` (assistant): stands beside the panel / dock or in the full-screen rail and **pops in/out** (scale+fade, 260 ms delay after the previous one leaves); no smoke (removed on request). Hidden unless there is room; reduced motion just shows/hides.
- "Ask Rover" launcher: white square, mango "Ask Rover" in Inter Light, Rover peeks over the top edge on **hover / keyboard focus-visible only** (not `focus-within`, which kept him out after the panel closed).

Voice: friendly, first person ("Hi, I'm Rover!"), short sentences, no jargon without a gloss. Rover only **explains**: it never changes plans, and says so. The "Rover says..." label (Baby Doll, coral) marks non-AI basic answers; the line below still states the answer was assembled without AI (honesty).

Mission Assistant layouts (`features/compare/assistant/layout.ts`): **side** (docked bottom-right, resizable from left/top/corner, size persisted), **full** (left rail with big Rover, chat centred max-w-3xl), **min** (slim dock). Minimise from full → side; minimise from side → closes back to the Ask Rover button; X closes. Geometry is px-based so layout changes animate. Words appear one by one (~85 ms/word, `paced.ts`) while Rover talks.

---

## 7. Explainability, honesty and attribution (non-negotiable)

1. **Never a bare number.** Show value + unit + threshold + margin + the reason ("Maximum continuous power-darkness 107 h, required <= 50 h, headroom -57 h, Failed"). Prefer the engine's own sentence over writing your own; if you must phrase, keep the number and the *constraint* together.
2. **Missing data is never zero.** Use "unavailable", "No data", "unknown" and a tooltip saying why. A range or bounded value is labelled "(proven range, not an observation)".
3. **Status = icon + word + colour.** Pass / Fail / Undecided / Not configured.
4. **Source on every science number's panel:** NASA JPL Horizons, NASA Moon Trek / LOLA, LROC Quickmap, Gracy & Lee (LPSC 2024). Synthetic/demonstration data is badged and never ranked with real data.
5. **Why it failed** should be visible: blocked by which rim, at what azimuth and distance, which requirement broke, by how much. The "Show why" / "Show in 3D" actions jump the 3D view to the evidence (`viz/evidence.ts`, `EvidenceOrigin` gives the way back).
6. **Do not recompute engine results in the UI.** Display only. Derived presentation (formatting, grouping, sorting) is fine.
7. AI answers are labelled; the assistant is read-only; basic answers say "without AI".
8. Keep a footer/modal that cites the data sources and the model's assumptions and validation accuracy.

---

## 8. Accessibility and input

- Real semantic elements: `button`, `nav aria-label`, `section aria-labelledby`, `role="tablist"/"tab"/"tabpanel"`, `role="switch" aria-checked`, `role="menu"/"menuitemradio" aria-checked`, `role="radiogroup"`, `role="dialog" aria-modal`, `role="status"` for polite updates, `role="alert"` for errors.
- Every icon-only button has `aria-label` **and** a `data-tip`.
- Keyboard: tabs use arrow/Home/End; menus close on Escape; dialogs close on Escape and restore focus (the Ask Rover launcher restores focus after the panel closes); no keyboard traps.
- Contrast: body text >= 4.5:1; white text on the mango mesh gets a subtle text-shadow (`0 1px 3px rgba(0,0,0,.4)`); `ink-4` is for disabled/decorative only.
- Touch: 48 dp targets, hover is progressive enhancement (`@media (hover: hover)`), no information only in hover (tooltips repeat visible labels or are extras).
- Pointer handling: floating panels capture the pointer **after** a ~4 px drag threshold (so clicks on inner buttons still work), then suppress the click that follows a drag (`consumeClick`).
- Respect `prefers-reduced-motion`, `prefers-color-scheme` is not used; dark mode is the in-app toggle.

---

## 9. Performance rules (the 3D view shares the GPU with your UI)

- The R3F canvas uses a **demand frameloop** and logarithmic depth. Never start a continuous `requestAnimationFrame` loop or a perpetual CSS animation on something near the canvas unless it is visible and necessary. Stop loops when settled (Rover's eye tween does).
- Prefer `transform`/`opacity` animations; promote with `will-change` only on elements that animate right now and remove it afterwards.
- `backdrop-filter` (glass) is costly: keep surfaces few and modest in area; the SVG refraction (`data-refract`) is Chromium-only and optional.
- Cache layout reads; batch pointer-move work into one rAF; use `passive` listeners; clean up in effect returns (StrictMode runs effects twice in dev).
- Lazy-load heavy views (`lazy` Disclosure, `React.lazy` for Landing/Atlas). Do not put large data in zustand selectors that re-render the whole page; select the smallest slice.
- WebGL contexts are limited (~16): the mango mesh must not be instanced in lists.
- Do not read from the DOM in render. Use refs and effects.

---

## 10. Code conventions

- File homes: generic UI `frontend/src/ui/`, planner floating UI `frontend/src/viz/`, features `frontend/src/features/<area>/`, tokens `index.css` + `ui/tokens.ts` (keep in sync; a test checks).
- **Tailwind v4:** utilities live in a cascade layer, so **un-layered CSS beats utilities**. A rule like `.glass-on { position: relative }` or a `transition` shorthand in `index.css` overrides `absolute`/`transition-*` classes: guard it (`:not(.absolute)`) or use a dedicated class. Inline `style={{ position }}` also beats classes.
- Hooks: never call a hook conditionally (`a && useB()` crashed the comparison page once). Call hooks unconditionally and combine results.
- State: zustand stores per feature (`useAppStore`, `useCompareStore`, `useRescueStore`, `usePlansStore`, `useAssistantLayout`, `useUiPrefs`, `useCompareView`, `useReveal`, `useEvidence`, `useAssessmentStore`). The timeline cursor/time (`useAppStore`) is shared across modules. Persist only what is a preference (size, dark mode).
- TypeScript strict; `noUnusedLocals` is on, so remove dead imports. No `any` without a reason. Match the existing naming (`md-*` for Material pieces, `cmp-*` comparison, `lnd-*` landing, `cmp-ai-*` assistant).
- Small components, pure formatting helpers in `.ts` files with unit tests, side-effects in hooks.
- Copy: sentence case, plain English, active voice, specific verbs ("Find alternatives", "Compare (3)"), UTC stated, no em dashes in new copy (the team replaced them with hyphens), no emoji.
- Comments explain *why* and the constraint, not what the line does.
- Hash routes: `#app/planner`, `#app/compare[/section]`, `#app/atlas`, `#app/method`, `#mango`, `#glass` (previews). Use `goToView` / `routeHash`.

---

## 11. Process: how to deliver a UI change

1. **Understand the request in product terms.** Which world (A/B)? Which audience? Is it a move (feature relocation), a restyle or a new feature? State assumptions in your reply when the request is ambiguous; if two readings differ greatly, ask once.
2. **Read before writing.** Open the files you will touch and the nearest existing example of the pattern (menus: `MapTools.tsx`; fields: `MdFields.tsx`; page sections: `ComparisonDashboard.tsx`). Reuse; extend; avoid parallel implementations. Search for tests and tour steps referencing what you change (`grep` `data-tour`, text strings, ids).
3. **Design with tokens.** Use the palette, spacing grid, M3 states, motion tokens. If it feels unlike its neighbours, you are probably inventing.
4. **Implement small, type-check often:** `cd frontend && npx tsc -b`.
5. **Tests:** `npx vitest run` (the suite is ~60+ files / ~680 tests and should stay green). Update tests that assert moved text or ids; add tests for new logic. Do not delete a test to make it pass unless the behaviour was intentionally removed and you say so.
6. **Verify in a real browser.** Backend must run on port 8000 (`uvicorn app.main:app --port 8000` from `backend/`); start the frontend on a free port (e.g. via a temporary `.claude/launch.json` and `preview_start`, or `npm run dev -- --port 5199`). Check: the happy path, hover/focus/pressed states, keyboard, narrow width (resize to 375 px), dark mode (planner), reduced motion (`prefers-reduced-motion`), the empty/loading/error states, console errors. Screenshots can time out in a hidden pane: fall back to `get_page_text` / DOM queries (`getBoundingClientRect`, computed styles). Remove temporary files (`.claude/launch.json`) and stop servers when done.
7. **Report honestly:** what changed (files), what you verified and how, what you could not verify (animations in a paused pane, hover-only effects), and anything the user must decide (licences, product trade-offs). Do not claim "done and verified" for what you did not see.
8. Do not commit or push unless asked. When merging, resolve conflicts by keeping both sides' intent and re-running tsc + vitest (a teammate's new dependency may need `npm install`).

---

## 12. Mistakes already made once (do not repeat)

| Symptom | Cause | Fix / rule |
|---|---|---|
| Blank dark page, hook-order error | Conditional hook call | Call hooks unconditionally |
| Mango mesh turned into a flat CSS gradient | StrictMode disposed the WebGL context with `loseContext` | `dispose(loseContext=false)` |
| Sidebar bar collapsed to zero height | Inline `position: relative` overrode `absolute` | Use the `fill` prop |
| White hairlines at the edges of the drag bar | Press `scale(.98)` + fractional px sizes | `no-press`, integer sizes, `-mx-px` |
| Absolute-positioned glass panel became static | `.glass-on { position: relative }` unlayered CSS beat Tailwind | `:not(.absolute)` guard |
| Clicks inside a draggable card died | Pointer capture at pointerdown | Capture only after the drag threshold |
| Flag never displayed | Hidden flag initial state | Initialise to `'off'`, derive from line-of-sight |
| Laggy flag occlusion | Per-frame raycasts | Height-field line of sight + per-column bisection + clip-path polygon |
| Rover's head cropped when squashing | Sprite viewBox had 5 px headroom | 22 units of headroom + negative margin |
| Rover stayed out after the panel closed | `:focus-within` kept the peek open after focus was restored | `:has(button:focus-visible)` + hover only |
| Deep link scrolled to the wrong place | Page grew above the target after results loaded; resize observer missed it | Poll `scrollToSection` for up to 40 s, cancelled by user input |
| Dense bash heredocs with apostrophes failed | Shell quoting | Write scripts to a file (scratchpad) and run them, or use the Write tool |
| Pasted `rm -rf ./*` blocked | Destructive and unnecessary | Never mass-delete; extract archives into new dirs |
| Typecheck failed after pull | Teammate added a dependency | `npm install` in `frontend/` |

---

## 13. Quality bar checklist (copy into your final report)

- [ ] Uses existing components/tokens; no new colours, fonts or dependencies.
- [ ] M3 states (hover 8 / focus 10 / press 10), 40 dp controls, 8 dp grid, 48 dp targets.
- [ ] Enter = emph-decel, exit = emph-accel and shorter; only transform/opacity; shared timing for companions.
- [ ] Reduced motion handled; no perpetual loops near the 3D canvas.
- [ ] Light and dark (planner) both checked; narrow width checked.
- [ ] Every number has unit, threshold/margin and source; missing data is "unavailable"; status = icon + word.
- [ ] Keyboard path works; roles/labels correct; icon buttons have `aria-label` + `data-tip`.
- [ ] Empty, loading and error states exist.
- [ ] Moved features are reachable; deep links, tour steps and tests updated.
- [ ] `npx tsc -b` clean; `npx vitest run` green; browser-verified; console clean.
- [ ] Backend and 3D logic untouched; temp files and servers cleaned up.
- [ ] Anything unverified or licence-sensitive is stated plainly in the report.

---

## 14. Quick reference: where things are

```
frontend/src/index.css                 tokens (@theme), .lp-light remaps, M3 motion vars, md-* components, glass, dark mode
frontend/src/ui/                       MdFields, GlassSurface, InteractiveGrainGradient, mangoShader, MangoRange, LoadingIndicator,
                                       RoverMascot (+css), primitives, icons, tokens
frontend/src/viz/                      Scene, MapTools (toolbar + menus), ViewerHud (info readout + site menu rows), TimeBar, DatePopup,
                                       MiniMapPanel, FloatingSidebar, useDraggable, RoverFlag, TooltipHost, Snackbar, uiPrefs, evidence
frontend/src/features/plans/           PlansPanel (+ FAB, dialogs), usePlansStore
frontend/src/features/rescue/          RescuePanel, MissionRescue, CompromisePanel, store (sidebar = plans + rescue only)
frontend/src/features/assessment/      AssessmentPanel, MissionAssessment (evidence banner), store, logic
frontend/src/features/compare/         ComparisonDashboard, sections.ts, PlanAnalysis, RescueStory/RescueImport, assistant/ (Rover panel), tour/
frontend/src/features/landing/         Landing + landing.css + content.ts
frontend/public/                       rover-sprites.svg, rover-talking.svg, fonts/BabyDoll.ttf, landing/moon.jpg
docs/design-system.md                  older dark-token rules (partly historical, see section 1)
docs/frontend-design-audit.md          earlier audit
CLAUDE.md                              judging criteria and submission requirements (read first)
```

References: Material Design 3 https://m3.material.io (Styles > Motion, Spacing, Color, Typography; Components > Buttons, FAB,
Switch, Text fields, Date pickers, Menus, Snackbar, Tooltips, Loading indicator, Toolbars) · WCAG 2.2 AA · NASA science.nasa.gov/moon ·
NASA JPL Horizons · NASA Moon Trek / LOLA · LROC Quickmap.
