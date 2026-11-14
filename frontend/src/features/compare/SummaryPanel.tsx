// Section 8: automatically generated comparison summary, written only from the computed numbers.
import { buildSummary, type Entry } from './analysis'
import { ScenarioChip } from './ui'

export function SummaryPanel({ entries }: { entries: Entry[] }) {
  const sum = buildSummary(entries)
  const byId = Object.fromEntries(entries.map((e) => [e.scenario.id, e.scenario]))
  return (
    <div className="space-y-4">
      {sum.bests.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          {sum.bests.map((b) => (
            <div key={b.label} className="rounded-lg border border-[#1c2a48] bg-[#08111f] p-2.5">
              <div className="text-[10px] uppercase tracking-wide text-slate-500">{b.label}</div>
              <div className="mt-1 flex flex-wrap gap-1">{b.ids.map((id) => <ScenarioChip key={id} s={byId[id]} />)}</div>
              <div className="mt-1 text-[11px] text-slate-300">{b.detail}</div>
            </div>
          ))}
        </div>
      )}
      {sum.overall.length > 0 && (
        <div className="rounded-lg border border-cyan-900/60 bg-gradient-to-br from-cyan-950/30 to-transparent p-3 text-sm leading-relaxed text-slate-200">
          {sum.overall.map((p) => <p key={p} className="mb-1.5 last:mb-0">{p}</p>)}
        </div>
      )}
      {sum.highlights.length > 0 && (
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
          {sum.highlights.map((hl) => (
            <div key={hl.entry.scenario.id} className="rounded-lg border border-[#1c2a48] p-2.5 text-xs">
              <div className="mb-1 flex items-center gap-2"><ScenarioChip s={hl.entry.scenario} size="sm" />
                <span className="truncate text-slate-200">{hl.entry.scenario.name}</span></div>
              {hl.strengths.map((s) => <p key={s} className="text-emerald-300">＋ {s}</p>)}
              {hl.weaknesses.map((s) => <p key={s} className="text-red-300">－ {s}</p>)}
              {!hl.strengths.length && !hl.weaknesses.length && <p className="text-slate-500">No stand-out differences.</p>}
            </div>
          ))}
        </div>
      )}
      <ul className="space-y-0.5 text-[11px] text-slate-500">
        {sum.caveats.map((c) => <li key={c}>• {c}</li>)}
      </ul>
    </div>
  )
}
