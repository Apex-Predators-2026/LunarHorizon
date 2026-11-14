import { useEffect, useRef, useState } from 'react'
import { InteractiveGrainGradient } from '../ui/InteractiveGrainGradient'
import { profileWaypointLabelAnchor, type MeasureAnalysis, type MeasureWaypoint, type ProfileSample } from './globe/measure'
import { fmtDistance } from './globe/overlays'
import { useDraggable } from './useDraggable'

const MARGIN = 8
const MIN_W = 320
const MIN_H = 76

type Dir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const HANDLES: { dir: Dir; cls: string; cursor: string }[] = [
  { dir: 'n', cls: 'left-3 right-3 top-0 h-1', cursor: 'ns-resize' },
  { dir: 's', cls: 'bottom-0 left-3 right-3 h-1.5', cursor: 'ns-resize' },
  { dir: 'e', cls: 'bottom-3 right-0 top-3 w-1.5', cursor: 'ew-resize' },
  { dir: 'w', cls: 'bottom-3 left-0 top-3 w-1.5', cursor: 'ew-resize' },
  { dir: 'ne', cls: 'right-0 top-0 h-3 w-3', cursor: 'nesw-resize' },
  { dir: 'nw', cls: 'left-0 top-0 h-3 w-3', cursor: 'nwse-resize' },
  { dir: 'se', cls: 'bottom-0 right-0 h-4 w-4', cursor: 'nwse-resize' },
  { dir: 'sw', cls: 'bottom-0 left-0 h-4 w-4', cursor: 'nesw-resize' },
]

const SPEEDS = [
  { id: 'eva', label: 'EVA (3.6 km/h)', kmh: 3.6 },
  { id: 'ltv', label: 'LTV (10 km/h)', kmh: 10.0 },
  { id: 'viper', label: 'Rover (0.5 km/h)', kmh: 0.5 },
] as const

export type MeasureDrawer = 'none' | 'profile' | 'points'

function fmtCoord(lat: number, lon: number, decimals = 3) {
  return `${Math.abs(lat).toFixed(decimals)}°${lat < 0 ? 'S' : 'N'}, ${lon.toFixed(decimals)}°E`
}

function fmtTraverseTime(distanceM: number, speedKmh: number) {
  const hours = distanceM / 1000 / speedKmh
  const mins = Math.round(hours * 60)
  if (mins < 1) return '<1m'
  if (mins < 60) return `${mins}m`
  return `${hours.toFixed(1)}h`
}

