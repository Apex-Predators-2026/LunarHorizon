import type { TutorialPlacement } from './steps'
import { useTutorialStore } from './useTutorialStore'

export interface RectBox {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

const VIEW_MARGIN = 16
const SPOTLIGHT_PAD = 8
const CARD_GAP = 16

function clamp(v: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(Math.max(v, min), max)
}

export function computeCoachmarkPosition(
  targetRect: RectBox | null,
  viewport: { width: number; height: number },
  cardSize: { width: number; height: number },
  preferredPlacement: TutorialPlacement = 'auto',
): { left: number; top: number; mode: 'anchored' | 'centered' } {
  const maxLeft = Math.max(VIEW_MARGIN, viewport.width - cardSize.width - VIEW_MARGIN)
  const maxTop = Math.max(VIEW_MARGIN, viewport.height - cardSize.height - VIEW_MARGIN)

  if (!targetRect || targetRect.width <= 0 || targetRect.height <= 0) {
    return {
      left: clamp(Math.round((viewport.width - cardSize.width) / 2), VIEW_MARGIN, maxLeft),
      top: clamp(Math.round((viewport.height - cardSize.height) / 2), VIEW_MARGIN, maxTop),
      mode: 'centered',
    }
  }

  const gap = SPOTLIGHT_PAD + CARD_GAP
  const candidates: Record<Exclude<TutorialPlacement, 'auto'>, { left: number; top: number; space: number }> = {
    left: {
      left: targetRect.left - cardSize.width - gap,
      top: targetRect.top + targetRect.height / 2 - cardSize.height / 2,
      space: targetRect.left - VIEW_MARGIN,
    },
    right: {
      left: targetRect.right + gap,
      top: targetRect.top + targetRect.height / 2 - cardSize.height / 2,
      space: viewport.width - targetRect.right - VIEW_MARGIN,
    },
    top: {
      left: targetRect.left + targetRect.width / 2 - cardSize.width / 2,
      top: targetRect.top - cardSize.height - gap,
      space: targetRect.top - VIEW_MARGIN,
    },
    bottom: {
      left: targetRect.left + targetRect.width / 2 - cardSize.width / 2,
      top: targetRect.bottom + gap,
      space: viewport.height - targetRect.bottom - VIEW_MARGIN,
    },
  }

  const order: Exclude<TutorialPlacement, 'auto'>[] =
    preferredPlacement !== 'auto'
      ? [preferredPlacement, ...(['left', 'top', 'bottom', 'right'] as const).filter((p) => p !== preferredPlacement)]
      : ['left', 'top', 'bottom', 'right']

  const needed = (side: Exclude<TutorialPlacement, 'auto'>) =>
    side === 'left' || side === 'right' ? cardSize.width + gap : cardSize.height + gap

  let chosen = order.find((side) => candidates[side].space >= needed(side))
  if (!chosen) {
    chosen = order.reduce((best, side) => (candidates[side].space > candidates[best].space ? side : best), order[0])
  }

  const raw = candidates[chosen]
  return {
    left: clamp(Math.round(raw.left), VIEW_MARGIN, maxLeft),
    top: clamp(Math.round(raw.top), VIEW_MARGIN, maxTop),
    mode: 'anchored',
  }
}

export function handleTutorialKeyDown(e: { key: string; preventDefault?: () => void }): boolean {
  const state = useTutorialStore.getState()
  if (!state.open) return false
  if (e.key === 'Escape') {
    e.preventDefault?.()
    state.skipTour()
    return true
  }
  if (e.key === 'ArrowRight') {
    e.preventDefault?.()
    state.nextStep()
    return true
  }
  if (e.key === 'ArrowLeft') {
    e.preventDefault?.()
    state.prevStep()
    return true
  }
  return false
}
