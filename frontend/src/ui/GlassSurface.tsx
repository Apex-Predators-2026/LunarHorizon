import { isLiteUi } from '../viz/graphics'
import { useEffect, useRef, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react'

/** Chromium can run an SVG displacement filter inside backdrop-filter; other browsers keep plain blur. */
const canRefract = typeof navigator !== 'undefined' && /Chrome\//.test(navigator.userAgent)

/**
 * SVG filter used for the faint edge refraction. Mount once near the app root.
 */
export function GlassDefs() {
  return (
    <svg width="0" height="0" aria-hidden style={{ position: 'absolute' }} focusable="false">
      <filter id="glass-refract" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.011 0.02" numOctaves="2" seed="4" result="n" />
        <feDisplacementMap in="SourceGraphic" in2="n" scale="9" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  )
}

export interface GlassSurfaceProps extends HTMLAttributes<HTMLDivElement> {
  /** Turn the glass look on or off while keeping the same element (so children are not remounted). Default true. */
  enabled?: boolean
  /** Corner radius. Default 28px (Material 3 extra large). */
  radius?: string
  /** Highlight that slides with the cursor. Default true. */
  interactive?: boolean
  children?: ReactNode
}

/**
 * Frosted glass surface: translucent neutral fill, background blur with saturation, light edge, inner
 * highlight, restrained shadow, fine grain, and a soft light that follows the cursor while the surface
 * stays put. Use it sparingly, for floating toolbars, navigation and overlays.
 */
export function GlassSurface({ enabled = true, radius = '28px', interactive = true, className = '', style, children, onPointerMove, onPointerLeave, ...rest }: GlassSurfaceProps) {
  const ref = useRef<HTMLDivElement>(null)
  const target = useRef<[number, number] | null>(null)
  const current = useRef<[number, number]>([30, 0])
  const raf = useRef(0)

  // The light eases toward the pointer (a little inertia) instead of snapping to it.
  useEffect(() => () => cancelAnimationFrame(raf.current), [])
  const step = () => {
    const el = ref.current
    const t = target.current
    if (!el || !t) return
    current.current[0] += (t[0] - current.current[0]) * 0.18
    current.current[1] += (t[1] - current.current[1]) * 0.18
    el.style.setProperty('--mx', `${current.current[0].toFixed(1)}px`)
    el.style.setProperty('--my', `${current.current[1].toFixed(1)}px`)
    if (Math.abs(t[0] - current.current[0]) + Math.abs(t[1] - current.current[1]) > 0.5) raf.current = requestAnimationFrame(step)
  }

  return (
    <div
      ref={ref}
      className={`${enabled ? 'glass-on' : ''} ${className}`}
      data-refract={enabled && canRefract ? 'true' : undefined}
      style={{ ...(enabled ? { borderRadius: radius } : null), ...style } as CSSProperties}
      onPointerMove={(e) => {
        onPointerMove?.(e)
        if (!enabled || !interactive || isLiteUi() || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
        const r = e.currentTarget.getBoundingClientRect()
        target.current = [e.clientX - r.left, e.clientY - r.top]
        cancelAnimationFrame(raf.current)
        raf.current = requestAnimationFrame(step)
      }}
      onPointerLeave={(e) => {
        onPointerLeave?.(e)
        target.current = null
      }}
      {...rest}
    >
      {children}
    </div>
  )
}

/** A glass pill for a row of controls (icon buttons, tabs). Pass role="toolbar" and an aria-label when it holds a tool set. */
export function GlassToolbar({ className = '', ...props }: GlassSurfaceProps) {
  return <GlassSurface radius="9999px" className={`inline-flex items-center ${className}`} {...props} />
}
