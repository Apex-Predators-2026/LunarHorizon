// Validation & Methodology: scientific credibility in layers (review item #19). A compact overview first (what was
// checked, how fresh the reports are, the material limitations), then three views:
//   Scientific validation: independent checks with the stored report's own numbers (/api/validation).
//   Engine verification: software verification from its stored report (/api/viability/validation-summary,
//      ViabilityChecks.tsx); missing / stale / failed reports are said to be so.
//   Methods & sources: where an answer comes from, what it can establish, a reproducible mission, sources.
// Tables, plots and methodology sit behind explicit disclosures. Wording follows docs/validation-engine.md; numbers come from the API, never typed in.
import { useEffect, useState } from 'react'

import '../compare/compare.css'
import { Disclosure, TabPanel, Tabs, useReveal, type TabDef } from '../compare/disclosure'
import {
  fetchValidation,
  fetchViabilityValidation,
  reportVerdict,
  siteName,
  type IlluminationCheck,
  type ValidationSummary,
  type ViabilityValidationState,
} from './api'
import { ViabilityChecks } from './ViabilityChecks'

const deg = (v: number, digits = 4) => `${v.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '')}°`
const pct = (v: number) => `${v.toFixed(1)}%`
const int = (v: number) => v.toLocaleString('en-US')

const PIPELINE = [
  {
    title: 'Sun and Earth positions',
    body: 'NASA JPL Horizons gives the Sun and Earth direction as seen from each site (CENTER=coord@301, Moon-fixed frame), hourly from 2026 to 2031. Earth’s libration is included.',
  },
  {
    title: 'Terrain',
    body: 'NASA Moon Trek LRO LOLA elevation in three tiers: 5 m out to 5 km, 30 m out to 45 km, 200 m out to about 294 km.',
  },
  {
    title: 'Horizon mask',
    body: 'From a sensor 2 m above the ground, rays run along great circles in 720 directions (every 0.5°), with the Moon’s curvature, to find how high the terrain stands.',
  },
  {
    title: 'Hourly timeline',
    body: 'Sun and Earth are compared with that horizon every hour. The Sun is a 0.53° disk, so a half-hidden Sun counts as half; Earth counts by its centre point.',
  },
  {
    title: 'Your requirements',
    body: 'The viability engine checks the timeline against the plan’s sunlight, power-gap and Earth line-of-sight requirements: pass, fail, or unknown when real data does not fully cover the mission.',
  },
]

const ESTABLISHED = [
  'Sun and Earth directions match an independent ephemeris to well under a thousandth of a degree, at every sampled hour of every site.',
  'The horizon geometry matches an independent method on the same elevation data.',
  'Averaged over the area around each comparable site, modelled sunlight agrees with what the LROC camera recorded from orbit.',
  'Past landings behave as expected: Earth is always in view at the near-side sites and never at the far-side ones (Chang’e 4 and 6).',
]

const NOT_ESTABLISHED = [
  'An exact score under this sampled model is not a physical certainty. The checks above compare methods and observations; they are not an error bar that applies everywhere.',
  '“Unknown” bounds cover missing data only. They do not include terrain, landing-position or spacecraft-model uncertainty.',
  'Sunlight at a single point on a light/dark edge is indicative only: Connecting Ridge’s own LROC pixel and its neighbour 100 m away differ by more than 20 percentage points.',
  'Times are hourly samples, so rises and sets are known to about ±30 min. Terrain smaller than the 5–200 m resolution is smoothed.',
  'Earth visibility uses Earth’s centre (Earth is about 1.9° wide), and no observed reference product exists for it.',
  'There is no battery state-of-charge model (only a declared darkness tolerance) and no radio-link model (only line of sight).',
  'Nearby landing positions are not evaluated on real terrain; rescue and sensitivity report them as not evaluated.',
  '3D-view shadows depend on the graphics setting. The numbers always use the engine’s full ~300 km horizon.',
]

const SOURCES = [
  { name: 'NASA JPL Horizons', url: 'https://ssd.jpl.nasa.gov/horizons/' },
  { name: 'NASA Moon Trek (LRO LOLA)', url: 'https://trek.nasa.gov/moon/' },
  { name: 'NASA LROC QuickMap', url: 'https://quickmap.lroc.asu.edu/' },
  { name: 'Speyerer & Robinson 2013, Icarus 222, 122–136', url: 'https://doi.org/10.1016/j.icarus.2012.10.010' },
]

