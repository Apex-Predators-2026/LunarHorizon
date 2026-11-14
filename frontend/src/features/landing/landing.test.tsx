// Landing page tests: the page renders its content without a browser and the live-conditions wording is right.
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { DATA_SOURCES, HERO, PICTURES } from './content'
import Landing from './Landing'
import { currentHourIso, describeEarth, describeSun, untilText } from './liveFormat'

describe('landing page', () => {
  it('renders one h1, the opening Moon picture, the app pictures and the NASA sources', () => {
    const html = renderToString(<Landing onOpen={() => {}} />)
    expect(html).toContain(HERO.headline)
    expect(html.match(/<h1/g)).toHaveLength(1)
    expect(html).toContain('/landing/moon.jpg')
    expect(html).toContain(HERO.lead)
    for (const p of PICTURES) expect(html).toContain(p.src)
    for (const s of DATA_SOURCES) expect(html).toContain(s.name)
    expect(html).toContain('Open the navigator')
  })
})

describe('live conditions wording', () => {
  it('asks the API for the current whole UTC hour', () => {
    expect(currentHourIso(new Date('2026-11-14T16:42:10Z'))).toBe('2026-11-14T16:00:00Z')
  })

  it('describes the Sun above, partly behind and below the terrain', () => {
    expect(describeSun({ elevation_deg: 1.545, horizon_deg: -1.9, visible: true, visible_fraction: 1 })).toBe('1.5° above the horizon')
    expect(describeSun({ elevation_deg: 0.4, horizon_deg: 0.3, visible: true, visible_fraction: 0.42 })).toBe(
      '0.4° above the horizon · 42% of the disk',
    )
    expect(describeSun({ elevation_deg: 1.2, horizon_deg: 2, visible: false, visible_fraction: 0 })).toBe('Hidden behind terrain')
    expect(describeSun({ elevation_deg: -0.8, horizon_deg: -1, visible: false, visible_fraction: 0 })).toBe('Below the horizon by 0.8°')
  })

  it('describes Earth by its margin over the terrain', () => {
    expect(describeEarth({ elevation_deg: -4.3, visible: false, margin_deg: -4.297 })).toBe('Out of view, 4.3° below the terrain')
    expect(describeEarth({ elevation_deg: 3, visible: true, margin_deg: 2.43 })).toBe('In view, 2.4° above the terrain')
  })

  it('says how long until the next event', () => {
    const now = new Date('2026-11-14T16:00:00Z')
    expect(untilText('2026-11-28T02:00Z', now)).toBe('in 13 days')
    expect(untilText('2026-11-15T02:00Z', now)).toBe('in 10 h')
    expect(untilText(null, now)).toBe('not in the data')
  })
})
