// Conditions at the selected moment for every scenario, with the reason for light/dark and Earth in/out of view.
import { fmtUtc } from '../rescue/format'
import { conditionsAt, fmtAxis, type Align, type Entry } from './analysis'
import { ScenarioChip } from './ui'
import { useCompareStore } from './useCompareStore'

const d2 = (v: number) => `${v.toFixed(2)}°`
const az = (v: number) => `${v.toFixed(1)}°`

export function ConditionsPanel({ entries, align, originMs }: { entries: Entry[]; align: Align; originMs: number }) {
  const cursor = useCompareStore((s) => s.cursor)
  if (cursor === null) {
    return <p className="text-xs text-slate-400">Click anywhere on the timeline or a chart to see the conditions at that moment in every scenario.</p>
  }
  return (
    <div>
      <p className="mb-2 text-xs text-slate-300">
        Selected: <b className="text-slate-100">{fmtAxis(cursor, align, originMs, 0)}</b>
        {align === 'met' ? ' after each landing' : ''} — sampled at the nearest timeline point.
      </p>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {entries.map((e) => {
          const c = conditionsAt(e, cursor)
          return (
            <div key={e.scenario.id} className="rounded-lg border border-[#1c2a48] bg-[#08111f] p-2.5 text-xs">
              <div className="mb-1.5 flex items-center gap-2">
                <ScenarioChip s={e.scenario} size="sm" />
                <span className="truncate text-slate-200">{e.scenario.site.name}</span>
              </div>
              {!c ? (
                <p className="text-slate-500">{e.result ? 'Outside this mission’s time span.' : 'No data.'}</p>
              ) : (
                <>
                  <p className="text-[11px] text-slate-400">{fmtUtc(c.time_utc)} · T+{Math.round(c.met)} h</p>
                  <div className={`mt-1.5 rounded px-2 py-1 ${c.sunFraction > 0 ? 'bg-amber-950/40 text-amber-200' : 'bg-slate-900 text-slate-300'}`}>
                    <div className="font-medium">☀ {c.sunReason}</div>
                    <div className="mt-0.5 grid grid-cols-2 gap-x-2 text-[11px] tabular-nums text-slate-300">
                      <span>Elevation {d2(c.sunEl)}</span><span>Azimuth {az(c.sunAz)}</span>
                      <span>Terrain {d2(c.sunHorizon)}</span><span>Disk {Math.round(c.sunFraction * 100)}%</span>
                      <span className="col-span-2" title="Idealised: visible disk × max(0, cos θ)">Incidence factor {c.incidence.toFixed(3)} (idealised)</span>
                    </div>
                  </div>
                  <div className={`mt-1.5 rounded px-2 py-1 ${c.earthVisible ? 'bg-sky-950/50 text-sky-200' : 'bg-red-950/40 text-red-200'}`}>
                    <div className="font-medium">⊕ {c.earthReason}</div>
                    <div className="mt-0.5 grid grid-cols-2 gap-x-2 text-[11px] tabular-nums text-slate-300">
                      <span>Elevation {d2(c.earthEl)}</span><span>Azimuth {az(c.earthAz)}</span>
                      <span>Terrain {d2(c.earthHorizon)}</span><span>Margin {d2(c.earthEl - c.earthHorizon)}</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
