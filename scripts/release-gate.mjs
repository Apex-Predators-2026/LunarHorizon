// Release gate: the checks a release must pass, each tied to the evidence that actually proves it, with the tested
// source identity, the exact commands and the pass / fail / incomplete result of each kept in release-gate/ (commit
// the record with the release).
//
//   node scripts/release-gate.mjs                 everything: full suites, type check, lint, production build and the
//                                                 four browser journeys (about 25 minutes on a prepared machine)
//   node scripts/release-gate.mjs --quick         skip the full backend / frontend suites (their gates stay INCOMPLETE)
//   node scripts/release-gate.mjs --no-browser    skip the browser journeys (their gates stay INCOMPLETE)
//   node scripts/release-gate.mjs --only atlas,export   re-run some checks after a fix (never a release pass)
//   node scripts/release-gate.mjs --list          print the gate ids and exit
//
// Required gates (ids):
//   backend-tests   full pytest suite            frontend-tests  full vitest suite     typecheck  tsc -b
//   lint            oxlint (errors fail)         build           npm run build
//   ...then the evidence checks (pass, fail, unknown, time-missing, mission-story, evidence, planner, comparison,
//   atlas, export, decision-report, scientific-validation, navigation) and the three browser gates
//   (production = strict smoke journey, guided = guided mission, offline = guided against LUNAR_OFFLINE=1).
//
// A gate is PASS only if everything it declares RAN AND PASSED. A skipped, unavailable or not-run piece of evidence makes
// it INCOMPLETE (never a pass); a test run that skips tests, runs none, or has no readable summary does not pass
// (scripts/release-gate-lib.mjs, tested by scripts/release-gate.test.mjs).
//
// Modes, kept apart on purpose (each record says which it used):
//   development  the Vite dev server: NEVER evidence here (it serves modules, not the shipped bundle)
//   production   dist/ built by `npm run build`, served by `vite preview` with /api proxied to a backend this script starts
//                on port 8011, from a fresh browser profile; strict (a missing journey step fails)
//   offline      the same production build against a backend this script starts with LUNAR_OFFLINE=1 (port 8012): only
//                committed site files and cached terrain; no NASA service is contacted. The script proves the mode is active.
// Browser runs use real Chrome/Edge (CHROME_PATH) at 1366x768 and 1920x1080 (guided) from the terrain cache the machine
// prepared (docs/demo-setup.md). Each report carries this run's id, so a report left from an earlier run is never read.
//
// Source identity: HEAD, the uncommitted files under backend/ frontend/ data/ scripts/ and a hash of their diff are
// recorded before and after. A dirty tree is not a release pass; a change during the run makes the result INVALID.
// Exit code 1 unless the gate PASSED.
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { combine, judgeCounted, oxlintCounts, pytestCounts, stepResults, verdictOf, vitestCounts, wholeRunResult } from './release-gate-lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND = join(ROOT, 'backend')
const FRONTEND = join(ROOT, 'frontend')
const OUT = join(ROOT, 'release-gate')
const args = process.argv.slice(2)
const flag = (n) => args.includes(`--${n}`)
const only = (() => {
  const i = args.indexOf('--only')
  return i >= 0 ? new Set((args[i + 1] ?? '').split(',').filter(Boolean)) : null
})()
const PY = process.env.PYTHON ?? [
  join(BACKEND, '.venv', 'Scripts', 'python.exe'), join(BACKEND, '.venv', 'bin', 'python'),
  join(ROOT, '.venv', 'Scripts', 'python.exe'), join(ROOT, '.venv', 'bin', 'python'),
].find(existsSync) ?? 'python'
const WIN = process.platform === 'win32'
const NPX = WIN ? 'npx.cmd' : 'npx'
const NPM = WIN ? 'npm.cmd' : 'npm'
const RUN_ID = randomUUID()
const PORT_ONLINE = 8011
const PORT_OFFLINE = 8012

