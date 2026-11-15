// Sections 4–5: synchronized solar and Earth-communication timelines for every compared scenario.
// Wheel = zoom, drag = pan, click = select a moment (every panel follows), arrow keys = step.
import { memo, useEffect, useMemo, useRef, useState } from 'react'

import { fmtAxis, type Align, type Entry } from './analysis'
import { STATE } from './palette'
import type { TimelineColumns, Window } from './types'
import { ScenarioChip, btn } from './ui'
import { useCompareStore } from './useCompareStore'
import { clampView, hourTicks, panView, useWidth, zoomView } from './useTimeAxis'

const GUTTER = 168
const LANE = 20
const LANE_GAP = 4
const ROW_GAP = 14
const AXIS_H = 26

const fmtDur = (h: number) => (h >= 48 ? `${(h / 24).toFixed(1)} d` : `${Math.round(h)} h`)

interface Props {
  entries: Entry[]
  full: [number, number]
  view: [number, number]
  align: Align
  originMs: number
}

function longest(ws: Window[]): Window | null {
  return ws.reduce<Window | null>((a, w) => (!a || w.duration_hours > a.duration_hours ? w : a), null)
}

/** Area path of the visible solar-disk fraction inside a lane. */
function sunPath(tl: TimelineColumns, offset: number, x: (v: number) => number, view: [number, number], top: number) {
  const pts: string[] = []
  const half = tl.step_hours / 2
  for (let i = 0; i < tl.hour.length; i++) {
    const t = offset + tl.hour[i]
    if (t < view[0] - tl.step_hours || t > view[1] + tl.step_hours) continue
    const frac = tl.sun_visible_fraction[i]
    if (frac === null) continue // unknown: no sunlight is drawn and none is implied
    const y = top + LANE - frac * LANE
    pts.push(`${x(t - half).toFixed(1)},${y.toFixed(1)}`, `${x(t + half).toFixed(1)},${y.toFixed(1)}`)
  }
  if (!pts.length) return ''
  const first = pts[0].split(',')[0], last = pts[pts.length - 1].split(',')[0]
  return `M${first},${top + LANE} L${pts.join(' L')} L${last},${top + LANE} Z`
}

