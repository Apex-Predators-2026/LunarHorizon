// End-to-end check of the hourly-grid time policy and of missing-data handling, against the running app (dev server or
// preview + backend, real site files). Adapted from the source branch's check (ba0a6dd), which asserted the obsolete
// exact-interval policy; this one asserts the policy in backend/app/timegrid.py:
//   1. A real-data mission landing BETWEEN hours (00:30) with a fractional length (1.01 d = 24.24 h) is evaluated on
//      the same hourly-grid interval (landing 01:00 UTC, 24 h) and gets the same verdict in the Scenario Comparison,
//      the canonical assessment API and Mission Rescue; each says what it evaluated (the request is not rewritten).
//   2. An incomplete-data site (a TEMPORARY test copy of Malapert Massif with 6 h of unknown Sun and Earth state,
//      written to data/sites/custom/ and always removed afterwards) comes back with whole-mission statistics withheld,
//      canonical bounds, its own unknown windows, no darkness/blackout window across the gap, and finite JSON...
//   3. ...and the Comparison page shows it as unknown/bounds (coverage note, unknown stretches on the timeline, no
//      "best" claim) at 1366x768 and 1920x1080.
//
//   node scripts/e2e-time-missing.mjs [--url http://localhost:5173] [--api http://localhost:8000] [--out e2e-output]
//
// Exits non-zero on any failed expectation, page error or failed /api request. Needs Chrome or Edge (CHROME_PATH).
// It writes one temporary file under data/sites/custom/ and removes it in a `finally`; it never edits a real site file.
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const URL_APP = opt('url', 'http://localhost:5173')
const API = opt('api', URL_APP) // the dev server proxies /api; pass --api for a preview without a proxy
const OUT = opt('out', 'e2e-output')
mkdirSync(OUT, { recursive: true })
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GAP_ID = 'custom_e2e_incomplete_test'
const GAP_FILE = join(ROOT, 'data', 'sites', 'custom', `${GAP_ID}.json`)

const chrome = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => p && existsSync(p))
if (!chrome) throw new Error('Chrome/Edge not found: set CHROME_PATH')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
const post = async (path, body) => {
  const r = await fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await r.text()
  return { status: r.status, text, json: JSON.parse(text) }
}

// The documented policy, restated independently of the code under test (backend/app/timegrid.py): the landing is
// rounded to the nearest whole UTC hour (half rounds up), the length to whole hours.
const gridLanding = (iso) => new Date(Math.floor((Date.parse(iso) + 30 * 60_000) / 3_600_000) * 3_600_000).toISOString().replace(/\.000Z$/, 'Z')
const gridHours = (days) => Math.max(1, Math.round(days * 24))

const MAL = { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.9635, lon: 357.6326 }
const REQ = { min_sunlight_fraction: 0.5, battery_hours: 50, panel_threshold: 0.25, min_earth_visibility_fraction: 0.4,
  max_comms_gap_hours: 96, min_initial_sun_hours: 2, min_initial_comms_hours: 1 }
const sameInstant = (a, b) => Date.parse(a) === Date.parse(b)

