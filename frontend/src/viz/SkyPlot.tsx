import { useMemo, useState } from 'react'
import type { Horizon, TimelineStep } from '../types'
import { skyRange, skyXY, sunUp } from './timeline'

const SIZE = 220
const R = SIZE / 2 - 18
const C = SIZE / 2

const COLORS = { sun: '#e8b84a', earth: '#5aa9f0', terrain: '#3a3f4b', grid: '#22304d', axis: '#cbd5e1' }

type Pt = (az: number, el: number) => [number, number]

/** Polyline segments, split where `on` changes, so visible and hidden parts can be styled. */
function tracks(steps: TimelineStep[], body: 'sun' | 'earth', pt: Pt) {
  const out: { on: boolean; d: string }[] = []
  let cur: { on: boolean; pts: string[] } | null = null
  for (const s of steps) {
    const b = s[body]
    const on = body === 'sun' ? sunUp(s.sun) : s.earth.visible === true // unknown drawn as blocked
    const [x, y] = pt(b.azimuth_deg, b.elevation_deg)
    const p = `${x.toFixed(1)},${y.toFixed(1)}`
    if (!cur || cur.on !== on) {
      if (cur) out.push({ on: cur.on, d: `M${cur.pts.join(' L')} L${p}` })
      cur = { on, pts: [p] }
    } else cur.pts.push(p)
  }
  if (cur) out.push({ on: cur.on, d: `M${cur.pts.join(' L')}` })
  return out
}

/**
 * Sky as seen from the lander: north up, east right, elevation increasing towards the centre
 * (range fitted to the site, see skyRange). Grey = terrain (the computed horizon). Lines = Sun /
 * Earth paths over the time window (solid where visible, dashed where blocked). Dots = positions
 * at the selected time.
 */
