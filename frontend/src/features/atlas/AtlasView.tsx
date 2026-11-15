// Feasibility Atlas: for one site and one spacecraft, which tested landing dates work for which tested
// mission lengths, and why. Each cell is one mission judged by the canonical viability engine (/api/atlas);
// selecting it explains the deciding requirement, shows the same mission at the neighbouring tested dates,
// and can send that exact mission to the Mission Planner.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import { useAppStore } from '../../store'
import { DEFAULT_REQUIREMENTS, type MissionRequirements, type SiteInfo } from '../../types'
import { LoadingIndicator } from '../../ui/LoadingIndicator'
import { fetchSites } from '../../viz/api'
import '../compare/compare.css'
import { Explain, Section, btn, btnPrimary, input } from '../compare/ui'
import { REQUIREMENT_FIELDS, REQUIREMENT_TIPS } from '../rescue/PlanForm'
import {
  MAX_CELLS,
  STATUS,
  STEP_OPTIONS,
  activeRequirements,
  cellLabel,
  cellScenario,
  fmtDay,
  fmtDays,
  fmtUtc,
  limitText,
  measuredText,
  moveSelection,
  neighbourhood,
  noFeasibleSummary,
  robustnessText,
  searchBounds,
  type AtlasRequest,
  type AtlasResponse,
  type CellStatus,
} from './atlas'
import { fetchAtlas } from './api'
import { openInPlanner } from './transfer'

const COLOR: Record<CellStatus, { bg: string; fg: string }> = {
  pass: { bg: '#2f9e62', fg: '#ffffff' },
  fail: { bg: '#d4493f', fg: '#ffffff' },
  unknown: { bg: '#e6b13a', fg: '#3b2a00' },
  not_evaluated: { bg: '#d5dbe3', fg: '#4b5563' },
}
// Not evaluated is also hatched, so it never reads as just a lighter colour.
const HATCH = 'repeating-linear-gradient(135deg, rgba(0,0,0,0.12) 0 2px, transparent 2px 6px)'

function StatusChip({ status, count }: { status: CellStatus; count?: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-300">
      <span aria-hidden className="inline-flex h-4 w-4 items-center justify-center rounded-sm text-[10px] font-bold"
        style={{ background: COLOR[status].bg, color: COLOR[status].fg, backgroundImage: status === 'not_evaluated' ? HATCH : undefined }}>
        {STATUS[status].symbol}
      </span>
      {STATUS[status].label}{count !== undefined && <span className="tabular-nums text-slate-500"> ({count})</span>}
    </span>
  )
}

/** The tested landing windows per duration, in words: the text alternative to the colours. */
function WindowsList({ r }: { r: AtlasResponse }) {
  return (
    <ul className="space-y-1 text-xs text-slate-300">
      {r.durations_days.map((d, row) => {
        const runs: string[] = []
        let start = -1
        r.cells[row].forEach((c, i) => {
          if (c.status === 'pass' && start < 0) start = i
          if ((c.status !== 'pass' || i === r.cells[row].length - 1) && start >= 0) {
            const end = c.status === 'pass' ? i : i - 1
            runs.push(start === end ? fmtDay(r.cells[row][start].landing_utc) : `${fmtDay(r.cells[row][start].landing_utc)} to ${fmtDay(r.cells[row][end].landing_utc)}`)
            start = -1
          }
        })
        return (
          <li key={d}>
            <b className="font-medium text-slate-200">{fmtDays(d)} missions:</b>{' '}
            {runs.length ? `pass at tested landings ${runs.join(', ')}` : 'no tested landing passes'}
          </li>
        )
      })}
    </ul>
  )
}

