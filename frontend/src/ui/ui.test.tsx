// Design-system primitives: missing data is never shown as zero, status is never colour-only.
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  Callout,
  DataSourceBadge,
  Segmented,
  Stat,
  StatusBadge,
  UNAVAILABLE,
  Value,
  buttonClass,
  color,
} from '.'

describe('Value', () => {
  it('renders unavailable data as an em dash, not 0', () => {
    for (const v of [null, undefined, Number.NaN]) {
      const html = renderToString(<Value value={v} unit="h" unavailableReason="No terrain data" />)
      expect(html).toContain(UNAVAILABLE)
      expect(html).toContain('No terrain data')
      expect(html).not.toContain('>0')
    }
  })

  it('renders a real zero as zero, with its unit', () => {
    const html = renderToString(<Value value={0} unit="h" digits={0} />)
    expect(html).toContain('0')
    expect(html).toContain('h')
    expect(html).not.toContain(`>${UNAVAILABLE}<`)
  })
})

describe('status', () => {
  it('always pairs status colour with an icon and a word', () => {
    const html = renderToString(<StatusBadge status="crit">Fails</StatusBadge>)
    expect(html).toContain('<svg')
    expect(html).toContain('Fails')
    expect(html).toContain('text-crit')
  })

  it('labels data provenance', () => {
    expect(renderToString(<DataSourceBadge source="real" />)).toContain('Horizons + LOLA')
    expect(renderToString(<DataSourceBadge source="demonstration" />)).toContain('Demonstration data')
    expect(renderToString(<DataSourceBadge source="unavailable" />)).toContain('No data')
  })

  it('marks warning and critical callouts as alerts', () => {
    expect(renderToString(<Callout status="warn">x</Callout>)).toContain('role="alert"')
    expect(renderToString(<Callout status="info">x</Callout>)).not.toContain('role="alert"')
  })

  it('Stat shows label, value and status icon', () => {
    const html = renderToString(<Stat label="Longest blackout" status="warn">124 h</Stat>)
    expect(html).toContain('Longest blackout')
    expect(html).toContain('124 h')
    expect(html).toContain('<svg')
  })
})

describe('controls', () => {
  it('Segmented exposes radio semantics', () => {
    const html = renderToString(
      <Segmented label="Align" value="met" onChange={() => {}} options={[{ value: 'met', label: 'Mission time' }, { value: 'utc', label: 'UTC' }]} />,
    )
    expect(html).toContain('role="radiogroup"')
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('aria-checked="false"')
  })

  it('button variants share one base style', () => {
    expect(buttonClass('primary')).toContain('bg-accent')
    expect(buttonClass('secondary', 'md')).toContain('h-8')
  })
})

describe('tokens', () => {
  it('JS tokens match the CSS @theme values', async () => {
    // Read the file directly: Vitest does not process CSS. (Node module typed loosely: the app tsconfig has no Node types.)
    const nodeFs = 'node:fs'
    const fs = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync: (p: URL, enc: string) => string }
    const css = fs.readFileSync(new URL('../index.css', import.meta.url), 'utf8')
    const pairs: [string, string][] = [
      ['canvas', color.canvas], ['surface', color.surface], ['line', color.line], ['ink', color.ink],
      ['ink-3', color.ink3], ['accent', color.accent], ['ok', color.ok], ['warn', color.warn], ['crit', color.crit],
      ['sun', color.sun], ['earth', color.earth], ['night', color.night], ['blackout', color.blackout],
    ]
    for (const [name, hex] of pairs) expect(css).toContain(`--color-${name}: ${hex};`)
  })
})
