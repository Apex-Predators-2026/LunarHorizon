// Location comparison: each site's terrain horizon (LOLA, from the data engine's /horizon endpoint)
// with the Sun and Earth positions at the selected time. Shows directly why one site is lit and another dark.
import { scenarioDisplayName } from './scenario'
import { useEffect, useMemo, useState } from 'react'
import { CartesianGrid, ComposedChart, Line, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import type { Horizon } from '../../types'
import { conditionsAt, type Entry } from './analysis'
import { fetchHorizon } from './api'
import { STATE, seriesColor, seriesDash } from './palette'
import { Explain, ScenarioChip } from './ui'
import { useCompareStore } from './useCompareStore'

const cache = new Map<string, Promise<Horizon | null>>()
const loadHorizon = (id: string) => {
  if (!cache.has(id)) cache.set(id, fetchHorizon(id).catch(() => { cache.delete(id); return null }))
  return cache.get(id)!
}

const STEP = 2 // degrees of azimuth per plotted point

export function HorizonCompare({ entries }: { entries: Entry[] }) {
  const cursor = useCompareStore((s) => s.cursor)
  const [horizons, setHorizons] = useState<Record<string, Horizon | null>>({})
  const siteIds = useMemo(() => [...new Set(entries.filter((e) => e.result?.data_kind === 'real').map((e) => e.scenario.site.id))], [entries])

  useEffect(() => {
    let live = true
    for (const id of siteIds) {
      if (id in horizons) continue
      loadHorizon(id).then((h) => live && setHorizons((prev) => ({ ...prev, [id]: h })))
    }
    return () => { live = false }
  }, [siteIds, horizons])

  // One line per distinct site (same-site scenarios share a horizon; use the first one's colour).
  const lines = useMemo(() => {
    const seen = new Set<string>()
    return entries.filter((e) => {
      const id = e.scenario.site.id
      if (seen.has(id) || !horizons[id]) return false
      seen.add(id)
      return true
    })
  }, [entries, horizons])

  const rows = useMemo(() => {
    const out: Record<string, number>[] = []
    for (let a = 0; a <= 360; a += STEP) {
      const row: Record<string, number> = { az: a }
      for (const e of lines) {
        const h = horizons[e.scenario.site.id]!
        const i = Math.round((a % 360) / 0.5) % h.elevation_deg.length
        const el = h.elevation_deg[i]
        if (el !== null) row[e.scenario.id] = el // null = unknown terrain (custom sites): leave a gap
      }
      out.push(row)
    }
    return out
  }, [lines, horizons])

  const points = cursor === null ? [] : entries.flatMap((e) => {
    const c = conditionsAt(e, cursor)
    return c ? [{ e, c }] : []
  })
  // Positions that are unknown at the selected time are not drawn.
  const sunPts = points.flatMap(({ e, c }) => (c.sunAz === null || c.sunEl === null ? []
    : [{ az: c.sunAz, el: c.sunEl, s: e.scenario, lit: c.sunFraction !== null && c.sunFraction > 0 }]))
  const earthPts = points.flatMap(({ e, c }) => (c.earthAz === null || c.earthEl === null ? []
    : [{ az: c.earthAz, el: c.earthEl, s: e.scenario, vis: c.earthVisible === true }]))

  if (!siteIds.length) return <p className="text-xs text-slate-500">Terrain horizons are available for sites with real data only.</p>
  if (!lines.length) return <p className="animate-pulse text-xs text-slate-400">Loading LOLA terrain horizons…</p>

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-400" aria-label="Legend">
        {lines.map((e) => (
          <span key={e.scenario.id} className="flex items-center gap-1.5"><ScenarioChip s={e.scenario} size="sm" />{scenarioDisplayName(e.scenario)}</span>
        ))}
        <span>Sun (☀) and Earth (⊕) at the selected time: filled = visible, hollow = hidden</span>
      </div>
      <div style={{ height: 260 }} role="img" aria-label="Terrain horizon elevation by azimuth for each site, with Sun and Earth positions at the selected time">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 16, left: 4 }}>
            <CartesianGrid stroke={STATE.grid} vertical={false} />
            <XAxis dataKey="az" type="number" domain={[0, 360]} ticks={[0, 45, 90, 135, 180, 225, 270, 315, 360]}
              tickFormatter={(v: number) => ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W', 360: 'N' } as Record<number, string>)[v] ?? `${v}°`}
              tick={{ fill: STATE.axis, fontSize: 10 }} stroke={STATE.grid}
              label={{ value: 'Azimuth (clockwise from north)', position: 'insideBottom', dy: 14, fill: STATE.muted, fontSize: 10 }} />
            <YAxis tick={{ fill: STATE.axis, fontSize: 10 }} stroke={STATE.grid} width={44} tickFormatter={(v: number) => `${v}°`}
              label={{ value: 'elevation', angle: -90, position: 'insideLeft', fill: STATE.muted, fontSize: 10, dy: 30 }} />
            <Tooltip isAnimationActive={false} cursor={{ stroke: '#6b7076', strokeDasharray: '2 3' }}
              content={({ active, payload, label }) => active && payload?.length ? (
                <div className="cmp-tip">
                  <div className="mb-1 text-slate-300">Azimuth {Number(label).toFixed(0)}°</div>
                  {lines.map((e) => {
                    const v = payload.find((p) => p.dataKey === e.scenario.id)?.value
                    return v === undefined ? null : (
                      <div key={e.scenario.id} className="flex items-center gap-2"><ScenarioChip s={e.scenario} size="sm" /><span>{scenarioDisplayName(e.scenario)}</span><span className="tabular-nums">terrain {Number(v).toFixed(2)}°</span></div>
                    )
                  })}
                </div>
              ) : null} />
            {lines.map((e) => (
              <Line key={e.scenario.id} dataKey={e.scenario.id} stroke={seriesColor(e.scenario.colorSlot)}
                strokeDasharray={seriesDash(e.scenario.colorSlot)} strokeWidth={2} dot={false} isAnimationActive={false} />
            ))}
            {/* Markers are drawn as reference dots with the point data captured in the closure. */}
            {sunPts.map((pt) => (
              <ReferenceDot key={`sun-${pt.s.id}`} x={pt.az} y={pt.el} ifOverflow="extendDomain" r={6}
                shape={(p: { cx?: number; cy?: number }) => (
                  <g>
                    <circle cx={p.cx} cy={p.cy} r={6} fill={pt.lit ? STATE.sun : 'none'} stroke={seriesColor(pt.s.colorSlot)} strokeWidth={2} />
                    <text x={p.cx} y={(p.cy ?? 0) - 9} textAnchor="middle" fontSize={9} fill={STATE.ink}>{pt.s.label}☀</text>
                  </g>
                )} />
            ))}
            {earthPts.map((pt) => (
              <ReferenceDot key={`earth-${pt.s.id}`} x={pt.az} y={pt.el} ifOverflow="extendDomain" r={6}
                shape={(p: { cx?: number; cy?: number }) => (
                  <g>
                    <rect x={(p.cx ?? 0) - 5} y={(p.cy ?? 0) - 5} width={10} height={10} rx={2} fill={pt.vis ? STATE.earth : 'none'} stroke={seriesColor(pt.s.colorSlot)} strokeWidth={2} />
                    <text x={p.cx} y={(p.cy ?? 0) + 16} textAnchor="middle" fontSize={9} fill={STATE.ink}>{pt.s.label}⊕</text>
                  </g>
                )} />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {cursor === null && <p className="text-[11px] text-slate-500">Select a time on the timeline to place the Sun (●) and Earth (■) for each plan.</p>}
      <Explain title="Why does a small change in landing location matter?">
        <p>Each line is the skyline seen from that site, computed from LOLA elevation maps out to ~300 km. Where the Sun (●) sits above its site’s line, that site is lit; below it, the terrain casts the site into shadow.</p>
        <p>Because the polar Sun and Earth stay within a few degrees of the horizon, a skyline that is just 1° higher in one direction can mean days of darkness or lost contact. Moving a few kilometres onto a peak lowers the skyline in every direction, which is why ridge and summit sites are favoured.</p>
      </Explain>
    </div>
  )
}