export function AtlasView() {
  const appSite = useAppStore((s) => s.siteId)
  const appTime = useAppStore((s) => s.timeUtc)
  const [sites, setSites] = useState<SiteInfo[] | null>(null)
  const [siteError, setSiteError] = useState<string | null>(null)
  const [form, setForm] = useState<AtlasRequest>(() => ({
    site_id: 'connecting-ridge',
    start_utc: `${(appTime || '2027-01-01T00:00:00Z').slice(0, 10)}T00:00:00Z`,
    step_hours: 24,
    count: 60,
    durations_days: [3, 7, 14, 28],
    requirements: { ...DEFAULT_REQUIREMENTS },
  }))
  const [durationsText, setDurationsText] = useState('3, 7, 14, 28')
  const [result, setResult] = useState<AtlasResponse | null>(null)
  const [ran, setRan] = useState<AtlasRequest | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<[number, number]>([0, 0])
  const cellRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const abort = useRef<AbortController | null>(null)

  const curated = useMemo(() => (sites ?? []).filter((s) => s.kind !== 'custom'), [sites])
  const site = curated.find((s) => s.id === form.site_id) ?? null

  const run = (req: AtlasRequest) => {
    abort.current?.abort()
    const ctl = new AbortController()
    abort.current = ctl
    setLoading(true)
    setError(null)
    fetchAtlas(req, ctl.signal)
      .then((r) => {
        setResult(r)
        setRan(req)
        // Start on the first passing cell (else the first cell), so the explanation has something to say.
        let first: [number, number] = [0, 0]
        outer: for (let i = 0; i < r.cells.length; i++) for (let j = 0; j < r.cells[i].length; j++) if (r.cells[i][j].status === 'pass') { first = [i, j]; break outer }
        setSel(first)
      })
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError') setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (abort.current === ctl) setLoading(false)
      })
  }

  useEffect(() => {
    const ctl = new AbortController()
    fetchSites(ctl.signal)
      .then((list) => {
        setSites(list)
        const curatedIds = list.filter((s) => s.kind !== 'custom').map((s) => s.id)
        const id = appSite && curatedIds.includes(appSite) ? appSite : form.site_id
        const first = { ...form, site_id: id }
        setForm(first)
        run(first)
      })
      .catch((e: unknown) => (e as Error).name !== 'AbortError' && setSiteError(e instanceof Error ? e.message : String(e)))
    return () => ctl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on opening the Atlas
  }, [])

  const durations = durationsText.split(/[,\s]+/).map(Number).filter((d) => Number.isFinite(d) && d > 0)
  const bounds = searchBounds({ ...form, durations_days: durations })
  const tooMany = bounds.cells > MAX_CELLS
  const valid = !!site && durations.length > 0 && durations.length <= 8 && form.count >= 1 && form.count <= 120 && !tooMany
  const changed = ran !== null && JSON.stringify({ ...form, durations_days: [...new Set(durations)].sort((a, b) => a - b) }) !== JSON.stringify(ran)
  const submit = () => valid && run({ ...form, durations_days: [...new Set(durations)].sort((a, b) => a - b) })

  const [row, col] = sel
  const cell = result?.cells[row]?.[col] ?? null
  const reqById = useMemo(() => new Map((result?.requirements ?? []).map((q) => [q.id, q])), [result])

  const focusCell = (r: number, c: number) => {
    setSel([r, c])
    cellRefs.current.get(`${r}:${c}`)?.focus()
  }
  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!result) return
    const next = moveSelection(e.key, row, col, result.cells.length, result.landing_utc.length)
    if (next) {
      e.preventDefault()
      focusCell(next[0], next[1])
    } else if (e.key === 'Enter' && cell && cell.status !== 'not_evaluated' && site) {
      e.preventDefault()
      openInPlanner(`Atlas: ${site.name} ${fmtDay(cell.landing_utc)} ${fmtDays(cell.duration_days)}`, cellScenario(result, cell, site))
    }
  }

  const cols = result?.landing_utc.length ?? 0
  const labelEvery = Math.max(1, Math.ceil(cols / 12))
  const wide = cols <= 45 // room for the symbol inside each cell

  return (
    <div className="cmp-page lp-light md-host min-h-full">
      <div className="mx-auto max-w-[1500px] px-6 pb-16 pt-8 lg:px-8">
        <header className="mb-6 max-w-3xl">
          <h1 className="text-[28px] font-medium leading-tight text-ink">Feasibility Atlas</h1>
          <p className="mt-2 text-base text-ink-3">
            Which landing dates work for a mission of this length, and why does the boundary fall where it does? Every cell is one
            mission judged by the viability engine on JPL Horizons + LOLA data.
          </p>
        </header>

        <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
          {/* Search and requirements, beside the map. */}
          <form
            aria-label="Atlas search and requirements"
            className="cmp-section space-y-3 self-start text-xs text-slate-300"
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            <h2 className="text-sm font-medium text-ink">Search</h2>
            <label className="block">
              Site
              <select className={input} value={form.site_id} onChange={(e) => setForm({ ...form, site_id: e.target.value })} disabled={!sites}>
                {curated.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            {siteError && <p role="alert" className="text-red-400">Couldn't load sites: {siteError}</p>}
            <label className="block">
              First landing date (UTC)
              <input type="date" className={input} value={form.start_utc.slice(0, 10)}
                min={site?.data_start_utc.slice(0, 10)} max={site?.data_stop_utc.slice(0, 10)}
                onChange={(e) => e.target.value && setForm({ ...form, start_utc: `${e.target.value}T00:00:00Z` })} />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                Sampling interval
                <select className={input} value={form.step_hours} onChange={(e) => setForm({ ...form, step_hours: Number(e.target.value) })}>
                  {STEP_OPTIONS.map((o) => <option key={o.hours} value={o.hours}>{o.label}</option>)}
                </select>
              </label>
              <label className="block">
                Landing dates tested
                <input type="number" className={input} min={1} max={120} value={form.count}
                  onChange={(e) => setForm({ ...form, count: Math.max(1, Math.min(120, Number(e.target.value) || 1)) })} />
              </label>
            </div>
            <label className="block">
              Mission lengths tested (days, up to 8)
              <input type="text" className={input} value={durationsText} onChange={(e) => setDurationsText(e.target.value)} aria-describedby="atlas-bounds" />
            </label>
            <p id="atlas-bounds" className="rounded-md bg-slate-900/40 p-2 leading-snug text-slate-400">
              Landings tested from <b className="text-slate-200">{fmtUtc(bounds.first)}</b> to <b className="text-slate-200">{fmtUtc(bounds.last)}</b>,{' '}
              {STEP_OPTIONS.find((o) => o.hours === form.step_hours)?.label ?? `every ${form.step_hours} h`}; {durations.length} mission length{durations.length === 1 ? '' : 's'}; {bounds.cells} missions.
              {site && <> Site data: {fmtDay(site.data_start_utc)} to {fmtDay(site.data_stop_utc)}.</>}
              {tooMany && <span className="block text-red-400">At most {MAX_CELLS} missions per map: fewer dates or lengths.</span>}
            </p>

            <h2 className="pt-2 text-sm font-medium text-ink">Spacecraft requirements</h2>
            {REQUIREMENT_FIELDS.map((f) => (
              <label key={f.key} className="block" data-tip={REQUIREMENT_TIPS[f.key]}>
                {f.label}
                <input type="number" className={input} min={0} max={f.percent ? 100 : undefined} step={f.step}
                  value={f.percent ? Math.round(form.requirements[f.key] * 100) : form.requirements[f.key]}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    setForm({ ...form, requirements: { ...form.requirements, [f.key]: f.percent ? v / 100 : v } as MissionRequirements })
                  }} />
              </label>
            ))}
            <div className="flex flex-col gap-2 pt-1">
              <button type="submit" className={btnPrimary} disabled={!valid || loading}>{loading ? 'Mapping…' : 'Map these missions'}</button>
              <button type="button" className={btn} onClick={() => setForm({ ...form, requirements: { ...DEFAULT_REQUIREMENTS } })}>Default requirements</button>
            </div>
            {changed && !loading && <p className="text-amber-300">Changed since the map below was made: press "Map these missions".</p>}
          </form>

          <div className="min-w-0 space-y-6">
            <Section title={result ? `${result.site_name}: landing date × mission length` : 'Landing date × mission length'}>
              {loading && !result && (
                <div className="flex items-center gap-3 py-10 text-sm text-slate-400"><LoadingIndicator size={36} /> Evaluating every mission…</div>
              )}
              {error && <p role="alert" className="rounded border border-red-900 bg-red-950/40 p-2 text-xs text-red-300">The Atlas couldn't be made: {error}</p>}
              {result && (
                <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'} aria-busy={loading}>
                  <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1" aria-label="Legend">
                    {(['pass', 'fail', 'unknown', 'not_evaluated'] as const).map((st) => <StatusChip key={st} status={st} count={result.counts[st]} />)}
                  </div>

                  {result.counts.pass === 0 && (
                    <div role="status" className="mb-3 rounded-lg border border-amber-700/60 bg-amber-950/20 p-3 text-xs text-amber-100">
                      {result.counts.not_evaluated === result.cells.length * cols ? (
                        <p><b>Nothing to evaluate:</b> every tested landing is outside this site's data ({fmtDay(result.data_start_utc)} to {fmtDay(result.data_stop_utc)}). Move the first landing date into that range.</p>
                      ) : (
                        <>
                          <p><b>No tested mission meets every requirement here.</b> The deciding requirement, most common first:</p>
                          <ul className="mt-1 list-disc pl-5">
                            {noFeasibleSummary(result).slice(0, 3).map(({ requirement, cells }) => (
                              <li key={requirement.id}>{requirement.name ?? requirement.id} ({limitText(requirement)}): {cells} mission{cells === 1 ? '' : 's'}</li>
                            ))}
                          </ul>
                          <p className="mt-1">Try shorter missions, another start date or interval, another site, or relax the requirement above (left). Select a cell to see by how much it misses.</p>
                        </>
                      )}
                    </div>
                  )}

                  {/* The map: rows = mission lengths, columns = tested landing dates. Arrow keys move, Enter opens in the Planner. */}
                  <div
                    role="grid"
                    aria-label={`Feasibility of ${result.site_name} missions: rows are mission lengths, columns are tested landing dates every ${result.step_hours} hours`}
                    aria-rowcount={result.cells.length + 1}
                    aria-colcount={cols + 1}
                    onKeyDown={onGridKey}
                    className="overflow-x-auto"
                  >
                    <div role="row" className="grid" style={{ gridTemplateColumns: `4rem repeat(${cols}, minmax(${wide ? 18 : 7}px, 1fr))` }}>
                      <div role="columnheader" className="text-[10px] text-slate-500">Length</div>
                      {result.landing_utc.map((t, i) => (
                        <div key={t} role="columnheader" aria-label={fmtUtc(t)} className="relative h-8 text-[10px] text-slate-500">
                          {i % labelEvery === 0 && <span className="absolute bottom-0 left-0 origin-bottom-left -rotate-45 whitespace-nowrap">{t.slice(5, 10)}</span>}
                        </div>
                      ))}
                    </div>
                    {result.cells.map((line, r) => (
                      <div key={result.durations_days[r]} role="row" className="grid" style={{ gridTemplateColumns: `4rem repeat(${cols}, minmax(${wide ? 18 : 7}px, 1fr))` }}>
                        <div role="rowheader" className="flex items-center text-xs font-medium text-slate-300">{fmtDays(result.durations_days[r])}</div>
                        {line.map((c, k) => {
                          const selected = r === row && k === col
                          return (
                            <div
                              key={c.landing_utc}
                              ref={(el) => {
                                if (el) cellRefs.current.set(`${r}:${k}`, el)
                                else cellRefs.current.delete(`${r}:${k}`)
                              }}
                              role="gridcell"
                              tabIndex={selected ? 0 : -1}
                              aria-selected={selected}
                              aria-label={cellLabel(result, r, k)}
                              data-status={c.status}
                              title={`${fmtUtc(c.landing_utc)} · ${fmtDays(c.duration_days)} · ${STATUS[c.status].label}`}
                              onClick={() => focusCell(r, k)}
                              className={`m-px flex h-8 cursor-pointer items-center justify-center rounded-[3px] text-[11px] font-bold outline-none ${selected ? 'ring-2 ring-ink ring-offset-1' : ''} focus-visible:ring-2 focus-visible:ring-sky-500`}
                              style={{ background: COLOR[c.status].bg, color: COLOR[c.status].fg, backgroundImage: c.status === 'not_evaluated' ? HATCH : undefined }}
                            >
                              {wide && <span aria-hidden>{STATUS[c.status].symbol}</span>}
                            </div>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] text-slate-500">
                    Click a cell, or use the arrow keys (Home / End, Page Up / Down = a week of columns); Enter opens that mission in the Planner.
                    Only the tested dates are shown: nothing is interpolated between them.
                  </p>

                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs font-medium text-slate-200">Passing landing windows, in words</summary>
                    <div className="mt-2"><WindowsList r={result} /></div>
                  </details>
                </div>
              )}
            </Section>

            {result && cell && (
              <Section title="Selected mission">
                <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                  <div className="space-y-3 text-xs">
                    <p className="flex flex-wrap items-center gap-2 text-sm text-slate-200">
                      <StatusChip status={cell.status} />
                      <span>Landing <b>{fmtUtc(cell.landing_utc)}</b>, {fmtDays(cell.duration_days)} at {result.site_name}</span>
                    </p>
                    <p className="text-slate-300" aria-live="polite">{cell.reason}</p>
                    {cell.constraints && cell.constraints.length > 0 && (
                      <table className="w-full text-left">
                        <caption className="mb-1 text-left text-[11px] text-slate-400">Every requirement for this mission (the deciding one is marked)</caption>
                        <thead className="text-slate-500">
                          <tr><th className="py-1 font-normal">Requirement</th><th className="font-normal">Limit</th><th className="font-normal">This mission</th><th className="font-normal">Margin</th><th className="font-normal">Result</th></tr>
                        </thead>
                        <tbody>
                          {cell.constraints.filter((c) => reqById.get(c.id)?.threshold !== undefined && reqById.get(c.id)?.threshold !== null).map((c) => {
                            const q = reqById.get(c.id)!
                            const deciding = c.id === cell.limiting
                            return (
                              <tr key={c.id} className={`border-t border-line ${deciding ? 'font-semibold text-slate-100' : 'text-slate-300'}`}>
                                <td className="py-1 pr-2">{deciding && <span className="mr-1" aria-label="deciding requirement">▶</span>}{q.name ?? c.id}</td>
                                <td className="pr-2 tabular-nums">{limitText(q)}</td>
                                <td className="pr-2 tabular-nums">{measuredText(c, q.unit)}</td>
                                <td className="pr-2 tabular-nums">{c.margin === null || c.margin === undefined ? '—' : `${c.margin >= 0 ? '+' : '−'}${measuredText({ ...c, measured: 'known', value: Math.abs(c.margin) }, q.unit)}`}</td>
                                <td>{c.status === 'pass' ? '✓ passes' : c.status === 'fail' ? '✕ fails' : c.status === 'unknown' ? `? undecided${c.note ? ` (${c.note})` : ''}` : 'n/a'}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                  <div className="space-y-3 text-xs">
                    <h3 className="text-sm font-medium text-slate-200">Neighbouring tested dates ({fmtDays(cell.duration_days)} missions)</h3>
                    <ol className="flex flex-wrap gap-1" aria-label="The same mission at the neighbouring tested landing dates">
                      {neighbourhood(result, row, col).cells.map((n) => (
                        <li key={n.col}>
                          <button type="button" onClick={() => focusCell(row, n.col)}
                            aria-label={`${fmtUtc(n.landing_utc)}: ${STATUS[n.status].label}${n.selected ? ' (selected)' : ''}`}
                            className={`flex w-12 flex-col items-center rounded-md px-1 py-1 ${n.selected ? 'ring-2 ring-ink' : ''}`}
                            style={{ background: COLOR[n.status].bg, color: COLOR[n.status].fg, backgroundImage: n.status === 'not_evaluated' ? HATCH : undefined }}>
                            <span className="text-sm font-bold" aria-hidden>{STATUS[n.status].symbol}</span>
                            <span className="text-[10px]">{n.landing_utc.slice(5, 10)}</span>
                          </button>
                        </li>
                      ))}
                    </ol>
                    <p className="text-slate-300">{robustnessText(result, row, col)}</p>
                    {cell.status !== 'not_evaluated' && site && (
                      <button type="button" className={btnPrimary}
                        onClick={() => openInPlanner(`Atlas: ${site.name} ${fmtDay(cell.landing_utc)} ${fmtDays(cell.duration_days)}`, cellScenario(result, cell, site))}>
                        Open this mission in the Planner
                      </button>
                    )}
                    <p className="text-[11px] text-slate-500">Creates a plan with exactly this site, landing time, length and requirements, and runs it in the 3D view{cell.status === 'fail' ? ' (it fails: Mission Rescue can then look for alternatives)' : ''}.</p>
                  </div>
                </div>
              </Section>
            )}

            {result && (
              <Explain title="How the Atlas works, and what it doesn't do yet">
                <p>{result.method}</p>
                <p className="mt-1">Active requirements: {activeRequirements(result).map((q) => `${q.name ?? q.id} ${limitText(q)}`).join('; ')}.</p>
                <ul className="mt-1 list-disc pl-5">{result.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
                <p className="mt-1"><b>Not implemented yet:</b> automatic refinement around a boundary (finer sampling where the result changes), capability studies (e.g. the battery a failing date would need) and sensitivity checks per cell. Engine {result.engine_version}.</p>
              </Explain>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
