// Sections 4–5: synchronized solar and Earth-communication timelines for every compared scenario.
// Wheel = zoom, drag = pan, click = select a moment (every panel follows), arrow keys = step.
import { memo, useEffect, useMemo, useRef, useState } from 'react'

import { fmtAxis, violationWindows, type Align, type Entry } from './analysis'
import { knownSpans, knownSunRuns, laneCoverage, timelineEarthRuns, unknownWindows, withheldNotes, type HourSpan, type LaneCoverage } from './lanes'
import { STATE } from './palette'
import type { TimelineColumns, Window } from './types'
import { ScenarioChip, btn } from './ui'
import { useCompareStore } from './useCompareStore'
import { clampView, hourTicks, panView, useWidth, zoomView } from './useTimeAxis'

// Label column width: full names on wide screens, just the scenario chip on phones.
const GUTTER_WIDE = 168
const GUTTER_NARROW = 60
const gutterFor = (width: number) => (width < 520 ? GUTTER_NARROW : GUTTER_WIDE)
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

/**
 * Area path of the visible solar-disk fraction inside a lane: one closed shape per run of known samples, so
 * an unknown stretch is a break in the shape (no sunlight drawn and none implied), never bridged across.
 */
function sunPath(tl: TimelineColumns, offset: number, x: (v: number) => number, view: [number, number], top: number) {
  const half = tl.step_hours / 2
  let d = ''
  for (const [a, b] of knownSunRuns(tl)) {
    const pts: string[] = []
    for (let i = a; i < b; i++) {
      const t = offset + tl.hour[i]
      if (t < view[0] - tl.step_hours || t > view[1] + tl.step_hours) continue
      const y = top + LANE - tl.sun_visible_fraction[i]! * LANE
      pts.push(`${x(t - half).toFixed(1)},${y.toFixed(1)}`, `${x(t + half).toFixed(1)},${y.toFixed(1)}`)
    }
    if (!pts.length) continue
    const first = pts[0].split(',')[0], last = pts[pts.length - 1].split(',')[0]
    d += `M${first},${top + LANE} L${pts.join(' L')} L${last},${top + LANE} Z `
  }
  return d
}

/** An engine window (with times and duration), as opposed to a span derived from the timeline samples. */
const isWindow = (s: HourSpan): s is Window => 'end_utc' in s && 'duration_hours' in s

const pctKnown = (c: LaneCoverage) => (c.knownHours === null || c.totalHours <= 0 ? null : Math.round((100 * c.knownHours) / c.totalHours))

