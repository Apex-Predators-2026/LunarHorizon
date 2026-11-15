// Feasibility Atlas: for one site and one spacecraft, which tested landing dates work for which tested
// mission lengths, and why. Each cell is one mission judged by the canonical viability engine (/api/atlas);
// selecting it explains the deciding requirement, shows the same mission at the neighbouring tested dates,
// and can send that exact mission to the Mission Planner.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useStore } from 'zustand'

import { useAppStore } from '../../store'
import { DEFAULT_REQUIREMENTS, type MissionRequirements, type SiteInfo } from '../../types'
import { LoadingIndicator } from '../../ui/LoadingIndicator'
import { fetchSites } from '../../viz/api'
import '../compare/compare.css'
import { Disclosure } from '../compare/disclosure'
import { btn, btnPrimary, input } from '../compare/ui'
import { REQUIREMENT_FIELDS, REQUIREMENT_TIPS } from '../rescue/PlanForm'
import {
  MAX_CELLS,
  STATUS,
  STEP_OPTIONS,
  activeRequirements,
  cellLabel,
  fmtDay,
  fmtDays,
  fmtUtc,
  limitText,
  measuredText,
  moveSelection,
  neighbourhood,
  noFeasibleSummary,
  noPassSummary,
  robustnessText,
  rowWindowsText,
  searchBounds,
  type AtlasRequest,
  type AtlasResponse,
  type CellStatus,
} from './atlas'
import { atlasSession, normalizeRequest, requestDiffs, transferFor } from './session'
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
        style={{ backgroundColor: COLOR[status].bg, color: COLOR[status].fg, backgroundImage: status === 'not_evaluated' ? HATCH : undefined }}>
        {STATUS[status].symbol}
      </span>
      {STATUS[status].label}{count !== undefined && <span className="tabular-nums text-slate-500"> ({count})</span>}
    </span>
  )
}