// pytest node ids are relative to backend/, vitest paths to frontend/.
const RV = 'tests/viability/test_real_sites_phase6_explanations.py'
const g = (...names) => names.map((step) => ({ run: 'guided', step }))
const sm = (...names) => names.map((step) => ({ run: 'production', step }))
const SUITES = [
  { id: 'backend-tests', name: 'Backend: full pytest suite', kind: 'pytest', cmd: PY, argv: ['-m', 'pytest', '-q', '-p', 'no:cacheprovider'], cwd: BACKEND, env: { LUNAR_OFFLINE: '1' } },
  { id: 'frontend-tests', name: 'Frontend: full vitest suite', kind: 'vitest', cmd: NPX, argv: ['vitest', 'run'], cwd: FRONTEND },
  { id: 'typecheck', name: 'Frontend: TypeScript (tsc -b)', kind: 'plain', cmd: NPX, argv: ['tsc', '-b'], cwd: FRONTEND },
  { id: 'lint', name: 'Frontend: lint (oxlint; errors fail, warnings are recorded)', kind: 'oxlint', cmd: NPX, argv: ['oxlint', '-f', 'json'], cwd: FRONTEND },
]
const BUILD = { id: 'build', name: 'Frontend: production build (npm run build = tsc -b + vite build)', kind: 'plain', cmd: NPM, argv: ['run', 'build'], cwd: FRONTEND }

