// Section 2: one card per compared scenario with its data status and headline numbers.
import { fmtUtc } from '../rescue/format'
import { fmtMetric, type Entry } from './analysis'
import { seriesColor } from './palette'
import { DataKindBadge, PassBadge, ScenarioChip } from './ui'
import { useCompareStore } from './useCompareStore'

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${warn ? 'text-amber-300' : 'text-slate-100'}`}>{value}</div>
    </div>
  )
}

export function OverviewCards({ entries }: { entries: Entry[] }) {
  const setActive = useCompareStore((s) => s.setActive)
  const activeId = useCompareStore((s) => s.activeId)
  const baselineId = useCompareStore((s) => s.baselineId)
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {entries.map((e) => {
        const s = e.scenario
        const r = e.result
        const v = r?.viability
        return (
          <article key={s.id} aria-label={`Scenario ${s.label} overview`}
            className={`relative overflow-hidden rounded-xl border bg-[#0a1324] p-3 ${activeId === s.id ? 'border-cyan-600' : 'border-[#1c2a48]'}`}>
            <div className="absolute inset-x-0 top-0 h-0.5" style={{ background: seriesColor(s.colorSlot) }} aria-hidden="true" />
            <header className="flex items-start gap-2">
              <ScenarioChip s={s} />
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm font-semibold text-slate-100" title={s.name}>{s.name}</h3>
                <p className="text-[11px] text-slate-400">
                  {s.site.name} · {fmtUtc(s.landing_utc)} · {s.duration_days} d
                </p>
              </div>
            </header>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {e.state?.state === 'loading' && <span className="animate-pulse text-[11px] text-cyan-300">Evaluating…</span>}
              {e.state?.state === 'error' && <span className="text-[11px] text-red-300">Error</span>}
              {e.state?.state === 'done' && <DataKindBadge kind={e.state.result.data_kind} />}
              {v && <PassBadge passes={v.passes} />}
              {baselineId === s.id && <span className="rounded bg-cyan-900/70 px-1.5 py-0.5 text-[10px] text-cyan-200">baseline</span>}
            </div>
            {r?.solar && r.earth && v ? (
              <div className="mt-3 grid grid-cols-3 gap-2">
                <Stat label="Sunlit" value={fmtMetric(r.solar.sunlit_fraction * 100, '%')} />
                <Stat label="Earth in view" value={fmtMetric(r.earth.visible_fraction * 100, '%')} />
                <Stat label="Viability" value={v.score.toFixed(0)} />
                <Stat label="Longest dark" value={fmtMetric(r.solar.longest_dark_hours, 'h')} warn={v.metrics.longest_dark_gap_hours > s.requirements.battery_hours} />
                <Stat label="Longest blackout" value={fmtMetric(r.earth.longest_blackout_hours, 'h')} warn={r.earth.longest_blackout_hours > s.requirements.max_comms_gap_hours} />
                <Stat label="Mean Sun el." value={fmtMetric(r.solar.mean_elevation_deg, 'deg')} />
              </div>
            ) : (
              <p className="mt-3 text-xs leading-snug text-slate-400">
                {e.state?.state === 'error' ? e.state.message
                  : e.state?.state === 'done' ? e.state.result.message
                    : e.state?.state === 'loading' ? 'Requesting timelines and viability from the backend…' : 'Waiting…'}
              </p>
            )}
            {r?.site_context && (
              <p className="mt-2 text-[10px] text-slate-500">
                Elevation {r.site_context.ground_height_m != null ? `${Math.round(r.site_context.ground_height_m)} m` : 'n/a'}
                {r.site_context.horizon_max_deg != null && ` · terrain horizon up to ${r.site_context.horizon_max_deg.toFixed(1)}°`}
                {r.science_context && ` · ${r.science_context.distance_to_psr_edge_km.toFixed(1)} km to ${r.science_context.nearest_psr_name} (approx.)`}
              </p>
            )}
            <button type="button" onClick={() => setActive(activeId === s.id ? null : s.id)}
              className="mt-2 text-[11px] text-cyan-400 hover:underline" aria-pressed={activeId === s.id}>
              {activeId === s.id ? 'Following in 3D view' : 'Follow in 3D view / edit'}
            </button>
          </article>
        )
      })}
    </div>
  )
}
