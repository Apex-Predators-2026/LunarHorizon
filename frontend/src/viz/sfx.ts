// Zero-dependency procedural Web Audio API sound effects (SFX):
// - playBubblePop: tactile upward bubble/pop for placing/selecting 3D waypoints and landing pins
// - playBubbleRemove: soft downward pop for removing/undoing/clearing waypoints
// - playUiTap: subtle soft bubble-tap for standard M3 UI button presses

let sharedCtx: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  const scope = globalThis as unknown as {
    AudioContext?: typeof AudioContext
    webkitAudioContext?: typeof AudioContext
  }
  if (!scope) return null
  if (sharedCtx && sharedCtx.state !== 'closed') {
    return sharedCtx
  }
  const Ctor = scope.AudioContext ?? scope.webkitAudioContext
  if (!Ctor) return null
  try {
    sharedCtx = new Ctor()
    return sharedCtx
  } catch {
    return null
  }
}

function scheduleToneGlide(
  ctx: AudioContext,
  startFreqHz: number,
  endFreqHz: number,
  durationSec: number,
  peakGain: number,
  type: OscillatorType = 'sine',
): void {
  try {
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()

    osc.type = type
    osc.frequency.setValueAtTime(startFreqHz, now)
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreqHz), now + durationSec * 0.85)

    const attackSec = Math.min(0.008, durationSec * 0.2)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.linearRampToValueAtTime(peakGain, now + attackSec)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec)

    osc.connect(gain)
    gain.connect(ctx.destination)

    osc.start(now)
    osc.stop(now + durationSec + 0.005)
  } catch {
    // Ignore audio scheduling errors in restricted or headless environments
  }
}

function playToneGlide(
  startFreqHz: number,
  endFreqHz: number,
  durationSec: number,
  peakGain: number,
  type: OscillatorType = 'sine',
): void {
  const ctx = getAudioContext()
  if (!ctx) return
  if (ctx.state === 'suspended') {
    void ctx
      .resume()
      .then(() => {
        scheduleToneGlide(ctx, startFreqHz, endFreqHz, durationSec, peakGain, type)
      })
      .catch(() => {})
    return
  }
  scheduleToneGlide(ctx, startFreqHz, endFreqHz, durationSec, peakGain, type)
}

/**
 * Tactile upward bubble/pop sound for 3D waypoints and surface pins.
 * `stepIndex` nudges the pitch up slightly (up to +6 semitones) as waypoints A -> B -> C are chained.
 */
export function playBubblePop(stepIndex = 0): void {
  const clampedStep = Math.min(Math.max(0, stepIndex), 6)
  const pitchScale = Math.pow(2, clampedStep / 12)
  playToneGlide(360 * pitchScale, 760 * pitchScale, 0.085, 0.22, 'sine')
}

/**
 * Soft downward bubble pop when deleting, undoing, or clearing a waypoint.
 */
export function playBubbleRemove(): void {
  playToneGlide(520, 250, 0.075, 0.18, 'sine')
}

/**
 * Subtle soft bubble-tap for standard UI button clicks.
 */
export function playUiTap(): void {
  playToneGlide(420, 580, 0.045, 0.09, 'sine')
}

/** Reset cached AudioContext instance (used by unit tests). */
export function resetSfxContextForTests(): void {
  sharedCtx = null
}