const CHECKS = [
  {
    id: 'pass', name: 'Real passing mission (engine)', outcome: 'Correct verdict, metrics and explanation on real site data',
    pytest: [`${RV}::test_malapert_lit_season_pass`, `${RV}::test_explanations_quote_independently_computed_values`,
      'tests/test_compare_evidence.py::test_assessment_carries_canonical_metric_states_and_versions',
      'tests/test_compare_evidence.py::test_constraints_match_the_verdict'],
  },
  {
    id: 'fail', name: 'Real failed mission (engine)', outcome: 'Correct violated requirement and evidence window',
    pytest: [`${RV}::test_peak_near_shackleton_night_landing`, `${RV}::test_shackleton_floor_control_fails_everything`,
      `${RV}::test_connecting_ridge_blackout_in_progress_at_landing`,
      'tests/test_compare_evidence.py::test_failed_requirements_carry_the_engine_evidence_windows'],
  },
  {
    id: 'unknown', name: 'UNKNOWN mission (engine and UI logic)', outcome: 'UNKNOWN stays UNKNOWN: no fabricated zero values or false failure',
    pytest: [`${RV}::test_mission_past_dataset_end_is_unknown_not_failed`, `${RV}::test_connecting_ridge_without_any_data`,
      'tests/test_rescue_unknown.py', 'tests/test_compare_ranking.py::test_missing_score_is_never_zero_and_measured_zero_is_kept',
      'tests/test_compare_ranking.py::test_unknown_stays_unknown_with_its_reason', 'tests/test_compare_evidence.py::test_unknown_samples_stay_unknown'],
    vitest: ['src/features/compare/missingData.test.tsx'],
  },
  {
    id: 'time-missing', name: 'Hourly-grid mission time and incomplete data across tools', outcome: 'Comparison, assessment and Rescue evaluate the same hourly-grid interval (request kept distinct); a data gap gives bounds and unknown stretches, never fabricated values',
    pytest: ['tests/test_timegrid.py', 'tests/test_compare_evidence.py::test_unknown_samples_stay_unknown'],
    vitest: ['src/features/compare/missionTime.test.tsx', 'src/features/compare/missionTimeRecovery.test.tsx', 'src/features/compare/missingData.test.tsx'],
    wholeRun: ['time-missing'],
  },
  {
    id: 'mission-story', name: 'Guided mission journey (Try a mission)', outcome: 'Real mission: PASS -> delay -> FAIL with evidence -> Rescue recovery PASS -> recommended; one saved plan however often it restarts',
    pytest: ['tests/test_mission_story.py', 'tests/test_guided_mission.py'],
    command: { label: 'python scripts/verify_mission_story.py (replay of the committed mission definition)', argv: ['scripts/verify_mission_story.py'], cwd: BACKEND, env: { LUNAR_OFFLINE: '1' }, must: /VERIFIED/ },
    vitest: ['src/features/guide/guide.test.tsx'],
    browser: g('1 mission: definition loaded', '2 original plan passes', '3 delay applied', '4 what changed: blackout PASS -> FAIL', '6 Rescue recovery passes',
      '7 comparison recommends the recovery', 'repeated restarts do not duplicate', "the user's own plan survives"),
  },
  {
    id: 'evidence', name: 'Show why: evidence in the 3D view', outcome: 'The canonical window, at the right site and time, with the way back',
    vitest: ['src/viz/evidence.test.tsx', 'src/features/assessment/sharedState.test.tsx', 'src/features/assessment/evidenceReturn.test.tsx'],
    browser: [...g('5 evidence opens the blackout window in 3D'), ...sm('Plan assessment dialog: Show in 3D, then Back returns to the same dialog')],
    wholeRun: ['evidence'],
  },
  {
    id: 'planner', name: "Planner and Playback show the canonical assessment", outcome: 'Verdict from the viability engine on the plan card, tied to the plan; Playback never invents a PASS',
    vitest: ['src/viz/MissionPlayback.test.tsx', 'src/lib/assessment.test.tsx', 'src/features/assessment/assessment.test.tsx', 'src/viz/mission.test.ts'],
    browser: [...sm('Run a plan: it becomes the active mission and its card shows the canonical assessment'), ...g("2 plan card shows the active plan's canonical verdict")],
  },
  {
    id: 'comparison', name: 'Comparison', outcome: 'Eligible ranks in comparable groups; no "best" across real and synthetic data',
    pytest: ['tests/test_compare_ranking.py'],
    vitest: ['src/features/compare/compare.test.tsx', 'src/features/compare/bestPool.test.tsx', 'src/features/compare/bestPoolRecovery.test.tsx', 'src/features/compare/decision.test.tsx'],
    browser: [...sm('Compare the two plans side by side'), ...g('7 comparison recommends the recovery')],
  },
  {
    id: 'atlas', name: 'Feasibility Atlas', outcome: 'A cell opens the mission that map evaluated (Enter and button), even after the form is edited',
    pytest: ['tests/test_atlas.py'],
    vitest: ['src/features/atlas/atlas.test.ts', 'src/features/atlas/session.test.ts'],
    browser: [...sm('Feasibility Atlas: map dates x lengths, explain a cell, check neighbours, open it in the Planner'),
      ...g('atlas enter transfer: the mapped site', 'atlas button transfer: the mapped site', "atlas enter transfer: the Planner's canonical verdict matches the cell")],
  },
  {
    id: 'export', name: 'Comparison export (JSON / CSV files)', outcome: 'Downloads keep missing values, UNKNOWN and valid ranks only',
    vitest: ['src/features/compare/export.test.tsx'],
    browser: sm('Export the comparison (JSON and CSV files the user can keep)'),
  },
  {
    id: 'decision-report', name: 'Mission decision report (frozen snapshot)', outcome: 'Preview of a frozen evaluated snapshot, matching JSON, A4 / Letter print, stale + regenerate',
    vitest: ['src/features/compare/report.test.tsx', 'src/features/compare/reportCard.test.tsx', 'src/features/compare/reportHeader.test.tsx', 'src/features/compare/reportRecovery.test.tsx'],
    browser: g('8 summary report opens for the evaluated selection', '8 report first page', '8 JSON = report snapshot', '8 JSON records dataset hashes',
      '8 Download PDF produces the report PDF', '8 A4 PDF renders only the report', '8 Letter PDF renders only the report', 'report flags a changed comparison', 'regenerate uses the new selection'),
  },
  {
    id: 'scientific-validation', name: 'Scientific validation (data-engine checks)', outcome: 'Stored independent checks are reproducible and shown in the Methodology view',
    pytest: ['tests/test_validation_report.py', 'tests/viability/test_part2_validation.py::test_demo_snapshot_is_reproducible', 'tests/test_timegrid.py'],
    vitest: ['src/features/methodology/methodology.test.tsx'],
  },
  {
    id: 'navigation', name: 'Navigation', outcome: 'No route collisions or lost scenarios; Back / Forward redraw the 3D view',
    vitest: ['src/appRoute.test.ts'],
    browser: sm('Browser Back / Forward between the views; the 3D view is drawn again', 'Compare the two plans side by side'),
  },
  {
    id: 'production', name: 'Production build, strict smoke journey', outcome: 'Every journey step present and passing in a fresh browser; no page errors, no 5xx',
    wholeRun: ['production'],
  },
  {
    id: 'guided', name: 'Guided mission journey on the production build', outcome: 'Every essential step passes at 1366x768 and 1920x1080: load, assess, delay, show why, rescue, compare, frozen report, JSON, PDF, Atlas transfer',
    wholeRun: ['guided'],
  },
  {
    id: 'offline', name: 'Prepared offline verification (local backend, LUNAR_OFFLINE=1)', outcome: 'The backend is provably offline and the guided journey works from committed data and cached terrain',
    wholeRun: ['offline'], probe: 'offline',
    limitations: 'A local backend with LUNAR_OFFLINE=1 serving the production build on this machine: only committed site files and cached terrain; the live JPL Horizons check '
      + 'and custom pins outside the cache are unavailable (the app says so); the UI font may fall back to a system font. The machine was not disconnected from the network and '
      + 'no public deployment was tested.',
  },
]
if (flag('list')) {
  console.log([...SUITES, BUILD].map((s) => s.id).concat(CHECKS.map((c) => c.id)).join('\n'))
  process.exit(0)
}
const everyId = new Set([...SUITES, BUILD, ...CHECKS].map((c) => c.id))
if (only && [...only].some((id) => !everyId.has(id))) throw new Error(`unknown id; ids: ${[...everyId].join(', ')}`)
const wanted = (id) => !only || only.has(id)

