// Multi-scenario chart on the shared time axis (Recharts). One series per scenario, coloured and dashed by scenario,
// with the selected time drawn as a reference line. Click selects a time. Drawn as steps: each sample holds until the
// next (the engine's sample-and-hold). Unknown data breaks the line (never connected through) and reads "Unknown" in
// the tooltip; a measured zero stays a zero.
import { memo, useMemo } from 'react'
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { fmtAxis, mergeSeries, type Align, type Entry } from './analysis'
import { STATE, seriesColor, seriesDash } from './palette'
import type { TimelineColumns } from './types'
import { TooltipBox } from './ui'
import { useCompareStore } from './useCompareStore'

interface Props {
  entries: Entry[]
  view: [number, number]
  align: Align
  originMs: number
  value: (tl: TimelineColumns, i: number) => number | null
  unit: string
  yLabel: string
  format: (v: number) => string
  yDomain?: [number | 'auto' | 'dataMin' | 'dataMax', number | 'auto' | 'dataMin' | 'dataMax']
  refLines?: { y: number; label: string; color?: string }[]
  height?: number
  ariaLabel: string
}

function ChartInner({ entries, view, align, originMs, value, unit, yLabel, format, yDomain = ['auto', 'auto'], refLines = [], height = 220, ariaLabel }: Props) {
  const cursor = useCompareStore((s) => s.cursor)
  const setCursor = useCompareStore((s) => s.setCursor)
  const rows = useMemo(() => mergeSeries(entries, value, view), [entries, value, view])
  const withData = entries.filter((e) => e.result?.timeline)
  const span = view[1] - view[0]

  if (!withData.length) return <p className="py-8 text-center text-xs text-slate-500">No timeline data to plot.</p>

  return (
    <div role="img" aria-label={ariaLabel} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}
          onClick={(st) => {
            const i = st?.activeIndex
            if (i !== undefined && i !== null && rows[Number(i)]) setCursor(rows[Number(i)].x)
          }}>
          <CartesianGrid stroke={STATE.grid} strokeDasharray="0" vertical={false} />
          <XAxis dataKey="x" type="number" domain={view} allowDataOverflow tick={{ fill: STATE.axis, fontSize: 10 }}
            tickFormatter={(v: number) => fmtAxis(v, align, originMs, span)} stroke={STATE.grid} minTickGap={40} />
          <YAxis domain={yDomain} tick={{ fill: STATE.axis, fontSize: 10 }} stroke={STATE.grid} width={48}
            tickFormatter={(v: number) => `${Number(v.toFixed(2))}${unit}`}
            label={{ value: yLabel, angle: -90, position: 'insideLeft', fill: STATE.muted, fontSize: 10, dy: 40 }} />
          {refLines.map((r) => (
            <ReferenceLine key={r.label} y={r.y} stroke={r.color ?? STATE.axis} strokeDasharray="4 4"
              label={{ value: r.label, position: 'insideTopRight', fill: STATE.muted, fontSize: 10 }} />
          ))}
          {cursor !== null && <ReferenceLine x={cursor} stroke="var(--color-accent)" strokeWidth={1.5} />}
          <Tooltip
            isAnimationActive={false}
            cursor={{ stroke: STATE.muted, strokeDasharray: '2 3' }}
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <TooltipBox
                  title={fmtAxis(Number(label), align, originMs, 0)}
                  rows={withData
                    .map((e) => ({ s: e.scenario, v: payload.find((p) => p.dataKey === e.scenario.id)?.value }))
                    .filter((r) => r.v !== undefined)
                    .map((r) => ({ s: r.s, text: r.v === null ? 'Unknown (no data)' : format(Number(r.v)) }))}
                />
              ) : null
            }
          />
          {withData.map((e) => (
            <Line key={e.scenario.id} dataKey={e.scenario.id} name={`Plan ${e.scenario.label}`} type="stepAfter"
              stroke={seriesColor(e.scenario.colorSlot)} strokeDasharray={seriesDash(e.scenario.colorSlot)}
              strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: STATE.surface }}
              connectNulls={false} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

export const SeriesChart = memo(ChartInner)
