import { afterEach, describe, expect, it, vi } from 'vitest'
import { playBubblePop, playBubbleRemove, playUiTap, resetSfxContextForTests } from './sfx'

describe('procedural Web Audio SFX (sfx.ts)', () => {
  const scope = globalThis as unknown as { AudioContext?: typeof AudioContext }
  const origAudioContext = scope.AudioContext

  afterEach(() => {
    scope.AudioContext = origAudioContext
    resetSfxContextForTests()
    vi.restoreAllMocks()
  })

  it('no-ops safely when AudioContext is unavailable', () => {
    scope.AudioContext = undefined
    expect(() => {
      playBubblePop(0)
      playBubbleRemove()
      playUiTap()
    }).not.toThrow()
  })

  it('schedules an upward frequency ramp for playBubblePop and scales pitch with stepIndex', () => {
    const setValueAtTime = vi.fn()
    const exponentialRampToValueAtTime = vi.fn()
    const start = vi.fn()
    const stop = vi.fn()

    class MockAudioContext {
      state = 'running'
      currentTime = 1.0
      destination = {}
      resume = vi.fn().mockResolvedValue(undefined)
      createOscillator() {
        return {
          type: 'sine',
          frequency: { setValueAtTime, exponentialRampToValueAtTime },
          connect: vi.fn(),
          start,
          stop,
        }
      }
      createGain() {
        return {
          gain: {
            setValueAtTime: vi.fn(),
            linearRampToValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
          connect: vi.fn(),
        }
      }
    }

    scope.AudioContext = MockAudioContext as unknown as typeof AudioContext

    playBubblePop(0)
    expect(setValueAtTime).toHaveBeenCalledWith(360, 1.0)
    expect(exponentialRampToValueAtTime).toHaveBeenCalledWith(760, expect.any(Number))
    expect(start).toHaveBeenCalledWith(1.0)
    expect(stop).toHaveBeenCalled()

    setValueAtTime.mockClear()
    exponentialRampToValueAtTime.mockClear()

    // Step 2 should shift pitch up by 2 semitones
    playBubblePop(2)
    const startFreq = setValueAtTime.mock.calls[0][0] as number
    const endFreq = exponentialRampToValueAtTime.mock.calls[0][0] as number
    expect(startFreq).toBeGreaterThan(360)
    expect(endFreq).toBeGreaterThan(760)
  })

  it('resumes a suspended AudioContext before scheduling playBubbleRemove', async () => {
    const setValueAtTime = vi.fn()
    const exponentialRampToValueAtTime = vi.fn()

    class MockAudioContext {
      state = 'suspended'
      currentTime = 0
      destination = {}
      resume = vi.fn().mockImplementation(async () => {
        this.state = 'running'
      })
      createOscillator() {
        return {
          type: 'sine',
          frequency: { setValueAtTime, exponentialRampToValueAtTime },
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        }
      }
      createGain() {
        return {
          gain: {
            setValueAtTime: vi.fn(),
            linearRampToValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
          connect: vi.fn(),
        }
      }
    }

    scope.AudioContext = MockAudioContext as unknown as typeof AudioContext
    playBubbleRemove()
    await Promise.resolve()
    expect(setValueAtTime).toHaveBeenCalledWith(520, 0)
    expect(exponentialRampToValueAtTime).toHaveBeenCalledWith(250, expect.any(Number))
  })
})
