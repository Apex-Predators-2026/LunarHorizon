// Section 6: Sun and Earth elevation over time (or clearance above the local terrain), plus the
// idealised panel incidence factor, all on the shared, synchronized time axis.
import { useState } from 'react'

import type { Align, Entry } from './analysis'
import { SeriesChart } from './SeriesChart'
import type { TimelineColumns } from './types'
import { Explain, ScenarioChip } from './ui'

type Mode = 'elevation' | 'clearance'

// Stable accessor functions so the memoised charts only recompute when data or view change.
const sunEl = (tl: TimelineColumns, i: number) => tl.sun_elevation_deg[i]
const sunClear = (tl: TimelineColumns, i: number) => tl.sun_elevation_deg[i] - tl.sun_horizon_deg[i]
const earthEl = (tl: TimelineColumns, i: number) => tl.earth_elevation_deg[i]
const earthClear = (tl: TimelineColumns, i: number) => tl.earth_elevation_deg[i] - tl.earth_horizon_deg[i]
const incidence = (tl: TimelineColumns, i: number) => tl.incidence_factor[i]
const deg = (v: number) => `${v.toFixed(2)}°`

export function ElevationCharts({ entries, view, align, originMs }: { entries: Entry[]; view: [number, number]; align: Align; originMs: number }) {
  const [mode, setMode] = useState<Mode>('elevation')
  const common = { entries, view, align, originMs }
  const clear = mode === 'clearance'
  const panels = [...new Set(entries.map((e) => e.result?.power?.panel_mode).filter(Boolean))]
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div role="radiogroup" aria-label="Elevation reference" className="inline-flex overflow-hidden rounded-md border border-[#25365a] text-xs">
          {(['elevation', 'clearance'] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
              className={`px-3 py-1 ${mode === m ? 'bg-cyan-700/40 text-cyan-100' : 'text-slate-400 hover:text-slate-200'}`}>
              {m === 'elevation' ? 'Elevation above flat horizon' : 'Clearance above local terrain'}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-400" aria-label="Legend">
          {entries.filter((e) => e.result?.timeline).map((e) => (
            <span key={e.scenario.id} className="flex items-center gap-1.5"><ScenarioChip s={e.scenario} size="sm" />{e.scenario.site.name}{e.result?.data_kind === 'demonstration' && <span className="text-amber-300">(demonstration data)</span>}</span>
          ))}
        </div>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <div>
          <h3 className="mb-1 text-xs font-semibold text-amber-200">☀ Sun {clear ? 'clearance above terrain' : 'elevation'}</h3>
          <SeriesChart {...common} value={clear ? sunClear : sunEl} unit="°" yLabel="degrees" format={deg}
            refLines={[{ y: 0, label: clear ? 'terrain line: below = blocked' : 'flat horizon' }]}
            ariaLabel={`Sun ${mode} over time for each compared scenario`} />
        </div>
        <div>
          <h3 className="mb-1 text-xs font-semibold text-sky-200">⊕ Earth {clear ? 'clearance above terrain (margin)' : 'elevation'}</h3>
          <SeriesChart {...common} value={clear ? earthClear : earthEl} unit="°" yLabel="degrees" format={deg}
            refLines={[{ y: 0, label: clear ? 'terrain line: below = no line of sight' : 'flat horizon' }]}
            ariaLabel={`Earth ${mode} over time for each compared scenario`} />
        </div>
      </div>
      <div className="mt-4">
        <h3 className="mb-1 text-xs font-semibold text-amber-200">Idealised solar incidence factor (0–1)</h3>
        <p className="mb-1 text-[11px] text-slate-500">
          visible solar disk × max(0, cos θ) for each scenario’s panel configuration ({panels.join(', ').replaceAll('_', ' ') || 'n/a'}).
          This is a geometric upper bound, not electrical power.
        </p>
        <SeriesChart {...common} value={incidence} unit="" yLabel="factor" format={(v) => v.toFixed(3)} yDomain={[0, 1]} height={180}
          ariaLabel="Idealised panel incidence factor over time for each scenario" />
      </div>
      <Explain title="Why can the Sun be up and the site still be dark?">
        <p>Elevation is measured from a perfectly flat horizon. Real terrain is not flat: a crater rim or ridge in the Sun’s direction can rise above it. Switch to <b>clearance above local terrain</b>: whenever a line drops below 0°, the terrain in that direction (LOLA elevation data) is higher than the Sun or Earth, so it is hidden even though it is above the flat horizon.</p>
        <p>At the south pole the Sun moves around the whole horizon once a month while staying within a few degrees of it (about ±1.5° at the pole itself, roughly ±5° at Malapert’s latitude), so the same site is lit when the Sun is over low terrain and dark when it passes behind a mountain.</p>
        <p>Earth hangs almost fixed in the sky (it only wobbles by a few degrees due to libration). Sites on the far side of a ridge from Earth can lose it for days.</p>
      </Explain>
    </div>
  )
}
