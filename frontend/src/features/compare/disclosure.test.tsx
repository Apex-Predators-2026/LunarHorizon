// Progressive disclosure: collapsed content is hidden but never removed, state is announced, and a deep link /
// tour / assistant can ask for a block to be opened. Rendered on the server (no DOM test environment here); the
// click, keyboard and reveal behaviour in a real browser is covered by the browser verification of these pages.
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { appRoute } from './sectionsTestHelpers'
import { Disclosure, TabPanel, Tabs, useReveal } from './disclosure'
import { COMPARE_SECTIONS, COMPARE_TABS, SECTION_TAB, TAB_ENTRY, tabOfSection, type CompareTab } from './sections'
import { TUTORIAL_STEPS } from '../tutorial/steps'

const html = (node: React.ReactElement) => renderToString(node).replace(/<!-- -->/g, '')

describe('Disclosure', () => {
  it('is closed by default, announces it, and keeps its content in the page', () => {
    const h = html(<Disclosure id="x" title="Details">Hidden evidence</Disclosure>)
    expect(h).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-controls="x-body"/)
    expect(h).toMatch(/id="x-body"[^>]*hidden/)
    expect(h).toContain('Hidden evidence') // collapsed, not deleted: reachable by find-in-page, print and deep links
  })

  it('opens when asked to by default, and shows its summary next to the title either way', () => {
    const h = html(<Disclosure id="y" defaultOpen title="Open one" summary="what is inside">Body</Disclosure>)
    expect(h).toMatch(/aria-expanded="true"/)
    expect(h).not.toMatch(/id="y-body"[^>]*hidden/)
    expect(h).toContain('what is inside')
  })

  it('defers heavy content until it has been opened when lazy, then never again', () => {
    expect(html(<Disclosure id="z" lazy title="Chart">CHART</Disclosure>)).not.toContain('CHART')
    expect(html(<Disclosure id="z" lazy defaultOpen title="Chart">CHART</Disclosure>)).toContain('CHART')
  })

  it('lets a deep link open it: each request is a new count, so asking twice still works', () => {
    const { reveal } = useReveal.getState()
    const before = useReveal.getState().requests['cmp-summary'] ?? 0
    reveal('cmp-summary')
    reveal('cmp-summary')
    expect(useReveal.getState().requests['cmp-summary']).toBe(before + 2)
  })
})

describe('Tabs', () => {
  const tabs = [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] as const
  it('marks the selected tab, with a roving tabindex and the tab/panel links', () => {
    const h = html(<Tabs base="t" label="Views" tabs={tabs} value="b" onChange={() => {}} />)
    expect(h).toContain('role="tablist"')
    expect(h).toMatch(/id="t-tab-b"[^>]*aria-selected="true"[^>]*aria-controls="t-panel-b"[^>]*tabindex="0"/)
    expect(h).toMatch(/id="t-tab-a"[^>]*aria-selected="false"[^>]*tabindex="-1"/)
  })

  it('mounts a view when it is first opened, and hides the others', () => {
    const h = html(<><TabPanel base="t" id="a" value="a">ALPHA</TabPanel><TabPanel base="t" id="b" value="a">BETA</TabPanel></>)
    expect(h).toContain('ALPHA')
    expect(h).not.toContain('BETA') // not yet opened: nothing measured or fetched for it
    expect(h).toMatch(/id="t-panel-b"[^>]*hidden/)
    expect(h).toMatch(/id="t-panel-a"(?![^>]*hidden)/)
  })
})

describe('comparison views and deep links', () => {
  it('puts every section in a view, except the scenario strip that sits above them', () => {
    for (const [id] of COMPARE_SECTIONS) {
      if (id === 'cmp-scenarios') expect(SECTION_TAB[id]).toBeNull()
      else expect(COMPARE_TABS.map((t) => t.id)).toContain(SECTION_TAB[id])
    }
  })

  it('knows which view a section is in (so a deep link opens it before scrolling), and ignores unknown ids', () => {
    expect(tabOfSection('cmp-metrics')).toBe('evidence')
    expect(tabOfSection('cmp-terrain')).toBe('detail')
    expect(tabOfSection('cmp-summary')).toBe('overview')
    expect(tabOfSection('cmp-nope')).toBeNull()
    expect(tabOfSection(null)).toBeNull()
  })

  it('remembers each view in the URL by a section that really is in that view, and every such URL parses', () => {
    for (const t of COMPARE_TABS) {
      const entry = TAB_ENTRY[t.id as CompareTab]
      if (entry) expect(SECTION_TAB[entry]).toBe(t.id)
      expect(appRoute(entry).section).toBe(entry)
    }
  })

  it('has a tour that only reveals sections that exist', () => {
    for (const s of TUTORIAL_STEPS) if (s.reveal) expect(COMPARE_SECTIONS.map(([id]) => id)).toContain(s.reveal)
  })
})
