// The release gate's decision logic, kept apart from process spawning so it can be tested (release-gate.test.mjs).
//
// The one rule everything here serves: only evidence that RAN AND PASSED counts as a pass. Every piece of evidence is
//   true   it ran and proved what it claims
//   false  it ran and failed, or it ran and its own output is unreadable / contradicts the claim
//   null   it did not run, was skipped, was unavailable, or ran nothing: INCOMPLETE, never a pass
// and a check passes only if it has evidence and all of it is true. A check with no evidence is null, not true.

export const stripAnsi = (s) => String(s ?? '').replace(/\u001b\[[0-9;]*m/g, '')

const count = (text, word) => Number(new RegExp(`(\\d+) ${word}`).exec(text ?? '')?.[1] ?? 0)

/** The last pytest summary line ("2139 passed, 1 skipped in 671.78s") as counts, or null if there is none. */
export function pytestCounts(output) {
  const lines = stripAnsi(output).trim().split('\n')
  const line = [...lines].reverse().find((l) => / in [\d.]+s/.test(l) && /(passed|failed|error|skipped|deselected)/.test(l))
  if (!line) return null
  return {
    passed: count(line, 'passed'), failed: count(line, 'failed'), errors: count(line, 'errors?'), skipped: count(line, 'skipped'),
    xfailed: count(line, 'xfailed'), xpassed: count(line, 'xpassed'), deselected: count(line, 'deselected'), todo: 0,
    summary: line.replace(/=/g, '').trim(),
  }
}

/** Vitest's "Tests  658 passed (658)" / "Test Files  61 passed (61)" lines as counts, or null. */
export function vitestCounts(output) {
  const text = stripAnsi(output)
  const tests = /^\s*Tests\s+(.+?)\s*\((\d+)\)/m.exec(text)
  if (!tests) return null
  const files = /^\s*Test Files\s+(.+?)\s*\((\d+)\)/m.exec(text)
  return {
    passed: count(tests[1], 'passed'), failed: count(tests[1], 'failed'), errors: 0, skipped: count(tests[1], 'skipped'), todo: count(tests[1], 'todo'),
    total: Number(tests[2]), files: files ? { passed: count(files[1], 'passed'), failed: count(files[1], 'failed'), total: Number(files[2]) } : null,
    summary: `${files ? `${files[0].trim().replace(/\s+/g, ' ')}; ` : ''}${tests[0].trim().replace(/\s+/g, ' ')}`,
  }
}

/** oxlint's counts, from its JSON output (`oxlint -f json`; the text format prints no summary when piped) or its text summary. */
export function oxlintCounts(output) {
  const text = stripAnsi(output)
  try {
    const j = JSON.parse(text)
    if (Array.isArray(j.diagnostics)) {
      const sev = (s) => j.diagnostics.filter((d) => d.severity === s).length
      return { warnings: sev('warning'), errors: sev('error') + sev('deny'), files: j.number_of_files ?? null }
    }
  } catch { /* not JSON: try the text summary */ }
  const m = /Found (\d+) warnings? and (\d+) errors?/.exec(text)
  return m ? { warnings: Number(m[1]), errors: Number(m[2]) } : null
}

/**
 * Judge a test command: it must have exited 0, printed a readable summary, run at least one test, failed none and
 * skipped none (a skipped test proves nothing, so a required run with skips is INCOMPLETE, not a pass).
 */
export function judgeCounted(run, counts) {
  if (!run.ok) return { ok: false, tail: run.tail }
  if (!counts) return { ok: false, tail: 'the output has no test summary, so what ran cannot be told' }
  if (counts.failed > 0 || counts.errors > 0) return { ok: false, tail: `${counts.failed} failed, ${counts.errors} errors: ${counts.summary}` }
  if (counts.passed === 0) return { ok: false, tail: `no test ran: ${counts.summary}` }
  if (counts.skipped > 0 || counts.todo > 0) return { ok: null, tail: `${counts.skipped} skipped, ${counts.todo} todo: skipped tests prove nothing (${counts.summary})` }
  return { ok: true, tail: counts.summary }
}

/** Combine one check's evidence: any failure fails it, anything that did not run leaves it incomplete, nothing = incomplete. */
export function combine(evidence) {
  if (!evidence.length) return null
  if (evidence.some((e) => e.ok === false)) return false
  if (evidence.some((e) => e.ok !== true)) return null
  return true
}

/** The whole gate's verdict. Only a complete, clean, unchanged, unselected, fully-run pass is PASSED. */
export function verdictOf({ failedAny, changed, partial, complete, clean }) {
  if (changed) return 'INVALID (the source changed during verification: re-run)'
  if (failedAny) return 'FAILED'
  if (partial) return 'INCOMPLETE (a subset of checks, or --quick / --no-browser: not a release pass)'
  if (!complete) return 'INCOMPLETE (checks skipped, unavailable or not run: not a release pass)'
  if (!clean) return 'INCOMPLETE (passed on uncommitted source: commit and re-run for a release pass)'
  return 'PASSED'
}

// ---------------------------------------------------------------- browser journeys

export const VIEWPORTS = ['1366x768', '1920x1080']

/** The production smoke journey's steps (frontend/scripts/smoke-prod.mjs): every one must be present and pass. */
export const SMOKE_STEPS = [
  'Open the app: landing page, then the navigator',
  'Assess a site: Sun/Earth status, next events and the timeline',
  'Plan two missions (New plan dialog)',
  'Run a plan: it becomes the active mission and its card shows the canonical assessment',
  'Plan assessment in the Comparison: Show in 3D, then Back returns to the same assessment',
  "Investigate: the lander's-eye Sun view, the sky plot and the map layers",
  'Rescue: a 10-day launch slip, find alternatives',
  'Compare the two plans side by side',
  'Export the comparison (JSON and CSV files the user can keep)',
  'Feasibility Atlas: map dates x lengths, explain a cell, check neighbours, open it in the Planner',
  'Browser Back / Forward between the views; the 3D view is drawn again',
]

/** The guided journey's essential steps (frontend/scripts/e2e-guided.mjs): each at BOTH viewports (name prefixes). */
export const GUIDED_ESSENTIAL = [
  '1 mission: definition loaded', '2 original plan passes', "2 plan card shows the active plan's canonical verdict",
  "3 delay applied through Rescue's change control", '3 the saved plan keeps its date and verdict', '4 what changed: blackout PASS -> FAIL',
  '5 evidence opens the blackout window in 3D', '6 Rescue recovery passes', '6 the saved plan keeps its date and verdict after the Rescue search', '7 comparison recommends the recovery',
  '8 summary report opens for the evaluated selection', '8 report first page', '8 JSON = report snapshot', '8 JSON records dataset hashes',
  '8 Download PDF produces the report PDF', '8 A4 PDF renders only the report', '8 Letter PDF renders only the report', 'report flags a changed comparison', 'regenerate uses the new selection',
  'repeated restarts do not duplicate', "the user's own plan survives", 'atlas enter transfer creates exactly one plan', 'atlas enter transfer: the mapped site',
  "atlas enter transfer: the Planner's canonical verdict matches the cell", 'atlas button transfer creates exactly one plan',
  'atlas button transfer: the mapped site', "atlas button transfer: the Planner's canonical verdict matches the cell",
  'no page errors', 'no failed API requests',
]

/** The hourly-grid / incomplete-data journey (frontend/scripts/e2e-time-missing.mjs): API checks once, UI checks per viewport. */
export const TIME_MISSING_API = [
  'policy fixture', 'Comparison evaluates the grid interval', 'canonical assessment evaluates the same interval', 'Rescue evaluates the same landing and length',
  'Comparison says what it did', 'same verdict in all three tools', 'same canonical sunlight', 'incomplete data: whole-mission statistics withheld',
  'incomplete data: known hours reported', 'incomplete data: canonical bounds', 'incomplete data: the gap is its own unknown windows',
  'incomplete data: no darkness or blackout window', 'incomplete data: JSON has no NaN',
]
export const TIME_MISSING_UI = [
  'UI: the incomplete scenario says what is known', 'UI: the card lists what is withheld', 'UI: the card names its dataset file and hash',
  'UI: bounds shown instead of numbers', 'UI: unknown time is its own stretch', 'UI: no "best solar" claim', 'UI: no NaN rendered',
  'no page errors', 'no failed /api requests',
]
/** The cross-screen Show-why journey (frontend/scripts/e2e-evidence.mjs): from the Comparison into the 3D view and back, both viewports. */
export const EVIDENCE_STEPS = [
  'comparison offers Show why', '3D view not mounted on the comparison page', 'navigates to the Mission Planner', 'banner names the requirement and its origin',
  'banner shows the threshold', 'scene paused', 'scene looks toward the Sun or Earth', 'scene time is the evidence start', 'a real interval is shaded',
  'scene site matches the scenario', 'Back returns to the comparison section', 'repeated Show why applies again', "returning to the planner keeps the user's time",
  'no page errors', 'no failed API requests',
]
const EVIDENCE_ESSENTIAL = VIEWPORTS.flatMap((vp) => EVIDENCE_STEPS.map((n) => `${vp} ${n}`))
const TIME_MISSING_ESSENTIAL = [...TIME_MISSING_API, ...VIEWPORTS.flatMap((vp) => TIME_MISSING_UI.map((n) => `${vp} ${n}`))]

const hitFor = (report, wanted) => report.results.find((x) => x.name.startsWith(wanted))
const kindOf = (id) => (id === 'production' ? 'smoke' : id === 'time-missing' ? 'time-missing' : id === 'evidence' ? 'evidence' : 'guided') // guided and offline share a journey

/** Pass / fail of ONE named step of a browser run (guided/offline names are required at both viewports). */
export function stepResults(runs, ref) {
  const label = `browser (${ref.run})`
  const r = runs[ref.run]
  if (!r) return [{ what: `${label}: ${ref.step}`, ok: null, tail: 'browser run not executed' }]
  if (!r.report) return [{ what: `${label}: ${ref.step}`, ok: false, tail: `no report from this run (${r.tail})` }]
  if (kindOf(ref.run) === 'smoke') {
    const s = r.report.steps.find((x) => x.name === ref.step)
    return [{ what: `${label}: ${ref.step}`, ok: s?.status === 'pass', tail: s ? `${s.status}${s.error ? `: ${s.error}` : ''}` : 'MISSING: the step did not run' }]
  }
  return VIEWPORTS.map((vp) => {
    const hit = hitFor(r.report, `${vp} ${ref.step}`)
    return { what: `${label}, ${vp}: ${ref.step}`, ok: !!hit?.ok, tail: hit ? (hit.ok ? hit.detail ?? '' : `failed${hit.detail ? `: ${hit.detail}` : ''}`) : 'MISSING: the step did not run' }
  })
}

/** Whole-run result: the process exit, the report's identity, every essential step present and passing, nothing extra failing. */
export function wholeRunResult(runs, id) {
  const r = runs[id]
  const what = { production: 'production smoke journey, strict', guided: 'guided journey, production build', offline: 'guided journey, offline backend (LUNAR_OFFLINE=1)', 'time-missing': 'hourly-grid and missing-data journey, production build', evidence: 'Show-why journey from the Comparison, production build' }[id]
  if (!r) return { what: `whole run: ${what}`, ok: null, tail: 'browser run not executed' }
  if (!r.report) return { what: `whole run: ${what}`, ok: false, tail: `no report from this run (${r.tail})` }
  if (kindOf(id) === 'smoke') {
    const bad = r.report.steps.filter((x) => x.status !== 'pass')
    const missing = SMOKE_STEPS.filter((n) => !r.report.steps.some((x) => x.name === n))
    return {
      what: `whole run: ${what} (${r.report.steps.length} steps)`,
      ok: r.ok && bad.length === 0 && missing.length === 0 && r.report.strict === true && r.report.page_errors.length === 0 && r.report.api_failures.length === 0,
      tail: `${r.report.steps.length - bad.length}/${r.report.steps.length} steps passed; strict=${r.report.strict}; ${r.report.page_errors.length} page errors; ${r.report.api_failures.length} API failures`
        + `${bad.length ? `; not passed: ${bad.map((x) => `${x.name} (${x.status})`).join('; ')}` : ''}${missing.length ? `; MISSING steps: ${missing.join('; ')}` : ''}`,
    }
  }
  const essential = kindOf(id) === 'time-missing' ? TIME_MISSING_ESSENTIAL : kindOf(id) === 'evidence' ? EVIDENCE_ESSENTIAL : VIEWPORTS.flatMap((vp) => GUIDED_ESSENTIAL.map((n) => `${vp} ${n}`))
  const missing = essential.filter((n) => !hitFor(r.report, n))
  const failed = r.report.results.filter((x) => !x.ok)
  return {
    what: `whole run: ${what} (${r.report.results.length} checks)`,
    ok: r.ok && failed.length === 0 && missing.length === 0,
    tail: `${r.report.results.length - failed.length}/${r.report.results.length} passed${failed.length ? `; failed: ${failed.map((x) => x.name).slice(0, 6).join('; ')}` : ''}${missing.length ? `; MISSING essential steps: ${missing.slice(0, 6).join('; ')}` : ''}`,
  }
}
