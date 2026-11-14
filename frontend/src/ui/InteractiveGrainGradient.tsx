import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createMangoGL, MANGO_FALLBACK_CSS } from './mangoShader'

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
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [fallback, setFallback] = useState(false)

  useEffect(() => {
    const cv = canvas.current
    const box = wrap.current
    if (!cv || !box) return
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

    const size = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, maxDpr)
      const w = Math.max(2, Math.round(box.clientWidth * dpr))
      const h = Math.max(2, Math.round(box.clientHeight * dpr))
      if (w !== cv.width || h !== cv.height) g.resize(w, h)
    }
    const frame = (now: number) => {
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
      const scale = patternScale ?? Math.min(2, Math.max(1, 220 / Math.max(1, Math.min(box.clientWidth, box.clientHeight))))
      g.draw({ time: ((now - t0) / 1000) * speed, mouse, vel, influence: influence * strength, grain, scale })
    }
    const loop = (now: number) => {
      frame(now)
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
      const r = box.getBoundingClientRect()
      const nx = (e.clientX - r.left) / r.width
      const ny = 1 - (e.clientY - r.top) / r.height
      const near = nx > -1 && nx < 2 && ny > -1 && ny < 2
      influenceTarget = near ? 1 : 0
      if (near) {
        target[0] = Math.min(1.2, Math.max(-0.2, nx))
        target[1] = Math.min(1.2, Math.max(-0.2, ny))
      }
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
  }, [interactive, grain, speed, maxDpr, strength, patternScale])

  return (
    <div ref={wrap} className={className} style={{ position: fill ? 'absolute' : 'relative', ...(fill ? { inset: 0 } : null), overflow: 'hidden', background: MANGO_FALLBACK_CSS, ...style }} aria-hidden>
      {!fallback && <canvas ref={canvas} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} />}
    </div>
  )
}