// ---------------------------------------------------------------- running commands

const shown = (cmd) => (cmd === PY ? 'python' : cmd === process.execPath ? 'node' : basename(cmd).replace(/\.(cmd|exe)$/, ''))
const rel = (p) => (p === ROOT ? '.' : p.slice(ROOT.length + 1).replace(/\\/g, '/'))
/** Run a command; keep the exact command, directory, relevant env, exit status and output. */
function run(cmd, argv, cwd, env = {}, label = null) {
  const t0 = Date.now()
  const command = label ?? [shown(cmd), ...argv.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ')
  const meta = { command, cwd: rel(cwd), env: Object.keys(env).length ? env : undefined }
  try {
    const out = execFileSync(cmd, argv, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: WIN && cmd.endsWith('.cmd'), maxBuffer: 256 << 20 })
    return { ok: true, ...meta, seconds: Math.round((Date.now() - t0) / 1000), tail: out.trim().split('\n').slice(-3).join(' | '), out }
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`
    return { ok: false, ...meta, seconds: Math.round((Date.now() - t0) / 1000), tail: out.trim().split('\n').slice(-6).join(' | '), out }
  }
}
const slim = ({ out, ...rest }) => rest

function runSuite(s) {
  const r = run(s.cmd, s.argv, s.cwd, s.env)
  if (s.kind === 'plain') return { ...slim(r), ok: r.ok }
  if (s.kind === 'oxlint') {
    const c = oxlintCounts(r.out)
    const ok = r.ok && c !== null && c.errors === 0
    return { ...slim(r), ok, counts: c, tail: c ? `${c.errors} errors, ${c.warnings} warnings` : `no oxlint summary: ${r.tail}` }
  }
  const counts = s.kind === 'pytest' ? pytestCounts(r.out) : vitestCounts(r.out)
  const j = judgeCounted(r, counts)
  return { ...slim(r), ok: j.ok, tail: j.tail, counts }
}
/** Targeted tests inside an evidence check: same judging as the full suites. */
function runTargeted(kind, targets) {
  const r = kind === 'pytest'
    ? run(PY, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', ...targets], BACKEND, { LUNAR_OFFLINE: '1' })
    : run(NPX, ['vitest', 'run', ...targets], FRONTEND)
  const j = judgeCounted(r, kind === 'pytest' ? pytestCounts(r.out) : vitestCounts(r.out))
  return { what: `tests: ${kind} ${targets.length} target(s)`, targets, ...slim(r), ok: j.ok, tail: j.tail }
}

async function startBackend(port, offline) {
  try {
    if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) throw new Error(`port ${port} already serves a backend (not started by this gate, so its source is unknown): stop it and re-run`)
  } catch (e) { if (String(e.message).startsWith('port ')) throw e }
  const p = spawn(PY, ['-m', 'uvicorn', 'app.main:app', '--port', String(port)], { cwd: BACKEND, env: { ...process.env, LUNAR_OFFLINE: offline ? '1' : '0' }, stdio: 'ignore' })
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return p
    } catch { /* not up yet */ }
  }
  p.kill()
  throw new Error(`backend on port ${port} did not start`)
}
/** Proof that the backend under test is really offline: the one live feature (JPL verify) must refuse and say so. */
async function offlineProbe(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/sites/connecting-ridge/verify?time=2027-01-15T00:00:00Z`)
    const body = await r.text()
    const ok = r.status === 503 && /offline mode/i.test(body)
    return { what: 'proof: the backend under test is in offline mode (live JPL check refused)', ok, tail: `HTTP ${r.status}: ${body.slice(0, 120)}` }
  } catch (e) { return { what: 'proof: the backend under test is in offline mode', ok: false, tail: String(e) } }
}

