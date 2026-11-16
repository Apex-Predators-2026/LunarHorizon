import { describe, expect, it } from 'vitest'
import { sitesRetryDelayMs } from './sitesRetry'

describe('sitesRetryDelayMs', () => {
  it('backs off from 2 s and is capped at 30 s', () => {
    expect([0, 1, 2, 3, 4, 10].map(sitesRetryDelayMs)).toEqual([2000, 4000, 8000, 16000, 30000, 30000])
  })
})