export function MeasureCard({
  armed,
  waypoints,
  selectedWaypointId,
  onSelectWaypoint,
  hoveredWaypointId,
  onHoverWaypoint,
  onRenameWaypoint,
  onDeleteWaypoint,
  analysis,
  hoveredSample,
  onHoverSample,
  onStartAtLander,
  onUndo,
  onClear,
  onClose,
  onAnalyseEndpoint,
  finestResM,
  drawer,
  onDrawerChange,
}: {
  armed: boolean
  waypoints: MeasureWaypoint[]
  selectedWaypointId: string | null
  onSelectWaypoint: (id: string | null) => void
  hoveredWaypointId: string | null
  onHoverWaypoint: (id: string | null) => void
  onRenameWaypoint: (id: string, name: string) => void
  onDeleteWaypoint: (id: string) => void
  analysis: MeasureAnalysis | null
  hoveredSample: ProfileSample | null
  onHoverSample: (s: ProfileSample | null) => void
  onStartAtLander: () => void
  onUndo: () => void
  onClear: () => void
  onClose: () => void
  onAnalyseEndpoint: (lat: number, lon: number) => void
  finestResM: number | null
  drawer: MeasureDrawer
  onDrawerChange: (d: MeasureDrawer) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(true)
  const [speedKmh, setSpeedKmh] = useState<number>(SPEEDS[0].kmh)
  const { pos, setPos, size, setSize, dragging, handlers, consumeClick, refit } = useDraggable(rootRef)
  const [customWidth, setCustomWidth] = useState<number | null>(null)

  useEffect(() => {
    const id = requestAnimationFrame(() => refit())
    return () => cancelAnimationFrame(id)
  }, [open, drawer, waypoints.length, refit])

  const onHeaderClick = () => {
    if (consumeClick()) return
    setOpen((o) => !o)
  }

  const startResize = (dir: Dir, cursor: string) => (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const r = rootRef.current!.getBoundingClientRect()
    const start = { x: e.clientX, y: e.clientY, l: r.left, t: r.top, w: r.width, h: r.height }
    const el = e.currentTarget
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      // pointer already released
    }
    document.body.style.cursor = cursor
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x
      const dy = ev.clientY - start.y
      let { l, t, w, h } = start
      if (dir.includes('e')) w = Math.min(Math.max(MIN_W, start.w + dx), window.innerWidth - start.l - MARGIN)
      if (dir.includes('w')) {
        w = Math.min(Math.max(MIN_W, start.w - dx), start.l + start.w - MARGIN)
        l = start.l + start.w - w
      }
      if (dir.includes('s')) h = Math.min(Math.max(MIN_H, start.h + dy), window.innerHeight - start.t - MARGIN)
      if (dir.includes('n')) {
        h = Math.min(Math.max(MIN_H, start.h - dy), start.t + start.h - MARGIN)
        t = start.t + start.h - h
      }
      setPos({ x: l, y: t })
      setSize({ w, h })
      setCustomWidth(w)
    }
    const up = () => {
      document.body.style.cursor = ''
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const pillBtn =
    'h-6 rounded-full border border-opal-300 bg-white px-2 text-[11px] font-medium text-slate-200 transition-colors hover:bg-calcite-peach/40 disabled:opacity-40'
  const tabBtn = (active: boolean) =>
    `h-6 rounded-full border px-2.5 text-[11px] font-medium transition-colors ${
      active
        ? 'border-coral bg-coral text-white'
        : 'border-opal-300 bg-white text-slate-200 hover:bg-calcite-peach/40'
    }`

  // SVG chart dimensions
  const W = 500
  const H = 96
  const padL = 38
  const padR = 12
  const padT = 18
  const padB = 16
  const pw = W - padL - padR
  const ph = H - padT - padB

  const samples = analysis?.samples ?? []
  const maxD = Math.max(1, analysis?.geodesicDistanceM ?? 1)
  const minH = analysis ? Math.min(analysis.minHeightM, ...samples.map((s) => s.losHeightM)) - 12 : 0
  const maxH = analysis ? Math.max(analysis.maxHeightM, ...samples.map((s) => s.losHeightM)) + 16 : 100
  const spanH = Math.max(10, maxH - minH)

  const xOf = (d: number) => padL + (d / maxD) * pw
  const yOf = (h: number) => padT + ph - ((h - minH) / spanH) * ph
  const slopeColor = (status: 'ok' | 'warn' | 'crit') =>
    status === 'crit' ? '#b42323' : status === 'warn' ? '#b45309' : '#17703f'

  const fixed = pos && size
  const cardWidth = customWidth ?? (open ? 500 : 320)

  return (
    <div
      ref={rootRef}
      role="region"
      aria-label="Lunar surface measurement and traverse tool"
      className={`md-reveal lp-light pointer-events-auto relative flex flex-col overflow-hidden rounded-[18px] border border-opal-300 bg-opal-50 text-xs text-slate-200 transition-shadow ${
        dragging ? 'shadow-2xl shadow-black/50' : 'shadow-lg shadow-black/30'
      }`}
      style={
        fixed
          ? {
              position: 'fixed',
              left: pos.x,
              top: pos.y,
              width: cardWidth,
              zIndex: 25,
            }
          : { width: `min(100%, ${cardWidth}px)` }
      }
    >
      {/* Coral Drag & Minimize Header Bar (matches FloatingSidebar.tsx) */}
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? 'Measure tool: drag to move, click to minimize' : 'Measure tool: drag to move, click to expand'}
        data-tip={open ? 'Drag to move anywhere · click to minimize' : 'Drag to move · click to expand'}
        {...handlers}
        onClick={onHeaderClick}
        className="flex h-5 w-full shrink-0 cursor-grab touch-none select-none items-center justify-between bg-coral px-3 text-[10px] font-medium text-white transition-[filter] hover:brightness-95 active:cursor-grabbing"
      >
        <InteractiveGrainGradient fill strength={1.6} patternScale={0.45} />
        <span className="relative z-10 truncate opacity-90">
          {!open && analysis
            ? `${fmtDistance(analysis.surfaceDistanceM)} · ${analysis.netElevationChangeM >= 0 ? '+' : '−'}${Math.round(Math.abs(analysis.netElevationChangeM))}m · ${analysis.maxSlopeDeg.toFixed(1)}° ${analysis.slopeStatus === 'crit' ? '✖' : analysis.slopeStatus === 'warn' ? '▲' : '✓'} · LOS ${analysis.losClear ? '●' : '▲'}`
            : `Measure (${waypoints.length} pt${waypoints.length === 1 ? '' : 's'})${armed ? ' · Click terrain' : ''}`}
        </span>
        <span aria-hidden className="relative z-10 mx-2 h-1 w-8 shrink-0 rounded-full bg-white/75" />
        <span className="relative z-10 shrink-0 opacity-90">{open ? 'Minimize ▾' : 'Expand ▸'}</span>
      </button>

      {/* Main Collapsible Body */}
      {open && (
        <div className="p-2.5 space-y-2">
          {/* Top Compact Control & Action Bar */}
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                className={pillBtn}
                onClick={onStartAtLander}
                data-tip="Anchor or prepend the active Lander position as Waypoint A"
              >
                + Lander
              </button>
              <button
                type="button"
                className={pillBtn}
                disabled={waypoints.length === 0}
                onClick={onUndo}
                data-tip="Undo last waypoint (Backspace)"
              >
                Undo
              </button>
              <button
                type="button"
                className={pillBtn}
                disabled={waypoints.length === 0}
                onClick={onClear}
                data-tip="Clear all waypoints"
              >
                Clear
              </button>
            </div>

            <div className="flex items-center gap-1">
              {analysis && (
                <button
                  type="button"
                  className={tabBtn(drawer === 'profile')}
                  onClick={() => {
                    onHoverSample(null)
                    onDrawerChange(drawer === 'profile' ? 'none' : 'profile')
                  }}
                  data-tip="Toggle LOLA DEM elevation & line-of-sight profile chart"
                >
                  Profile
                </button>
              )}
              {waypoints.length > 0 && (
                <button
                  type="button"
                  className={tabBtn(drawer === 'points')}
                  onClick={() => {
                    onHoverSample(null)
                    onDrawerChange(drawer === 'points' ? 'none' : 'points')
                  }}
                  data-tip="Inspect, rename, or delete individual waypoints"
                >
                  Points ({waypoints.length})
                </button>
              )}
              <button
                type="button"
                className="ml-0.5 flex h-6 w-6 items-center justify-center rounded-full text-slate-400 hover:bg-opal-300/50 hover:text-slate-100"
                onClick={onClose}
                aria-label="Close measurement tool"
                data-tip="Close measurement tool (Esc)"
              >
                ✕
              </button>
            </div>
          </div>

          {/* 0 or 1 Waypoint Compact Prompt */}
          {!analysis && (
            <div className="rounded-lg bg-white/60 px-2.5 py-1.5 text-[11px] text-slate-300">
              {waypoints.length === 0 ? (
                <span>
                  Click terrain to place <strong>Point A</strong> (or click <strong>+ Lander</strong>). Click any point’s pill to inspect/rename, or click <strong>×</strong> to remove.
                </span>
              ) : (
                <span className="font-mono tabular-nums">
                  <strong>{waypoints[0].label}{waypoints[0].name ? ` (${waypoints[0].name})` : ''}:</strong>{' '}
                  {fmtCoord(waypoints[0].lat, waypoints[0].lon)} · <strong>{Math.round(waypoints[0].heightM)} m</strong> — click terrain for Point B.
                </span>
              )}
            </div>
          )}

          {/* Minimalist Single-Row Telemetry Strip (when >= 2 waypoints exist) */}
          {analysis && (
            <div className="grid grid-cols-5 gap-1.5 rounded-xl border border-opal-300 bg-white/75 px-2.5 py-1.5 font-mono tabular-nums">
              <div data-tip="True 3D surface distance following LOLA terrain vs. great-circle geodesic distance">
                <div className="font-sans text-[9px] uppercase tracking-wider text-slate-400">Surface</div>
                <div className="text-xs font-semibold text-slate-100">{fmtDistance(analysis.surfaceDistanceM)}</div>
                <div className="text-[9.5px] text-slate-400">{fmtDistance(analysis.geodesicDistanceM)} arc</div>
              </div>

              <div data-tip="Net elevation delta from start to end, plus cumulative climb (+m) and descent (−m)">
                <div className="font-sans text-[9px] uppercase tracking-wider text-slate-400">Δ Elev</div>
                <div className="text-xs font-semibold text-slate-100">
                  {analysis.netElevationChangeM >= 0 ? '+' : '−'}
                  {Math.round(Math.abs(analysis.netElevationChangeM))} m
                </div>
                <div className="text-[9.5px] text-slate-400">
                  +{Math.round(analysis.totalAscentM)} / −{Math.round(analysis.totalDescentM)}m
                </div>
              </div>

              <div data-tip="Steepest grade along path. Artemis EVA limit ≤15°; VIPER/CLPS rover limit ≤20°.">
                <div className="font-sans text-[9px] uppercase tracking-wider text-slate-400">Max Slope</div>
                <div
                  className={`text-xs font-semibold ${
                    analysis.slopeStatus === 'crit'
                      ? 'text-red-300'
                      : analysis.slopeStatus === 'warn'
                        ? 'text-amber-300'
                        : 'text-emerald-300'
                  }`}
                >
                  {analysis.maxSlopeDeg.toFixed(1)}°{' '}
                  {analysis.slopeStatus === 'crit' ? '✖' : analysis.slopeStatus === 'warn' ? '▲' : '✓'}
                </div>
                <div className="font-sans text-[9.5px] text-slate-400">
                  {analysis.slopeStatus === 'crit'
                    ? 'Hazard >20°'
                    : analysis.slopeStatus === 'warn'
                      ? 'Caution ≤20°'
                      : 'Safe <10°'}
                </div>
              </div>

              <div data-tip="2 m mast direct Line-of-Sight clearance (accounting for lunar curvature d²/2R and terrain ridges)">
                <div className="font-sans text-[9px] uppercase tracking-wider text-slate-400">Relay LOS</div>
                <div className={`text-xs font-semibold ${analysis.losClear ? 'text-emerald-300' : 'text-red-300'}`}>
                  {analysis.losClear ? '● ' : '▲ '}
                  {analysis.losMinClearanceM >= 0 ? '+' : '−'}
                  {Math.abs(analysis.losMinClearanceM).toFixed(1)} m
                </div>
                <div className="text-[9.5px] text-slate-400">Curv −{analysis.curvatureDropM.toFixed(1)}m</div>
              </div>

              <div data-tip="Estimated traverse time, forward azimuth from true North, and nearest Moon Trek water-ice distance">
                <div className="font-sans text-[9px] uppercase tracking-wider text-slate-400">Traverse</div>
                <div className="text-xs font-semibold text-slate-100">
                  {fmtTraverseTime(analysis.surfaceDistanceM, speedKmh)} · {Math.round(analysis.initialBearingDeg)}°{analysis.compassRose}
                </div>
                <div className="text-[9.5px] text-slate-400">
                  {analysis.nearestIceDistanceM !== null
                    ? `Ice ${fmtDistance(analysis.nearestIceDistanceM)}`
                    : `LOLA ~${finestResM ?? 5}m`}
                </div>
              </div>
            </div>
          )}

          {/* Drawer 1: Interactive LOLA Elevation & Line-of-Sight Profile */}
          {drawer === 'profile' && analysis && (
            <div className="space-y-1 pt-0.5">
              <div className="flex flex-wrap items-center justify-between gap-1 text-[10px] text-slate-400">
                <span className="font-mono tabular-nums text-slate-200">
                  {hoveredSample
                    ? `${fmtDistance(hoveredSample.distanceM)} · Elev ${Math.round(hoveredSample.heightM)} m · Slope ${hoveredSample.slopeDeg.toFixed(1)}° · LOS ${hoveredSample.losClearanceM >= 0 ? '+' : '−'}${Math.abs(hoveredSample.losClearanceM).toFixed(1)} m`
                    : `LOLA DEM (~${finestResM ?? 5} m) · Dashed = 2 m Mast LOS`}
                </span>
                <select
                  value={speedKmh}
                  onChange={(e) => setSpeedKmh(Number(e.target.value))}
                  aria-label="Traverse mobility speed"
                  className="h-5 rounded border border-opal-300 bg-white px-1 text-[10px] text-slate-200"
                >
                  {SPEEDS.map((s) => (
                    <option key={s.id} value={s.kmh}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>

              <svg
                viewBox={`0 0 ${W} ${H}`}
                className="h-[92px] w-full cursor-crosshair touch-none rounded-lg border border-opal-300 bg-white/80"
                role="img"
                aria-label="Terrain elevation and slope profile along the measured path"
                onPointerMove={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  const svgX = ((e.clientX - rect.left) / rect.width) * W
                  if (svgX < padL || svgX > W - padR || !samples.length) {
                    onHoverSample(null)
                    return
                  }
                  const targetD = ((svgX - padL) / pw) * maxD
                  let best = samples[0]
                  let bestDiff = Math.abs(best.distanceM - targetD)
                  for (const s of samples) {
                    const diff = Math.abs(s.distanceM - targetD)
                    if (diff < bestDiff) {
                      best = s
                      bestDiff = diff
                    }
                  }
                  onHoverSample(best)
                }}
                onPointerLeave={() => onHoverSample(null)}
              >
                {[0, 0.5, 1].map((g) => {
                  const val = Math.round(minH + g * spanH)
                  const y = yOf(val)
                  return (
                    <g key={g}>
                      <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="#d3d3d5" strokeWidth="1" />
                      <text x={padL - 4} y={y + 3} textAnchor="end" fontSize="9" fill="#5b6168" fontFamily="monospace">
                        {val}m
                      </text>
                    </g>
                  )
                })}

                {samples.length > 1 && (
                  <path
                    d={`M ${xOf(0)} ${padT + ph} ${samples.map((s) => `L ${xOf(s.distanceM)} ${yOf(s.heightM)}`).join(' ')} L ${xOf(maxD)} ${padT + ph} Z`}
                    fill="rgba(60, 64, 68, 0.08)"
                  />
                )}

                {samples.length > 1 && (
                  <path
                    d={samples.map((s, idx) => `${idx === 0 ? 'M' : 'L'} ${xOf(s.distanceM)} ${yOf(s.heightM)}`).join(' ')}
                    fill="none"
                    stroke="transparent"
                  />
                )}

                {/* 2 m Mast Line-of-Sight ray */}
                {samples.length > 1 && (
                  <path
                    d={samples.map((s, idx) => `${idx === 0 ? 'M' : 'L'} ${xOf(s.distanceM)} ${yOf(s.losHeightM)}`).join(' ')}
                    fill="none"
                    stroke={analysis.losClear ? '#0ea5e9' : '#b42323'}
                    strokeWidth="1.3"
                    strokeDasharray="4 3"
                  />
                )}

                {/* Slope-colored terrain segments */}
                {samples.slice(0, -1).map((a, idx) => {
                  const b = samples[idx + 1]
                  return (
                    <line
                      key={idx}
                      x1={xOf(a.distanceM)}
                      y1={yOf(a.heightM)}
                      x2={xOf(b.distanceM)}
                      y2={yOf(b.heightM)}
                      stroke={slopeColor(b.slopeStatus)}
                      strokeWidth="2.3"
                      strokeLinecap="round"
                    />
                  )
                })}

                {/* Clickable Waypoint Dots on Profile */}
                {(() => {
                  let dCum = 0
                  return waypoints.map((wp, idx) => {
                    if (idx > 0) dCum += analysis.segments[idx - 1].geodesicDistanceM
                    const cx = xOf(dCum)
                    const cy = yOf(wp.heightM)
                    const isSel = wp.id === selectedWaypointId || wp.id === hoveredWaypointId
                    const { textAnchor, dx } = profileWaypointLabelAnchor(dCum, maxD)
                    return (
                      <g
                        key={wp.id}
                        className="cursor-pointer"
                        onPointerEnter={() => onHoverWaypoint(wp.id)}
                        onPointerLeave={() => onHoverWaypoint(null)}
                        onClick={(ev) => {
                          ev.stopPropagation()
                          onHoverSample(null)
                          onHoverWaypoint(null)
                          onSelectWaypoint(wp.id)
                          onDrawerChange('points')
                        }}
                      >
                        <circle
                          cx={cx}
                          cy={cy}
                          r={isSel ? '5.2' : '3.6'}
                          fill="#ff634a"
                          stroke="#ffffff"
                          strokeWidth="1.4"
                        />
                        <text
                          x={cx + dx}
                          y={Math.max(11, cy - 6)}
                          textAnchor={textAnchor}
                          fontSize="9.5"
                          fontWeight="bold"
                          fill="#1f2326"
                          paintOrder="stroke"
                          stroke="#ffffff"
                          strokeWidth="2.5"
                          strokeLinejoin="round"
                        >
                          {wp.name ? `${wp.label}:${wp.name.slice(0, 8)}` : wp.label}
                        </text>
                      </g>
                    )
                  })
                })()}

                {hoveredSample && (
                  <g>
                    <line
                      x1={xOf(hoveredSample.distanceM)}
                      y1={padT}
                      x2={xOf(hoveredSample.distanceM)}
                      y2={padT + ph}
                      stroke="#ff634a"
                      strokeWidth="1.1"
                    />
                    <circle
                      cx={xOf(hoveredSample.distanceM)}
                      cy={yOf(hoveredSample.heightM)}
                      r="3.8"
                      fill="#ff634a"
                      stroke="#ffffff"
                      strokeWidth="1.4"
                    />
                  </g>
                )}

                <text x={padL} y={H - 3} fontSize="9" fill="#5b6168" fontFamily="monospace">
                  0 m
                </text>
                <text x={padL + pw / 2} y={H - 3} textAnchor="middle" fontSize="9" fill="#5b6168" fontFamily="monospace">
                  {fmtDistance(maxD / 2)}
                </text>
                <text x={W - padR} y={H - 3} textAnchor="end" fontSize="9" fill="#5b6168" fontFamily="monospace">
                  {fmtDistance(maxD)}
                </text>
              </svg>
            </div>
          )}

          {/* Drawer 2: Customizable Waypoint Inspector & Renamer */}
          {drawer === 'points' && waypoints.length > 0 && (
            <div className="max-h-40 space-y-1 overflow-y-auto pr-0.5 pt-0.5">
              {waypoints.map((wp, idx) => {
                const stat = analysis?.waypointStats[idx]
                const isSelected = wp.id === selectedWaypointId
                const isHovered = wp.id === hoveredWaypointId
                return (
                  <div
                    key={wp.id}
                    onPointerEnter={() => onHoverWaypoint(wp.id)}
                    onPointerLeave={() => onHoverWaypoint(null)}
                    onClick={() => onSelectWaypoint(isSelected ? null : wp.id)}
                    className={`flex items-center justify-between gap-1.5 rounded-lg border px-2 py-1 text-[11px] transition-colors cursor-pointer ${
                      isSelected || isHovered
                        ? 'border-coral bg-coral/10'
                        : 'border-opal-300/80 bg-white/70 hover:bg-white'
                    }`}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-coral font-mono text-[10px] font-bold text-white">
                        {wp.label}
                      </span>
                      <input
                        type="text"
                        value={wp.name ?? ''}
                        placeholder={`Label ${wp.label}…`}
                        aria-label={`Custom name for waypoint ${wp.label}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          onSelectWaypoint(wp.id)
                        }}
                        onChange={(e) => onRenameWaypoint(wp.id, e.target.value)}
                        className="h-6 w-24 shrink-0 rounded border border-opal-300 bg-white px-1.5 text-[11px] font-medium text-slate-100 placeholder:text-slate-500 focus:border-coral focus:outline-none"
                      />
                      <span
                        className="truncate font-mono text-[10px] tabular-nums text-slate-400"
                        data-tip={`${fmtCoord(wp.lat, wp.lon, 4)} · Elevation ${Math.round(wp.heightM)} m`}
                      >
                        {fmtCoord(wp.lat, wp.lon, 2)}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] font-semibold tabular-nums text-slate-200">
                        · {Math.round(wp.heightM)}m
                      </span>
                    </div>

                    <div className="flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums">
                      {stat && idx > 0 ? (
                        <span
                          className={
                            stat.segmentSlopeStatus === 'crit'
                              ? 'text-red-300'
                              : stat.segmentSlopeStatus === 'warn'
                                ? 'text-amber-300'
                                : 'text-emerald-300'
                          }
                          data-tip={`Segment ${waypoints[idx - 1].label}→${wp.label}: ${fmtDistance(stat.segmentSurfaceM)}, cumulative ${fmtDistance(stat.cumulativeSurfaceM)}`}
                        >
                          +{fmtDistance(stat.segmentSurfaceM)} ({stat.segmentMaxSlopeDeg.toFixed(1)}°)
                        </span>
                      ) : (
                        <span className="text-slate-400">Origin</span>
                      )}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onAnalyseEndpoint(wp.lat, wp.lon)
                        }}
                        data-tip={`Promote Waypoint ${wp.label} to a custom landing site for full Sun & Earth analysis`}
                        className="rounded border border-opal-300 bg-white px-1.5 py-0.5 font-sans text-[10px] font-medium text-slate-200 hover:bg-calcite-peach/40"
                      >
                        Pin site
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onDeleteWaypoint(wp.id)
                        }}
                        aria-label={`Delete waypoint ${wp.label}`}
                        data-tip={`Remove Waypoint ${wp.label} (or click it again on the 3D terrain)`}
                        className="flex h-5 w-5 items-center justify-center rounded border border-opal-300 bg-white text-slate-300 hover:bg-red-950 hover:text-red-300"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* 8-Way Edge & Corner Resize Handles (matches FloatingSidebar.tsx) */}
      {open &&
        HANDLES.map((hd) => (
          <div
            key={hd.dir}
            aria-hidden
            className={`absolute z-10 touch-none ${hd.cls}`}
            style={{ cursor: hd.cursor }}
            onPointerDown={startResize(hd.dir, hd.cursor)}
          />
        ))}
    </div>
  )
}
