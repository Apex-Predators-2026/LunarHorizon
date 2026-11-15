import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createMangoGL, MANGO_FALLBACK_CSS } from './mangoShader'
import { useLiteUi } from '../viz/graphics'

export interface InteractiveGrainGradientProps {
  className?: string
  style?: CSSProperties
  /** React to the pointer (it need not be over the gradient: it works within about a width of it). Default true. */
  interactive?: boolean
  /** Film grain strength, 0..0.2. Default 0.07. */
  grain?: number
  /** Speed of the ambient drift. 1 = very slow (default). */
  speed?: number
  /** Fill the nearest positioned parent (absolute, inset 0) instead of flowing in layout. */
  fill?: boolean
  /** Pattern scale override: below 1 gives larger colour chunks, above 1 smaller. Default: automatic by element size. */
  patternScale?: number
  /** How strongly the pointer bends the colours. Default 1. */
  strength?: number
  /** Cap on the pixel ratio, to keep it cheap. Default 1.5. */
  maxDpr?: number
}

/**
 * "Mango mesh": a living peach (#FFB08C) / coral (#FF634A) gradient with domain-warped flow and fine film
 * grain, drawn by a WebGL fragment shader. It fills its container, drifts slowly by itself and bends softly
 * around the pointer with some inertia. With "reduce motion" it draws a single still frame; without WebGL it
 * falls back to a plain CSS gradient. Pauses while off screen or the tab is hidden.
 */
export function InteractiveGrainGradient({ className, style, interactive = true, grain = 0.07, speed = 1, maxDpr = 1.5, fill = false, strength = 1, patternScale }: InteractiveGrainGradientProps) {
  const wrap = useRef<HTMLSpanElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [fallback, setFallback] = useState(false)
  const lite = useLiteUi() // Extra low: no WebGL shader at all, just the flat CSS gradient

  useEffect(() => {
    const cv = canvas.current
    const box = wrap.current
    if (!cv || !box || lite) return
    const g = createMangoGL(cv)
    if (!g) {
      setFallback(true)
      return
    }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    let raf = 0
    let visible = true
    const t0 = performance.now()
    const mouse: [number, number] = [0.5, 0.5]
    const target: [number, number] = [0.5, 0.5]
    const vel: [number, number] = [0, 0]
    let influence = 0
    let influenceTarget = 0
    let last = performance.now()
    // Layout is read as little as possible: the size is cached (the ResizeObserver updates it) and the pointer is
    // only turned into gradient coordinates once per drawn frame, not on every pointer event.
    let bw = box.clientWidth
    let bh = box.clientHeight
    let pointer: { x: number; y: number } | null = null

    const size = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, maxDpr)
      const w = Math.max(2, Math.round(bw * dpr))
      const h = Math.max(2, Math.round(bh * dpr))
      if (w !== cv.width || h !== cv.height) g.resize(w, h)
    }
    const applyPointer = () => {
      if (!pointer) return
      const r = box.getBoundingClientRect()
      const nx = (pointer.x - r.left) / r.width
      const ny = 1 - (pointer.y - r.top) / r.height
      const near = nx > -1 && nx < 2 && ny > -1 && ny < 2
      influenceTarget = near ? 1 : 0
      if (near) {
        target[0] = Math.min(1.2, Math.max(-0.2, nx))
        target[1] = Math.min(1.2, Math.max(-0.2, ny))
      }
      pointer = null
    }
    const frame = (now: number) => {
      applyPointer()
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      // Inertia: the pointer position is chased, and its velocity relaxes back to zero.
      const k = 1 - Math.exp(-dt * 4)
      const px = mouse[0], py = mouse[1]
      mouse[0] += (target[0] - mouse[0]) * k
      mouse[1] += (target[1] - mouse[1]) * k
      vel[0] += ((mouse[0] - px) / Math.max(dt, 1e-3) * 0.12 - vel[0]) * (1 - Math.exp(-dt * 6))
      vel[1] += ((mouse[1] - py) / Math.max(dt, 1e-3) * 0.12 - vel[1]) * (1 - Math.exp(-dt * 6))
      influence += (influenceTarget - influence) * (1 - Math.exp(-dt * 3))
      size()
      // Small elements (a button glyph, a thin bar) would otherwise show a single hue: pack more pattern in.
      const scale = patternScale ?? Math.min(2, Math.max(1, 220 / Math.max(1, Math.min(bw, bh))))
      g.draw({ time: ((now - t0) / 1000) * speed, mouse, vel, influence: influence * strength, grain, scale })
    }
    // While nothing is happening near it the drift is too slow to see: draw about 15 times a second instead of 60.
    let lastDraw = 0
    const loop = (now: number) => {
      applyPointer()
      const busy = influenceTarget > 0 || influence > 0.01
      if (busy || now - lastDraw >= 64) {
        lastDraw = now
        frame(now)
      }
      raf = visible && !document.hidden ? requestAnimationFrame(loop) : 0
    }
    const start = () => {
      if (!raf && !reduced.matches) {
        last = performance.now()
        raf = requestAnimationFrame(loop)
      }
    }

    // Reduced motion: one still frame, no loop and no pointer response.
    if (reduced.matches) frame(performance.now())
    else start()

    const onMove = (e: PointerEvent) => {
      if (!interactive || reduced.matches) return
      pointer = { x: e.clientX, y: e.clientY }
    }
    const onLeave = () => (influenceTarget = 0)
    window.addEventListener('pointermove', onMove, { passive: true })
    document.addEventListener('pointerleave', onLeave)
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting
      if (visible) start()
    })
    io.observe(box)
    const onVis = () => !document.hidden && start()
    document.addEventListener('visibilitychange', onVis)
    const ro = new ResizeObserver(() => {
      bw = box.clientWidth
      bh = box.clientHeight
      size()
      if (reduced.matches || !raf) frame(performance.now())
    })
    ro.observe(box)
    const onLost = (e: Event) => {
      e.preventDefault()
      setFallback(true)
    }
    cv.addEventListener('webglcontextlost', onLost)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerleave', onLeave)
      document.removeEventListener('visibilitychange', onVis)
      cv.removeEventListener('webglcontextlost', onLost)
      io.disconnect()
      ro.disconnect()
      g.dispose()
    }
  }, [interactive, grain, speed, maxDpr, strength, patternScale, lite])

  return (
    <span ref={wrap} className={className} style={{ display: 'block', position: fill ? 'absolute' : 'relative', ...(fill ? { inset: 0 } : null), overflow: 'hidden', background: MANGO_FALLBACK_CSS, ...style }} aria-hidden>
      {!fallback && !lite && <canvas ref={canvas} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} />}
    </span>
  )
}
