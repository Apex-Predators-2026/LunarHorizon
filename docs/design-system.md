# Design system

A restrained, flight-software look: dark layered surfaces, thin lines, small precise labels, one
interaction accent, and colours that always mean the same thing. No new dependencies — it is
Tailwind 4 theme tokens plus a few React primitives.

| What | Where |
|---|---|
| Tokens (CSS) | `frontend/src/index.css` (`@theme` block) → Tailwind utilities |
| Tokens (JS, for SVG / Recharts / three.js) | `frontend/src/ui/tokens.ts` — keep in sync (a test checks) |
| Primitives | `frontend/src/ui/primitives.tsx`, `frontend/src/ui/classes.ts` |
| Icons | `frontend/src/ui/icons.tsx` (inline SVG, `currentColor`) |

Import from `src/ui` (`import { Panel, Stat, StatusBadge } from '../../ui'`).

## Colour

| Role | Token | Use |
|---|---|---|
| Canvas / surface / raised / inset | `canvas`, `surface`, `raised`, `inset` | Page background → panels → hovered/selected rows → inputs and wells |
| Lines | `line`, `line-strong` | Panel borders and dividers; control borders |
| Text | `ink`, `ink-2`, `ink-3`, `ink-4` | Primary values → body text → labels and axes → disabled only |
| Accent | `accent`, `accent-strong` | Navigation, focus, active selection. **Never** for data |
| Status | `ok`, `warn`, `crit`, `unknown` | Requirement met / caution or demonstration data / violation / unavailable. Always with an icon and a word |
| Data | `sun`, `earth`, `night`, `blackout` | Sunlight, Earth visibility, darkness, communication blackout — same meaning in every chart, timeline and overlay |
| Scenarios | `series[0..3]` + `seriesDash` | Scenario A–D identity, always with the letter and dash pattern |

All text tokens except `ink-4` reach WCAG AA (≥ 4.5:1) on `canvas`, `surface` and `raised`.

## Type, spacing, shape

- System fonts only. `font-mono` for timestamps; the `nums` utility for tabular figures.
- Sizes: `text-micro` 10 · `text-label` 11 · `text-body` 13 · `text-title` 14 · `text-heading` 18 ·
  `text-figure` 22 (headline numbers).
- 4 px spacing grid (Tailwind's default scale).
- Corners: `rounded-control` 3 px, `rounded-panel` 4 px. No pills except switches.
- Borders: 1 px. Shadows: none, except the accent underline on a selected segment.
- No gradients, glass effects or decorative animation; motion is disabled under `prefers-reduced-motion`.

## Primitives

| Component | Purpose |
|---|---|
| `Panel` | Bordered surface with a compact header (title, meta, actions) |
| `Label` | Small uppercase label |
| `Value` | Number + unit; `null` renders `—` with a tooltip, never `0` |
| `Stat` | Label + headline value (+ status icon, note) |
| `StatusBadge` | Icon + word in a status colour |
| `DataSourceBadge` | `real` / `demonstration` / `unavailable` provenance |
| `Callout` | Inline info / warning / error message (warnings are `role="alert"`) |
| `Button`, `buttonClass` | `primary`, `secondary`, `ghost`, `danger`; sizes `sm`, `md` |
| `Field`, `inputClass` | Labelled inputs and selects |
| `Segmented` | Exclusive options (radio group) |
| `Toggle` | Labelled on/off switch |

## Rules

1. Missing data is shown as unavailable (`—`, "No data", "unknown"), never as zero.
2. Status is never colour alone.
3. Every number that comes from science data shows its source somewhere on the same panel.
4. Every visible control does something.
