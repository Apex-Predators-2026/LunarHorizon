// Landing page tests: the page renders its content without a browser, the live-conditions wording is right,
// and the scroll film's beats cover the whole film in order.
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { BEATS, DATA_SOURCES, HERO, NAV_BEATS, PICTURES } from './content'
import Landing from './Landing'
import { currentHourIso, describeEarth, describeSun, untilText } from './liveFormat'
import { beatAt, beatJumpT, beatT } from './storyRender'

describe('landing page', () => {
  it('renders one h1, every beat, the app pictures and the NASA sources', () => {
    const html = renderToString(<Landing onOpen={() => {}} />)
    expect(html).toContain(HERO.headline)
    expect(html.match(/<h1/g)).toHaveLength(1)
    for (const b of BEATS.slice(1)) expect(html).toContain(b.title)
    for (const p of PICTURES) expect(html).toContain(p.src)
    for (const s of DATA_SOURCES) expect(html).toContain(s.name)
    expect(html).toContain('Open the navigator')
  })

  it('links every beat to a picture and the header to real beats', () => {
    const ids = new Set(PICTURES.map((p) => p.id))
    for (const b of BEATS) expect(ids.has(b.picture)).toBe(true)
    for (const id of NAV_BEATS) expect(BEATS.some((b) => b.id === id)).toBe(true)
  })
})

describe('scroll film beats', () => {
  it('cover the film from 0 to 1 without gaps, in order', () => {
    expect(BEATS[0].start).toBe(0)
    expect(BEATS[BEATS.length - 1].end).toBe(1)
    BEATS.slice(1).forEach((b, i) => expect(b.start).toBe(BEATS[i].end))
  })

  it('finds the beat at a position and lands links inside their beat', () => {
    BEATS.forEach((b, i) => {
      expect(beatAt(beatJumpT(i))).toBe(i)
      expect(beatT(b.end, b.id)).toBe(1)
      expect(beatT(b.start, b.id)).toBe(0)
    })
    expect(beatAt(1)).toBe(BEATS.length - 1)
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
