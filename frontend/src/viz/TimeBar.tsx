import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAppStore } from '../store'
import { LoadingIndicator } from '../ui/LoadingIndicator'
import { MangoRange } from '../ui/MangoRange'
import type { SiteInfo, TimelineStep } from '../types'
import { DatePopup } from './DatePopup'
import { useDragGuard } from './dragGuard'
import { HOUR_MS, longestRun, parseUtc, roundHour, runs, sunKnown, sunUp, toIsoMinute } from './timeline'
import { useTutorialStore } from '../features/tutorial'

const COLORS = {
  sun: '#e8b84a',
  earth: '#5aa9f0',
  dark: '#111a2e',
  gap: '#d03b3b',
  grid: '#22304d',
  axis: 'var(--color-slate-400)',
  unknown: '#5b6475', // hatch stripes: no data (never drawn as darkness)
  unknownBg: '#262b36',
}
const SPEEDS = [
  { label: '1 h/s', hoursPerSec: 1 },
  { label: '6 h/s', hoursPerSec: 6 },
  { label: '1 day/s', hoursPerSec: 24 },
  { label: '3 days/s', hoursPerSec: 72 },
  { label: '1 week/s', hoursPerSec: 168 },
]
const WINDOW_DAYS = [7, 14, 28] as const

const GUTTER = 46
const SUN_H = 30
const EARTH_H = 14
const LANE_GAP = 4
const AXIS_H = 16
const STRIP_H = SUN_H + LANE_GAP + EARTH_H + AXIS_H

