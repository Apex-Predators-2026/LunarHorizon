// Release gate: the checks a release must pass, each tied to the tests or browser steps that prove it, with the
// commit and the results kept in release-gate/ (commit them with the release).
//
//   node scripts/release-gate.mjs                 all gate checks (targeted tests + production + offline browser runs)
//   node scripts/release-gate.mjs --full          the full backend and frontend suites first, then the gate
//   node scripts/release-gate.mjs --only atlas,report   re-run some checks after a fix (ids below)
//   node scripts/release-gate.mjs --no-browser    tests only (no production build / browser runs)
//
// It starts its own backends (normal on port 8011, LUNAR_OFFLINE=1 on 8012) and stops them afterwards. Needs the
// backend venv (backend/.venv, or PYTHON=...), the frontend's node_modules, Chrome/Edge (CHROME_PATH), and for the
// browser checks the prepared terrain cache (docs/demo-setup.md). Exit code 1 if any check fails.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND = join(ROOT, 'backend')
const FRONTEND = join(ROOT, 'frontend')
const OUT = join(ROOT, 'release-gate')
const args = process.argv.slice(2)
const flag = (n) => args.includes(`--${n}`)
const only = (() => {
  const i = args.indexOf('--only')
  return i >= 0 ? new Set(args[i + 1].split(',')) : null
})()
const PY = process.env.PYTHON ?? [join(BACKEND, '.venv', 'Scripts', 'python.exe'), join(BACKEND, '.venv', 'bin', 'python')].find(existsSync) ?? 'python'
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx'

// pytest node ids are relative to backend/, vitest paths to frontend/.
const RV = 'tests/viability/test_real_sites_phase6_explanations.py'
const CHECKS = [
  {
    id: 'pass', name: 'Real passing mission', outcome: 'Correct verdict, metrics, and explanation',
    pytest: [`${RV}::test_malapert_lit_season_pass`, `${RV}::test_explanations_quote_independently_computed_values`,
      'tests/test_compare_evidence.py::test_assessment_carries_canonical_metric_states_and_versions',
      'tests/test_compare_evidence.py::test_constraints_match_the_verdict'],
  },
  {
    id: 'fail', name: 'Real failed mission', outcome: 'Correct violated requirement and evidence',
    pytest: [`${RV}::test_peak_near_shackleton_night_landing`, `${RV}::test_shackleton_floor_control_fails_everything`,
      `${RV}::test_connecting_ridge_blackout_in_progress_at_landing`,
      'tests/test_compare_evidence.py::test_failed_requirements_carry_the_engine_evidence_windows'],
  },
  {
    id: 'unknown', name: 'UNKNOWN mission', outcome: 'No fabricated zero values or false failure',
    pytest: [`${RV}::test_mission_past_dataset_end_is_unknown_not_failed`, `${RV}::test_connecting_ridge_without_any_data`,
      'tests/test_rescue_unknown.py', 'tests/test_compare_ranking.py::test_missing_score_is_never_zero_and_measured_zero_is_kept',
      'tests/test_compare_ranking.py::test_unknown_stays_unknown_with_its_reason', 'tests/test_compare_evidence.py::test_unknown_samples_stay_unknown'],
    vitest: ['src/features/compare/compare.test.tsx -t "UNKNOWN"'],
  },
  {
    id: 'comparison', name: 'Comparison', outcome: 'Eligible ranks, honest groups, consistent times',
    pytest: ['tests/test_compare_ranking.py'],
    vitest: ['src/features/compare/compare.test.tsx'],
    smoke: ['Compare the two plans side by side'],
  },
  {
    id: 'atlas', name: 'Atlas', outcome: 'Selected cell opens the matching mission',
    pytest: ['tests/test_atlas.py'],
    vitest: ['src/features/atlas/atlas.test.ts'],
    smoke: ['Feasibility Atlas: map dates x lengths, explain a cell, check neighbours, open it in the Planner'],
  },
  {
    id: 'report', name: 'Report', outcome: 'Matches the evaluated snapshot',
    pytest: ['tests/test_validation_report.py', 'tests/viability/test_part2_validation.py::test_demo_snapshot_is_reproducible'],
    vitest: ['src/features/compare/export.test.tsx'],
    smoke: ['Export the comparison (JSON and CSV files the user can keep)'],
  },
  {
    id: 'navigation', name: 'Navigation', outcome: 'No route collisions or lost scenarios',
    vitest: ['src/appRoute.test.ts'],
    smoke: ['Browser Back / Forward between the views; the 3D view is drawn again', 'Compare the two plans side by side'],
  },
  {
    id: 'production', name: 'Production demo', outcome: 'Works from a fresh browser',
    smokeRun: 'production',
  },
  {
    id: 'offline', name: 'Offline fallback', outcome: 'Prepared demonstration works with stated limitations',
    smokeRun: 'offline',
    limitations: 'Backend with LUNAR_OFFLINE=1: only cached terrain and precomputed data; the live JPL Horizons check and '
      + 'custom pins outside the cache are unavailable (the app says so); the UI font falls back to a system font.',
  },
]
const selected = CHECKS.filter((c) => !only || only.has(c.id))
if (only && selected.length !== only.size) throw new Error(`unknown check id; ids: ${CHECKS.map((c) => c.id).join(', ')}`)