/** The tested landing windows per duration, in words: the text alternative to the colours. */
function WindowsList({ r }: { r: AtlasResponse }) {
  return (
    <>
      <ul className="space-y-1 text-xs text-slate-300">
        {r.durations_days.map((d, row) => (
          <li key={d}><b className="font-medium text-slate-200">{fmtDays(d)} missions:</b> {rowWindowsText(r, row)}</li>
        ))}
      </ul>
      <p className="mt-1 text-[11px] text-slate-500">A run is a sequence of consecutive tested dates that pass, one every {r.step_hours} h; times between tested dates were not evaluated.</p>
    </>
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
  const snapshot = useStore(atlasSession, (s) => s.snapshot)
  const pending = useStore(atlasSession, (s) => s.pending)
  const error = useStore(atlasSession, (s) => s.error)
  const sel = useStore(atlasSession, (s) => s.sel)
  const result: AtlasResponse | null = snapshot?.response ?? null
  const loading = pending !== null
  const cellRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  const curated = useMemo(() => (sites ?? []).filter((s) => s.kind !== 'custom'), [sites])
  const site = curated.find((s) => s.id === form.site_id) ?? null

  const run = (req: AtlasRequest, siteInfo: SiteInfo | null) => void atlasSession.getState().submit(req, siteInfo)

  useEffect(() => {
    const ctl = new AbortController()
    fetchSites(ctl.signal)
      .then((list) => {
        setSites(list)
        const shown = atlasSession.getState().snapshot
        if (shown) {
          // Back on the Atlas: show the search the map was made from, not a fresh default.
          setForm(shown.request)
          setDurationsText(shown.request.durations_days.join(', '))
          return
        }
        const curatedIds = list.filter((s) => s.kind !== 'custom').map((s) => s.id)
        const id = appSite && curatedIds.includes(appSite) ? appSite : form.site_id
        const first = { ...form, site_id: id }
        setForm(first)
        run(normalizeRequest(first, first.durations_days), list.find((s) => s.id === id) ?? null)
      })
      .catch((e: unknown) => (e as Error).name !== 'AbortError' && setSiteError(e instanceof Error ? e.message : String(e)))
    return () => ctl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on opening the Atlas
  }, [])

  const durations = durationsText.split(/[,\s]+/).map(Number).filter((d) => Number.isFinite(d) && d > 0)
  const bounds = searchBounds({ ...form, durations_days: durations })
  const tooMany = bounds.cells > MAX_CELLS
  const valid = !!site && durations.length > 0 && durations.length <= 8 && form.count >= 1 && form.count <= 120 && !tooMany
  const edited = normalizeRequest(form, durations)
  // What the edited search changes relative to the map shown ([] = the map shows this search).
  const diffs = snapshot ? requestDiffs(edited, snapshot.request) : []
  const submit = () => valid && run(edited, site)

  const [row, col] = sel
  const cell = result?.cells[row]?.[col] ?? null
  const reqById = useMemo(() => new Map((result?.requirements ?? []).map((q) => [q.id, q])), [result])

  // The selected cell as a Planner mission, from the map's own snapshot (or why it can't be sent).
  const plan = transferFor(snapshot, row, col, loading)
  /** The one path to the Planner, for the button and for Enter: it reads the session, never the form. */
  const sendToPlanner = () => {
    const t = atlasSession.getState().transfer()
    if (t.ok) openInPlanner(t.name, t.scenario)
  }

  const focusCell = (r: number, c: number) => {
    atlasSession.getState().select(r, c)
    cellRefs.current.get(`${r}:${c}`)?.focus()
  }
  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!result) return
    const next = moveSelection(e.key, row, col, result.cells.length, result.landing_utc.length)
    if (next) {
      e.preventDefault()
      focusCell(next[0], next[1])
    } else if (e.key === 'Enter') {
      e.preventDefault()
      sendToPlanner()
    }
  }

  const cols = result?.landing_utc.length ?? 0
  const labelEvery = Math.max(1, Math.ceil(cols / 12))
  const wide = cols <= 45 // room for the symbol inside each cell
  const gridCols = `4rem repeat(${cols}, minmax(${wide ? 18 : 7}px, 1fr))`

  // What the map evaluates: the engine's own requirement list once a map exists, else the controls' values.
  const requirementSummary = result
    ? activeRequirements(result).map((q) => `${q.name ?? q.id} ${limitText(q)}`)
    : REQUIREMENT_FIELDS.map((f) => `${f.label.replace(/ \(.*\)$/, '')} ${f.percent ? `${Math.round(form.requirements[f.key] * 100)}%` : form.requirements[f.key]}`)

  return (
    <div className="cmp-page lp-light md-host min-h-full">
      <div className="mx-auto max-w-[1600px] px-6 pb-16 pt-6 lg:px-8">
        <header className="mb-4 max-w-3xl">
          <h1 className="text-2xl font-medium leading-tight text-ink">Feasibility Atlas</h1>
          <p className="mt-1 text-sm text-ink-3">
            Which landing dates work for a mission of this length, and why does the boundary fall where it does? Every cell is one
            mission judged by the viability engine on JPL Horizons + LOLA data.
          </p>
        </header>

        {/* Controls: compact. The spacecraft requirements are one click away, and always summarised below. */}
        <form aria-label="Atlas search and requirements" className="cmp-section !p-4 text-xs text-slate-300"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}>
          <div className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.3fr)_repeat(2,minmax(0,1fr))_minmax(0,0.7fr)_minmax(0,1fr)_auto]">
            <label className="block">
              Site
              <select className={input} value={form.site_id} onChange={(e) => setForm({ ...form, site_id: e.target.value })} disabled={!sites}>
                {curated.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label className="block">
              First landing date (UTC)
              <input type="date" className={input} value={form.start_utc.slice(0, 10)}
                min={site?.data_start_utc.slice(0, 10)} max={site?.data_stop_utc.slice(0, 10)}
                onChange={(e) => e.target.value && setForm({ ...form, start_utc: `${e.target.value}T00:00:00Z` })} />
            </label>
            <label className="block">
              Sampling interval
              <select className={input} value={form.step_hours} onChange={(e) => setForm({ ...form, step_hours: Number(e.target.value) })}>
                {STEP_OPTIONS.map((o) => <option key={o.hours} value={o.hours}>{o.label}</option>)}
              </select>
            </label>
            <label className="block">
              Dates tested
              <input type="number" className={input} min={1} max={120} value={form.count}
                onChange={(e) => setForm({ ...form, count: Math.max(1, Math.min(120, Number(e.target.value) || 1)) })} />
            </label>
            <label className="block">
              Mission lengths (days, up to 8)
              <input type="text" className={input} value={durationsText} onChange={(e) => setDurationsText(e.target.value)} aria-describedby="atlas-bounds" />
            </label>
            <button type="submit" className={btnPrimary} disabled={!valid || loading}>{loading ? 'Mapping…' : 'Map these missions'}</button>
          </div>
          {siteError && <p role="alert" className="mt-2 text-red-400">Couldn't load sites: {siteError}</p>}
          <p id="atlas-bounds" className="mt-2 leading-snug text-slate-400">
            Landings tested from <b className="text-slate-200">{fmtUtc(bounds.first)}</b> to <b className="text-slate-200">{fmtUtc(bounds.last)}</b>,{' '}
            {STEP_OPTIONS.find((o) => o.hours === form.step_hours)?.label ?? `every ${form.step_hours} h`}; {durations.length} mission length{durations.length === 1 ? '' : 's'}; {bounds.cells} missions.
            {site && <> Site data: {fmtDay(site.data_start_utc)} to {fmtDay(site.data_stop_utc)}.</>}
            {tooMany && <span className="block text-red-400">At most {MAX_CELLS} missions per map: fewer dates or lengths.</span>}
          </p>
          {loading && <p role="status" className="mt-1 text-slate-400">Evaluating your search: the map shown will be replaced when it is ready.</p>}
          {!loading && diffs.length > 0 && (
            <p role="status" className="mt-1 text-amber-300" data-testid="atlas-edited">
              Edited, not mapped yet ({diffs.join(', ')}). The map shown is still the previous search: press “Map these missions” to evaluate your edits.
            </p>
          )}

          <p className="mt-2 leading-snug" data-testid="atlas-active-requirements">
            <span className="font-medium text-slate-200">{result ? 'This map evaluates: ' : 'Requirements: '}</span>
            {requirementSummary.join(' · ')}
          </p>
          <Disclosure id="atlas-requirements" className="mt-1" title="Spacecraft requirements"
            summary="Edit the limits every mission is judged against">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
              <div className="flex items-end">
                <button type="button" className={btn} onClick={() => setForm({ ...form, requirements: { ...DEFAULT_REQUIREMENTS } })}>Default requirements</button>
              </div>
            </div>
          </Disclosure>
        </form>

        {/* Workspace: the map first; the selected mission's inspector beside it on wide screens, below it otherwise. */}
        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <section aria-labelledby="atlas-map-h" data-tour="atlas-grid" className="cmp-section min-w-0 !p-4">
            <h2 id="atlas-map-h" className="mb-3 text-base font-medium text-ink">
              {result ? `${result.site_name}: landing date × mission length` : 'Landing date × mission length'}
            </h2>
            {loading && !result && (
              <div className="flex items-center gap-3 py-10 text-sm text-slate-400"><LoadingIndicator size={36} /> Evaluating every mission…</div>
            )}
            {!loading && !result && !error && (
              <p className="py-6 text-sm text-slate-400">No map yet. Choose a site, dates and mission lengths, then press "Map these missions".</p>
            )}
            {error && <p role="alert" className="rounded border border-red-900 bg-red-950/40 p-2 text-xs text-red-300">The Atlas couldn't be made: {error}</p>}
            {result && (
              <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'} aria-busy={loading}>
                {result.time_note && <p className="mb-2 text-xs text-slate-400">{result.time_note}</p>}
                <p className="mb-2 text-[11px] text-slate-400" data-testid="atlas-shown">
                  Map shown: {result.site_name}, landings {fmtUtc(result.landing_utc[0])} to {fmtUtc(result.landing_utc[result.landing_utc.length - 1])}{' '}
                  every {result.step_hours} h, {result.durations_days.map(fmtDays).join(' / ')} missions, with the requirements it was mapped with
                  {diffs.length > 0 && <b className="ml-1 font-medium text-amber-300">(not your edited search)</b>}.
                </p>
                <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1" aria-label="Legend">
                  {(['pass', 'fail', 'unknown', 'not_evaluated'] as const).map((st) => <StatusChip key={st} status={st} count={result.counts[st]} />)}
                </div>

                {result.counts.pass === 0 && (() => {
                  const none = noPassSummary(result)
                  const deciding = noFeasibleSummary(result).slice(0, 3)
                  return (
                    <div role="status" data-testid="atlas-no-pass" data-kind={none.kind} className="mb-3 rounded-lg border border-amber-700/60 bg-amber-950/20 p-3 text-xs text-amber-100">
                      <p><b>{none.text}</b></p>
                      {deciding.length > 0 && (
                        <>
                          <p className="mt-1">Among the confirmed failures, the deciding requirement, most common first:</p>
                          <ul className="mt-1 list-disc pl-5">
                            {deciding.map(({ requirement, cells }) => (
                              <li key={requirement.id}>{requirement.name ?? requirement.id} ({limitText(requirement)}): {cells} mission{cells === 1 ? '' : 's'}</li>
                            ))}
                          </ul>
                        </>
                      )}
                      {none.kind !== 'none_evaluated' && <p className="mt-1">Try shorter missions, another start date or interval, another site, or relax a requirement above. Select a cell to see what decides it.</p>}
                    </div>
                  )
                })()}

                {/* The map: rows = mission lengths, columns = tested landing dates. Arrow keys move, Enter opens in the Planner. */}
                <div
                  role="grid"
                  aria-label={`Feasibility of ${result.site_name} missions: rows are mission lengths, columns are tested landing dates every ${result.step_hours} hours`}
                  aria-rowcount={result.cells.length + 1}
                  aria-colcount={cols + 1}
                  onKeyDown={onGridKey}
                  className="overflow-x-auto pb-1"
                >
                  <div role="row" className="grid" style={{ gridTemplateColumns: gridCols }}>
                    <div role="columnheader" className="text-[10px] text-slate-500">Length</div>
                    {result.landing_utc.map((t, i) => (
                      <div key={t} role="columnheader" aria-label={fmtUtc(t)} className="relative h-8 text-[10px] text-slate-500">
                        {i % labelEvery === 0 && <span className="absolute bottom-0 left-0 origin-bottom-left -rotate-45 whitespace-nowrap">{t.slice(5, 10)}</span>}
                      </div>
                    ))}
                  </div>
                  {result.cells.map((line, r) => (
                    <div key={result.durations_days[r]} role="row" className="grid" style={{ gridTemplateColumns: gridCols }}>
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
                            className={`atlas-cell m-px flex h-8 cursor-pointer items-center justify-center rounded-[3px] text-[11px] font-bold outline-none ${selected ? 'ring-2 ring-ink ring-offset-1' : ''} focus-visible:ring-2 focus-visible:ring-sky-500`}
                            style={{ backgroundColor: COLOR[c.status].bg, color: COLOR[c.status].fg, backgroundImage: c.status === 'not_evaluated' ? HATCH : undefined }}
                          >
                            {wide && <span aria-hidden>{STATUS[c.status].symbol}</span>}
                          </div>
                        )
                      })}
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-slate-500">
                  Click a cell, or use the arrow keys (Home / End, Page Up / Down = a week of columns); Enter opens that mission (from this map) in the Planner.
                  Only the tested dates are shown: nothing is interpolated between them.
                </p>

                {/* Limitations stay visible: they decide how much a green cell can be trusted. */}
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[11px] text-slate-400" aria-label="Limitations of this map">
                  {result.limitations.map((l) => <li key={l}>{l}</li>)}
                </ul>

                <Disclosure className="mt-2" title="Passing landing windows, in words" summary="The map's colours as text">
                  <WindowsList r={result} />
                </Disclosure>
              </div>
            )}
          </section>

          {result && cell && (
            <aside aria-label="Selected mission" className="cmp-section min-w-0 self-start !p-4 xl:sticky xl:top-4" data-testid="atlas-inspector">
              <h2 className="mb-2 text-base font-medium text-ink">Selected mission</h2>
              <div className="space-y-3 text-xs">
                <p className="flex flex-wrap items-center gap-2 text-sm text-slate-200">
                  <StatusChip status={cell.status} />
                  <span>{fmtDays(cell.duration_days)} at {result.site_name}</span>
                </p>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                  <dt className="text-slate-500">Landing</dt><dd className="text-slate-200">{fmtUtc(cell.landing_utc)}</dd>
                  <dt className="text-slate-500">Decisive</dt>
                  <dd className="text-slate-200" aria-live="polite">{cell.reason}</dd>
                </dl>
                <div>
                  <button type="button" className={btnPrimary} disabled={!plan.ok} onClick={sendToPlanner} data-testid="atlas-open-planner"
                    aria-describedby="atlas-transfer-note">
                    Open this mission in the Planner
                  </button>
                  <p id="atlas-transfer-note" className="mt-1 text-[11px] text-slate-500">
                    {plan.ok ? (
                      <>Creates a plan from the map shown ({plan.from}) and runs it in the 3D view{cell.status === 'fail' ? '; it fails, so Mission Rescue can then look for alternatives' : ''}.{diffs.length > 0 && ' Your edited search is not used.'}</>
                    ) : plan.reason}
                  </p>
                </div>

                {cell.constraints && cell.constraints.length > 0 && (
                  <Disclosure id="atlas-requirement-table" title="Every requirement for this mission" summary="limits, measured values and margins">
                    <div className="overflow-x-auto">
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
                                <td className="pr-2 tabular-nums">{c.margin === null || c.margin === undefined ? '-' : `${c.margin >= 0 ? '+' : '−'}${measuredText({ ...c, measured: 'known', value: Math.abs(c.margin) }, q.unit)}`}</td>
                                <td>{c.status === 'pass' ? '✓ passes' : c.status === 'fail' ? '✕ fails' : c.status === 'unknown' ? `? undecided${c.note ? ` (${c.note})` : ''}` : 'n/a'}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </Disclosure>
                )}

                <Disclosure id="atlas-neighbours" title="Neighbouring tested dates" summary={`${fmtDays(cell.duration_days)} missions`}>
                  <ol className="flex flex-wrap gap-1" aria-label="The same mission at the neighbouring tested landing dates">
                    {neighbourhood(result, row, col).cells.map((n) => (
                      <li key={n.col}>
                        <button type="button" onClick={() => focusCell(row, n.col)}
                          aria-label={`${fmtUtc(n.landing_utc)}: ${STATUS[n.status].label}${n.selected ? ' (selected)' : ''}`}
                          className={`atlas-cell flex w-12 flex-col items-center rounded-md px-1 py-1 ${n.selected ? 'ring-2 ring-ink' : ''}`}
                          style={{ backgroundColor: COLOR[n.status].bg, color: COLOR[n.status].fg, backgroundImage: n.status === 'not_evaluated' ? HATCH : undefined }}>
                          <span className="text-sm font-bold" aria-hidden>{STATUS[n.status].symbol}</span>
                          <span className="text-[10px]">{n.landing_utc.slice(5, 10)}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                  <p className="mt-2 text-slate-300">{robustnessText(result, row, col)}</p>
                </Disclosure>
              </div>
            </aside>
          )}
        </div>

        {result && (
          <Disclosure className="mt-4" card level={2} title="How the Atlas works, and what it doesn't do yet" summary={`Engine ${result.engine_version}`}>
            <div className="text-xs text-slate-300">
              <p>{result.method}</p>
              <p className="mt-1"><b>Not implemented yet:</b> automatic refinement around a boundary (finer sampling where the result changes), capability studies (e.g. the battery a failing date would need) and sensitivity checks per cell. Engine {result.engine_version}.</p>
            </div>
          </Disclosure>
        )}
      </div>
    </div>
  )
}
