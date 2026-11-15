// Shared time-axis helpers for the synchronized timeline and charts.
import { useLayoutEffect, useRef, useState } from 'react'

import { useCompareStore } from './useCompareStore'

export const MIN_SPAN_H = 6

export function clampView(v: [number, number], full: [number, number]): [number, number] {
  const fullSpan = full[1] - full[0]
  let span = Math.min(Math.max(v[1] - v[0], Math.min(MIN_SPAN_H, fullSpan)), fullSpan)
  if (!Number.isFinite(span) || span <= 0) span = fullSpan
  let a = v[0]
  if (a < full[0]) a = full[0]
  if (a + span > full[1]) a = full[1] - span
  return [a, a + span]
}

/** Current visible window: the store's view clamped to the full domain. */
export function useView(full: [number, number]): [number, number] {
  const view = useCompareStore((s) => s.view)
  return view ? clampView(view, full) : full
}

export function zoomView(view: [number, number], full: [number, number], factor: number, anchor?: number): [number, number] {
  const a = anchor ?? (view[0] + view[1]) / 2
  const t = (a - view[0]) / (view[1] - view[0] || 1)
  const span = (view[1] - view[0]) * factor
  return clampView([a - t * span, a - t * span + span], full)
}

export const panView = (view: [number, number], full: [number, number], frac: number): [number, number] => {
  const d = (view[1] - view[0]) * frac
  return clampView([view[0] + d, view[1] + d], full)
}

/**
 * Element width: measured once on mount (so the first layout is right even where ResizeObserver callbacks are
 * delayed, e.g. a background tab), then kept up to date with ResizeObserver and window resizes.
 */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(800)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const width = Math.floor(el.getBoundingClientRect().width)
      if (width > 0) setW(Math.max(240, width))
    }
    measure()
    window.addEventListener('resize', measure)
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(el)
    return () => {
      window.removeEventListener('resize', measure)
      ro?.disconnect()
    }
  }, [])
  return [ref, w]
}

/** "Nice" tick values for a numeric hour axis. */
export function hourTicks(view: [number, number], maxTicks: number): number[] {
  const span = view[1] - view[0]
  const steps = [1, 2, 3, 6, 12, 24, 48, 72, 96, 168, 336, 720, 1440]
  const step = steps.find((s) => span / s <= maxTicks) ?? Math.ceil(span / maxTicks / 720) * 720
  const out: number[] = []
  for (let t = Math.ceil(view[0] / step) * step; t <= view[1] + 1e-9; t += step) out.push(t)
  return out
}