function run(cmd, argv, cwd, env = {}) {
  const t0 = Date.now()
  try {
    const out = execFileSync(cmd, argv, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' && cmd.endsWith('.cmd'), maxBuffer: 64 << 20 })
    return { ok: true, seconds: Math.round((Date.now() - t0) / 1000), tail: out.trim().split('\n').slice(-3).join(' | ') }
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim().split('\n')
    return { ok: false, seconds: Math.round((Date.now() - t0) / 1000), tail: out.slice(-6).join(' | ') }
  }
}
const pytest = (ids) => run(PY, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', ...ids], BACKEND, { LUNAR_OFFLINE: '1' })
const vitest = (spec) => {
  const [file, ...rest] = spec.split(' ')
  const t = rest.join(' ').match(/-t "(.*)"/)
  return run(NPX, ['vitest', 'run', file, ...(t ? ['-t', t[1]] : [])], FRONTEND)
}

async function startBackend(port, offline) {
  const p = spawn(PY, ['-m', 'uvicorn', 'app.main:app', '--port', String(port)], { cwd: BACKEND, env: { ...process.env, ...(offline ? { LUNAR_OFFLINE: '1' } : {}) }, stdio: 'ignore' })
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return p
    } catch { /* not up yet */ }
  }
  p.kill()
  throw new Error(`backend on port ${port} did not start`)
}
function smoke(api, out, build) {
  const res = run(process.execPath, ['scripts/smoke-prod.mjs', '--api', api, '--out', out, ...(build ? [] : ['--no-build'])], FRONTEND)
  let report = null
  try { report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) } catch { /* no report */ }
  return { ...res, report }
}

// ---------------------------------------------------------------- run

mkdirSync(OUT, { recursive: true })
const git = (...a) => { try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim() } catch { return 'unknown' } }
const commit = git('rev-parse', 'HEAD')
const dirty = git('status', '--porcelain', '--', 'backend', 'frontend', 'data', 'scripts').length > 0
const started = new Date().toISOString()
console.log(`Release gate at ${commit.slice(0, 10)}${dirty ? ' (+ uncommitted changes)' : ''}\n`)

