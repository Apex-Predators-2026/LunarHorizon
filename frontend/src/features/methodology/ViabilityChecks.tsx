// Software verification of the viability engine, from its stored validation report
// (GET /api/viability/validation-summary, written by `python -m app.viability.validation`).
//
// This is not the independent scientific validation (the Scientific validation tab: ephemeris, horizon geometry, LROC sunlight):
// it checks that the engine applies its own rules correctly on the committed site files (PASS / FAIL / UNKNOWN,
// bounds, ranking, invariants). Every figure shown is the report's; a missing, stale, failed or unreachable report
// is said to be exactly that, never shown as a success.
import { Disclosure } from '../compare/disclosure'
import type { ViabilityValidationState, ViabilityValidationSummary } from './api'
import { reportVerdict, siteName } from './api'

const text = (x: unknown) => (typeof x === 'string' ? x : JSON.stringify(x))
const int = (v: number) => v.toLocaleString('en-US')
const day = (iso: string) => iso.slice(0, 10)

function Banner({ s }: { s: ViabilityValidationSummary }) {
  const v = reportVerdict(s)
  const when = `generated ${day(s.generated_utc)}`
  if (v === 'failed') {
    const failedCases = s.cases.filter((c) => !c.passed)
    const failedInv = s.invariants.filter((i) => !i.passed)
    return (
      <div role="status" className="rounded-xl border border-red-800 bg-red-950 p-4 text-sm text-red-200">
        <p className="font-medium">
          The stored report records failures: {int(s.totals.failed)} of {int(s.totals.checks)} checks failed ({when}).
        </p>
        {failedCases.length > 0 && <p className="mt-1">Failing cases: {failedCases.map((c) => c.category).join(', ')}.</p>}
        {failedInv.length > 0 && <p className="mt-1">Failing invariants: {failedInv.map((i) => i.name).join('; ')}.</p>}
        {s.totals.smoke_failed.length > 0 && <p className="mt-1">Failed smoke checks: {s.totals.smoke_failed.map(text).join('; ')}.</p>}
      </div>
    )
  }
  if (v === 'stale_pass') {
    const c = s.currency
    return (
      <div role="status" className="rounded-xl border border-amber-800 bg-amber-950 p-4 text-sm text-amber-200">
        <p className="font-medium">
          Out of date: these {int(s.totals.checks)} checks passed when the report was {when}, but it no longer matches the
          running engine or data, so it does not verify the current version.
        </p>
        <p className="mt-1">{c.note}</p>
        <ul className="mt-1 list-disc pl-5">
          {c.version_mismatches.length > 0 && <li>Version changes: {c.version_mismatches.map(text).join('; ')}</li>}
          {c.changed_datasets.length > 0 && <li>Site files changed since: {c.changed_datasets.map(text).join('; ')}</li>}
          {c.unvalidated_datasets.length > 0 && <li>Site files never validated: {c.unvalidated_datasets.map(text).join('; ')}</li>}
        </ul>
        <p className="mt-1 text-xs">Regenerate: <code>{s.regenerate_command}</code></p>
      </div>
    )
  }
  return (
    <div role="status" className="rounded-xl border border-emerald-800 bg-emerald-950 p-4 text-sm text-emerald-200">
      <p className="font-medium">
        All {int(s.totals.checks)} recorded checks passed ({when}), and the report is current: {s.currency.note}
      </p>
    </div>
  )
}