const fmtTime = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
const fmtDur = (h: number) => (h >= 48 ? `${(h / 24).toFixed(1)} d` : `${Math.round(h)} h`)
const fmtDay = (ms: number) => new Date(ms).toISOString().slice(5, 10)

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(600)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.floor(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

/** Store updates while playing at most this often: each one re-renders the whole 3D view. */
const PLAYBACK_UPDATE_MS = 80

/**
 * Advances the shared time while playing: one store update per data hour, and at fast speeds (more
 * than ~12 data hours a second) no more than every PLAYBACK_UPDATE_MS, not on every frame. Hours in
 * between are skipped, as frames already skipped them; mission playback checks failures by time
 * (f.t <= now), so it still stops at each one.
 */
function usePlayback(hoursPerSec: number, dataStop: number) {
  const playing = useAppStore((s) => s.playing)
  useEffect(() => {
    if (!playing) return
    const { setTime, setPlaying } = useAppStore.getState()
    let acc = parseUtc(useAppStore.getState().timeUtc)
    let lastSet = useAppStore.getState().timeUtc
    let prev = performance.now()
    let lastSetAt = -Infinity
    let raf = 0
    const tick = (now: number) => {
      const cur = useAppStore.getState().timeUtc
      if (cur !== lastSet) acc = parseUtc(cur) // user scrubbed while playing
      acc += ((now - prev) / 1000) * hoursPerSec * HOUR_MS
      prev = now
      if (acc >= dataStop) {
        setTime(toIsoMinute(dataStop))
        setPlaying(false)
        return
      }
      const next = toIsoMinute(Math.floor(acc / HOUR_MS) * HOUR_MS)
      if (next !== lastSet && now - lastSetAt >= PLAYBACK_UPDATE_MS) {
        lastSet = next
        lastSetAt = now
        setTime(next)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, hoursPerSec, dataStop])
}

/** Sunlight / Earth-visibility strip for the current window. Click or drag to move the time. */
/** A mission being played back: its window and the moments a requirement breaks (see viz/mission.ts). */
export interface StripMission {
  start: number
  end: number
  failures: number[] // epoch ms
  label?: string // legend text; default "Mission"
}

/** "Show why" evidence (viz/evidence.ts): the canonical window, or a single moment when the source gives no end. */
export interface StripEvidence {
  start: number
  end: number
  point: boolean
  dataMissing: boolean // the window marks missing data, not a measured condition
}

export const EVIDENCE_COLOR = '#38bdf8'
export const MISSING_COLOR = '#9ca3af' // unknown data: neutral grey, distinct from darkness and blackout

function Strip({
  steps,
  win,
  now,
  onSeek,
  mission,
  evidence,
  rightSlot,
}: {
  steps: TimelineStep[]
  win: [number, number]
  now: number
  onSeek: (ms: number) => void
  mission?: StripMission | null
  evidence?: StripEvidence | null
  rightSlot?: ReactNode
}) {
  const [boxRef, width] = useWidth<HTMLDivElement>()
  const dragging = useRef(false)
  const guard = useDragGuard()
  const [hoveringStrip, setHoveringStrip] = useState(false)
  const w = Math.max(50, width - GUTTER - 4)
  const x = (t: number) => GUTTER + ((t - win[0]) / (win[1] - win[0])) * w
  const inv = (px: number) => win[0] + ((px - GUTTER) / w) * (win[1] - win[0])

  const data = useMemo(() => {
    const t = steps.map((s) => parseUtc(s.time_utc))
    const earth = steps.map((s) => s.earth.visible === true)
    // Unknown (terrain data missing in that direction, custom sites) is its own state: never drawn
    // or counted as darkness / blackout. Gaps only count hours known to be dark / blocked.
    const sunKnownFlags = steps.map((s) => sunKnown(s.sun))
    const earthKnownFlags = steps.map((s) => s.earth.visible !== null && s.earth.visible !== undefined)
    const dark = steps.map((s, i) => sunKnownFlags[i] && !sunUp(s.sun))
    const blocked = steps.map((s) => s.earth.visible === false)
    return {
      t,
      earthRuns: runs(earth),
      sunKnownRuns: runs(sunKnownFlags),
      earthBlockedRuns: runs(blocked),
      sunUnknownRuns: runs(sunKnownFlags, false),
      earthUnknownRuns: runs(earthKnownFlags, false),
      sunUnknownHours: sunKnownFlags.filter((k) => !k).length,
      sunKnownHours: sunKnownFlags.filter(Boolean).length,
      sunLitHours: steps.filter((st, i) => sunKnownFlags[i] && sunUp(st.sun)).length,
      earthUnknownHours: earthKnownFlags.filter((k) => !k).length,
      longDark: longestRun(dark),
      longBlackout: longestRun(blocked),
    }
  }, [steps])

  // A run of samples covers [first sample, last sample + 1 h): each sample holds until the next (sample-and-hold,
  // backend app/timegrid.py), so the strip shows what the engine used.
  const span = (r: [number, number]) => {
    const a = data.t[r[0]]
    const b = (data.t[r[1] - 1] ?? data.t[r[0]]) + HOUR_MS
    return { x: x(a), w: Math.max(1, x(b) - x(a)), hours: (b - a) / HOUR_MS }
  }

  // Sunlight over known hours only (one closed shape per run): an unknown hour is not a 0 % hour.
  const sunPath = useMemo(() => {
    let d = ''
    for (const [a, b] of data.sunKnownRuns) {
      const pts: string[] = []
      for (let i = a; i < b; i++) {
        const f = steps[i].sun.visible_fraction ?? (sunUp(steps[i].sun) ? 1 : 0)
        const y = SUN_H - (f === 0 && steps[i].sun.visible === true ? 0.03 : f) * SUN_H // a visible sliver that rounds to 0 is not darkness
        pts.push(`${x(data.t[i]).toFixed(1)},${y.toFixed(1)}`, `${x(data.t[i] + HOUR_MS).toFixed(1)},${y.toFixed(1)}`)
      }
      d += `M${pts[0].split(',')[0]},${SUN_H} L${pts.join(' L')} L${pts[pts.length - 1].split(',')[0]},${SUN_H} Z `
    }
    return d
    // x depends on win and width
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, steps, win, width])
  const hatchId = `unknown-hatch-${useId().replace(/:/g, '')}`
  // With data loaded, the lanes start as "no data" and only known hours are painted over it, so
  // hours with no sample at all show as unknown too. While loading: the plain background.
  const laneFill = steps.length ? `url(#${hatchId})` : COLORS.dark

  const days = (win[1] - win[0]) / (24 * HOUR_MS)
  const tickEvery = days <= 8 ? 1 : days <= 15 ? 2 : 4
  const ticks: number[] = []
  for (let t = win[0]; t <= win[1]; t += tickEvery * 24 * HOUR_MS) ticks.push(t)

  const seekAt = (ev: React.PointerEvent<SVGSVGElement>) => {
    const px = ev.clientX - ev.currentTarget.getBoundingClientRect().left
    onSeek(Math.min(win[1], Math.max(win[0], inv(px))))
  }
  const earthTop = SUN_H + LANE_GAP
  const dark = data.longDark ? span(data.longDark) : null
  const blackout = data.longBlackout ? span(data.longBlackout) : null

  return (
    <div ref={boxRef} className="w-full select-none">
      <svg
        width={width}
        height={STRIP_H}
        className="cursor-crosshair touch-none rounded focus-visible:outline-2 focus-visible:outline-coral"
        role="slider"
        tabIndex={0}
        aria-label="Sunlight and Earth visibility over the time window. Click, drag, or use Left and Right arrow keys to choose a time."
        aria-valuemin={win[0]}
        aria-valuemax={win[1]}
        aria-valuenow={now}
        aria-valuetext={fmtTime(now)}
        onKeyDown={(ev) => {
          const stepMs = (ev.shiftKey ? 24 : 1) * HOUR_MS
          if (ev.key === 'ArrowLeft') {
            ev.preventDefault()
            onSeek(Math.max(win[0], now - stepMs))
          } else if (ev.key === 'ArrowRight') {
            ev.preventDefault()
            onSeek(Math.min(win[1], now + stepMs))
          } else if (ev.key === 'Home') {
            ev.preventDefault()
            onSeek(win[0])
          } else if (ev.key === 'End') {
            ev.preventDefault()
            onSeek(win[1])
          }
        }}
        onPointerEnter={() => setHoveringStrip(true)}
        onPointerLeave={() => {
          setHoveringStrip(false)
          dragging.current = false
          guard.end()
        }}
        onDragStart={guard.onDragStart}
        onPointerDown={(ev) => {
          dragging.current = true
          guard.begin() // scrubbing must not start a browser text selection or an image-style drag
          ev.currentTarget.setPointerCapture(ev.pointerId)
          seekAt(ev)
        }}
        onPointerMove={(ev) => dragging.current && seekAt(ev)}
        onPointerUp={() => {
          dragging.current = false
          guard.end()
        }}
        onPointerCancel={() => {
          dragging.current = false
          guard.end()
        }}
      >
        <defs>
          <pattern id={hatchId} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width={6} height={6} fill={COLORS.unknownBg} />
            <line x1={0} y1={0} x2={0} y2={6} stroke={COLORS.unknown} strokeWidth={2} />
          </pattern>
        </defs>
        <text x={0} y={SUN_H / 2 + 4} fontSize={10} fill={COLORS.axis}>Sun</text>
        <text x={0} y={earthTop + EARTH_H / 2 + 4} fontSize={10} fill={COLORS.axis}>Earth</text>
        <rect x={GUTTER} y={0} width={w} height={SUN_H} fill={laneFill} />
        <rect x={GUTTER} y={earthTop} width={w} height={EARTH_H} fill={laneFill} />
        {/* Known hours: dark first (the Sun's shape goes on top), Earth known blocked. */}
        {data.sunKnownRuns.map((r) => {
          const s = span(r)
          return <rect key={`sk${r[0]}`} x={s.x} y={0} width={s.w} height={SUN_H} fill={COLORS.dark} />
        })}
        {data.earthBlockedRuns.map((r) => {
          const s = span(r)
          return <rect key={`eb${r[0]}`} x={s.x} y={earthTop} width={s.w} height={EARTH_H} fill={COLORS.dark} />
        })}
        {data.sunUnknownRuns.map((r) => {
          const s = span(r)
          return (
            <rect key={`su${r[0]}`} x={s.x} y={0} width={s.w} height={SUN_H} fill="transparent">
              <title>Sun unknown for {fmtDur(s.hours)}: terrain data is missing in that direction. Not darkness.</title>
            </rect>
          )
        })}
        {data.earthUnknownRuns.map((r) => {
          const s = span(r)
          return (
            <rect key={`eu${r[0]}`} x={s.x} y={earthTop} width={s.w} height={EARTH_H} fill="transparent">
              <title>Earth visibility unknown for {fmtDur(s.hours)}: terrain data is missing in that direction. Not a blackout.</title>
            </rect>
          )
        })}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={0} y2={earthTop + EARTH_H + 3} stroke={COLORS.grid} />
            {x(t) < GUTTER + w - 14 && (
              <text x={x(t)} y={STRIP_H - 3} fontSize={9} textAnchor="middle" fill={COLORS.axis}>{fmtDay(t)}</text>
            )}
          </g>
        ))}
        <path d={sunPath} fill={COLORS.sun} opacity={0.9} />
        {data.earthRuns.map((r) => {
          const s = span(r)
          return <rect key={r[0]} x={s.x} y={earthTop} width={s.w} height={EARTH_H} fill={COLORS.earth} opacity={0.85} />
        })}
        {dark && (
          <g>
            <rect x={dark.x} y={-0.5} width={dark.w} height={SUN_H + 1} fill="none" stroke={COLORS.gap} strokeWidth={1.5} rx={2}>
              <title>Longest darkness in this window: {fmtDur(dark.hours)}</title>
            </rect>
            {dark.w > 90 && <text x={dark.x + dark.w / 2} y={SUN_H / 2 + 4} fontSize={10} textAnchor="middle" fill="#ffb4b4">longest dark {fmtDur(dark.hours)}</text>}
          </g>
        )}
        {blackout && (
          <rect x={blackout.x} y={earthTop - 0.5} width={blackout.w} height={EARTH_H + 1} fill="none" stroke={COLORS.gap} strokeWidth={1.5} rx={2}>
            <title>Longest blackout in this window: {fmtDur(blackout.hours)}</title>
          </rect>
        )}
        {mission && mission.end > win[0] && mission.start < win[1] && (
          <g pointerEvents="none">
            <rect
              x={x(Math.max(mission.start, win[0]))}
              y={-2}
              width={Math.max(1, x(Math.min(mission.end, win[1])) - x(Math.max(mission.start, win[0])))}
              height={earthTop + EARTH_H + 4}
              fill="#ff634a"
              fillOpacity={0.1}
              stroke="#ff634a"
              strokeWidth={1}
              strokeDasharray="4 3"
              rx={3}
            />
            {mission.failures
              .filter((t) => t >= win[0] && t <= win[1])
              .map((t) => (
                <path key={t} d={`M${x(t) - 5},-2 L${x(t) + 5},-2 L${x(t)},6 Z`} fill="#ef4444" />
              ))}
          </g>
        )}
        {evidence && evidence.end >= win[0] && evidence.start <= win[1] && (() => {
          const color = evidence.dataMissing ? MISSING_COLOR : EVIDENCE_COLOR
          const a = x(Math.max(evidence.start, win[0]))
          const b = x(Math.min(evidence.end, win[1]))
          return (
            <g pointerEvents="none" data-testid="evidence-band" data-evidence-start={evidence.start} data-evidence-end={evidence.end}>
              {evidence.point ? (
                <line x1={a} x2={a} y1={-2} y2={earthTop + EARTH_H + 2} stroke={color} strokeWidth={2} strokeDasharray="2 2" />
              ) : (
                <rect x={a} y={-3} width={Math.max(2, b - a)} height={earthTop + EARTH_H + 6} fill={color} fillOpacity={evidence.dataMissing ? 0.22 : 0.16}
                  stroke={color} strokeWidth={1.5} strokeDasharray={evidence.dataMissing ? '1 3' : undefined} rx={3} />
              )}
            </g>
          )
        })()}
        {now >= win[0] && now <= win[1] && (() => {
          const px = x(now)
          const badgeX = Math.min(GUTTER + w - 42, Math.max(GUTTER + 42, px))
          return (
            <g pointerEvents="none">
              <line x1={px} x2={px} y1={0} y2={earthTop + EARTH_H + 2} stroke="#ff634a" strokeWidth={2} />
              <path d={`M${px - 4.5},0 L${px + 4.5},0 L${px},5.5 Z`} fill="#ff634a" />
              {(hoveringStrip || dragging.current) && (
                <g transform={`translate(${badgeX}, 1)`}>
                  <rect x={-40} y={0} width={80} height={15} rx={7.5} fill="#0f172a" fillOpacity={0.9} stroke="#ff634a" strokeWidth={1} />
                  <text x={0} y={10.5} fontSize={9} fontFamily="monospace" fontWeight={600} textAnchor="middle" fill="#ffffff">
                    {fmtTime(now).slice(5, 16)}
                  </text>
                </g>
              )}
            </g>
          )
        })()}
      </svg>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[10px] text-slate-400">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <span><span className="mr-1 inline-block h-2 w-3 align-middle" style={{ background: COLORS.sun }} />Sunlight (height = % of solar disk visible)</span>
          <span><span className="mr-1 inline-block h-2 w-3 align-middle" style={{ background: COLORS.earth }} />Earth in view</span>
          {data.sunKnownHours > 0 && data.sunLitHours === 0 && (
            <span className="text-amber-300" data-testid="no-sunlight-note">
              No sunlight in this window: the Sun stays below the terrain horizon (shadow, not missing data). Try another date or site.
            </span>
          )}
          {(data.sunUnknownHours > 0 || data.earthUnknownHours > 0) && (
            <span>
              <span
                className="mr-1 inline-block h-2 w-3 align-middle"
                style={{ background: `repeating-linear-gradient(45deg, ${COLORS.unknown} 0 2px, ${COLORS.unknownBg} 2px 4px)` }}
              />
              Unknown, not dark
              {data.sunUnknownHours > 0 ? ` · Sun ${fmtDur(data.sunUnknownHours)}` : ''}
              {data.earthUnknownHours > 0 ? ` · Earth ${fmtDur(data.earthUnknownHours)}` : ''}
            </span>
          )}
          <span><span className="mr-1 inline-block h-2 w-3 border align-middle" style={{ borderColor: COLORS.gap }} />
            Longest gap in window{dark ? ` · dark ${fmtDur(dark.hours)}` : ''}{blackout ? ` · blackout ${fmtDur(blackout.hours)}` : ''}</span>
          {evidence && (
            <span><span className="mr-1 inline-block h-2 w-3 border align-middle" style={{ borderColor: evidence.dataMissing ? MISSING_COLOR : EVIDENCE_COLOR, background: `${evidence.dataMissing ? MISSING_COLOR : EVIDENCE_COLOR}33` }} />
              {evidence.dataMissing ? 'Missing data (unknown, not dark or blocked)' : evidence.point ? 'Evidence moment' : 'Evidence window'}</span>
          )}
          {mission && (
            <span><span className="mr-1 inline-block h-2 w-3 border border-dashed align-middle" style={{ borderColor: '#ff634a' }} />
              {mission.label ?? 'Mission'}{mission.failures.length ? <> · <span className="text-red-400">▼</span> requirement broken</> : ''}</span>
          )}
        </div>
        {rightSlot}
      </div>
    </div>
  )
}

