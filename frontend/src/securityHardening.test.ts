import { afterEach, describe, expect, it, vi } from 'vitest'

describe('split-origin VITE_API_URL consistency', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('methodology API fetches respect VITE_API_URL for split-origin deployments', async () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.xyz')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ summary: {} }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { fetchValidation, fetchViabilityValidation } = await import('./features/methodology/api')
    await fetchValidation()
    await fetchViabilityValidation()

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://api.example.xyz/api/validation', { signal: undefined })
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://api.example.xyz/api/viability/validation-summary', { signal: undefined })
  })

  it('landing LiveNow fetchStatus respects VITE_API_URL', async () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.xyz')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sun: {}, earth: {} }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { fetchStatus } = await import('./features/landing/LiveNow')
    await fetchStatus('connecting-ridge', '2026-11-15T20:00:00Z')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.xyz/api/sites/connecting-ridge/status?time=2026-11-15T20%3A00%3A00Z',
    )
  })
})