const Lanes = memo(function Lanes({ e, top, x, view, w }: { e: Entry; top: number; x: (v: number) => number; view: [number, number]; w: number }) {
  const r = e.result!
  const o = e.offsetHours
  const clipX = (v: number) => Math.min(GUTTER + w, Math.max(GUTTER, x(v)))
  const rect = (win: Window) => ({ x: clipX(o + win.start_hour), w: Math.max(0.5, clipX(o + win.end_hour) - clipX(o + win.start_hour)) })
  const missionA = clipX(o), missionB = clipX(o + e.scenario.duration_days * 24)
  const longDark = longest(r.dark_windows)
  const longBlack = longest(r.blackout_windows)
  const earthTop = top + LANE + LANE_GAP
  const span = view[1] - view[0]
  const showEvents = span <= 24 * 40
  return (
    <g>
      {/* mission extent */}
      <rect x={missionA} y={top} width={Math.max(0, missionB - missionA)} height={LANE} fill={STATE.dark} />
      <rect x={missionA} y={earthTop} width={Math.max(0, missionB - missionA)} height={LANE} fill={STATE.dark} />
      {/* solar lane: visible-disk fraction (partial Sun shows as a lower fill) */}
      {r.timeline && <path d={sunPath(r.timeline, o, x, view, top)} fill={STATE.sun} opacity={0.9} />}
      {longDark && longDark.duration_hours > 0 && (() => {
        const b = rect(longDark)
        return (
          <g>
            <rect x={b.x} y={top - 1} width={b.w} height={LANE + 2} fill="none" stroke={STATE.blackout} strokeWidth={1.5} rx={2}>
              <title>Longest darkness: {fmtDur(longDark.duration_hours)} ({longDark.start_utc} → {longDark.end_utc})</title>
            </rect>
            {b.w > 70 && <text x={b.x + b.w / 2} y={top + LANE / 2 + 4} textAnchor="middle" fontSize={10} fill="#ffb4b4">longest dark {fmtDur(longDark.duration_hours)}</text>}
          </g>
        )
      })()}
      {/* Earth lane */}
      {r.earth_windows.map((win) => {
        const b = rect(win)
        return <rect key={`e${win.start_hour}`} x={b.x} y={earthTop} width={b.w} height={LANE} fill={STATE.earth} opacity={0.85}><title>Earth in view {fmtDur(win.duration_hours)}: {win.start_utc} → {win.end_utc}</title></rect>
      })}
      {r.blackout_windows.map((win) => {
        const b = rect(win)
        return <rect key={`b${win.start_hour}`} x={b.x} y={earthTop} width={b.w} height={LANE} fill="url(#hatch-blackout)"><title>Blackout {fmtDur(win.duration_hours)}: {win.start_utc} → {win.end_utc}</title></rect>
      })}
      {longBlack && longBlack.duration_hours > 0 && (() => {
        const b = rect(longBlack)
        return (
          <g>
            <rect x={b.x} y={earthTop - 1} width={b.w} height={LANE + 2} fill="none" stroke={STATE.blackout} strokeWidth={1.5} rx={2} />
            {b.w > 80 && <text x={b.x + b.w / 2} y={earthTop + LANE / 2 + 4} textAnchor="middle" fontSize={10} fill="#ffd0d0" style={{ paintOrder: 'stroke' }} stroke="#1a0b12" strokeWidth={3}>longest blackout {fmtDur(longBlack.duration_hours)}</text>}
          </g>
        )
      })()}
      {showEvents && r.events.map((ev) => {
        const t = o + ev.hour
        if (t < view[0] || t > view[1]) return null
        const px = x(t)
        const sun = ev.type === 'sunrise' || ev.type === 'sunset'
        const y = sun ? top : earthTop
        const up = ev.type === 'sunrise' || ev.type === 'earthrise'
        return (
          <path key={`${ev.type}${ev.hour}`} d={up ? `M${px - 4},${y - 1} L${px + 4},${y - 1} L${px},${y - 7} Z` : `M${px - 4},${y - 7} L${px + 4},${y - 7} L${px},${y - 1} Z`}
            fill={sun ? STATE.sun : STATE.earth} stroke="#1f2326" strokeWidth={0.5}>
            <title>{ev.type} · {ev.time_utc}</title>
          </path>
        )
      })}
      {/* data-kind marker */}
      {r.data_kind === 'demonstration' && (
        <text x={missionA + 4} y={top + 12} fontSize={9} fill="#fcd34d">Demonstration data</text>
      )}
    </g>
  )
})

