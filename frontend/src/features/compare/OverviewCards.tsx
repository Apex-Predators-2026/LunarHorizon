// Section 2: one card per compared scenario, status first: data source, eligibility and canonical rank, then the
// headline figures (from the viability engine's own metrics) and which requirements pass, fail or cannot be decided.
import { fmtUtc } from '../rescue/format'
import {
  cm,
  eligibilityOf,
  groupCountOf,
  measuredText,
  rankText,
  requirementSummary,
  scoreText,
  type Entry,
  type ReqStatus,
} from './analysis'
import { seriesColor } from './palette'
import type { CompareResult } from './types'
import { DataKindBadge, EligibilityBadge, RankBadge, ReqIcon, ScenarioChip } from './ui'
import { useCompareStore } from './useCompareStore'

const constraintStatus = (r: CompareResult, id: string): ReqStatus | null =>
  r.assessment?.constraints.find((c) => c.id === id)?.status ?? null

/** Headline figure with the verdict of the requirement it is checked against (if that requirement applies). */
function Figure({ label, r, metric, constraint }: { label: string; r: CompareResult; metric: string; constraint?: string }) {
  const m = cm(r, metric)
  const status = constraint ? constraintStatus(r, constraint) : null
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="flex items-center gap-1 text-sm font-medium tabular-nums text-slate-100">
        {status && status !== 'not_applicable' && <ReqIcon status={status} />}
        <span className="truncate" title={m?.reason ?? undefined}>{m ? measuredText(m) : 'unavailable'}</span>
      </div>
    </div>
  )
}

export function OverviewCards({ entries }: { entries: Entry[] }) {
  const groupCount = groupCountOf(entries)
  const setActive = useCompareStore((s) => s.setActive)
  const activeId = useCompareStore((s) => s.activeId)
  const baselineId = useCompareStore((s) => s.baselineId)
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {entries.map((e) => {
        const s = e.scenario
        const r = e.result
        const a = r?.assessment
        const elig = eligibilityOf(e)
        const rank = rankText(e.ranking, groupCount)
        const req = requirementSummary(e)
        return (
          <article key={s.id} aria-label={`Scenario ${s.label} overview`}
            className={`relative flex flex-col overflow-hidden rounded-xl border bg-surface p-3 ${activeId === s.id ? 'border-cyan-600' : 'border-line'}`}>
            <div className="absolute inset-x-0 top-0 h-0.5" style={{ background: seriesColor(s.colorSlot) }} aria-hidden="true" />
            <header className="flex items-start gap-2">
              <ScenarioChip s={s} />
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm font-medium text-slate-100" title={s.name}>{s.name}</h3>
                <p className="text-[11px] leading-snug text-slate-400">
                  {s.site.name} · {Math.abs(s.site.lat).toFixed(3)}°{s.site.lat < 0 ? 'S' : 'N'}, {(((s.site.lon % 360) + 360) % 360).toFixed(3)}°E
                  <br />Lands {fmtUtc(s.landing_utc)} · {s.duration_days} d
                </p>
              </div>
            </header>

            {/* Status first: what the result is based on, and the verdict. */}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {e.state?.state === 'loading' && <span className="animate-pulse text-[11px] text-cyan-300">Evaluating…</span>}
              {e.state?.state === 'error' && <span className="text-[11px] text-red-300">Error</span>}
              {e.state?.state === 'done' && <DataKindBadge kind={e.state.result.data_kind} />}
              {elig && <EligibilityBadge eligibility={elig} />}
              {rank ? <RankBadge text={rank} /> : elig && <span className="text-[11px] text-slate-500">not ranked</span>}
              {baselineId === s.id && <span className="rounded bg-cyan-900/70 px-1.5 py-0.5 text-[11px] text-cyan-200">baseline</span>}
            </div>

            {r && a ? (
              <>
                <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
                  <Figure label="Mean visible solar disk" r={r} metric="mean_solar_disk_fraction" constraint="min_mean_solar_disk_fraction" />
                  <Figure label="Earth in line of sight" r={r} metric="earth_visible_percent" constraint="min_earth_visibility_percent" />
                  <Figure label="Longest power darkness" r={r} metric="longest_power_darkness_h" constraint="max_continuous_darkness" />
                  <Figure label="Longest blackout" r={r} metric="longest_blackout_h" constraint="max_communication_blackout" />
                </div>
                {req && (
                  <div className="mt-3 border-t border-line pt-2 text-[11px]">
                    <div className="text-slate-300">
                      <span className="tabular-nums font-medium">{req.passed} of {req.applicable}</span> requirements met
                      {req.failed.length > 0 && <> · <span className="text-red-300">{req.failed.length} failed</span></>}
                      {req.undecided.length > 0 && <> · <span className="text-slate-200">{req.undecided.length} cannot be decided</span></>}
                    </div>
                    {[...req.failed.map((x) => ({ ...x, st: 'fail' as const })), ...req.undecided.map((x) => ({ ...x, st: 'unknown' as const }))].map((x) => (
                      <div key={x.id} className="mt-0.5 flex items-start gap-1 text-slate-400"><ReqIcon status={x.st} />{x.name}</div>
                    ))}
                  </div>
                )}
                <p className="mt-2 text-[11px] text-slate-500">
                  Score {scoreText(e.ranking, r.viability?.score)} · risk {a.overall_risk} · data coverage{' '}
                  {Math.min(a.sun_coverage_percent, a.earth_coverage_percent).toFixed(0)}%
                </p>
              </>
            ) : (
              <p className="mt-3 text-xs leading-snug text-slate-400">
                {e.state?.state === 'error' ? e.state.message
                  : e.state?.state === 'done' ? e.state.result.message
                    : e.state?.state === 'loading' ? 'Requesting timelines and viability from the backend…' : 'Waiting…'}
              </p>
            )}
            {r?.site_context && (
              <p className="mt-1 text-[11px] text-slate-500">
                Ground {r.site_context.ground_height_m != null ? `${Math.round(r.site_context.ground_height_m)} m` : 'n/a'}
                {r.site_context.horizon_max_deg != null && ` · terrain horizon up to ${r.site_context.horizon_max_deg.toFixed(1)}°`}
                {r.science_context && ` · ${r.science_context.distance_to_psr_edge_km.toFixed(1)} km to ${r.science_context.nearest_psr_name} (approx.)`}
              </p>
            )}
            <button type="button" onClick={() => setActive(activeId === s.id ? null : s.id)}
              className="mt-auto pt-2 text-left text-[11px] text-cyan-400 hover:underline" aria-pressed={activeId === s.id}>
              {activeId === s.id ? 'Following in 3D view' : 'Follow in 3D view / edit'}
            </button>
          </article>
        )
      })}
    </div>
  )
}
