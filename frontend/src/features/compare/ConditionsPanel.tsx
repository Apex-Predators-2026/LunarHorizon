// Conditions at the selected moment for every scenario, with the reason for light/dark and Earth in/out of view.
import { fmtUtc } from '../rescue/format'
import { conditionsAt, fmtAxis, type Align, type Entry } from './analysis'
import { ScenarioChip } from './ui'
import { useCompareStore } from './useCompareStore'

// Unknown samples show as an em dash, never as 0.
const d2 = (v: number | null) => (v === null ? '-' : `${v.toFixed(2)}°`)
const az = (v: number | null) => (v === null ? '-' : `${v.toFixed(1)}°`)
const diff = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b)
// Hours after landing, exact to the minute (a landing between samples gives fractional hours).
const fmtMet = (h: number) => (Math.abs(h - Math.round(h)) < 1 / 120 ? `${Math.round(h)} h` : `${h.toFixed(2)} h`)

export function ConditionsPanel({ entries, align, originMs, onOpen3D }: { entries: Entry[]; align: Align; originMs: number; onOpen3D?: () => void }) {
  const cursor = useCompareStore((s) => s.cursor)
  const setActive = useCompareStore((s) => s.setActive)
  if (cursor === null) {
    return <p className="text-xs text-slate-400">Click anywhere on the timeline or a chart to see the conditions at that moment in every scenario.</p>
  }
  return (
    <div>
      <p className="mb-2 text-xs text-slate-300">
        Selected: <b className="text-slate-100">{fmtAxis(cursor, align, originMs, 0)}</b>
        {align === 'met' ? ' after each landing' : ''}: each scenario shows the data sample holding at that moment (a sample holds until the next one, as the viability engine reads it; nothing is interpolated).
      </p>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {entries.map((e) => {
          const c = conditionsAt(e, cursor)
          return (
            <div key={e.scenario.id} className="rounded-lg border border-line bg-inset p-2.5 text-xs">
              <div className="mb-1.5 flex items-center gap-2">
                <ScenarioChip s={e.scenario} size="sm" />
                <span className="min-w-0 flex-1 truncate text-slate-200">{e.scenario.site.name}</span>
                {onOpen3D && c && e.result?.data_kind === 'real' && (
                  <button type="button" className="text-[11px] text-cyan-400 hover:underline"
                    title="Open the 3D terrain view at this site and moment"
                    onClick={() => { setActive(e.scenario.id); onOpen3D() }}>
                    View in 3D ↗
                  </button>
                )}
              </div>
              {!c ? (
                <p className="text-slate-500">{e.result ? 'Outside this mission’s time span.' : 'No data.'}</p>
              ) : (
                <>
                  <p className="text-[11px] text-slate-400">
                    Data sample {fmtUtc(c.time_utc)}
                    {c.held && <> · held at T+{fmtMet(c.selectedMet)} (sample at T{c.met < 0 ? '−' : '+'}{fmtMet(Math.abs(c.met))})</>}
                  </p>
                  <div className={`mt-1.5 rounded px-2 py-1 ${c.sunFraction === null ? 'bg-slate-800 text-slate-200' : c.sunFraction > 0 ? 'bg-amber-950/40 text-amber-200' : 'bg-slate-900 text-slate-300'}`}>
                    <div className="font-medium">Sun: {c.sunReason}</div>
                    <div className="mt-0.5 grid grid-cols-2 gap-x-2 text-[11px] tabular-nums text-slate-300">
                      <span>Elevation {d2(c.sunEl)}</span><span>Azimuth {az(c.sunAz)}</span>
                      <span>Terrain {d2(c.sunHorizon)}</span><span>Disk {c.sunFraction === null ? '-' : `${Math.round(c.sunFraction * 100)}%`}</span>
                      <span className="col-span-2" title="Idealised: visible disk × max(0, cos θ)">Incidence factor {c.incidence === null ? '-' : c.incidence.toFixed(3)} (idealised)</span>
                    </div>
                  </div>
                  <div className={`mt-1.5 rounded px-2 py-1 ${c.earthVisible === null ? 'bg-slate-800 text-slate-200' : c.earthVisible ? 'bg-sky-950/50 text-sky-200' : 'bg-red-950/40 text-red-200'}`}>
                    <div className="font-medium">Earth: {c.earthReason}</div>
                    <div className="mt-0.5 grid grid-cols-2 gap-x-2 text-[11px] tabular-nums text-slate-300">
                      <span>Elevation {d2(c.earthEl)}</span><span>Azimuth {az(c.earthAz)}</span>
                      <span>Terrain {d2(c.earthHorizon)}</span><span>Margin {d2(diff(c.earthEl, c.earthHorizon))}</span>
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