const suites = []
if (flag('full')) {
  console.log('Full suites...')
  suites.push({ name: 'Backend: full pytest suite', ...run(PY, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider'], BACKEND, { LUNAR_OFFLINE: '1' }) })
  suites.push({ name: 'Frontend: full vitest suite', ...run(NPX, ['vitest', 'run'], FRONTEND) })
  suites.push({ name: 'Frontend: lint (oxlint)', ...run(NPX, ['oxlint'], FRONTEND) })
  const build = run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], FRONTEND)
  suites.push({ name: 'Frontend: production build (tsc + vite)', ...build })
  for (const s of suites) console.log(`  ${s.ok ? 'PASS' : 'FAIL'}  ${s.name} (${s.seconds} s)${s.ok ? '' : `\n        ${s.tail}`}`)
}

// Browser runs once each, shared by the checks that cite their steps.
const browser = !flag('no-browser') && selected.some((c) => c.smoke || c.smokeRun)
const smokes = {}
if (browser) {
  const needOffline = selected.some((c) => c.smokeRun === 'offline')
  const needProd = selected.some((c) => c.smoke || c.smokeRun === 'production')
  if (needProd) {
    console.log('Production build in a fresh browser (smoke-prod.mjs)...')
    const be = await startBackend(8011, false)
    try { smokes.production = smoke('http://127.0.0.1:8011', join(OUT, 'smoke-production'), true) } finally { be.kill() }
  }
  if (needOffline) {
    console.log('The same journey against an offline backend (LUNAR_OFFLINE=1)...')
    const be = await startBackend(8012, true)
    try { smokes.offline = smoke('http://127.0.0.1:8012', join(OUT, 'smoke-offline'), !needProd) } finally { be.kill() }
  }
}

const results = []
for (const c of selected) {
  const evidence = []
  if (c.pytest) evidence.push({ what: `pytest ${c.pytest.length} test target(s)`, targets: c.pytest, ...pytest(c.pytest) })
  for (const v of c.vitest ?? []) evidence.push({ what: `vitest ${v}`, ...vitest(v) })
  if (c.smoke && browser) {
    const steps = smokes.production?.report?.steps ?? []
    for (const name of c.smoke) {
      const s = steps.find((x) => x.name === name)
      evidence.push({ what: `browser step: ${name}`, ok: s?.status === 'pass', tail: s ? `${s.status}${s.error ? `: ${s.error}` : ''}` : 'step did not run' })
    }
  }
  if (c.smokeRun && browser) {
    const s = smokes[c.smokeRun]
    const r = s?.report
    const failed = r?.steps.filter((x) => x.status !== 'pass') ?? []
    evidence.push({
      what: `whole journey (${r?.steps.length ?? 0} steps, ${c.smokeRun === 'offline' ? 'offline backend' : 'fresh browser, production build'})`,
      ok: !!s?.ok,
      tail: r ? `${r.steps.length - failed.length}/${r.steps.length} steps passed; ${r.page_errors.length} page errors; ${r.api_failures.length} API failures${failed.length ? `; not passed: ${failed.map((x) => x.name).join('; ')}` : ''}` : s?.tail ?? 'not run',
    })
  }
  if (!evidence.length) evidence.push({ what: 'skipped (--no-browser)', ok: null, tail: '' })
  const skipped = evidence.every((e) => e.ok === null)
  const ok = skipped ? null : evidence.every((e) => e.ok !== false)
  results.push({ id: c.id, name: c.name, outcome: c.outcome, ok, limitations: c.limitations ?? null, evidence })
  console.log(`${ok ? 'PASS' : skipped ? 'SKIP' : 'FAIL'}  ${c.name}: ${c.outcome}`)
  for (const e of evidence.filter((x) => x.ok === false)) console.log(`        ${e.what}: ${e.tail}`)
}

// ---------------------------------------------------------------- keep the results with the commit

const failedAny = results.some((r) => r.ok === false) || suites.some((s) => !s.ok)
const complete = !only && results.every((r) => r.ok !== null)
const passed = !failedAny && complete
const verdict = failedAny ? 'FAILED' : complete ? 'PASSED' : 'INCOMPLETE (checks skipped or not selected: not a release pass)'
const stamp = started.replace(/[:.]/g, '-').slice(0, 19)
const record = { commit, uncommitted_changes: dirty, started, finished: new Date().toISOString(), node: process.version, platform: process.platform, full_suites: suites, checks: results, verdict, passed }
writeFileSync(join(OUT, `gate-${stamp}-${commit.slice(0, 8)}.json`), JSON.stringify(record, null, 2))
const md = [
  '# Release gate: latest run', '',
  `- **Commit:** \`${commit}\`${dirty ? ' **plus uncommitted changes** (commit them and re-run before releasing)' : ''}`,
  `- **Run:** ${started} to ${record.finished} (${process.platform}, node ${process.version})`,
  `- **Result:** ${verdict}${only ? ` (only: ${[...only].join(', ')})` : ''}`, '',
  ...(suites.length ? ['| Full suite | Result |', '|---|---|', ...suites.map((s) => `| ${s.name} | ${s.ok ? 'pass' : 'FAIL'}: ${s.tail.replace(/\|/g, '/')} |`), ''] : []),
  '| Check | Required outcome | Result | Evidence |', '|---|---|---|---|',
  ...results.map((r) => `| ${r.name} | ${r.outcome} | ${r.ok === null ? 'skipped' : r.ok ? 'pass' : 'FAIL'} | ${r.evidence.map((e) => `${e.what}: ${e.ok === null ? 'skipped' : e.ok ? 'pass' : 'FAIL'}${e.ok ? '' : ` (${e.tail.replace(/\|/g, '/')})`}`).join('<br>')}${r.limitations ? `<br>*Limitations:* ${r.limitations}` : ''} |`),
  '', `Raw results: \`release-gate/gate-${stamp}-${commit.slice(0, 8)}.json\`. Re-run: \`node scripts/release-gate.mjs\` (\`--only <ids>\` after a fix).`,
]
writeFileSync(join(OUT, 'LATEST.md'), md.join('\n') + '\n')
console.log(`\nRELEASE GATE ${verdict}  (results in release-gate/LATEST.md)`)
process.exit(failedAny ? 1 : 0)