rmSync(GAP_FILE, { force: true }) // a file left by a crashed earlier run must not leak into this one
try {
  // ---- 1. one mission, three tools, one evaluated time -------------------------------------------------------
  const requested = '2027-01-15T02:30:00+02:00' // = 00:30Z, an offset time between two hourly samples
  const days = 1.01
  const scenario = { site: MAL, landing_utc: requested, duration_days: days, requirements: REQ }
  const wantLanding = gridLanding(requested)
  const wantHours = gridHours(days)
  check('policy fixture: 00:30 UTC rounds to 01:00 and 24.24 h to 24 h', sameInstant(wantLanding, '2027-01-15T01:00:00Z') && wantHours === 24, `${wantLanding} + ${wantHours} h`)
  const cmp = (await post('/api/compare', { scenarios: [{ key: 'm', scenario }] })).json.results[0]
  const can = (await post('/api/viability/assess-scenario', { scenario })).json.assessment
  const res = (await post('/api/rescue', { original: scenario, change: { launch_delay_days: 0 },
    search: { date_window_days: 0.5, robustness_check: false } })).json
  check('Comparison evaluates the grid interval', sameInstant(cmp.evaluated_landing_utc, wantLanding) && cmp.evaluated_hours === wantHours,
    `${cmp.evaluated_landing_utc} + ${cmp.evaluated_hours} h`)
  check('canonical assessment evaluates the same interval', sameInstant(can.evaluated_start_utc, wantLanding)
    && Date.parse(can.evaluated_end_utc) - Date.parse(can.evaluated_start_utc) === wantHours * 3_600_000, `${can.evaluated_start_utc} → ${can.evaluated_end_utc}`)
  check('Rescue evaluates the same landing and length', sameInstant(res.original.scenario.landing_utc, wantLanding)
    && Math.round(res.original.scenario.duration_days * 24) === wantHours, `${res.original.scenario.landing_utc}, ${res.original.scenario.duration_days} d`)
  check('Comparison says what it did, and keeps the request distinct from the evaluation',
    /hourly data grid/.test(cmp.time_note ?? '') && /00:30 UTC/.test(cmp.time_note ?? '') && /24\.24 h/.test(cmp.time_note ?? ''), cmp.time_note)
  check('same verdict in all three tools', cmp.ranking.eligibility === can.eligibility && res.original.eligibility === can.eligibility, can.eligibility)
  const cs = cmp.assessment.metrics.sunlight_percent
  const ks = can.metrics.sunlight_percent
  check('same canonical sunlight in Comparison and assessment', cs.status === ks.status && Math.abs(cs.value - ks.value) < 1e-9, `${cs.value}%`)

  // ---- 2. incomplete data through the API --------------------------------------------------------------------
  const src = JSON.parse(readFileSync(join(ROOT, 'data', 'sites', 'malapert-massif.json'), 'utf8'))
  src.site = { ...src.site, id: GAP_ID, name: 'E2E incomplete-data test copy (not a real site)', kind: 'custom' }
  const tl = src.timeline
  const i0 = tl.time_utc.findIndex((t) => t.startsWith('2027-01-16T00:00'))
  const GAP_H = 6
  for (let i = i0; i < i0 + GAP_H; i++) {
    for (const k of ['sun_horizon_deg', 'sun_visible_fraction', 'earth_horizon_deg', 'earth_margin_deg']) if (k in tl) tl[k][i] = null
    if ('sun_visible' in tl) tl.sun_visible[i] = null
    tl.earth_visible[i] = null
  }
  mkdirSync(dirname(GAP_FILE), { recursive: true })
  writeFileSync(GAP_FILE, JSON.stringify(src))
  const gapSite = { id: GAP_ID, name: src.site.name, lat: MAL.lat, lon: MAL.lon }
  const MISSION_H = 7 * 24
  const gapReq = { site: gapSite, landing_utc: '2027-01-15T00:00:00Z', duration_days: 7, requirements: REQ }
  const raw = await post('/api/compare', { scenarios: [{ key: 'g', scenario: gapReq }] })
  const g = raw.json.results[0]
  check('incomplete data: whole-mission statistics withheld per body, with reasons',
    g.status === 'ok' && g.solar === null && g.earth === null && g.power === null && Object.keys(g.withheld).length === 3)
  check('incomplete data: known hours reported, none invented', Math.abs(g.sun_known_hours - (MISSION_H - GAP_H)) < 1e-9
    && Math.abs(g.earth_known_hours - (MISSION_H - GAP_H)) < 1e-9, `${g.sun_known_hours} h known of ${g.evaluated_hours}`)
  check('incomplete data: canonical bounds, not exact values', g.assessment.metrics.sunlight_percent.status === 'bounded'
    && g.assessment.metrics.earth_visible_percent.status === 'bounded')
  check('incomplete data: the gap is its own unknown windows (Sun and Earth)', g.unknown_windows.length === 2
    && g.unknown_windows.every((w) => w.start_utc === '2027-01-16T00:00:00Z' && w.end_utc === '2027-01-16T06:00:00Z'))
  check('incomplete data: no darkness or blackout window crosses the gap', [...g.dark_windows, ...g.blackout_windows]
    .every((w) => w.end_utc <= '2027-01-16T00:00:00Z' || w.start_utc >= '2027-01-16T06:00:00Z'))
  check('incomplete data: JSON has no NaN/Infinity', !/NaN|Infinity/.test(raw.text))

  // ---- 3. incomplete data in the visible UI, at both target sizes --------------------------------------------
  const sc = (id, label, site, colorSlot) => ({ id, label, name: `${site.name} test`, site, landing_utc: '2027-01-15T00:00:00.000Z', duration_days: 7,
    requirements: REQ, spacecraft: { panel_mode: 'vertical_sun_tracking', panel_azimuth_deg: 0, panel_rated_power_w: 400, average_load_w: 150, battery_capacity_wh: 7500 },
    origin: 'external', colorSlot })
  const workspace = { state: { scenarios: [sc('s1', 'A', MAL, 0), sc('s2', 'B', gapSite, 1)], selectedIds: ['s1', 's2'], activeId: null, baselineId: 's1' }, version: 1 }
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
    const tag = `${viewport.width}x${viewport.height}`
    const browser = await chromium.launch({ executablePath: chrome, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] })
    const page = await (await browser.newContext({ viewport })).newPage()
    const apiFailures = []
    const pageErrors = []
    page.on('response', (r) => r.url().includes('/api/') && r.status() >= 500 && apiFailures.push(`${r.status()} ${r.url()}`))
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    await page.addInitScript((w) => sessionStorage.setItem('lunar-compare-workspace', JSON.stringify(w)), workspace)
    await page.goto(`${URL_APP}/#app/compare/cmp-overview`, { waitUntil: 'domcontentloaded' })
    const note = page.locator('[data-testid=coverage-note]')
    await note.first().waitFor({ timeout: 60_000 })
    const noteText = await note.first().innerText()
    check(`${tag} UI: the incomplete scenario says what is known`, new RegExp(`Sun known ${MISSION_H - GAP_H} h, Earth known ${MISSION_H - GAP_H} h of ${MISSION_H} h`).test(noteText), noteText.slice(0, 90))
    const card = page.getByRole('article', { name: 'Scenario B overview' })
    // The card names what is withheld; the Key metrics table shows the engine's range instead of a number.
    check(`${tag} UI: the card lists what is withheld`, /Withheld: solar, power, earth/i.test(noteText) || /withheld/i.test(await card.innerText()))
    await page.locator('#cmp-metrics').scrollIntoViewIfNeeded().catch(() => {})
    const pageText = await page.locator('body').innerText()
    check(`${tag} UI: bounds shown instead of numbers (Key metrics)`, /bounds: data incomplete/.test(pageText))
    const sha = await card.locator('[data-testid=dataset-identity]').first().innerText().catch(() => '')
    check(`${tag} UI: the card names its dataset file and hash`, /[0-9a-f]{8}/.test(sha) && /custom_e2e_incomplete_test|malapert/.test(sha), sha.slice(0, 80))
    await page.locator('#cmp-timeline').scrollIntoViewIfNeeded().catch(() => {})
    const unknownTitles = await page.locator('svg title', { hasText: /unknown/i }).count()
    check(`${tag} UI: unknown time is its own stretch on the Sun and Earth lanes`, unknownTitles >= 2, `${unknownTitles} unknown stretches`)
    await page.screenshot({ path: join(OUT, `${tag}-missing-data-comparison.png`), fullPage: true })
    const body = await page.locator('body').innerText()
    check(`${tag} UI: no "best solar" claim with incomparable coverage`, !/Best solar performance/.test(body))
    check(`${tag} UI: no NaN rendered`, !/NaN/.test(body))
    check(`${tag} no page errors`, pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300))
    check(`${tag} no failed /api requests`, apiFailures.length === 0, apiFailures.join(' | ').slice(0, 300))
    await browser.close()
  }
} catch (e) {
  check('journey completed', false, String(e).split('\n')[0])
} finally {
  rmSync(GAP_FILE, { force: true }) // the test copy never outlives the check
}
writeFileSync(join(OUT, 'time-missing-report.json'), JSON.stringify({ finished: new Date().toISOString(), app: URL_APP, results }, null, 2))
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
