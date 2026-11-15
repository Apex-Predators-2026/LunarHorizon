// Failed API calls become readable sentences (the Drop pin snackbar shows this text verbatim).
import { describe, expect, it } from 'vitest'

import { apiErrorMessage } from './api'

describe('apiErrorMessage', () => {
  it('keeps the backend sentence for our own errors (offline, missing ephemeris library, outages)', () => {
    const detail = "Custom sites can't be analysed right now. The local ephemeris library (skyfield) is not installed on the backend."
    expect(apiErrorMessage(503, 'Service Unavailable', { detail })).toBe(detail)
  })

  it('turns a FastAPI validation list into field: message pairs, not raw JSON', () => {
    const body = {
      detail: [
        { type: 'greater_than_equal', loc: ['body', 'lat'], msg: 'Input should be greater than or equal to -90', input: -95 },
        { type: 'missing', loc: ['body', 'lon'], msg: 'Field required' },
      ],
    }
    const text = apiErrorMessage(422, 'Unprocessable Content', body)
    expect(text).toBe('lat: Input should be greater than or equal to -90; lon: Field required')
    expect(text).not.toContain('{')
  })

  it('falls back to the status line with its code when the body says nothing useful', () => {
    expect(apiErrorMessage(500, 'Internal Server Error', null)).toBe('Internal Server Error (HTTP 500)')
    expect(apiErrorMessage(502, '', { detail: '' })).toBe('Request failed (HTTP 502)')
    expect(apiErrorMessage(422, 'Unprocessable Content', { detail: [{}] })).toBe('Unprocessable Content (HTTP 422)')
  })
})
