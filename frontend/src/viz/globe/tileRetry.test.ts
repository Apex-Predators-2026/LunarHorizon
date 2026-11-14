import { describe, expect, it } from 'vitest'
import { MAX_TILE_ATTEMPTS, retryDelayMs } from './tileRetry'

describe('tile retries', () => {
  it('back off 1, 2, 4, 8 ... s, never more than 30 s apart', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(retryDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
  })

  it('give up only after more than a minute of attempts', () => {
    let total = 0
    for (let f = 1; f < MAX_TILE_ATTEMPTS; f++) total += retryDelayMs(f)
    expect(total).toBeGreaterThan(60_000)
  })
})
