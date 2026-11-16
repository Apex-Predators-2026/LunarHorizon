// The Atlas while its site list is still loading: a visible loading state, never an empty picker that looks broken
// or a "No map yet" prompt the user cannot act on yet.
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { AtlasView } from './AtlasView'

describe('Atlas while the sites load', () => {
  const html = renderToString(<AtlasView />)

  it('shows a loading indicator for the landing sites', () => {
    expect(html).toContain('Loading the landing sites…')
    expect(html).toMatch(/role="status"[^>]*>.*Loading the landing sites/)
  })

  it('says the site picker is loading instead of leaving it empty, and shows no premature prompt or retry', () => {
    expect(html).toContain('Loading sites…')
    expect(html).toMatch(/<select[^>]*aria-busy="true"/)
    expect(html).not.toContain('No map yet')
    expect(html).not.toContain('Retry')
  })
})