export function SkyPlot({
  horizon,
  steps,
  current,
  windowLabel,
  suppressTip = false,
}: {
  horizon: Horizon | null
  steps: TimelineStep[]
  current: TimelineStep | null
  windowLabel: string
  suppressTip?: boolean // hide the hover note (e.g. while the panel is being dragged)
}) {
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null) // cursor position
  const [focused, setFocused] = useState(false)
  const [topEl, bottomEl] = useMemo(() => skyRange(horizon?.elevation_deg, steps), [horizon, steps])
  const pt: Pt = useMemo(
    () => (az, el) => skyXY(az, el, R, topEl, bottomEl).map((v) => C + v) as [number, number],
    [topEl, bottomEl],
  )
  const terrainPath = useMemo(() => {
    if (!horizon) return ''
    // Unknown directions (custom sites only) are drawn at 0°, the flat horizon.
    const ring = horizon.azimuth_deg.map((az, i) => pt(az, horizon.elevation_deg[i] ?? 0).map((v) => v.toFixed(1)).join(','))
    // Rim circle + horizon polygon, filled with even-odd: the band between them is the terrain.
    return `M${C - R},${C} a${R},${R} 0 1,0 ${2 * R},0 a${R},${R} 0 1,0 ${-2 * R},0 Z M${ring.join(' L')} Z`
  }, [horizon, pt])
  const sunTracks = useMemo(() => tracks(steps, 'sun', pt), [steps, pt])
  const earthTracks = useMemo(() => tracks(steps, 'earth', pt), [steps, pt])
  const ringStep = topEl - bottomEl > 20 ? 10 : 5
  const rings: number[] = []
  for (let el = Math.ceil(bottomEl / ringStep) * ringStep; el < topEl; el += ringStep) if (el > bottomEl) rings.push(el)

  return (
    <figure
      className="relative m-0 flex w-full justify-center rounded-[20px] p-3 outline-offset-[-4px]"
      tabIndex={0}
      aria-label="Mini map: sky from the lander. Hover or focus for details."
      onPointerMove={(e) => setTip({ x: e.clientX, y: e.clientY })}
      onPointerLeave={() => setTip(null)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <svg width={SIZE} height={SIZE} role="img" aria-label="Sky plot: terrain horizon with Sun and Earth paths">
        <circle cx={C} cy={C} r={R} fill="#05080f" stroke="#ffffff" strokeWidth={1.5} />
        {/* neutral outline, so the yellow Sun path (which often hugs the skyline) stays distinct */}
        {terrainPath && <path d={terrainPath} fill={COLORS.terrain} fillRule="evenodd" stroke="#8b93a5" strokeWidth={0.8} />}
        {rings.map((el) => {
          const [, y] = pt(0, el)
          return (
            <g key={el}>
              <circle cx={C} cy={C} r={C - y} fill="none" stroke={COLORS.grid} strokeDasharray={el === 0 ? '' : '2 3'} />
              <text x={C + 2} y={y - 2} fontSize={9} fill={COLORS.axis} stroke="#05080f" strokeWidth={2.5} paintOrder="stroke">
                {el}°
              </text>
            </g>
          )
        })}
        {[0, 90, 180, 270].map((az) => {
          const [x, y] = skyXY(az, bottomEl, R + 9, topEl, bottomEl)
          return (
            <text key={az} x={C + x} y={C + y + 3} fontSize={10} fontWeight={600} textAnchor="middle" fill="#ffffff" style={{ paintOrder: 'stroke' }} stroke="rgba(0,0,0,0.6)" strokeWidth={2.5}>
              {['N', 'E', 'S', 'W'][az / 90]}
            </text>
          )
        })}
        {earthTracks.map((t, i) => (
          <path key={`e${i}`} d={t.d} fill="none" stroke={COLORS.earth} strokeWidth={1.6} strokeDasharray={t.on ? '' : '2 3'} opacity={t.on ? 0.95 : 0.6} />
        ))}
        {sunTracks.map((t, i) => (
          <path key={`s${i}`} d={t.d} fill="none" stroke={COLORS.sun} strokeWidth={1.6} strokeDasharray={t.on ? '' : '2 3'} opacity={t.on ? 0.95 : 0.6} />
        ))}
        {current && (
          <>
            <circle
              cx={pt(current.earth.azimuth_deg, current.earth.elevation_deg)[0]}
              cy={pt(current.earth.azimuth_deg, current.earth.elevation_deg)[1]}
              r={5}
              fill={current.earth.visible ? COLORS.earth : '#05080f'}
              stroke={COLORS.earth}
              strokeWidth={1.5}
            />
            <circle
              cx={pt(current.sun.azimuth_deg, current.sun.elevation_deg)[0]}
              cy={pt(current.sun.azimuth_deg, current.sun.elevation_deg)[1]}
              r={5}
              fill={sunUp(current.sun) ? COLORS.sun : '#05080f'}
              stroke={COLORS.sun}
              strokeWidth={1.5}
            />
          </>
        )}
      </svg>
      <figcaption
        role="tooltip"
        className={`pointer-events-none fixed z-50 w-60 rounded-xl bg-calcite-ink/95 px-3 py-2 text-[11px] leading-snug origin-top-left text-opal-50 transition-[opacity,transform] duration-150 ${
          !suppressTip && (tip || focused) ? 'scale-100 opacity-100' : 'scale-90 opacity-0'
        }`}
        style={
          tip
            ? { left: Math.min(tip.x + 14, window.innerWidth - 252), top: Math.min(tip.y + 18, window.innerHeight - 90) }
            : { right: 'calc(var(--lp-side-w, 320px) + 4vw + 12px)', top: 110 }
        }
      >
        Sky from the lander · grey = terrain · <span style={{ color: COLORS.sun }}>Sun</span> /{' '}
        <span style={{ color: COLORS.earth }}>Earth</span> paths {windowLabel} (dashed = blocked) · centre {topEl}°, rim{' '}
        {bottomEl}°
      </figcaption>
    </figure>
  )
}
