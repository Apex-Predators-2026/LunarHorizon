// Scenario Comparison's methodology subpage (#app/compare/methodology): how a comparison is built, from
// the NASA data to the recommendation. A secondary page of the comparison, not a main view: it is opened
// from the bottom of the comparison and its Back button returns there. The comparison's state lives in
// its store, so nothing is lost while this page is shown.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { routeHash } from '../../../appRoute'
import { METRICS, type MetricDef } from '../analysis'
import { ProvenanceTag } from '../ui'
import { CurvatureExplorer, Figure, PipelineStepper, SunDiskExplorer, VerdictExplorer } from './MethodologyFigures'
import { backToComparison } from './methodology'
import './methodology.css'

const TOC = [
  { id: 'cmpm-overview', label: 'Overview' },
  { id: 'cmpm-data', label: 'Data sources' },
  { id: 'cmpm-models', label: 'Models' },
  { id: 'cmpm-calculations', label: 'Calculations' },
  { id: 'cmpm-criteria', label: 'Evaluation criteria' },
  { id: 'cmpm-assumptions', label: 'Assumptions & limits' },
  { id: 'cmpm-implementation', label: 'Technical implementation' },
] as const

function Part({ id, n, title, lead, children }: { id: string; n: number; title: string; lead: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="cmp-method-part scroll-mt-6">
      <p className="cmp-kicker">{String(n).padStart(2, '0')}</p>
      <h2 id={`${id}-h`} className="mt-1 text-xl font-medium text-ink">{title}</h2>
      <p className="mt-1 max-w-3xl text-sm leading-relaxed text-ink-3">{lead}</p>
      <div className="mt-5 space-y-5">{children}</div>
    </section>
  )
}

function Card({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={`cmp-method-card ${className}`}>
      <h3 className="text-sm font-medium text-ink">{title}</h3>
      <div className="mt-1.5 space-y-2 text-sm leading-relaxed text-ink-3">{children}</div>
    </div>
  )
}

const BackButton = ({ className = '' }: { className?: string }) => (
  <button type="button" className={`cmp-btn ${className}`} onClick={backToComparison}>
    <span aria-hidden="true">←</span> Back to Scenario Comparison
  </button>
)

// ---- content ------------------------------------------------------------------------------------

const SOURCES = [
  { name: 'NASA JPL Horizons', role: 'Where the Sun and Earth are in the sky',
    text: 'Topocentric azimuth, elevation and angular size of the Sun and Earth for each site, queried with CENTER=\'coord@301\' at the site’s coordinates, hourly from 2026 to 2031.',
    href: 'https://ssd.jpl.nasa.gov/horizons/' },
  { name: 'LRO LOLA elevation models (NASA Moon Trek)', role: 'What the terrain blocks',
    text: 'Lunar Orbiter Laser Altimeter digital elevation models of the south pole: 5 m near the site, 30 m to 45 km and 200 m out to about 300 km. They give each site its terrain horizon.',
    href: 'https://trek.nasa.gov/moon/' },
  { name: 'LROC QuickMap illumination', role: 'Independent check',
    text: 'The empirical south-pole illumination layer (WAC_POLE_ILL_TWI_SOUTH) is used to cross-check computed sunlight. It is a validation reference only, never an input.',
    href: 'https://quickmap.lroc.asu.edu/' },
  { name: 'Gracy & Lee, LPSC 2024', role: 'Site coordinates source',
    text: 'Locates the curated sites, including Connecting Ridge and Peak Near Shackleton (LPSC 55, abstract 1695). The site coordinates come from this work; it is not a validation of this model.',
    href: 'https://www.hou.usra.edu/meetings/lpsc2024/pdf/1695.pdf' },
]

const DEFAULT_REQUIREMENTS = [
  { req: 'Mean visible solar disk', rule: 'at least 50%', why: 'Enough sunlight overall for the solar arrays' },
  { req: 'Earth line of sight', rule: 'at least 40% of the mission', why: 'Enough direct-to-Earth contact time' },
  { req: 'Longest power darkness', rule: 'at most 50 h', why: 'The battery must last through every dark spell' },
  { req: 'Longest communication blackout', rule: 'at most 96 h', why: 'Contact must return before the limit' },
  { req: 'Sunlight right after landing', rule: 'at least 24 h continuous', why: 'Time to deploy and charge after touchdown' },
  { req: 'Earth contact right after landing', rule: 'at least 12 h continuous', why: 'Time to confirm landing and send first data' },
]