/** Run a browser journey script and read ITS report: missing, unreadable or another run's report = not run. */
function browserRun(script, scriptArgs, out, mode) {
  rmSync(out, { recursive: true, force: true })
  const outRel = relative(FRONTEND, out).split('\\').join('/') // the scripts run in frontend/
  const r = run(process.execPath, [script, ...scriptArgs, '--out', outRel, '--run-id', RUN_ID], FRONTEND)
  let report = null
  try {
    const j = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'))
    if (j.run_id === RUN_ID) report = j
  } catch { /* no report */ }
  return { ...slim(r), mode, report }
}

// ---------------------------------------------------------------- source identity

const git = (...a) => { try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 << 20 }).trimEnd() } catch { return 'unknown' } }
const PATHS = ['backend', 'frontend', 'data', 'scripts']
function sourceIdentity() {
  const files = git('status', '--porcelain', '--', ...PATHS).split('\n').filter(Boolean)
  const diff = git('diff', 'HEAD', '--', ...PATHS)
  const untracked = files.filter((f) => f.startsWith('??')).map((f) => f.slice(3)).sort()
  const h = createHash('sha256').update(diff)
  for (const f of untracked) { try { h.update(f).update(readFileSync(join(ROOT, f))) } catch { h.update(f) } }
  return { commit: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), dirty_files: files, diff_sha256: h.digest('hex') }
}

// ---------------------------------------------------------------- run

mkdirSync(OUT, { recursive: true })
const before = sourceIdentity()
const started = new Date().toISOString()
console.log(`Release gate at ${before.commit.slice(0, 10)} (${before.branch})${before.dirty_files.length ? ` (+ ${before.dirty_files.length} uncommitted file(s))` : ''}, run ${RUN_ID}\n`)

const gates = []
const record = (res, c) => { gates.push(res); console.log(`${res.ok === true ? 'PASS' : res.ok === null ? 'INCOMPLETE' : 'FAIL'}  ${c.name}${res.ok === true ? `: ${res.tail}` : ''}${res.ok === true ? '' : `\n        ${res.tail}`}`) }

// Full suites, type check, lint: required by default; --quick leaves them INCOMPLETE rather than silently passing.
for (const s of SUITES.filter((x) => wanted(x.id))) {
  if (flag('quick')) { record({ id: s.id, name: s.name, ok: null, command: `${s.cmd === PY ? 'python' : shown(s.cmd)} ${s.argv.join(' ')}`, tail: 'skipped (--quick): not run' }, s); continue }
  console.log(`${s.name}...`)
  record({ id: s.id, name: s.name, ...runSuite(s) }, s)
}

// The production build (also the artefact every browser journey tests).
const needBrowser = !flag('no-browser') && CHECKS.some((c) => wanted(c.id) && (c.browser || c.wholeRun))
let buildOk = null
if (wanted('build') || needBrowser) {
  console.log('Production build...')
  const b = runSuite(BUILD)
  buildOk = b.ok
  if (wanted('build')) record({ id: BUILD.id, name: BUILD.name, ...b }, BUILD)
}

