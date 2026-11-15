// Validation & Methodology: scientific credibility in three layers (review item #19).
//   1. Where an answer comes from: NASA data and the model inputs.
//   2. How it was checked: the independent comparisons, with the stored report's own numbers (/api/validation).
//   3. What it can establish: assumptions, coverage, resolution and limitations.
// Plus one reproducible mission. Wording follows docs/validation-engine.md; numbers come from the API, never typed in.
import { useEffect, useState } from 'react'

import '../compare/compare.css'
import { Section } from '../compare/ui'
import { fetchValidation, siteName, type IlluminationCheck, type ValidationSummary } from './api'

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

function Check({ label, scope, reference, children, limitation }: {
  label: string
  scope: string
  reference: string
  children: React.ReactNode
  limitation: string
}) {
  return (
    <article className="rounded-2xl bg-inset p-5">
      <h3 className="text-base font-medium text-ink">{label}</h3>
      <div className="mt-3 text-sm text-ink-2">{children}</div>
      <dl className="mt-4 space-y-1 text-xs text-ink-3">
        <div><dt className="inline font-medium text-ink-2">Scope: </dt><dd className="inline">{scope}</dd></div>
        <div><dt className="inline font-medium text-ink-2">Reference: </dt><dd className="inline">{reference}</dd></div>
        <div><dt className="inline font-medium text-ink-2">Limitation: </dt><dd className="inline">{limitation}</dd></div>
      </dl>
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
          <Check label="Sunlight vs what LROC observed from orbit" scope={il.scope} reference={il.reference} limitation={il.limitation}>
            <p className="mb-3">
              Over the area around each site the patterns correlate and the bias is a few percentage points. At a single point on a
              light/dark edge the model and one 100 m camera pixel can disagree a lot: see Connecting Ridge, where LROC’s own
              neighbourhood spans a wide range. These are observed discrepancies at a few sites, not an error bar.
            </p>
            <LrocChart data={il} />
            <AreaTable data={il} />
          </Check>
        </div>
      )}
    </div>
  )
}

export function MethodologyView() {
  const [state, setState] = useState<{ data?: ValidationSummary; error?: string }>({})
  useEffect(() => {
    const ctrl = new AbortController()
    fetchValidation(ctrl.signal)
      .then((data) => setState({ data }))
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setState({ error: e.message })
      })
    return () => ctrl.abort()
  }, [])
  const run = state.data?.run

  return (
    <div className="cmp-page lp-light md-host min-h-full">
      <div className="mx-auto max-w-[1500px] px-6 pb-16 pt-8 lg:px-8">
        <header className="mb-6 max-w-3xl">
          <h1 className="text-[28px] font-medium leading-tight text-ink">Validation & Methodology</h1>
          <p className="mt-2 text-base text-ink-3">
            Where each answer comes from, how it was checked, and what it can and cannot establish.
          </p>
        </header>

        <div className="space-y-6">
          <Section title="1. Where an answer comes from">
            <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              {PIPELINE.map((p, i) => (
                <li key={p.title} className="rounded-2xl bg-inset p-4">
                  <p className="text-xs text-ink-3">Step {i + 1}</p>
                  <h3 className="mt-1 text-sm font-medium text-ink">{p.title}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-ink-2">{p.body}</p>
                </li>
              ))}
            </ol>
            <p className="mt-4 text-xs text-ink-3">
              {run
                ? `This data set: ${run.sites} precomputed sites, ${run.data_range}, site files generator ${run.site_generator_versions.join(', ')}. Validation run ${run.run_utc.slice(0, 10)} on code ${run.code_commit}.`
                : 'This data set: 24 precomputed sites, 2026-01-01 to 2031-01-01 (validation details load from the backend).'}
            </p>
          </Section>

          <Section title="2. How it was checked">
            {state.error && (
              <p role="status" className="rounded-xl bg-inset p-4 text-sm text-ink-2">
                The validation results could not be loaded ({state.error}). The method and limitations below still apply; the full
                report is in docs/validation-engine.md.
              </p>
            )}
            {!state.data && !state.error && <p className="text-sm text-ink-3">Loading the stored validation results…</p>}
            {state.data && <Checks s={state.data} />}
          </Section>

          <Section title="3. What it can and cannot establish">
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
          </Section>

          <Section title="4. A mission you can reproduce">
            <div className="max-w-3xl text-sm text-ink-2">
              <p>
                Connecting Ridge, landing 2027-02-08 00:00 UTC, 7 days, with the default requirements written out in
                backend/app/rescue/demo_scenario.json (battery darkness ≤ 50 h, Earth blackout ≤ 96 h, sunlight ≥ 50%, Earth in
                view ≥ 40%). As planned it passes (score 100).
                After a 5-day launch delay it fails: the longest power gap is 63 h against a 50 h battery limit. Mission Rescue
                then finds passing alternatives; the top one lands at Malapert Massif on 2027-02-16 12:00 UTC, 84 h after the
                delayed date (score 100).
              </p>
              <p className="mt-2 text-ink-3">
                Reproduce it: in the Mission Planner create that plan, press Run, set Launch delay to 5 days and press Find alternatives.
                The same outcome is checked by an automated test (backend/tests/test_rescue_real_data.py) on every run of the test suite.
              </p>
            </div>
          </Section>

          <Section title="Sources">
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
          </Section>
        </div>
      </div>
    </div>
  )
}