const SCORE_PARTS = [
  { part: 'Sunlight', from: 'Mean visible solar-disk fraction', weight: 1 },
  { part: 'Earth visibility', from: 'Earth line-of-sight share ÷ 100', weight: 1 },
  { part: 'Darkness margin', from: '(battery limit − longest darkness) ÷ limit, clipped to 0…1', weight: 1 },
  { part: 'Blackout margin', from: '(blackout limit − longest blackout) ÷ limit, clipped to 0…1', weight: 1 },
  { part: 'Simultaneous Sun and Earth', from: 'Share of time power-lit with Earth in view', weight: 0 },
]

const DECISIONS = [
  { kind: 'Recommended', text: 'Two or more comparable plans pass every requirement; the top-ranked one is preferred, with the reasons it wins.' },
  { kind: 'Only passing plan', text: 'Exactly one plan passes; it is the only option that meets every requirement.' },
  { kind: 'Nothing to compare', text: 'A passing plan has no comparable partner (different rules or data), so no ranking is claimed.' },
  { kind: 'Not enough data', text: 'Nothing is proven to pass and at least one plan cannot be decided: no conclusion is drawn.' },
  { kind: 'No plan passes', text: 'Every plan fails a requirement: no recommendation, only what would need to change.' },
]

const ASSUMPTIONS = [
  { t: 'No atmosphere', d: 'The Moon has none, so the horizon is a sharp geometric line: no refraction, no twilight.' },
  { t: 'Straight map sightlines', d: 'Each of the 720 sightlines runs straight in the polar map projection. Over hundreds of kilometres this differs slightly from a true great-circle path.' },
  { t: 'Earth centre, not its disk', d: 'Earth counts as visible when its centre clears the terrain. A partly hidden Earth may still be usable, or not, depending on the antenna.' },
  { t: 'Hourly sampling', d: 'Conditions are evaluated every whole UTC hour. Events shorter than an hour can fall between samples, so durations are accurate to about an hour.' },
  { t: 'Terrain resolution', d: 'Terrain is only as detailed as the LOLA grids: 5 m near the site, 200 m far away. Boulders and features smaller than that are not seen.' },
  { t: 'Simplified power', d: 'The panel threshold is a visibility rule, not a solar-array model. Idealised power figures are ceilings: real output is lower.' },
  { t: 'Unsupported checks stay Unknown', d: 'A minimum Sun or Earth clearance cannot yet be proven from the data, so such a requirement is reported Unknown, never silently passed.' },
  { t: 'A score is not a probability', d: 'The desirability score orders comparable plans; it is not a chance of mission success.' },
  { t: 'Data range', d: 'Real data covers the curated sites from 1 January 2026 to 1 January 2031. Demonstration data is synthetic, labelled, ranked separately and never for planning.' },
]

const STACK = [
  { lane: 'In the browser', items: ['React 19 + TypeScript (Vite)', 'Zustand stores: scenarios, results, ranking', 'Recharts and SVG charts', 'Mission Report: @react-pdf/renderer, loaded on demand'] },
  { lane: 'API (FastAPI)', items: ['POST /api/compare: evaluates each plan', 'GET /api/sites: curated sites and data range', '/api/assistant: proxy to the AI provider; the key never leaves the server'] },
  { lane: 'Engine (Python)', items: ['Horizon: numpy + rasterio over LOLA GeoTIFFs', 'Ephemeris: astroquery → JPL Horizons, precomputed hourly', 'Viability: metrics, constraints, scoring, ranking (Pydantic models)'] },
  { lane: 'Checks', items: ['2,100+ backend tests incl. a validation suite', 'Frontend tests for the comparison rules', 'Cross-checks against LROC and published results'] },
]

const GROUP_LABEL: Record<MetricDef['group'], string> = { solar: 'Sunlight', power: 'Power (idealised)', earth: 'Earth contact', mission: 'Mission' }
const BETTER_LABEL = { higher: 'Higher is better', lower: 'Lower is better' } as const