const runs = {}
const needs = (id) => CHECKS.some((c) => wanted(c.id) && ((c.browser ?? []).some((b) => b.run === id) || (c.wholeRun ?? []).includes(id)))
const probes = {}
if (needBrowser) {
  const ids = ['production', 'guided', 'time-missing', 'evidence', 'offline'].filter(needs)
  if (!buildOk) {
    for (const id of ids) runs[id] = { ok: false, tail: 'the production build failed: nothing to test', report: null }
  } else {
    const guard = async (id, fn) => { try { await fn() } catch (e) { runs[id] = { ok: false, tail: String(e.message ?? e), report: null } } }
    if (ids.some((i) => i !== 'offline')) {
      let be = null
      try {
        be = await startBackend(PORT_ONLINE, false)
        const api = `http://127.0.0.1:${PORT_ONLINE}`
        const mode = 'production build (vite preview of dist/) + online backend'
        if (needs('production')) {
          console.log('Production smoke journey (smoke-prod.mjs --strict)...')
          await guard('production', () => { runs.production = browserRun('scripts/smoke-prod.mjs', ['--no-build', '--strict', '--api', api], join(OUT, 'smoke-production'), mode) })
        }
        if (needs('guided')) {
          console.log('Guided mission journey (e2e-guided.mjs, 1366x768 and 1920x1080)...')
          await guard('guided', () => { runs.guided = browserRun('scripts/e2e-guided.mjs', ['--serve-dist', '--api', api], join(OUT, 'guided-production'), mode) })
        }
        if (needs('evidence')) {
          console.log('Show-why journey from the Comparison (e2e-evidence.mjs, 1366x768 and 1920x1080)...')
          await guard('evidence', () => { runs.evidence = browserRun('scripts/e2e-evidence.mjs', ['--serve-dist', '--api', api], join(OUT, 'evidence-production'), mode) })
        }
        if (needs('time-missing')) {
          console.log('Hourly-grid and missing-data journey (e2e-time-missing.mjs, 1366x768 and 1920x1080)...')
          await guard('time-missing', () => { runs['time-missing'] = browserRun('scripts/e2e-time-missing.mjs', ['--serve-dist', '--api', api], join(OUT, 'time-missing-production'), mode) })
        }
      } catch (e) {
        for (const id of ids.filter((i) => i !== 'offline' && !runs[i])) runs[id] = { ok: false, tail: String(e.message ?? e), report: null }
      } finally { be?.kill() }
    }
    if (ids.includes('offline')) {
      let be = null
      try {
        be = await startBackend(PORT_OFFLINE, true)
        probes.offline = await offlineProbe(PORT_OFFLINE)
        console.log('The guided journey against an offline backend (LUNAR_OFFLINE=1)...')
        runs.offline = browserRun('scripts/e2e-guided.mjs', ['--serve-dist', '--api', `http://127.0.0.1:${PORT_OFFLINE}`], join(OUT, 'guided-offline'), 'production build + backend with LUNAR_OFFLINE=1')
      } catch (e) { runs.offline = { ok: false, tail: String(e.message ?? e), report: null } } finally { be?.kill() }
    }
  }
}
const browserCommands = Object.fromEntries(Object.entries(runs).map(([id, r]) => [id, { command: r.command, cwd: r.cwd, mode: r.mode, exit_ok: r.ok, seconds: r.seconds }]))

const results = []
for (const c of CHECKS.filter((x) => wanted(x.id))) {
  const evidence = []
  if (c.pytest) evidence.push(runTargeted('pytest', c.pytest))
  if (c.vitest) evidence.push(runTargeted('vitest', c.vitest))
  if (c.command) {
    const r = run(PY, c.command.argv, c.command.cwd, c.command.env, c.command.label)
    evidence.push({ what: `command: ${c.command.label}`, ...slim(r), ok: r.ok && c.command.must.test(r.out) })
  }
  for (const ref of c.browser ?? []) evidence.push(...(flag('no-browser') ? [{ what: `browser (${ref.run}): ${ref.step}`, ok: null, tail: 'skipped (--no-browser)' }] : stepResults(runs, ref)))
  for (const id of c.wholeRun ?? []) evidence.push(flag('no-browser') ? { what: `whole run: ${id}`, ok: null, tail: 'skipped (--no-browser)' } : wholeRunResult(runs, id))
  if (c.probe && probes[c.probe]) evidence.push(probes[c.probe])
  else if (c.probe) evidence.push({ what: `proof: ${c.probe} mode is active`, ok: null, tail: 'not run' })
  const ok = combine(evidence)
  results.push({ id: c.id, name: c.name, outcome: c.outcome, ok, limitations: c.limitations ?? null, evidence })
  console.log(`${ok === true ? 'PASS' : ok === null ? 'INCOMPLETE' : 'FAIL'}  ${c.name}: ${c.outcome}`)
  for (const e of evidence.filter((x) => x.ok !== true)) console.log(`        ${e.ok === null ? 'not run / skipped' : 'FAIL'}: ${e.what}: ${e.tail}`)
}

