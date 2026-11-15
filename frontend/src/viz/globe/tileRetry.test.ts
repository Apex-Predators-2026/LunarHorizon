import { describe, expect, it } from 'vitest'
import { retryDelayMs, STALE_REQUEST_MS, TILE_TIMEOUT_MS } from './tileRetry'

describe('tile retries', () => {
  it('back off 1, 2, 4, 8 ... s, never more than 30 s apart', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(retryDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
  })

  it('keep retrying every 30 s however many attempts failed (no permanent give-up)', () => {
    expect(retryDelayMs(50)).toBe(30_000)
    expect(retryDelayMs(1000)).toBe(30_000)
  })

  it('cancel unwanted downloads well before they would time out', () => {
    expect(STALE_REQUEST_MS).toBeLessThan(TILE_TIMEOUT_MS / 10)
  })
})