/** The viability engine's validation report, or exactly why it cannot be shown. */
export function ViabilityChecks({ state }: { state: ViabilityValidationState }) {
  if (state.status === 'loading') return <p className="text-sm text-ink-3">Loading the stored viability-engine report…</p>
  if (state.status === 'missing')
    return (
      <p role="status" className="rounded-xl bg-inset p-4 text-sm text-ink-2">
        No viability-engine validation report has been generated, so no verification result is shown. {state.detail}
      </p>
    )
  if (state.status === 'unavailable')
    return (
      <p role="status" className="rounded-xl bg-inset p-4 text-sm text-ink-2">
        The viability-engine report could not be loaded ({state.detail}) No verification result is shown; the stored report
        and how to regenerate it are described in docs/member2-part2-validation.md.
      </p>
    )
  const s = state.summary
  const realCases = s.cases.filter((c) => !c.synthetic)
  const syntheticCases = s.cases.filter((c) => c.synthetic)
  const changed = s.datasets.filter((d) => !d.unchanged)
  const synthData = s.datasets.filter((d) => d.is_synthetic)
  const starts = [...new Set(s.datasets.map((d) => day(d.coverage_start_utc)))]
  const ends = [...new Set(s.datasets.map((d) => day(d.coverage_end_utc)))]
  const t = s.timing
  // Failures are never tucked away: the case list and invariants open themselves when the report records any.
  const failing = reportVerdict(s) === 'failed'
  return (
    <div className="space-y-3">
      <Banner s={s} />

      <div>
        <h3 className="text-sm font-medium text-ink">Scope: {s.cases.length} cases on real site data</h3>
        <p className="mt-1 text-xs text-ink-3">
          {realCases.length} use the committed real site files
          {syntheticCases.length ? `; ${syntheticCases.length} uses a labelled synthetic fixture only to show synthetic data is kept apart` : ''}.
          Plus {int(s.totals.smoke_checks)} smoke checks across every site file.
        </p>
      </div>

      <Disclosure level={4} defaultOpen={failing} title="Cases" summary={`${s.cases.length} cases, ${int(s.totals.checks)} checks`}>
        <table className="w-full max-w-[900px] text-left text-xs">
          <caption className="sr-only">Viability validation cases</caption>
          <thead className="text-ink-3">
            <tr>
              <th className="py-1 font-medium">Case</th>
              <th className="py-1 font-medium">Data</th>
              <th className="py-1 font-medium">Checks</th>
              <th className="py-1 font-medium">Result</th>
            </tr>
          </thead>
          <tbody className="text-ink-2">
            {s.cases.map((c) => (
              <tr key={c.name} className="border-t border-line">
                <td className="py-1">{c.category}</td>
                <td>{c.synthetic ? 'synthetic fixture' : typeof c.inputs.site === 'string' ? siteName(c.inputs.site) : 'real site files'}</td>
                <td className="tabular-nums">{c.check_count}</td>
                <td>{c.passed ? 'passed' : <span className="text-red-300">failed: {c.failed_checks.join('; ')}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Disclosure>

      <Disclosure level={4} defaultOpen={failing} title="Invariants" summary={`${s.invariants.filter((i) => i.passed).length} of ${s.invariants.length} held`}>
        <ul className="space-y-1 text-xs text-ink-2">
          {s.invariants.map((i) => (
            <li key={i.name}>
              <span className={i.passed ? 'text-emerald-300' : 'text-red-300'}>{i.passed ? 'Held' : 'Violated'}:</span> {i.name}
              <span className="text-ink-3"> ({i.detail})</span>
            </li>
          ))}
        </ul>
      </Disclosure>

      <Disclosure level={4} title="Data currency and versions" summary={`${s.datasets.length} site files, ${changed.length} changed since`}>
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="text-sm font-medium text-ink">Data currency</h3>
          <p className="mt-1 text-xs text-ink-2">
            {s.datasets.length} site files recorded with SHA-256 ({s.datasets.length - changed.length} unchanged now
            {changed.length ? `, ${changed.length} changed: ${changed.map((d) => siteName(d.site_id)).join(', ')}` : ''}).
            {synthData.length ? ` ${synthData.length} synthetic.` : ' None synthetic.'} Coverage {starts.join(', ')} to {ends.join(', ')}.
          </p>
          <p className="mt-1 text-xs text-ink-3">Report: {s.report_file} · {s.validation_version} · API {s.api_version}</p>
        </div>
        <div>
          <h3 className="text-sm font-medium text-ink">Versions verified</h3>
          <p className="mt-1 text-xs text-ink-2">
            {Object.entries(s.versions).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(' · ')}
          </p>
        </div>
      </div>
      </Disclosure>

      <p className="text-xs text-ink-3">
        Standard lander used by the cases: {Object.entries(s.standard_lander).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ')}.
        {t && t.evaluate_scenario_median_ms !== null && (
          <> Speed: one mission evaluation takes {t.evaluate_scenario_median_ms.toFixed(1)} ms median
            {t.evaluate_scenario_p95_ms !== null ? `, ${t.evaluate_scenario_p95_ms.toFixed(1)} ms p95` : ''} ({t.evaluate_scenario_workload ?? 'workload not recorded'}
            {t.machine ? `; ${String(t.machine.platform ?? '')}, Python ${String(t.machine.python ?? '')}` : ''}).</>
        )}
      </p>

      <Disclosure level={4} title="Limitations stated by the report" summary={`${s.limitations.length} stated`}>
        <ul className="list-disc space-y-1 pl-5 text-xs text-ink-2">
          {s.limitations.map((l) => <li key={l}>{l}</li>)}
        </ul>
      </Disclosure>
    </div>
  )
}
