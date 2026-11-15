// Graphics presets for the 3D view. "high" is the full-quality default; "low" keeps the view
// usable on weak hardware (Chromebooks, old laptops with integrated graphics).
// Nothing here changes the science: the engine's numbers, the skyline and the lighting at the
// lander are the same in every preset; only how much terrain detail and effects are drawn.
import { useCallback, useState, useSyncExternalStore } from 'react'

export type GraphicsQuality = 'high' | 'low' | 'xlow'

export interface GraphicsSettings {
  label: string
  hint: string
  dpr: number | [number, number] // canvas resolution scale (min, max of the screen's pixel ratio)
  antialias: boolean
  shadows: boolean // terrain casting shadows near the lander (shadow map)
  shadowMapSize: number
  lodThresholdPx: number // refine terrain while a vertex step covers more than this many pixels
  maxCachedMeshes: number // terrain tiles kept in memory
  stars: number // the brightest this many of the ~8,800 catalogue stars (sky/stars.ts)
  material: 'standard' | 'lambert' // terrain shading: physically based, or cheaper diffuse-only
  detailedModels: boolean // the rover model (11 MB, textured) instead of a simple primitive lander
  lite: boolean // Extra low: no mango-mesh shader, no liquid glass, and (almost) no UI animation (data-gfx on <html>)
}

export const GRAPHICS: Record<GraphicsQuality, GraphicsSettings> = {
  high: {
    label: 'High',
    hint: 'Full detail and shadows (default)',
    dpr: [1, 2],
    antialias: true,
    shadows: true,
    shadowMapSize: 4096,
    lodThresholdPx: 4,
    maxCachedMeshes: 500,
    stars: 9000, // all of them: the naked-eye sky to magnitude 6.5
    material: 'standard',
    detailedModels: true,
    lite: false,
  },
  low: {
    label: 'Low',
    hint: 'For Chromebooks and older laptops: no shadows or anti-aliasing, much less terrain detail',
    dpr: 1,
    antialias: false,
    shadows: false,
    shadowMapSize: 1024, // unused while shadows are off
    lodThresholdPx: 10,
    maxCachedMeshes: 200,
    stars: 1500, // to about magnitude 4.8
    material: 'lambert',
    detailedModels: false,
    lite: false,
  },
  xlow: {
    label: 'Extra low',
    hint: 'Maximum speed: lowest 3D detail, no shadows, no mango gradient, no glass blur and almost no animation',
    dpr: 0.75,
    antialias: false,
    shadows: false,
    shadowMapSize: 512, // unused while shadows are off
    lodThresholdPx: 18,
    maxCachedMeshes: 100,
    stars: 400, // to about magnitude 3.5
    material: 'lambert',
    detailedModels: false,
    lite: true,
  },
}

export const DEFAULT_GRAPHICS: GraphicsQuality = 'high'
const STORAGE_KEY = 'lunar-navigator.graphics'

const isQuality = (v: unknown): v is GraphicsQuality => v === 'high' || v === 'low' || v === 'xlow'

export const LITE_EVENT = 'lunar-gfx-change'

/** Mirror the preset on <html data-gfx="..."> so CSS can switch off glass, blur and animation, and tell
 *  JS-driven effects (the mango shader, the glass cursor light, button ripples) to stand down. */
export function applyGraphicsAttribute(q: GraphicsQuality) {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.gfx = q
  window.dispatchEvent(new Event(LITE_EVENT))
}

/** True while the Extra low preset is on (non-reactive; read it when an effect starts). */
export const isLiteUi = () => typeof document !== 'undefined' && document.documentElement.dataset.gfx === 'xlow'

/** Reactive version of isLiteUi(). */
export function useLiteUi(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener(LITE_EVENT, cb)
      return () => window.removeEventListener(LITE_EVENT, cb)
    },
    isLiteUi,
    () => false,
  )
}

function loadQuality(): GraphicsQuality {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    return isQuality(v) ? v : DEFAULT_GRAPHICS
  } catch {
    return DEFAULT_GRAPHICS // storage blocked (private window etc.)
  }
}

/** An on/off graphics option (e.g. far shadows), remembered in this browser. */
export function useStoredFlag(key: string, initial: boolean): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState<boolean>(() => {
    try {
      const v = window.localStorage.getItem(key)
      return v === null ? initial : v === '1'
    } catch {
      return initial
    }
  })
  const set = useCallback(
    (v: boolean) => {
      setOn(v)
      try {
        window.localStorage.setItem(key, v ? '1' : '0')
      } catch {
        // not remembered, but still applied
      }
    },
    [key],
  )
  return [on, set]
}

// Applied at load so the landing page, Comparison, Atlas and Methodology honour the saved preset too.
applyGraphicsAttribute(loadQuality())

/** The chosen preset, remembered in this browser. */
export function useGraphicsQuality(): [GraphicsQuality, (q: GraphicsQuality) => void] {
  const [quality, setQuality] = useState<GraphicsQuality>(loadQuality)
  const set = useCallback((q: GraphicsQuality) => {
    setQuality(q)
    applyGraphicsAttribute(q)
    try {
      window.localStorage.setItem(STORAGE_KEY, q)
    } catch {
      // not remembered, but still applied
    }
  }, [])
  return [quality, set]
}