/** Playback controls, the window strip, and a slider over the whole data range. */
export function TimeBar({
  site,
  steps,
  win,
  windowDays,
  onWindowDays,
  loading,
  views,
  onHide,
  mission,
  evidence,
}: {
  site: SiteInfo
  steps: TimelineStep[]
  win: [number, number]
  windowDays: number
  onWindowDays: (d: number) => void
  loading: boolean
  onHide?: () => void // slides the panel off screen
  views?: ReactNode // camera view buttons, shown under the slider
  mission?: StripMission | null // mission playback: window band and failure markers on the strip
  evidence?: StripEvidence | null // "Show why": drawn alongside the mission band, never instead of it
}) {
  const timeUtc = useAppStore((s) => s.timeUtc)
  const setTime = useAppStore((s) => s.setTime)
  const [speed, setSpeed] = useState(SPEEDS[1].hoursPerSec)
  const [calendarOpen, setCalendarOpen] = useState(false)

  const start = parseUtc(site.data_start_utc)
  const stop = parseUtc(site.data_stop_utc)
  const now = parseUtc(timeUtc)
  usePlayback(speed, stop)

  const seek = (ms: number) => {
    setTime(toIsoMinute(Math.min(stop, Math.max(start, roundHour(ms)))))
    useTutorialStore.getState().recordInteraction('time-scrub')
  }
  const step = (hours: number) => seek(now + hours * HOUR_MS)
  const totalHours = Math.round((stop - start) / HOUR_MS)

  const stepBtn =
    'h-7 rounded-full px-2.5 text-xs font-medium tabular-nums text-slate-200 transition-colors hover:bg-calcite-peach/40 disabled:opacity-40'
  const selectCls =
    'h-8 cursor-pointer appearance-none rounded-full border border-opal-300 bg-panel-fill pl-3 pr-7 text-xs font-medium text-slate-200 transition-colors hover:border-coral/50 focus:border-coral focus:outline-none'

  const datePill = (
    <div className="ml-auto flex items-center gap-2">
      {loading && <LoadingIndicator size={22} contained={false} label="Loading timeline" />}
      <button
        type="button"
        onClick={() => setCalendarOpen((o) => !o)}
        aria-expanded={calendarOpen}
        aria-label={`Simulation time ${fmtTime(now)}. Click to open calendar.`}
        data-tip="Click to pick a date & time (UTC)"
        className="inline-flex h-6 items-center gap-1.5 rounded-full border border-opal-300 bg-panel-fill px-2.5 font-mono text-[11px] font-semibold tabular-nums text-slate-100 shadow-2xs transition-colors hover:border-coral hover:bg-calcite-peach/30"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden className="text-coral">
          <path d="M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V10h14v10zM5 8V6h14v2H5z" />
        </svg>
        {fmtTime(now)}
      </button>
    </div>
  )

  return (
    <div className="lp-light pointer-events-auto relative max-h-[48vh] overflow-y-auto rounded-t-[24px] bg-opal-50 px-4 pb-2.5 pt-2.5 text-xs shadow-lg shadow-black/30">
      <div className="relative mb-2 flex min-h-9 flex-wrap items-center justify-between gap-2">
        <div className="inline-flex items-center rounded-full border border-opal-300 bg-panel-fill p-0.5 shadow-2xs">
          <button type="button" className={stepBtn} onClick={() => step(-windowDays * 24)} aria-label={`Previous ${windowDays}-day window`} data-tip="Previous window">⏮</button>
          <span className="mx-0.5 h-4 w-px bg-opal-300" aria-hidden />
          <button type="button" className={stepBtn} onClick={() => step(-24)} aria-label="Step back 1 day" data-tip="Back 1 day">−1 d</button>
          <button type="button" className={stepBtn} onClick={() => step(-1)} aria-label="Step back 1 hour" data-tip="Back 1 hour">−1 h</button>
          <button type="button" className={stepBtn} onClick={() => step(1)} aria-label="Step forward 1 hour" data-tip="Forward 1 hour">+1 h</button>
          <button type="button" className={stepBtn} onClick={() => step(24)} aria-label="Step forward 1 day" data-tip="Forward 1 day">+1 d</button>
          <span className="mx-0.5 h-4 w-px bg-opal-300" aria-hidden />
          <button type="button" className={stepBtn} onClick={() => step(windowDays * 24)} aria-label={`Next ${windowDays}-day window`} data-tip="Next window">⏭</button>
        </div>

        {onHide && (
          <button
            type="button"
            onClick={onHide}
            aria-label="Hide timeline panel"
            data-tip="Hide timeline"
            className="absolute left-1/2 top-1/2 z-10 flex h-9 w-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-slate-300 transition-colors hover:bg-calcite-peach/40 hover:text-slate-100"
          >
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 8l7 7 7-7" />
            </svg>
          </button>
        )}

        <div className="ml-auto flex items-center gap-2.5">
          <label className="flex items-center gap-1.5 text-[11px] font-medium text-slate-400">
            Speed
            <span className="relative inline-flex items-center">
              <select className={selectCls} value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                {SPEEDS.map((s) => <option key={s.label} value={s.hoursPerSec}>{s.label}</option>)}
              </select>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="pointer-events-none absolute right-2.5 text-slate-400">
                <path d="M3 4.5l3 3 3-3" />
              </svg>
            </span>
          </label>
          <label className="flex items-center gap-1.5 text-[11px] font-medium text-slate-400">
            Window
            <span className="relative inline-flex items-center">
              <select className={selectCls} value={windowDays} onChange={(e) => onWindowDays(Number(e.target.value))}>
                {WINDOW_DAYS.map((d) => <option key={d} value={d}>{d} days</option>)}
              </select>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="pointer-events-none absolute right-2.5 text-slate-400">
                <path d="M3 4.5l3 3 3-3" />
              </svg>
            </span>
          </label>
        </div>
      </div>

      {steps.length ? (
        <Strip steps={steps} win={win} now={now} onSeek={seek} mission={mission} evidence={evidence} rightSlot={datePill} />
      ) : (
        <div className="flex flex-col justify-end pb-1" style={{ height: STRIP_H + 14 }}>
          <div className="flex items-center justify-end">{datePill}</div>
        </div>
      )}

      <div className="mt-1 flex items-center gap-2" data-tour="time-scrubber">
        <span className="shrink-0 text-[10px] tabular-nums text-slate-500">{site.data_start_utc.slice(0, 10)}</span>
        <MangoRange
          aria-label="Time across the whole data range"
          wrapperClassName="min-w-0 flex-1"
          min={0}
          max={totalHours}
          step={1}
          value={Math.round((now - start) / HOUR_MS)}
          onChange={(e) => seek(start + Number(e.target.value) * HOUR_MS)}
        />
        <span className="shrink-0 text-[10px] tabular-nums text-slate-500">{site.data_stop_utc.slice(0, 10)}</span>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        {views}
        <span className="min-w-0 flex-1 text-right text-[10px] leading-tight text-slate-500">
          {site.lat.toFixed(4)}°, {site.lon.toFixed(4)}°E · ground {Math.round(site.ground_height_m)} m · terrain: Moon Trek LOLA ·
          ephemeris: {site.kind === 'custom' ? 'JPL DE421 (local, checked against Horizons)' : 'JPL Horizons'} · drag to spin the Moon, right-drag to turn, scroll to zoom
        </span>
      </div>
      {calendarOpen && (
        <DatePopup
          timeUtc={timeUtc}
          min={site.data_start_utc}
          max={site.data_stop_utc}
          onPick={(iso) => {
            setTime(iso)
            useTutorialStore.getState().recordInteraction('date-pick')
          }}
          onClose={() => setCalendarOpen(false)}
        />
      )}
    </div>
  )
}
