import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAppStore } from '../store'
import { LoadingIndicator } from '../ui/LoadingIndicator'
import { MangoRange } from '../ui/MangoRange'
import type { SiteInfo, TimelineStep } from '../types'
import { DatePopup } from './DatePopup'
import { HOUR_MS, longestRun, parseUtc, roundHour, runs, sunUp, toIsoMinute } from './timeline'
import { useTutorialStore } from '../features/tutorial'

const COLORS = { sun: '#e8b84a', earth: '#5aa9f0', dark: '#111a2e', gap: '#d03b3b', grid: '#22304d', axis: '#5b6168' }
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

/** Advances the shared time while playing (one store update per data hour, not per frame). */
function usePlayback(hoursPerSec: number, dataStop: number) {
  const playing = useAppStore((s) => s.playing)
  useEffect(() => {
    if (!playing) return
    const { setTime, setPlaying } = useAppStore.getState()
    let acc = parseUtc(useAppStore.getState().timeUtc)
    let lastSet = useAppStore.getState().timeUtc
    let prev = performance.now()
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
      if (next !== lastSet) {
        lastSet = next
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
}

function Strip({
  steps,
  win,
  now,
  onSeek,
  mission,
  rightSlot,
}: {
  steps: TimelineStep[]
  win: [number, number]
  now: number
  onSeek: (ms: number) => void
  mission?: StripMission | null
  rightSlot?: ReactNode
}) {
  const [boxRef, width] = useWidth<HTMLDivElement>()
  const dragging = useRef(false)
  const [hoveringStrip, setHoveringStrip] = useState(false)
  const w = Math.max(50, width - GUTTER - 4)
  const x = (t: number) => GUTTER + ((t - win[0]) / (win[1] - win[0])) * w
  const inv = (px: number) => win[0] + ((px - GUTTER) / w) * (win[1] - win[0])

  const data = useMemo(() => {
    const t = steps.map((s) => parseUtc(s.time_utc))
    const earth = steps.map((s) => s.earth.visible === true)
    // Gaps only count hours known to be dark / blocked; unknown hours (custom sites with missing
    // terrain) neither extend nor break a gap's "known" status.
    const dark = steps.map((s) => s.sun.visible_fraction !== null && !sunUp(s.sun))
    const blocked = steps.map((s) => s.earth.visible === false)
    return { t, earthRuns: runs(earth), longDark: longestRun(dark), longBlackout: longestRun(blocked) }
  }, [steps])

  const span = (r: [number, number]) => {
    const a = data.t[r[0]] - HOUR_MS / 2
    const b = (data.t[r[1] - 1] ?? data.t[r[0]]) + HOUR_MS / 2
    return { x: x(a), w: Math.max(1, x(b) - x(a)), hours: (b - a) / HOUR_MS }
  }

  const sunPath = useMemo(() => {
    if (!data.t.length) return ''
    const pts: string[] = []
    data.t.forEach((t, i) => {
      const y = SUN_H - (steps[i].sun.visible_fraction ?? 0) * SUN_H
      pts.push(`${x(t - HOUR_MS / 2).toFixed(1)},${y.toFixed(1)}`, `${x(t + HOUR_MS / 2).toFixed(1)},${y.toFixed(1)}`)
    })
    return `M${pts[0].split(',')[0]},${SUN_H} L${pts.join(' L')} L${pts[pts.length - 1].split(',')[0]},${SUN_H} Z`
    // x depends on win and width
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, steps, win, width])

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
        }}
        onPointerDown={(ev) => {
          dragging.current = true
          ev.currentTarget.setPointerCapture(ev.pointerId)
          seekAt(ev)
        }}
        onPointerMove={(ev) => dragging.current && seekAt(ev)}
        onPointerUp={() => (dragging.current = false)}
      >
        <text x={0} y={SUN_H / 2 + 4} fontSize={10} fill={COLORS.axis}>Sun</text>
        <text x={0} y={earthTop + EARTH_H / 2 + 4} fontSize={10} fill={COLORS.axis}>Earth</text>
        <rect x={GUTTER} y={0} width={w} height={SUN_H} fill={COLORS.dark} />
        <rect x={GUTTER} y={earthTop} width={w} height={EARTH_H} fill={COLORS.dark} />
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
          <span><span className="mr-1 inline-block h-2 w-3 border align-middle" style={{ borderColor: COLORS.gap }} />
            Longest gap in window{dark ? ` · dark ${fmtDur(dark.hours)}` : ''}{blackout ? ` · blackout ${fmtDur(blackout.hours)}` : ''}</span>
          {mission && (
            <span><span className="mr-1 inline-block h-2 w-3 border border-dashed align-middle" style={{ borderColor: '#ff634a' }} />
              Mission{mission.failures.length ? <> · <span className="text-red-400">▼</span> requirement broken</> : ''}</span>
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
    'h-8 cursor-pointer appearance-none rounded-full border border-opal-300 bg-white pl-3 pr-7 text-xs font-medium text-slate-200 transition-colors hover:border-coral/50 focus:border-coral focus:outline-none'

  const datePill = (
    <div className="ml-auto flex items-center gap-2">
      {loading && <LoadingIndicator size={22} contained={false} label="Loading timeline" />}
      <button
        type="button"
        onClick={() => setCalendarOpen((o) => !o)}
        aria-expanded={calendarOpen}
        aria-label={`Simulation time ${fmtTime(now)}. Click to open calendar.`}
        data-tip="Click to pick a date & time (UTC)"
        className="inline-flex h-6 items-center gap-1.5 rounded-full border border-opal-300 bg-white px-2.5 font-mono text-[11px] font-semibold tabular-nums text-slate-100 shadow-2xs transition-colors hover:border-coral hover:bg-calcite-peach/30"
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
        <div className="inline-flex items-center rounded-full border border-opal-300 bg-white p-0.5 shadow-2xs">
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
        <Strip steps={steps} win={win} now={now} onSeek={seek} mission={mission} rightSlot={datePill} />
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