function Check({ label, scope, reference, children, limitation, detail }: {
  label: string
  scope: string
  reference: string
  children: React.ReactNode
  limitation: string
  /** Plots and tables: available on demand, after the summary. */
  detail?: { title: string; summary: string; children: React.ReactNode }
}) {
  return (
    <article className="rounded-2xl bg-inset p-5">
      <h3 className="text-base font-medium text-ink">{label}</h3>
      <div className="mt-3 text-sm text-ink-2">{children}</div>
      <Disclosure level={4} className="mt-3" title="Scope, reference and limitation" summary="what was compared, against what, and where it falls short">
        <dl className="space-y-1 text-xs text-ink-3">
          <div><dt className="inline font-medium text-ink-2">Scope: </dt><dd className="inline">{scope}</dd></div>
          <div><dt className="inline font-medium text-ink-2">Reference: </dt><dd className="inline">{reference}</dd></div>
          <div><dt className="inline font-medium text-ink-2">Limitation: </dt><dd className="inline">{limitation}</dd></div>
        </dl>
      </Disclosure>
      {detail && (
        <Disclosure level={4} className="mt-1" title={detail.title} summary={detail.summary}>
          {detail.children}
        </Disclosure>
      )}
    </article>
  )
}

/** Model vs LROC at each comparable site: the LROC 3x3 neighbourhood as a band, its pixel as a ring, the model as a dot. */
export function LrocChart({ data }: { data: IlluminationCheck }) {
  const rows = Object.entries(data.site_pixel)
  const top = Math.max(50, ...rows.flatMap(([, p]) => [p.model_any_sun_pct, p.lroc_3x3_pct[1]]))
  const max = Math.ceil(top / 10) * 10
  const W = 560
  const L = 170
  const R = 20
  const rowH = 44
  const x = (v: number) => L + (v / max) * (W - L - R)
  const ticks = Array.from({ length: max / 10 + 1 }, (_, i) => i * 10)
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${rows.length * rowH + 40}`} className="w-full max-w-[640px]" role="img"
        aria-label="Sunlight at each site: model compared with LROC observations">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={8} y2={rows.length * rowH + 8} stroke="currentColor" className="text-line" />
            <text x={x(t)} y={rows.length * rowH + 26} textAnchor="middle" className="fill-ink-3 text-[11px]">{t}%</text>
          </g>
        ))}
        {rows.map(([id, p], i) => {
          const cy = 8 + i * rowH + rowH / 2
          return (
            <g key={id}>
              <text x={0} y={cy + 4} className="fill-ink-2 text-[12px]">{siteName(id)}</text>
              <rect x={x(p.lroc_3x3_pct[0])} y={cy - 7} width={Math.max(2, x(p.lroc_3x3_pct[1]) - x(p.lroc_3x3_pct[0]))} height={14}
                rx={3} className="fill-[#d9dadd]" />
              <circle cx={x(p.lroc_pct)} cy={cy} r={6} fill="none" stroke="#3c4044" strokeWidth={2} />
              <circle cx={x(p.model_any_sun_pct)} cy={cy} r={5} fill="#b07a00" />
              <title>{`${siteName(id)}: model ${pct(p.model_any_sun_pct)}, LROC pixel ${pct(p.lroc_pct)}, LROC 3×3 neighbourhood ${pct(p.lroc_3x3_pct[0])}–${pct(p.lroc_3x3_pct[1])}`}</title>
            </g>
          )
        })}
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-3">
        <span><span aria-hidden className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-[#b07a00] align-middle" />Model: share of time any of the Sun is visible</span>
        <span><span aria-hidden className="mr-1 inline-block h-2.5 w-2.5 rounded-full border-2 border-[#3c4044] align-middle" />LROC: the site’s own 100 m pixel</span>
        <span><span aria-hidden className="mr-1 inline-block h-2.5 w-4 rounded-sm bg-[#d9dadd] align-middle" />LROC: range across the 3×3 pixels around it</span>
      </figcaption>
    </figure>
  )
}

function AreaTable({ data }: { data: IlluminationCheck }) {
  return (
    <table className="mt-4 w-full max-w-[640px] text-left text-xs">
      <caption className="sr-only">Area comparison with LROC around each site</caption>
      <thead className="text-ink-3">
        <tr>
          <th className="py-1 font-medium">Site (area grid)</th>
          <th className="py-1 font-medium">Correlation r</th>
          <th className="py-1 font-medium">Mean bias</th>
          <th className="py-1 font-medium">Mean abs. difference</th>
        </tr>
      </thead>
      <tbody className="tabular-nums text-ink-2">
        {Object.entries(data.area).map(([id, a]) => (
          <tr key={id} className="border-t border-line">
            <td className="py-1">{siteName(id)} <span className="text-ink-3">({a.points} points, {a.grid})</span></td>
            <td>{a.pearson_r === null ? (a.lroc_mean_pct === 0 ? 'n/a (dark in both)' : 'n/a') : a.pearson_r.toFixed(2)}</td>
            <td>{a.mean_bias_pct > 0 ? '+' : ''}{a.mean_bias_pct.toFixed(1)} pts</td>
            <td>{a.mean_abs_diff_pct.toFixed(1)} pts</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function Checks({ s }: { s: ValidationSummary }) {
  const e = s.ephemeris_agreement
  const h = s.horizon_method
  const il = s.illumination_observed
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {e && (
        <Check label="Sun and Earth positions vs an independent ephemeris" scope={e.scope} reference={e.reference} limitation={e.limitation}>
          <p>
            Largest difference <b className="font-medium text-ink">{deg(e.max_separation_deg, 5)}</b> (RMS {deg(e.max_rms_deg, 5)}).
            Of <b className="font-medium text-ink">{int(e.verdict_checks)}</b> sampled visible/blocked verdicts,{' '}
            <b className="font-medium text-ink">{int(e.verdict_changes)}</b> changed when the reference positions were used.
          </p>
        </Check>
      )}
      {h && (
        <Check label="Horizon geometry vs an independent method" scope={h.scope} reference={h.reference} limitation={h.limitation}>
          <p>
            Per-site largest difference between {deg(h.max_difference_deg.min, 4)} and{' '}
            <b className="font-medium text-ink">{deg(h.max_difference_deg.max, 3)}</b> ({siteName(h.max_difference_deg.site)}).
            As a control, a deliberately mirrored horizon differs by {deg(h.mirrored_max_deg.min, 1)} to {deg(h.mirrored_max_deg.max, 1)},
            so the check would catch a flipped direction convention.
          </p>
        </Check>
      )}
      {il && (
        <div className="xl:col-span-2">
          <Check label="Sunlight vs what LROC observed from orbit" scope={il.scope} reference={il.reference} limitation={il.limitation}
            detail={{
              title: 'Model vs LROC plot and area table',
              summary: 'each comparable site, and the correlation and bias around it',
              children: <><LrocChart data={il} /><AreaTable data={il} /></>,
            }}>
            <p>
              Over the area around each site the patterns correlate and the bias is a few percentage points. At a single point on a
              light/dark edge the model and one 100 m camera pixel can disagree a lot: see Connecting Ridge, where LROC’s own
              neighbourhood spans a wide range. These are observed discrepancies at a few sites, not an error bar.
            </p>
          </Check>
        </div>
      )}
    </div>
  )
}

export type MethodTab = 'science' | 'engine' | 'methods'
const METHOD_TABS: readonly TabDef<MethodTab>[] = [
  { id: 'science', label: 'Scientific validation', hint: 'Independent checks of the inputs and results against other references' },
  { id: 'engine', label: 'Engine verification', hint: 'Software checks that the viability engine applies its own rules correctly' },
  { id: 'methods', label: 'Methods & sources', hint: 'How an answer is made, what it can and cannot establish, a reproducible mission and the sources' },
]

/** How the engine's stored report stands, in words and a status colour: never a success it did not record. */
function engineStatus(state: ViabilityValidationState): { tone: 'ok' | 'warn' | 'bad' | 'none'; text: string } {
  if (state.status === 'loading') return { tone: 'none', text: 'Loading the stored report…' }
  if (state.status === 'missing') return { tone: 'none', text: 'No report has been generated, so no verification result is shown.' }
  if (state.status === 'unavailable') return { tone: 'none', text: 'The report could not be loaded, so no verification result is shown.' }
  const s = state.summary
  const v = reportVerdict(s)
  const date = s.generated_utc.slice(0, 10)
  if (v === 'failed') return { tone: 'bad', text: `The report records failures: ${int(s.totals.failed)} of ${int(s.totals.checks)} checks failed (${date}).` }
  if (v === 'stale_pass') return { tone: 'warn', text: `Out of date: ${int(s.totals.checks)} checks passed on ${date}, but the report no longer matches the running engine or data.` }
  return { tone: 'ok', text: `All ${int(s.totals.checks)} recorded checks passed (${date}) and the report is current.` }
}

const TONE: Record<'ok' | 'warn' | 'bad' | 'none', string> = {
  ok: 'border-l-emerald-600', warn: 'border-l-amber-500', bad: 'border-l-red-600', none: 'border-l-slate-400',
}

function Fact({ title, tone = 'none', children }: { title: string; tone?: 'ok' | 'warn' | 'bad' | 'none'; children: React.ReactNode }) {
  return (
    <div className={`min-w-0 rounded-xl border border-l-4 border-line bg-inset p-3 ${TONE[tone]}`}>
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">{title}</h3>
      <div className="mt-1 text-sm text-ink-2">{children}</div>
    </div>
  )
}

export function MethodologyView({ initialTab = 'science' }: { initialTab?: MethodTab } = {}) {
  const [state, setState] = useState<{ data?: ValidationSummary; error?: string }>({})
  const [engine, setEngine] = useState<ViabilityValidationState>({ status: 'loading' })
  const [tab, setTab] = useState<MethodTab>(initialTab)
  const reveal = useReveal((s) => s.reveal)
  useEffect(() => {
    const ctrl = new AbortController()
    fetchValidation(ctrl.signal)
      .then((data) => setState({ data }))
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setState({ error: e.message })
      })
    fetchViabilityValidation(ctrl.signal)
      .then(setEngine)
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setEngine({ status: 'unavailable', detail: e.message })
      })
    return () => ctrl.abort()
  }, [])
  const run = state.data?.run
  const checkCount = state.data ? [state.data.ephemeris_agreement, state.data.horizon_method, state.data.illumination_observed].filter(Boolean).length : 0
  const eng = engineStatus(engine)
  const open = (t: MethodTab, id?: string) => {
    setTab(t)
    if (id) reveal(id)
    requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById(id ?? `meth-tab-${t}`)?.scrollIntoView({ block: 'start', behavior: 'auto' })))
  }

  return (
    <div className="cmp-page lp-light md-host min-h-full">
      <div className="mx-auto max-w-[1500px] px-6 pb-16 pt-6 lg:px-8">
        <header className="mb-4 max-w-3xl">
          <h1 className="text-2xl font-medium leading-tight text-ink">Validation & Methodology</h1>
          <p className="mt-1 text-sm text-ink-3">
            Where each answer comes from, how it was checked, and what it can and cannot establish.
          </p>
        </header>

        {/* The credibility overview: what was checked, how fresh the reports are, and what remains uncertain. */}
        <section aria-labelledby="meth-overview-h" className="cmp-section !p-4">
          <h2 id="meth-overview-h" className="mb-3 text-base font-medium text-ink">What was checked</h2>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Fact title="Scientific validation">
              {state.error
                ? <p role="status">The stored results could not be loaded ({state.error}); the method and limitations still apply.</p>
                : !state.data
                  ? <p>Loading the stored validation results…</p>
                  : <p>{checkCount} independent {checkCount === 1 ? 'check' : 'checks'} against another ephemeris, another horizon method and LROC sunlight observations.</p>}
            </Fact>
            <Fact title="Engine verification (software)" tone={eng.tone}>
              <p role="status">{eng.text}</p>
            </Fact>
            <Fact title="Scope and freshness">
              <p>
                {run
                  ? `${run.sites} precomputed sites, ${run.data_range}. Scientific validation run ${run.run_utc.slice(0, 10)} on code ${run.code_commit}.`
                  : '24 precomputed sites, 2026-01-01 to 2031-01-01 (validation details load from the backend).'}
                {engine.status === 'loaded' && ` Engine report generated ${engine.summary.generated_utc.slice(0, 10)}.`}
              </p>
            </Fact>
            <Fact title="Material limitations" tone="warn">
              <ul className="list-disc space-y-1 pl-4 text-xs">
                {NOT_ESTABLISHED.slice(0, 3).map((t) => <li key={t}>{t}</li>)}
              </ul>
              <button type="button" className="cmp-btn-text mt-1 !h-8" onClick={() => open('methods', 'meth-limits')}>All {NOT_ESTABLISHED.length} limitations</button>
            </Fact>
          </div>
          <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-3">
            <span>Independent scientific validation and software verification are different things: each has its own tab below.</span>
            <button type="button" className="cmp-btn-text !h-8" onClick={() => open('methods', 'meth-repro')}>Reproduce a mission</button>
            <button type="button" className="cmp-btn-text !h-8" onClick={() => open('methods', 'meth-sources')}>Sources</button>
          </p>
        </section>

        <Tabs base="meth" label="Validation and methodology" tabs={METHOD_TABS} value={tab} onChange={setTab} className="mt-4" />

        <div className="mt-3 space-y-4">
          <TabPanel base="meth" id="science" value={tab}>
            <section aria-labelledby="meth-science-h" className="cmp-section">
              <h2 id="meth-science-h" className="text-lg font-medium text-ink">Scientific validation</h2>
              <p className="mb-4 mt-1 max-w-3xl text-sm text-ink-2">
                <b className="font-medium text-ink">Independent scientific validation.</b> The model’s inputs and results are
                compared with independent references: another ephemeris, another horizon method, and sunlight that the LROC
                camera observed from orbit.
              </p>
              {state.error && (
                <p role="status" className="rounded-xl bg-inset p-4 text-sm text-ink-2">
                  The validation results could not be loaded ({state.error}). The method and limitations still apply; the full
                  report is in docs/validation-engine.md.
                </p>
              )}
              {!state.data && !state.error && <p className="text-sm text-ink-3">Loading the stored validation results…</p>}
              {state.data && <Checks s={state.data} />}
            </section>
          </TabPanel>

          <TabPanel base="meth" id="engine" value={tab}>
            <section aria-labelledby="meth-engine-h" className="cmp-section">
              <h2 id="meth-engine-h" className="text-lg font-medium text-ink">Engine verification</h2>
              <p className="mb-4 mt-1 max-w-3xl text-sm text-ink-2">
                <b className="font-medium text-ink">Software verification, not scientific validation.</b> These checks confirm that
                the engine applies its own rules correctly on the committed site files: PASS, FAIL and UNKNOWN verdicts, bounds for
                missing data, scores and ranking. They show the software does what it specifies; they do not show the data or the
                model match the real Moon (that is the Scientific validation tab).
              </p>
              <ViabilityChecks state={engine} />
            </section>
          </TabPanel>

          <TabPanel base="meth" id="methods" value={tab}>
            <div className="space-y-4">
              <Disclosure id="meth-pipeline" card level={2} defaultOpen title="Where an answer comes from" summary="Five steps, from NASA data to a verdict">
                <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                  {PIPELINE.map((p, i) => (
                    <li key={p.title} className="rounded-2xl bg-inset p-4">
                      <p className="text-xs text-ink-3">Step {i + 1}</p>
                      <h3 className="mt-1 text-sm font-medium text-ink">{p.title}</h3>
                      <p className="mt-1 text-xs leading-relaxed text-ink-2">{p.body}</p>
                    </li>
                  ))}
                </ol>
              </Disclosure>

              <Disclosure id="meth-limits" card level={2} defaultOpen title="What it can and cannot establish" summary="Supported by the checks, and the limitations">
                <div className="grid gap-6 lg:grid-cols-2">
                  <div>
                    <h3 className="text-sm font-medium text-ink">Supported by the checks</h3>
                    <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-ink-2">
                      {ESTABLISHED.map((t) => <li key={t}>{t}</li>)}
                    </ul>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-ink">Not established (limitations)</h3>
                    <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-ink-2">
                      {NOT_ESTABLISHED.map((t) => <li key={t}>{t}</li>)}
                    </ul>
                  </div>
                </div>
              </Disclosure>

              <Disclosure id="meth-repro" card level={2} title="A mission you can reproduce" summary="Connecting Ridge, a launch delay, and the rescue that follows">
                <div className="max-w-3xl text-sm text-ink-2">
                  <p>
                    Connecting Ridge, landing 2027-02-08 00:00 UTC, 7 days, default requirements. As planned it passes (score 100).
                    After a 5-day launch delay it fails: the longest power gap is 63 h against a 50 h battery limit. Mission Rescue
                    then finds passing alternatives; the top one lands at Malapert Massif on 2027-02-16 12:00 UTC (score 100).
                  </p>
                  <p className="mt-2 text-ink-3">
                    Reproduce it: in the Mission Planner create that plan, press Run, set Launch delay to 5 days and press Find alternatives.
                    The same outcome is checked by an automated test (backend/tests/test_rescue_real_data.py) on every run of the test suite.
                  </p>
                </div>
              </Disclosure>

              <Disclosure id="meth-sources" card level={2} defaultOpen title="Sources" summary="NASA JPL Horizons, Moon Trek (LOLA), LROC QuickMap, Speyerer & Robinson 2013">
                <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
                  {SOURCES.map((s) => (
                    <li key={s.url}>
                      <a className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-current" href={s.url} target="_blank" rel="noopener noreferrer">
                        {s.name}
                      </a>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-xs text-ink-3">
                  Full method, earlier superseded runs and suggested follow-ups: docs/validation-engine.md. Re-run the checks with
                  backend/scripts/validate_engine.py.
                </p>
              </Disclosure>
            </div>
          </TabPanel>
        </div>
      </div>
    </div>
  )
}
