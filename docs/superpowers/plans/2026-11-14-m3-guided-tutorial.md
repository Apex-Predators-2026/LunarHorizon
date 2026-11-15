# M3 Guided Mission Briefing Tutorial Implementation Plan

> **For agentic workers:** Executing autonomously via TDD (`test-driven-development`), M3 UI conventions (`.agents/rules/m3-ui-conventions.md`), and Playwright visual verification (`webapp-testing`).

**Goal:** Build an interactive, attention-holding 8-step **Guided Mission Briefing Tutorial** for Lunar Landing Site Navigator (`frontend/`) using Material Design 3 tokens (`.lp-light` / `.lp-dark`, Opaline surfaces, Coral `#ff634a`, `InteractiveGrainGradient`, `.md-btn` / `.md-compact` pills, `.md-dialog-in` / `.md-reveal` / `.md-pop`, subtle `sfx.ts` taps, `prefers-reduced-motion`).

**Architecture:**
- **`frontend/src/features/tutorial/steps.ts`**: Defines the 8 interactive Mission Briefing stops matching all core software features:
  1. `site-selection` — Mission & Site Selection (`[data-tour="site-select"]`, also accepts `orbit-3d` / `site-select` / `drop-pin` action triggers)
  2. `camera-views` — Camera & Eye Views (`[data-tour="camera-menu"]` or `[data-tour="top-down"]`)
  3. `solar-timeline` — Time & Solar Shadow Simulation (`[data-tour="time-bar"]`)
  4. `sky-obstructions` — Sky Plot & Terrain Obstructions (`[data-tour="minimap-panel"]` — auto-switches to Sky tab)
  5. `traverse-measure` — Traverse, Slope & Relay LOS (`[data-tour="measure-tool"]`)
  6. `jpl-verify` — Live NASA Ephemeris Verification (`[data-tour="jpl-verify"]`)
  7. `viability-rescue` — Viability & Mission Rescue (`[data-tour="mission-rescue"]`)
  8. `plans-compare` — Saved Plans, Playback & Multi-Scenario Compare (`[data-tour="plan-fab"]` / `[data-tour="plans-panel"]` / `[data-tour="compare-dashboard"]`)
- **`frontend/src/features/tutorial/useTutorialStore.ts`**: Zustand store managing `open`, `stepIndex`, `actionDone`, `offerDismissed`, `dontShowAgain`, `completed`, `requestedAppView`, `requestedMiniMapTab`, `requestedMeasureArm`, `requestedSidebarOpen`, `requestedBarVisible`. Persists `"lunar-tutorial-prefs"` in `localStorage` safely. Supports `?tour=1` query param auto-launch and `recordInteraction(key)` for live "Try it" auto-advance!
- **`frontend/src/features/tutorial/TutorialSpotlight.tsx`**: Measures active `[data-tour="..."]` target via `ResizeObserver`, scroll, and window resize listeners; renders translucent dark scrim with SVG/clip cutout (`pointer-events: none` over cutout so the user interacts directly with live controls!), Coral glowing target ring, and smart viewport-clamped floating M3 coachmark card (`.lp-light`, Opaline `--color-opal-50`/`--color-opal-100`, Coral `InteractiveGrainGradient` progress bar + accent badge, `1/8` counter, "Why it matters", "Try it" live trigger badge that pulses until interacted, Back / Next / Skip buttons, `Esc` / `ArrowLeft` / `ArrowRight` shortcuts, respects `[data-ui-hidden='true']` and `prefers-reduced-motion`).
- **`frontend/src/features/tutorial/TutorialOfferChip.tsx`**: Non-blocking first-visit M3 pill card inside `#app` ("New to Lunar Site Navigator? Take a 90s interactive mission briefing", Start Tour / Dismiss / Don't show again). Hidden automatically if tour is open, completed, dismissed, or `[data-ui-hidden='true']`.
- **Wiring & Integration**:
  - `App.tsx`: Renders `TutorialOfferChip` + `TutorialSpotlight`, checks `?tour=1` on mount, syncs `view` (`planner` vs `compare`) when `requestedAppView` changes during tour, exposes `data-tour="nav-compare"`.
  - `Scene.tsx`: Opens `barHidden = false` on Step 3 (`solar-timeline`), reports `orbit-3d` interaction lightly on canvas pointer up if needed, passes `data-tour` to TimeBar/PlanFab wrappers.
  - `FloatingSidebar.tsx`, `MiniMapPanel.tsx`, `MapTools.tsx`, `ViewerHud.tsx`, `TimeBar.tsx`, `PlansPanel.tsx`, `MissionRescue.tsx`, `ComparisonDashboard.tsx`: Lightweight `data-tour` attributes, `"Guided Tour"` item inside `MapTools` `More` menu, and `recordInteraction(...)` calls on real user actions without altering `demo-tour.mjs` selectors.

**Verification:**
1. TDD unit/component tests in `frontend/src/features/tutorial/tutorial.test.tsx`.
2. `npm --prefix frontend run build`, `npm --prefix frontend run lint`, and `npx --prefix frontend vitest run`.
3. Playwright browser verification against `http://localhost:5173/#app` at `1366x768` and `1920x1080` in both light and `.lp-dark` modes across all 8 steps + `?tour=1` + `More` -> `Guided Tour`, inspecting screenshots for contrast and zero viewport clipping.
