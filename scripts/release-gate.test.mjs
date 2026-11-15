// Tests of the release gate's decision logic: `node --test scripts/` (no dependencies). They pin the rule that only
// evidence which ran and passed counts: skipped, unavailable, empty and unreadable evidence is never a pass.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  GUIDED_ESSENTIAL, SMOKE_STEPS, TIME_MISSING_API, TIME_MISSING_UI, VIEWPORTS,
  combine, judgeCounted, oxlintCounts, pytestCounts, stepResults, verdictOf, vitestCounts, wholeRunResult,
} from './release-gate-lib.mjs'

const okRun = { ok: true, tail: '' }

test('combine: nothing, skipped and not-run evidence never pass', () => {
  assert.equal(combine([]), null)
  assert.equal(combine([{ ok: true }, { ok: null }]), null)
  assert.equal(combine([{ ok: true }, { ok: undefined }]), null)
  assert.equal(combine([{ ok: null }, { ok: false }]), false) // a failure outranks an incomplete piece
  assert.equal(combine([{ ok: true }, { ok: true }]), true)
})

test('pytestCounts reads the summary line', () => {
  assert.deepEqual(
    (({ passed, failed, skipped, errors }) => ({ passed, failed, skipped, errors }))(pytestCounts('....\n2139 passed in 671.78s (0:11:11)\n')),
    { passed: 2139, failed: 0, skipped: 0, errors: 0 })
  const c = pytestCounts('=== 3 failed, 10 passed, 1 skipped, 2 errors in 2.10s ===')
  assert.equal(c.failed, 3); assert.equal(c.passed, 10); assert.equal(c.skipped, 1); assert.equal(c.errors, 2)
  assert.equal(pytestCounts('no tests ran'), null)
  assert.equal(pytestCounts('1 xpassed in 0.1s').passed, 0) // "xpassed" is not "passed"
})

test('vitestCounts reads the Tests and Test Files lines (with colours)', () => {
  const out = '\u001b[2m Test Files \u001b[22m \u001b[32m61 passed\u001b[39m (61)\n      Tests  1 skipped | 657 passed (658)\n'
  const c = vitestCounts(out)
  assert.equal(c.passed, 657); assert.equal(c.skipped, 1); assert.equal(c.total, 658); assert.equal(c.files.total, 61)
  assert.equal(vitestCounts('nothing useful'), null)
})

test('oxlintCounts', () => {
  assert.deepEqual(oxlintCounts('Found 21 warnings and 0 errors.'), { warnings: 21, errors: 0 })
  assert.equal(oxlintCounts('crashed'), null)
})

test('judgeCounted: only an exit 0, readable, non-empty, failure-free, skip-free run passes', () => {
  const good = { passed: 5, failed: 0, errors: 0, skipped: 0, todo: 0, summary: '5 passed' }
  assert.equal(judgeCounted(okRun, good).ok, true)
  assert.equal(judgeCounted({ ok: false, tail: 'boom' }, good).ok, false) // non-zero exit, whatever the summary says
  assert.equal(judgeCounted(okRun, null).ok, false) // unreadable output: cannot tell what ran
  assert.equal(judgeCounted(okRun, { ...good, passed: 0 }).ok, false) // nothing ran
  assert.equal(judgeCounted(okRun, { ...good, failed: 1 }).ok, false)
  assert.equal(judgeCounted(okRun, { ...good, errors: 1 }).ok, false)
  assert.equal(judgeCounted(okRun, { ...good, skipped: 2 }).ok, null) // skipped = incomplete, never a pass
  assert.equal(judgeCounted(okRun, { ...good, todo: 1 }).ok, null)
})

test('verdictOf: only a complete, clean, unchanged, unselected run is PASSED', () => {
  const base = { failedAny: false, changed: false, partial: false, complete: true, clean: true }
  assert.equal(verdictOf(base), 'PASSED')
  assert.match(verdictOf({ ...base, changed: true }), /^INVALID/)
  assert.equal(verdictOf({ ...base, failedAny: true }), 'FAILED')
  assert.match(verdictOf({ ...base, partial: true }), /^INCOMPLETE/) // --only / --quick / --no-browser
  assert.match(verdictOf({ ...base, complete: false }), /^INCOMPLETE/)
  assert.match(verdictOf({ ...base, clean: false }), /^INCOMPLETE/)
  assert.match(verdictOf({ ...base, changed: true, failedAny: true }), /^INVALID/)
})