function MetricCatalogue() {
  const groups = useMemo(() => [...new Set(METRICS.map((m) => m.group))], [])
  const [group, setGroup] = useState<MetricDef['group']>(groups[0])
  const rows = METRICS.filter((m) => m.group === group)
  return (
    <Figure title="Every metric on the comparison page"
      caption="Taken from the same definitions the comparison table uses, so this list always matches what you see there.">
      <div role="radiogroup" aria-label="Metric group" className="mb-3 flex flex-wrap gap-2">
        {groups.map((g) => (
          <button key={g} type="button" role="radio" aria-checked={g === group} onClick={() => setGroup(g)} className="cmp-btn-quiet">
            {GROUP_LABEL[g]} <span className="text-ink-4">({METRICS.filter((m) => m.group === g).length})</span>
          </button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="cmp-method-table min-w-[560px]">
          <thead><tr><th scope="col">Metric</th><th scope="col">What it means</th><th scope="col">Direction</th><th scope="col">Source</th></tr></thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id}>
                <th scope="row">{m.label}</th>
                <td>{m.hint ?? '-'}</td>
                <td className="whitespace-nowrap">{m.better ? BETTER_LABEL[m.better] : 'Context only'}</td>
                <td><ProvenanceTag p={m.provenance} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Figure>
  )
}

/** The section being read, for the table of contents. */
function useActiveSection(ids: readonly string[]) {
  const [active, setActive] = useState<string>(ids[0])
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((list) => {
      const seen = list.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
      if (seen[0]) setActive(seen[0].target.id)
    }, { rootMargin: '-15% 0px -70% 0px' })
    ids.forEach((id) => {
      const el = document.getElementById(id)
      if (el) io.observe(el)
    })
    return () => io.disconnect()
  }, [ids])
  return active
}