export function SyncTimeline({ entries, full, view, align, originMs }: Props) {
  const cursor = useCompareStore((s) => s.cursor)
  const setCursor = useCompareStore((s) => s.setCursor)
  const setView = useCompareStore((s) => s.setView)
  const [boxRef, width] = useWidth<HTMLDivElement>()
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<{ x0: number; view: [number, number]; moved: boolean } | null>(null)
  const [hover, setHover] = useState<number | null>(null)

  const w = Math.max(100, width - GUTTER - 8)
  const x = useMemo(() => (v: number) => GUTTER + ((v - view[0]) / (view[1] - view[0])) * w, [view, w])
  const inv = (px: number) => view[0] + ((px - GUTTER) / w) * (view[1] - view[0])
  const rowH = 2 * LANE + LANE_GAP + ROW_GAP
  const height = AXIS_H + entries.length * rowH + 4
  const ticks = hourTicks(view, Math.max(3, Math.floor(w / 90)))
  const minStep = Math.min(...entries.map((e) => e.result?.timeline?.step_hours ?? 1), 1)

  // Native, non-passive wheel listener so the page does not scroll while zooming.
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (ev: WheelEvent) => {
      const rect = el.getBoundingClientRect()
      const px = ev.clientX - rect.left
      if (px < GUTTER) return
      ev.preventDefault()
      const st = useCompareStore.getState()
      const cur = st.view ? clampView(st.view, full) : full
      const anchor = cur[0] + ((px - GUTTER) / w) * (cur[1] - cur[0])
      if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) st.setView(panView(cur, full, ev.deltaX / 600))
      else st.setView(zoomView(cur, full, ev.deltaY > 0 ? 1.25 : 0.8, anchor))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [full, w])

  const localX = (ev: React.PointerEvent) => ev.clientX - svgRef.current!.getBoundingClientRect().left

  const onKey = (ev: React.KeyboardEvent) => {
    const step = ev.shiftKey ? 24 : minStep
    const c = cursor ?? (view[0] + view[1]) / 2
    if (ev.key === 'ArrowRight') setCursor(Math.min(full[1], c + step))
    else if (ev.key === 'ArrowLeft') setCursor(Math.max(full[0], c - step))
    else if (ev.key === '+' || ev.key === '=') setView(zoomView(view, full, 0.7, cursor ?? undefined))
    else if (ev.key === '-') setView(zoomView(view, full, 1.4, cursor ?? undefined))
    else return
    ev.preventDefault()
  }

  const jumpToLongest = (kind: 'dark' | 'blackout') => {
    let best: { e: Entry; w: Window } | null = null
    for (const e of entries) {
      const win = longest(kind === 'dark' ? e.result?.dark_windows ?? [] : e.result?.blackout_windows ?? [])
      if (win && (!best || win.duration_hours > best.w.duration_hours)) best = { e, w: win }
    }
    if (!best) return
    const a = best.e.offsetHours + best.w.start_hour, b = best.e.offsetHours + best.w.end_hour
    const pad = (b - a) * 0.3 + 6
    setView(clampView([a - pad, b + pad], full))
    setCursor((a + b) / 2)
  }

  const span = view[1] - view[0]
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <button type="button" className={btn} onClick={() => setView(zoomView(view, full, 0.6, cursor ?? undefined))} aria-label="Zoom in">＋ Zoom in</button>
        <button type="button" className={btn} onClick={() => setView(zoomView(view, full, 1.6, cursor ?? undefined))} aria-label="Zoom out">－ Zoom out</button>
        <button type="button" className={btn} onClick={() => setView(panView(view, full, -0.4))} aria-label="Move earlier">◀</button>
        <button type="button" className={btn} onClick={() => setView(panView(view, full, 0.4))} aria-label="Move later">▶</button>
        <button type="button" className={btn} onClick={() => setView(null)}>Whole mission</button>
        <span className="mx-1 h-4 w-px bg-slate-700" aria-hidden="true" />
        <button type="button" className={btn} onClick={() => jumpToLongest('dark')}>Go to longest darkness</button>
        <button type="button" className={btn} onClick={() => jumpToLongest('blackout')}>Go to longest blackout</button>
        <span className="ml-auto text-[11px] text-slate-500">
          Showing {fmtAxis(view[0], align, originMs, span)} → {fmtAxis(view[1], align, originMs, span)} · wheel to zoom, drag to pan, click to select a time
        </span>
      </div>
      <div ref={boxRef} className="w-full select-none">
        <svg ref={svgRef} width={width} height={height} role="application" tabIndex={0} onKeyDown={onKey}
          aria-label="Synchronized sunlight and Earth-visibility timeline. Use arrow keys to move the selected time, plus and minus to zoom."
          className="touch-none rounded-md outline-none focus-visible:ring-1 focus-visible:ring-cyan-600"
          onPointerDown={(ev) => {
            if (localX(ev) < GUTTER) return
            ;(ev.target as Element).setPointerCapture?.(ev.pointerId)
            drag.current = { x0: ev.clientX, view, moved: false }
          }}
          onPointerMove={(ev) => {
            const px = localX(ev)
            setHover(px >= GUTTER ? inv(px) : null)
            const d = drag.current
            if (!d) return
            const dx = ev.clientX - d.x0
            if (Math.abs(dx) > 3) d.moved = true
            if (d.moved) {
              const dh = (-dx / w) * (d.view[1] - d.view[0])
              setView(clampView([d.view[0] + dh, d.view[1] + dh], full))
            }
          }}
          onPointerUp={(ev) => {
            const d = drag.current
            drag.current = null
            if (d && !d.moved) setCursor(Math.min(full[1], Math.max(full[0], inv(localX(ev)))))
          }}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <pattern id="hatch-blackout" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="#2a0f18" />
              <line x1="0" y1="0" x2="0" y2="6" stroke={STATE.blackout} strokeWidth="2" opacity="0.7" />
            </pattern>
            <clipPath id="tl-plot"><rect x={GUTTER} y={0} width={w} height={height} /></clipPath>
          </defs>
          {/* axis */}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={AXIS_H - 6} y2={height} stroke={STATE.grid} strokeWidth={1} />
              <text x={x(t)} y={AXIS_H - 10} textAnchor={x(t) > GUTTER + w - 24 ? 'end' : x(t) < GUTTER + 24 ? 'start' : 'middle'} fontSize={10} fill={STATE.axis}>{fmtAxis(t, align, originMs, span)}</text>
            </g>
          ))}
          <g clipPath="url(#tl-plot)">
            {entries.map((e, i) => {
              const top = AXIS_H + i * rowH
              return e.result ? <Lanes key={e.scenario.id} e={e} top={top} x={x} view={view} w={w} /> : (
                <text key={e.scenario.id} x={GUTTER + 8} y={top + LANE + 4} fontSize={11} fill={STATE.muted}>
                  {e.state?.state === 'loading' ? 'Loading…' : 'No scientific data for this scenario'}
                </text>
              )
            })}
            {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={AXIS_H - 4} y2={height} stroke="#6b7076" strokeDasharray="2 3" opacity={0.7} />}
            {cursor !== null && cursor >= view[0] && cursor <= view[1] && (
              <g>
                <line x1={x(cursor)} x2={x(cursor)} y1={AXIS_H - 6} y2={height} stroke="#d9472f" strokeWidth={1.5} />
                <rect x={x(cursor) - 3} y={AXIS_H - 8} width={6} height={6} fill="#d9472f" transform={`rotate(45 ${x(cursor)} ${AXIS_H - 5})`} />
              </g>
            )}
          </g>
          {/* gutter labels */}
          {entries.map((e, i) => {
            const top = AXIS_H + i * rowH
            return (
              <g key={e.scenario.id}>
                <foreignObject x={0} y={top - 2} width={GUTTER - 8} height={2 * LANE + LANE_GAP + 4}>
                  <div className="flex h-full flex-col justify-center gap-0.5 pr-1 text-[11px] leading-tight text-slate-300">
                    <div className="flex items-center gap-1.5 truncate"><ScenarioChip s={e.scenario} size="sm" /><span className="truncate">{e.scenario.site.name}</span></div>
                    <div className="truncate text-[11px] text-slate-500">Sun · Earth</div>
                  </div>
                </foreignObject>
              </g>
            )
          })}
        </svg>
      </div>
      <input type="range" aria-label="Selected time" className="mt-2 w-full"
        min={full[0]} max={full[1]} step={minStep} value={cursor ?? full[0]}
        style={{ marginLeft: 0 }} onChange={(ev) => {
          const c = Number(ev.target.value)
          setCursor(c)
          if (c < view[0] || c > view[1]) setView(clampView([c - span / 2, c + span / 2], full))
        }} />
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400" aria-label="Legend">
        <span className="flex items-center gap-1.5"><span className="h-3 w-5 rounded-sm" style={{ background: STATE.sun }} /> Sunlight (height = visible share of solar disk)</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-5 rounded-sm border border-slate-700" style={{ background: STATE.dark }} /> Darkness</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-5 rounded-sm" style={{ background: STATE.earth }} /> Earth in line of sight</span>
        <span className="flex items-center gap-1.5"><svg width="20" height="12"><rect width="20" height="12" fill="url(#hatch-blackout)" /></svg> Communication blackout</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-5 rounded-sm border-2" style={{ borderColor: STATE.blackout }} /> Longest gap</span>
        <span>▲ rise · ▼ set</span>
      </div>
    </div>
  )
}
