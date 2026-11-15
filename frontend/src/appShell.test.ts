// Design-spec guards for the app shell that a server render cannot see (the views need a browser and WebGL).
import { describe, expect, it } from 'vitest'

async function source(path: string): Promise<string> {
  // Node module typed loosely: the app tsconfig has no Node types (same approach as ui.test.tsx).
  const nodeFs = 'node:fs'
  const fs = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync: (p: URL, enc: string) => string }
  return fs.readFileSync(new URL(path, import.meta.url), 'utf8')
}

describe('tooltips', () => {
  it('mounts the data-tip host once at app level, so Comparison, Atlas and Methodology tips render', async () => {
    const app = await source('./App.tsx')
    const scene = await source('./viz/Scene.tsx')
    expect(app).toMatch(/<TooltipHost \/>/)
    // A second host inside the 3D view would show every planner tip twice.
    expect(scene).not.toMatch(/<TooltipHost/)
  })
})

describe('M3 fields', () => {
  it('the Drop pin coordinate form uses the shared outlined TextField, not raw inputs', async () => {
    const tools = await source('./viz/MapTools.tsx')
    const form = tools.slice(tools.indexOf('function CoordinateForm'), tools.indexOf('export function MapTools'))
    expect(form).toContain('<TextField')
    expect(form).not.toMatch(/<input\b/)
  })

  it('a field on a non-default surface can set the floating label background from its container', async () => {
    const css = await source('./index.css')
    expect(css).toContain('--md-field-bg: var(--md-field-surface, #e8e8e8);')
    expect(css).toContain('--md-field-bg: var(--md-field-surface, var(--color-opal-100));')
  })
})