export function ComparisonMethodology() {
  const rootRef = useRef<HTMLDivElement>(null)
  const ids = useMemo(() => TOC.map((t) => t.id), [])
  const active = useActiveSection(ids)
  // Opened from the bottom of the comparison: start at the top of the subpage.
  useLayoutEffect(() => {
    let el = rootRef.current?.parentElement ?? null
    while (el && !/auto|scroll/.test(getComputedStyle(el).overflowY)) el = el.parentElement
    ;(el ?? document.scrollingElement)?.scrollTo({ top: 0 })
  }, [])
  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <div ref={rootRef} className="cmp-page lp-light md-host min-h-full" data-testid="comparison-methodology">
      <div className="mx-auto max-w-[1200px] px-4 pb-16 pt-6 sm:px-6 lg:px-8">
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center justify-between gap-3">
          <BackButton />
          <ol className="flex items-center gap-1.5 text-xs text-ink-4">
            <li><a href={routeHash('compare')} onClick={(e) => { e.preventDefault(); backToComparison() }} className="hover:text-ink">Scenario Comparison</a></li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="text-ink-2">Methodology</li>
          </ol>
        </nav>

        <header className="cmp-method-hero mt-5">
          <p className="cmp-kicker">Scenario Comparison · Methodology</p>
          <h1 className="mt-1 text-2xl font-medium leading-tight text-ink sm:text-3xl">How This Analysis Was Built</h1>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-ink-3 sm:text-base">
            Every comparison starts from NASA data: where the Sun and Earth are in the sky, from JPL Horizons, and what
            the terrain blocks, from LRO LOLA elevation models. From these the engine works out, hour by hour, when a
            landing site has sunlight and Earth contact, judges each plan against its requirements, and ranks only the
            plans that can fairly be compared.
          </p>
          <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['720', 'horizon directions per site (every 0.5°)'],
              ['≈300 km', 'of terrain in every direction'],
              ['1 h', 'time step, 2026 to 2031'],
              ['3', 'verdicts: Pass, Fail, Unknown'],
            ].map(([v, l]) => (
              <div key={l} className="cmp-method-stat"><dt className="sr-only">{l}</dt><dd><span className="block text-xl font-medium text-ink">{v}</span><span className="block text-xs text-ink-3">{l}</span></dd></div>
            ))}
          </dl>
        </header>

        <div className="mt-8 lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-10">
          <nav aria-label="On this page" className="cmp-method-toc">
            <p className="mb-2 hidden text-xs font-medium uppercase tracking-wide text-ink-4 lg:block">On this page</p>
            <ul>
              {TOC.map((t) => (
                <li key={t.id}>
                  <a href={`#${t.id}`} aria-current={active === t.id ? 'location' : undefined}
                    onClick={(e) => { e.preventDefault(); go(t.id) }}>{t.label}</a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="min-w-0 space-y-6">
            <Part id="cmpm-overview" n={1} title="Overview: from a plan to a recommendation"
              lead="A comparison runs the same seven steps for every plan, so plans differ only where their sites, dates or requirements differ. Choose a step to see what it takes in and produces.">
              <PipelineStepper />
            </Part>

            <Part id="cmpm-data" n={2} title="Data sources"
              lead="Two NASA datasets drive every number; two more independent references are used only to check the results.">
              <div className="grid gap-4 sm:grid-cols-2">
                {SOURCES.map((s, i) => (
                  <div key={s.name} className="cmp-method-card">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-ink-4">{i < 2 ? 'Input' : 'Validation'} · {s.role}</p>
                    <h3 className="mt-1 text-sm font-medium text-ink">{s.name}</h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-ink-3">{s.text}</p>
                    <a href={s.href} target="_blank" rel="noreferrer" className="cmp-method-link mt-2 inline-block text-xs">Visit source ↗</a>
                  </div>
                ))}
              </div>
              <p className="text-sm text-ink-3">
                How these results were checked against LROC and the published values, site by site, is in the app’s{' '}
                <a href={routeHash('method')} className="cmp-method-link">Validation &amp; Methodology</a> view.
              </p>
            </Part>

            <Part id="cmpm-models" n={3} title="Models"
              lead="Near the south pole the Sun and Earth sit just above the horizon, so small terrain details decide whether a site is lit or in contact. Three models handle this.">
              <Card title="Terrain horizon">
                <p>For each site the engine looks out in 720 directions, every 0.5° of azimuth. Along each it steps outward (5 m steps to 5 km, 30 m to 45 km, 200 m to about 300 km), reads the finest LOLA terrain available there and keeps the highest angle it sees. That angle is the horizon in that direction.</p>
                <p>Each angle accounts for the Moon’s curvature: angle = atan((h<sub>terrain</sub> − h<sub>site</sub> − d²/2R) / d).</p>
              </Card>
              <CurvatureExplorer />
              <SunDiskExplorer />
              <Card title="Earth line of sight">
                <p>Earth hangs almost still in the lunar sky but, near the pole, only a few degrees above the horizon. Libration makes it wander by several degrees over a month, so at some sites it slips behind terrain for days. Earth is counted visible when its centre is above the terrain horizon in its direction; the longest gap is the communication blackout.</p>
              </Card>
              <Card title="Time">
                <p>Missions are evaluated on the hourly data grid: the landing time is rounded to the nearest whole UTC hour and the length to whole hours. Two plans that land in the same hour are the same date for the engine.</p>
              </Card>
            </Part>

            <Part id="cmpm-calculations" n={4} title="Calculations"
              lead="Hourly conditions become mission metrics: how much of the time something holds, the longest spell it does not, and what happens right after landing.">
              <div className="grid gap-4 md:grid-cols-3">
                <Card title="Shares of time"><p>Sunlight, power-lit and Earth-visible hours divided by the evaluated mission length, as percentages.</p></Card>
                <Card title="Longest spells"><p>The longest unbroken run of power darkness (what the battery must survive) and of Earth blackout (the longest silence).</p></Card>
                <Card title="After landing"><p>Continuous sunlight and Earth contact from touchdown, and the time until the first sunset and first Earth-set.</p></Card>
              </div>
              <Card title="When data is missing">
                <p>If some hours have no data, a metric is not guessed. It is given as the range it must lie in. For example, with 10 of 100 hours missing, a site seen lit for 60 hours was lit between 60% and 70% of the time. Every verdict and score respects that range.</p>
              </Card>
              <MetricCatalogue />
            </Part>

            <Part id="cmpm-criteria" n={5} title="Evaluation criteria"
              lead="First each plan is judged against hard requirements. Only plans that pass are ranked, and only against plans judged by the same rules.">
              <VerdictExplorer />
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="cmp-method-card">
                  <h3 className="text-sm font-medium text-ink">Default requirements</h3>
                  <p className="mt-1 text-xs text-ink-3">Every plan can change these; the values below are the starting point.</p>
                  <table className="cmp-method-table mt-3">
                    <thead><tr><th scope="col">Requirement</th><th scope="col">Rule</th></tr></thead>
                    <tbody>
                      {DEFAULT_REQUIREMENTS.map((r) => (
                        <tr key={r.req}><th scope="row">{r.req}<span className="block text-xs font-normal text-ink-4">{r.why}</span></th><td className="whitespace-nowrap">{r.rule}</td></tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-3 text-xs text-ink-3">Panels count as dark when less than 25% of the solar disk is visible. A plan is eligible only if no requirement fails and none is Unknown.</p>
                </div>
                <div className="cmp-method-card">
                  <h3 className="text-sm font-medium text-ink">Desirability score</h3>
                  <p className="mt-1 text-xs text-ink-3">For eligible plans only: 100 × the weighted average of these parts, each between 0 and 1.</p>
                  <table className="cmp-method-table mt-3">
                    <thead><tr><th scope="col">Part</th><th scope="col">Measured as</th><th scope="col">Weight</th></tr></thead>
                    <tbody>
                      {SCORE_PARTS.map((p) => (
                        <tr key={p.part} className={p.weight ? '' : 'text-ink-4'}>
                          <th scope="row">{p.part}</th><td>{p.from}</td>
                          <td className="whitespace-nowrap tabular-nums">{p.weight ? `${Math.round((100 * p.weight) / 4)}%` : 'off'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-3 text-xs text-ink-3">If a part is known only as a range, the score is a range too. The score orders plans; it is not a probability of success.</p>
                </div>
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <Card title="Fair comparison groups">
                  <p>Plans are ranked against each other only when they share the same data basis, scoring method and weights, spacecraft limits, panel threshold, every hard requirement and mission length. Otherwise a difference could come from the rules rather than the site or date, so those plans are placed in separate groups.</p>
                  <p>Real data and demonstration data are never ranked together.</p>
                </Card>
                <Card title="What counts as a real difference">
                  <p>Two plans are called different on a metric only when the gap is large enough to matter:</p>
                  <ul className="list-disc space-y-0.5 pl-5">
                    <li>1 percentage point for shares of time</li>
                    <li>2 hours or 10%, whichever is larger, for durations</li>
                    <li>0.1° for angles</li>
                  </ul>
                  <p>Smaller gaps are reported as ties, so a “best” mark never rests on noise.</p>
                </Card>
              </div>
              <div className="cmp-method-card">
                <h3 className="text-sm font-medium text-ink">The decision you see at the top</h3>
                <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {DECISIONS.map((d) => (
                    <li key={d.kind} className="rounded-xl bg-[var(--color-inset)] p-3">
                      <p className="text-sm font-medium text-ink">{d.kind}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-ink-3">{d.text}</p>
                    </li>
                  ))}
                </ul>
              </div>
            </Part>

            <Part id="cmpm-assumptions" n={6} title="Assumptions and limitations"
              lead="What the model simplifies, and what it cannot tell you. The comparison page repeats the ones that apply to your plans.">
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {ASSUMPTIONS.map((a) => (
                  <li key={a.t} className="cmp-method-card">
                    <p className="text-sm font-medium text-ink">{a.t}</p>
                    <p className="mt-1 text-sm leading-relaxed text-ink-3">{a.d}</p>
                  </li>
                ))}
              </ul>
            </Part>

            <Part id="cmpm-implementation" n={7} title="Technical implementation"
              lead="The browser never computes a scientific result: it sends the plans to the backend engine and shows what comes back.">
              <ol className="cmp-method-flow" aria-label="Architecture, from the browser to the engine">
                {STACK.map((s) => (
                  <li key={s.lane} className="cmp-method-card">
                    <p className="text-sm font-medium text-ink">{s.lane}</p>
                    <ul className="mt-2 space-y-1 text-xs leading-relaxed text-ink-3">{s.items.map((it) => <li key={it}>{it}</li>)}</ul>
                  </li>
                ))}
              </ol>
              <Card title="Reports and the Mission Assistant">
                <p>A Mission Report freezes the comparison when it is made. If you change the plans afterwards, it is marked out of date instead of silently changing. The Mission Assistant reads the same results to explain them in plain language; it cannot change a result, and when no AI provider is configured it says so rather than inventing an answer.</p>
              </Card>
            </Part>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6">
              <p className="text-sm text-ink-3">Your plans, results and settings are kept while you read.</p>
              <BackButton />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
