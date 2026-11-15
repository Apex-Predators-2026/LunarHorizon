import { useEffect, useRef } from 'react'

import { morphAt, POINTS, SHAPES, type Shape } from './loadingMorph'

/**
 * M3 loading indicator (https://m3.material.io/components/loading-indicator): a shape that turns steadily
 * while it morphs from one rounded polygon to the next. Use for waits of a few seconds or less; `contained`
 * puts it on a soft round container. Static (a single shape) with reduced motion.
 */

const radius = (s: Shape, th: number) => 1 + s.a * Math.cos(s.n * th)

function pathFor(from: Shape, to: Shape, t: number, r: number, cx: number, cy: number): string {
  let d = ''
  for (let i = 0; i < POINTS; i++) {
    const th = (i / POINTS) * Math.PI * 2
    const rr = r * (radius(from, th) * (1 - t) + radius(to, th) * t) * 0.86 // 0.86 keeps the lobes inside the box
    d += `${i ? 'L' : 'M'}${(cx + rr * Math.cos(th)).toFixed(2)},${(cy + rr * Math.sin(th)).toFixed(2)}`
  }
  return d + 'Z'
}

export function LoadingIndicator({
  size = 48,
  contained = true,
  color = '#ff634a',
  label = 'Loading',
  className = '',
}: {
  size?: number
  contained?: boolean
  color?: string
  label?: string
  className?: string
}) {
  const path = useRef<SVGPathElement>(null)
  const g = useRef<SVGGElement>(null)
  const half = size / 2
  const r = half * (contained ? 0.62 : 0.92) // the M3 indicator is 38 dp inside a 48 dp container

  useEffect(() => {
    const el = path.current
    const grp = g.current
    if (!el || !grp) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.setAttribute('d', pathFor(SHAPES[0], SHAPES[0], 0, r, half, half))
    if (reduced) return
    let raf = 0
    const t0 = performance.now()
    const frame = (now: number) => {
      const { from, to, mix, turnDeg } = morphAt(now - t0)
      el.setAttribute('d', pathFor(from, to, mix, r, half, half))
      grp.setAttribute('transform', `rotate(${turnDeg} ${half} ${half})`)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [r, half])

  return (
    <span role="status" aria-label={label} className={`inline-flex shrink-0 ${className}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        {contained && <circle cx={half} cy={half} r={half} fill={color} fillOpacity={0.16} />}
        <g ref={g}>
          <path ref={path} fill={color} />
        </g>
      </svg>
    </span>
  )
}