const guidedReport = (drop = []) => ({
  run_id: 'r', results: VIEWPORTS.flatMap((vp) => GUIDED_ESSENTIAL.map((n) => ({ name: `${vp} ${n}`, ok: true, detail: '' }))).filter((x) => !drop.includes(x.name)),
})
const smokeReport = (over = {}) => ({ run_id: 'r', strict: true, steps: SMOKE_STEPS.map((name) => ({ name, status: 'pass' })), page_errors: [], api_failures: [], ...over })
const tmReport = (drop = []) => ({
  run_id: 'r', results: [...TIME_MISSING_API, ...VIEWPORTS.flatMap((vp) => TIME_MISSING_UI.map((n) => `${vp} ${n}`))].map((name) => ({ name, ok: true })).filter((x) => !drop.includes(x.name)),
})

test('stepResults: not executed is incomplete, a missing step fails, guided steps are required at both viewports', () => {
  assert.equal(stepResults({}, { run: 'guided', step: GUIDED_ESSENTIAL[0] })[0].ok, null)
  assert.equal(stepResults({ guided: { ok: true, report: null, tail: 'x' } }, { run: 'guided', step: GUIDED_ESSENTIAL[0] })[0].ok, false)
  const full = stepResults({ guided: { ok: true, report: guidedReport() } }, { run: 'guided', step: '5 evidence opens the blackout window in 3D' })
  assert.deepEqual(full.map((e) => e.ok), [true, true])
  const missing = stepResults({ guided: { ok: true, report: guidedReport(['1920x1080 5 evidence opens the blackout window in 3D']) } }, { run: 'guided', step: '5 evidence opens the blackout window in 3D' })
  assert.deepEqual(missing.map((e) => e.ok), [true, false])
  assert.match(missing[1].tail, /MISSING/)
  const smoke = stepResults({ production: { ok: true, report: smokeReport({ steps: [] }) } }, { run: 'production', step: SMOKE_STEPS[0] })
  assert.equal(smoke[0].ok, false)
})

test('wholeRunResult: the journey passes only when every essential step ran and passed', () => {
  assert.equal(wholeRunResult({}, 'guided').ok, null)
  assert.equal(wholeRunResult({ guided: { ok: true, report: guidedReport() } }, 'guided').ok, true)
  assert.equal(wholeRunResult({ offline: { ok: true, report: guidedReport() } }, 'offline').ok, true)
  assert.equal(wholeRunResult({ guided: { ok: false, report: guidedReport() } }, 'guided').ok, false) // the script itself exited non-zero
  assert.equal(wholeRunResult({ guided: { ok: true, report: guidedReport(['1366x768 8 A4 PDF renders only the report']) } }, 'guided').ok, false)
  const failing = guidedReport(); failing.results[3].ok = false
  assert.equal(wholeRunResult({ guided: { ok: true, report: failing } }, 'guided').ok, false)
  // strict smoke
  assert.equal(wholeRunResult({ production: { ok: true, report: smokeReport() } }, 'production').ok, true)
  assert.equal(wholeRunResult({ production: { ok: true, report: smokeReport({ strict: false }) } }, 'production').ok, false)
  assert.equal(wholeRunResult({ production: { ok: true, report: smokeReport({ steps: SMOKE_STEPS.slice(1).map((name) => ({ name, status: 'pass' })) }) } }, 'production').ok, false)
  assert.equal(wholeRunResult({ production: { ok: true, report: smokeReport({ steps: SMOKE_STEPS.map((name, i) => ({ name, status: i === 2 ? 'missing' : 'pass' })) }) } }, 'production').ok, false)
  assert.equal(wholeRunResult({ production: { ok: true, report: smokeReport({ page_errors: ['x'] }) } }, 'production').ok, false)
  // hourly-grid / missing-data journey
  assert.equal(wholeRunResult({ 'time-missing': { ok: true, report: tmReport() } }, 'time-missing').ok, true)
  assert.equal(wholeRunResult({ 'time-missing': { ok: true, report: tmReport(['1366x768 UI: no NaN rendered']) } }, 'time-missing').ok, false)
  assert.equal(wholeRunResult({ 'time-missing': { ok: true, report: { run_id: 'r', results: [{ name: 'journey completed', ok: false }] } } }, 'time-missing').ok, false)
})