// ---------------------------------------------------------------- verdict, kept with the commit

const after = sourceIdentity()
const changed = after.commit !== before.commit || after.diff_sha256 !== before.diff_sha256
const required = [...gates, ...results]
const failedAny = required.some((r) => r.ok === false)
const partial = !!only || flag('quick') || flag('no-browser')
const everyRequired = new Set([...SUITES, BUILD, ...CHECKS].map((x) => x.id))
const complete = [...everyRequired].every((id) => required.some((r) => r.id === id && r.ok === true))
const clean = before.dirty_files.length === 0
const verdict = verdictOf({ failedAny, changed, partial, complete, clean })
const passed = verdict === 'PASSED'
const stamp = started.replace(/[:.]/g, '-').slice(0, 19)
const rec = {
  run_id: RUN_ID, source_before: before, source_after: after, source_changed_during_run: changed, started, finished: new Date().toISOString(),
  node: process.version, platform: process.platform, options: args, gates, browser_runs: browserCommands, checks: results, verdict, passed,
}
// A partial run (--only / --quick / --no-browser) never replaces the record of the last full run.
const kind = partial ? '-partial' : ''
const jsonName = `gate${kind}-${stamp}-${before.commit.slice(0, 8)}.json`
writeFileSync(join(OUT, jsonName), JSON.stringify(rec, null, 2))
const esc = (t) => String(t ?? '').replace(/\|/g, '/').replace(/\n/g, ' ')
const word = (ok) => (ok === null ? 'INCOMPLETE' : ok ? 'pass' : 'FAIL')
const md = [
  '# Release gate: latest run', '',
  `- **Tested source:** \`${before.commit}\` on \`${before.branch}\`${clean ? ' (clean: no uncommitted changes under backend/, frontend/, data/, scripts/)' : ` **plus ${before.dirty_files.length} uncommitted file(s)**: ${before.dirty_files.map((f) => `\`${f.slice(3)}\``).join(', ')}`}`,
  `- **Source unchanged during the run:** ${changed ? '**no** (result invalid)' : 'yes'} (diff hash \`${before.diff_sha256.slice(0, 12)}\`)`,
  `- **Run:** ${started} to ${rec.finished} (${process.platform}, node ${process.version}), run id \`${RUN_ID}\``,
  `- **Result:** ${verdict}${only ? ` (only: ${[...only].join(', ')})` : ''}`, '',
  '## Required gates (suites, types, lint, build)', '',
  '| Gate | Result | Command | Evidence |', '|---|---|---|---|',
  ...gates.map((s) => `| ${s.name} | ${word(s.ok)} | \`${esc(s.command)}\` (in \`${s.cwd ?? '.'}\`${s.env ? `, ${Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}) | ${esc(s.tail)}${s.seconds != null ? ` (${s.seconds} s)` : ''} |`),
  '', '## Browser journeys (real Chrome, production build)', '',
  '| Journey | Mode | Command | Result |', '|---|---|---|---|',
  ...Object.entries(browserCommands).map(([id, b]) => `| ${id} | ${esc(b.mode)} | \`${esc(b.command)}\` | ${esc(wholeRunResult(runs, id).tail)} |`),
  '', '## Checks', '',
  '| Check | Required outcome | Result | Evidence |', '|---|---|---|---|',
  ...results.map((r) => `| ${r.name} | ${r.outcome} | ${word(r.ok)} | ${r.evidence.map((e) => `${esc(e.what)}: ${e.ok === null ? `not run (${esc(e.tail)})` : e.ok ? 'pass' : `FAIL (${esc(e.tail)})`}`).join('<br>')}${r.limitations ? `<br>*Limitations:* ${r.limitations}` : ''} |`),
  '', 'Evidence kinds: *tests* prove logic and contracts only; *browser* steps ran in Chrome on the production build of the tested source. The Vite development server is never evidence here.',
  `Raw results (exact commands, counts, evidence): \`release-gate/${jsonName}\`. Re-run: \`node scripts/release-gate.mjs\`.`,
]
writeFileSync(join(OUT, `LATEST${kind}.md`), md.join('\n') + '\n')
console.log(`\nRELEASE GATE ${verdict}  (results in release-gate/LATEST${kind}.md)`)
process.exit(passed ? 0 : 1)