const Lanes = memo(function Lanes({ e, top, x, view, w, gutter: GUTTER }: { e: Entry; top: number; x: (v: number) => number; view: [number, number]; w: number; gutter: number }) {
  const r = e.result!
  const o = e.offsetHours
  const clipX = (v: number) => Math.min(GUTTER + w, Math.max(GUTTER, x(v)))
  const rect = (win: HourSpan) => ({ x: clipX(o + win.start_hour), w: Math.max(0.5, clipX(o + win.end_hour) - clipX(o + win.start_hour)) })
  const missionA = clipX(o), missionB = clipX(o + (r.evaluated_duration_days ?? e.scenario.duration_days) * 24)
  const longDark = longest(r.dark_windows)
  const longBlack = longest(r.blackout_windows)
  const earthTop = top + LANE + LANE_GAP
  const span = view[1] - view[0]
  const showEvents = span <= 24 * 40
  // Earth: the engine's windows, or (never assessed) the timeline samples. Unknown samples are in neither.
  const engineEarth = r.earth_windows.length + r.blackout_windows.length + unknownWindows(r, 'earth').length > 0
  const earthIn = engineEarth || !r.timeline ? r.earth_windows : timelineEarthRuns(r.timeline, true)
  const earthOut = engineEarth || !r.timeline ? r.blackout_windows : timelineEarthRuns(r.timeline, false)
  const unknownTitle = (lane: 'Sun' | 'Earth', w: Window) =>
    `${lane} unknown ${fmtDur(w.duration_hours)}: ${w.start_utc} → ${w.end_utc}. No terrain or ephemeris data — ` +
    `not ${lane === 'Sun' ? 'darkness' : 'a blackout'}, and not counted as one.`
  return (
    <g>
      {/* mission extent: "no data" until known time is painted over it (incl. hours past the end of the data) */}
      <rect x={missionA} y={top} width={Math.max(0, missionB - missionA)} height={LANE} fill="url(#hatch-unknown)" />
      <rect x={missionA} y={earthTop} width={Math.max(0, missionB - missionA)} height={LANE} fill="url(#hatch-unknown)" />
      {/* solar lane: known time is night-coloured, the visible-disk fraction on top (partial Sun = lower fill) */}
      {knownSpans(r, 'sun').map((k) => {
        const b = rect(k)
        return <rect key={`k${k.start_hour}`} x={b.x} y={top} width={b.w} height={LANE} fill={STATE.dark} />
      })}
      {r.timeline && <path d={sunPath(r.timeline, o, x, view, top)} fill={STATE.sun} opacity={0.9} />}
      {unknownWindows(r, 'sun').map((win) => {
        const b = rect(win)
        return <rect key={`su${win.start_hour}`} x={b.x} y={top} width={b.w} height={LANE} fill="transparent"><title>{unknownTitle('Sun', win)}</title></rect>
      })}
      {longDark && longDark.duration_hours > 0 && (() => {
        const b = rect(longDark)
        return (
          <g>
            <rect x={b.x} y={top - 1} width={b.w} height={LANE + 2} fill="none" stroke={STATE.muted} strokeWidth={1} strokeDasharray="3 2" rx={2}>
              <title>Longest darkness (no solar disk visible): {fmtDur(longDark.duration_hours)} ({longDark.start_utc} → {longDark.end_utc})</title>
            </rect>
            {b.w > 70 && <text x={b.x + b.w / 2} y={top + LANE / 2 + 4} textAnchor="middle" fontSize={10} fill="#ffb4b4">longest dark {fmtDur(longDark.duration_hours)}</text>}
          </g>
        )
      })()}
      {/* Earth lane */}
      {earthIn.map((win) => {
        const b = rect(win)
        const tip = isWindow(win) ? `Earth in view ${fmtDur(win.duration_hours)}: ${win.start_utc} → ${win.end_utc}` : 'Earth in view'
        return <rect key={`e${win.start_hour}`} x={b.x} y={earthTop} width={b.w} height={LANE} fill={STATE.earth} opacity={0.85}><title>{tip}</title></rect>
      })}
      {earthOut.map((win) => {
        const b = rect(win)
        const tip = isWindow(win) ? `Blackout ${fmtDur(win.duration_hours)}: ${win.start_utc} → ${win.end_utc}` : 'Blackout (Earth below the terrain)'
        return <rect key={`b${win.start_hour}`} x={b.x} y={earthTop} width={b.w} height={LANE} fill="url(#hatch-blackout)"><title>{tip}</title></rect>
      })}
      {unknownWindows(r, 'earth').map((win) => {
        const b = rect(win)
        return <rect key={`eu${win.start_hour}`} x={b.x} y={earthTop} width={b.w} height={LANE} fill="transparent"><title>{unknownTitle('Earth', win)}</title></rect>
      })}
      {longBlack && longBlack.duration_hours > 0 && (() => {
        const b = rect(longBlack)
        return (
          <g>
            <rect x={b.x} y={earthTop - 1} width={b.w} height={LANE + 2} fill="none" stroke={STATE.muted} strokeWidth={1} strokeDasharray="3 2" rx={2} />
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
      {/* Requirement evidence from the engine: the windows behind a failed (red) or undecided (dashed) verdict. */}
      {violationWindows(r).map((v) => {
        const vx = clipX(o + v.start_hour), vw = Math.max(1, clipX(o + v.end_hour) - vx)
        const y = v.lane === 'sun' ? top : earthTop
        const fail = v.status === 'fail'
        return (
          <g key={`${v.constraintId}-${v.start_hour}`}>
            <rect x={vx} y={y - 2} width={vw} height={LANE + 4} fill="none" rx={2}
              stroke={fail ? STATE.blackout : STATE.muted} strokeWidth={fail ? 2.5 : 1.5} strokeDasharray={fail ? undefined : '4 3'}>
              <title>{v.text} · {v.start_utc} → {v.end_utc}</title>
            </rect>
            {vw > 14 && (
              // Sun-lane labels sit above the Sun lane, Earth-lane labels below the Earth lane, so they never cover a lane.
              <text x={vx + 3} y={v.lane === 'sun' ? y - 4 : y + LANE + 11} fontSize={9} fill={fail ? STATE.blackout : STATE.muted} fontWeight={600}>
                {fail ? '✕' : '?'} {vw > 120 ? v.name : ''}
              </text>
            )}
          </g>
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

  const GUTTER = gutterFor(width)
  const w = Math.max(100, width - GUTTER - 8)
  const x = useMemo(() => (v: number) => GUTTER + ((v - view[0]) / (view[1] - view[0])) * w, [view, w, GUTTER])
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
  }, [full, w, GUTTER])

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

  const violations = entries.flatMap((e) => violationWindows(e.result).map((v) => ({ e, v })))
  const jumpToViolation = () => {
    const first = [...violations].sort((a, b) => (a.e.offsetHours + a.v.start_hour) - (b.e.offsetHours + b.v.start_hour))[0]
    if (!first) return
    const a = first.e.offsetHours + first.v.start_hour, b = first.e.offsetHours + first.v.end_hour
    const pad = (b - a) * 0.3 + 6
    setView(clampView([a - pad, b + pad], full))
    setCursor((a + b) / 2)
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
        <button type="button" className={btn} onClick={jumpToViolation} disabled={!violations.length}
          title={violations.length ? 'Zoom to the first window the engine cites for a failed or undecided requirement' : 'No failed or undecided requirement has a time window'}>
          Go to first violation{violations.length ? ` (${violations.length})` : ''}
        </button>
        <span className="ml-auto text-[11px] text-slate-500">
          Showing {fmtAxis(view[0], align, originMs, span)} → {fmtAxis(view[1], align, originMs, span)} · wheel to zoom, drag to pan, click to select a time
        </span>
      </div>
      <div ref={boxRef} className="w-full min-w-0 max-w-full select-none overflow-hidden">
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
            {/* Unknown: grey, leaning the other way from the blackout hatch, so the two never read alike. */}
            <pattern id="hatch-unknown" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
              <rect width="6" height="6" fill={STATE.unknownBg} />
              <line x1="0" y1="0" x2="0" y2="6" stroke={STATE.unknown} strokeWidth="1.5" />
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
              return e.result ? <Lanes key={e.scenario.id} e={e} top={top} x={x} view={view} w={w} gutter={GUTTER} /> : (
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
            const r = e.result
            const sunCov = r ? laneCoverage(r, 'sun', e.scenario.duration_days) : null
            const earthCov = r ? laneCoverage(r, 'earth', e.scenario.duration_days) : null
            const partial = !!(sunCov && earthCov && sunCov.knownHours !== null && earthCov.knownHours !== null && !(sunCov.complete && earthCov.complete))
            const covTitle = partial
              ? `Hours with known data: Sun ${sunCov!.knownHours!.toFixed(1)} of ${sunCov!.totalHours.toFixed(1)} h, Earth ${earthCov!.knownHours!.toFixed(1)} of ${earthCov!.totalHours.toFixed(1)} h. The rest is unknown (hatched grey), not darkness or blackout.`
              : undefined
            return (
              <g key={e.scenario.id}>
                <foreignObject x={0} y={top - 2} width={GUTTER - 8} height={2 * LANE + LANE_GAP + 4}>
                  <div className="flex h-full flex-col justify-center gap-0.5 pr-1 text-[11px] leading-tight text-slate-300">
                    <div className="flex items-center gap-1.5 truncate"><ScenarioChip s={e.scenario} size="sm" /><span className="truncate">{e.scenario.site.name}</span></div>
                    {partial ? (
                      <div className="truncate text-[11px] text-amber-500" title={covTitle}>
                        known: Sun {pctKnown(sunCov!)}% · Earth {pctKnown(earthCov!)}%
                      </div>
                    ) : (
                      <div className="truncate text-[11px] text-slate-500">Sun · Earth</div>
                    )}
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
        <span className="flex items-center gap-1.5"><svg width="20" height="12"><rect width="20" height="12" fill="url(#hatch-unknown)" /></svg> Unknown (no data; not darkness or blackout)</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-5 rounded-sm border border-dashed" style={{ borderColor: STATE.muted }} /> Longest gap (measured)</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-5 rounded-sm border-2" style={{ borderColor: STATE.blackout }} /> ✕ Window behind a failed requirement</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-5 rounded-sm border-2 border-dashed" style={{ borderColor: STATE.muted }} /> ? Window behind an undecided requirement</span>
        <span>▲ rise · ▼ set</span>
      </div>
      <IncompleteDataNotes entries={entries} />
    </div>
  )
}

/** Per scenario: known hours per body and the backend's reasons for statistics it withheld (never shown as 0). */
function IncompleteDataNotes({ entries }: { entries: Entry[] }) {
  const rows = entries.flatMap((e) => {
    const r = e.result
    if (!r) return []
    const notes = withheldNotes(r)
    const sun = laneCoverage(r, 'sun', e.scenario.duration_days)
    const earth = laneCoverage(r, 'earth', e.scenario.duration_days)
    const unknownCount = (r.unknown_windows ?? []).length
    const partial = (sun.knownHours !== null && !sun.complete) || (earth.knownHours !== null && !earth.complete)
    if (!notes.length && !partial && !unknownCount) return []
    return [{ e, notes, sun, earth, unknownCount }]
  })
  if (!rows.length) return null
  const h = (v: number | null, total: number) => (v === null ? 'not reported' : `${v.toFixed(1)} of ${total.toFixed(1)} h`)
  return (
    <div className="mt-3 rounded-md border border-amber-600/40 bg-amber-500/5 p-2.5 text-[11px] text-slate-300" aria-label="Incomplete data">
      <div className="mb-1 font-medium text-amber-500">Incomplete data: what is unknown and what is withheld</div>
      <ul className="space-y-1.5">
        {rows.map(({ e, notes, sun, earth, unknownCount }) => (
          <li key={e.scenario.id}>
            <div className="flex flex-wrap items-center gap-1.5">
              <ScenarioChip s={e.scenario} size="sm" />
              <span className="text-slate-200">{e.scenario.site.name}</span>
              <span className="text-slate-500">
                · known Sun {h(sun.knownHours, sun.totalHours)} · known Earth {h(earth.knownHours, earth.totalHours)}
                {unknownCount ? ` · ${unknownCount} unknown window${unknownCount === 1 ? '' : 's'} (grey hatch)` : ''}
              </span>
            </div>
            {notes.map((n) => (
              <p key={n.blocks} className="mt-0.5 pl-1 text-slate-400">
                <b className="font-medium text-slate-300">{n.blocks} withheld:</b> {n.reason}
              </p>
            ))}
          </li>
        ))}
      </ul>
    </div>
  )
}
