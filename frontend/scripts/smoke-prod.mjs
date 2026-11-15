// Production smoke test: the user journey on the PRODUCTION build, through the real interface only.
//
//   node scripts/smoke-prod.mjs              build (tsc + vite build), serve dist/, run the journey
//   node scripts/smoke-prod.mjs --no-build   reuse the existing dist/
//   node scripts/smoke-prod.mjs --url <u>    test an already deployed app instead (no build, no server)
//
// Options: --api (backend for the served build's /api, default http://localhost:8000), --out <dir>
// (screenshots + report.json, default smoke-output/), --online (also run the live JPL Horizons check).
// Needs the backend running and Chrome or Edge (CHROME_PATH if it isn't found).
//
// Unlike scripts/demo-tour.mjs (a terrain-cache diagnostic on the dev server that steers the app through its
// stores), this only clicks, types and reads what a user sees: open the app, assess a site, plan two missions,
// investigate one in 3D, rescue it after a launch slip, compare the two, and find a landing date in the
// Feasibility Atlas and send it to the Planner. It fails (exit 1) on any failed
// step, any uncaught page error and any 5xx from the API. A journey step the app doesn't offer at all is
// reported as MISSING (and fails the run with --strict).
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const flag = (name) => args.includes(`--${name}`)
const API = opt('api', 'http://localhost:8000')
const OUT = opt('out', 'smoke-output')
const DEPLOYED = opt('url', null)
const ONLINE = flag('online')
const STRICT = flag('strict')
const RUN_ID = opt('run-id', null) // written into report.json so a caller never mistakes an older report for this run
const STARTED = new Date().toISOString()

function findChrome() {
  const found = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].find((p) => p && existsSync(p))
  if (!found) throw new Error('Chrome/Edge not found: set CHROME_PATH')
  return found
}

// ---------------------------------------------------------------- the app under test

let server = null
let base = DEPLOYED
if (!DEPLOYED) {
  if (!flag('no-build')) {
    console.log('Building the production bundle (tsc + vite build)...')
    execSync('npm run build', { stdio: 'inherit' })
  }
  if (!existsSync('dist/index.html')) throw new Error('dist/ is missing: run without --no-build')
  // Vite's preview server serves dist/ exactly as built (no dev modules), with /api forwarded to the backend.
  const { preview } = await import('vite')
  server = await preview({ preview: { port: 4179, strictPort: false, proxy: { '/api': API } }, logLevel: 'warn' })
  base = server.resolvedUrls.local[0].replace(/\/$/, '')
}
console.log(`App: ${base}  (API: ${DEPLOYED ? 'as deployed' : API})`)

rmSync(OUT, { recursive: true, force: true }) // no screenshot or report from an earlier run survives beside this one
mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ executablePath: findChrome(), args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] })
const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage()

const pageErrors = []
const apiFailures = []
const consoleErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e.stack ?? e).split('\n').slice(0, 3).join(' | ')))
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 300)))
page.on('response', (r) => r.url().includes('/api/') && r.status() >= 500 && apiFailures.push(`${r.status()} ${r.url()}`))

const steps = []
const sleep = (ms) => page.waitForTimeout(ms)
/** One journey step: passes, fails (with a screenshot), or is MISSING from the app. */
async function step(name, fn) {
  const t0 = Date.now()
  try {
    const note = await fn()
    steps.push({ name, status: note === MISSING ? 'missing' : 'pass', seconds: Math.round((Date.now() - t0) / 1000) })
    console.log(`${note === MISSING ? 'MISSING' : 'ok     '} ${name}`)
  } catch (e) {
    const shot = join(OUT, `fail-${steps.length + 1}.png`)
    await page.screenshot({ path: shot }).catch(() => {})
    const why = String(e.message ?? e).split('\n').slice(0, 3).join(' | ') // the message and the locator being waited for
    steps.push({ name, status: 'fail', error: why, screenshot: shot })
    console.log(`FAIL    ${name}: ${why}`)
  }
}
const MISSING = Symbol('missing')
const text = () => page.locator('body').innerText()
/** Open a disclosure (the compact UI keeps supporting evidence closed) the way a user would: by its button. */
async function openDisclosure(name) {
  const b = page.getByRole('button', { name }).first()
  await b.waitFor({ timeout: 10_000 })
  if ((await b.getAttribute('aria-expanded')) !== 'true') await b.click()
}
async function waitForText(re, timeout = 60_000) {
  await page.waitForFunction((src) => new RegExp(src).test(document.body.innerText), re.source, { timeout })
}
async function cameraView(name) {
  await page.getByRole('button', { name: 'Camera position' }).hover()
  await sleep(400)
  await page.getByRole('menuitemradio', { name }).click()
  await page.mouse.move(800, 300)
  await sleep(2500)
}
async function newPlan(name, site) {
  await page.getByRole('button', { name: 'New plan' }).last().click()
  const dialog = page.getByRole('dialog', { name: 'New plan' })
  await dialog.waitFor()
  await dialog.getByLabel('Plan name').fill(name)
  const select = dialog.getByLabel('Landing site')
  await page.waitForFunction(() => {
    const s = [...document.querySelectorAll('select')].find((x) => x.closest('[role=dialog]'))
    return s && s.options.length > 1
  }, null, { timeout: 30_000 })
  await select.selectOption({ label: site })
  await dialog.getByRole('button', { name: 'Create plan' }).click()
  await page.getByRole('listitem', { name: `Plan ${name}` }).waitFor({ timeout: 10_000 })
}
/** Fraction of sampled pixels in the 3D view that aren't (near) black: the Moon is actually drawn. */
async function drawnFraction() {
  const png = await page.locator('canvas').first().screenshot()
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = new OffscreenCanvas(img.width, img.height)
    const g = c.getContext('2d')
    g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, img.width, img.height).data
    let lit = 0, n = 0
    for (let i = 0; i < d.length; i += 4 * 97) { n++; if (d[i] + d[i + 1] + d[i + 2] > 60) lit++ }
    return lit / n
  }, png.toString('base64'))
}

// ---------------------------------------------------------------- the journey

await step('Open the app: landing page, then the navigator', async () => {
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Open the navigator' }).first().click()
  await page.getByRole('toolbar', { name: 'Map tools' }).waitFor({ timeout: 90_000 })
  if (!page.url().includes('#app')) throw new Error(`unexpected URL ${page.url()}`)
})

await step('Assess a site: Sun/Earth status, next events and the timeline', async () => {
  await waitForText(/Sunlight\s+[\d.]+% of disk|Sunlight\s+\S+ of disk/)
  await waitForText(/Next (sunset|sunrise)\s+\d{4}-\d{2}-\d{2}|Next (sunset|sunrise)\s+(not before|after)/)
  await waitForText(/Earth\s+(in view|blocked)/)
  await sleep(4000) // terrain
  const lit = await drawnFraction()
  if (lit < 0.05) throw new Error(`the 3D view looks empty (${(lit * 100).toFixed(1)}% drawn)`)
  await page.screenshot({ path: join(OUT, '1-assess.png') })
})

await step('Plan two missions (New plan dialog)', async () => {
  await newPlan('Smoke Malapert', 'Malapert Massif')
  await newPlan('Smoke Ridge', 'Connecting Ridge')
})

await step('Run a plan: it becomes the active mission and its card shows the canonical assessment', async () => {
  const card = page.getByRole('listitem', { name: 'Plan Smoke Ridge' })
  await card.getByRole('button', { name: 'Run' }).click()
  await card.getByText('Active · in 3D view').waitFor({ timeout: 10_000 })
  // A canonical verdict from the assessment API on the card (not just "Active"): Passes, Fails or Cannot be decided.
  await ['Passes', 'Fails', 'Cannot be decided'].map((w) => card.getByText(w, { exact: true })).reduce((x, y) => x.or(y)).first().waitFor({ timeout: 60_000 })
    .catch(async (e) => { throw new Error(`no canonical verdict on the plan card: ${(await card.innerText()).replace(/\s+/g, ' ').slice(0, 240)} (${String(e).split('\n')[0]})`) })
})

// The plan card's "Full assessment in Comparison" (the per-plan dialog it replaced moved to the Comparison's Mission
// assessment section in the branding refresh, 2b69bf2): the same plan's assessment, its evidence in 3D and the way back.
await step('Plan assessment in the Comparison: Show in 3D, then Back returns to the same assessment', async () => {
  const card = page.getByRole('listitem', { name: 'Plan Smoke Ridge' })
  await card.getByRole('button', { name: /Full assessment/ }).click()
  try {
    await page.waitForFunction(() => location.hash.startsWith('#app/compare'), null, { timeout: 10_000 })
    const panel = page.locator('#cmp-assessment')
    await panel.getByText('Smoke Ridge').first().waitFor({ timeout: 60_000 }) // this plan, not the running one
    const show = panel.getByRole('button', { name: 'Show in 3D' }).first() // the failing requirement's evidence window
    await show.waitFor({ timeout: 60_000 })
    await show.click()
    const banner = page.locator('[data-testid=evidence-banner]')
    await banner.waitFor({ timeout: 30_000 })
    if (!(await page.evaluate(() => location.hash)).startsWith('#app/planner')) throw new Error('Show in 3D did not open the 3D view')
    await banner.getByRole('button', { name: /^Back to / }).click()
    await panel.getByText('Smoke Ridge').first().waitFor({ timeout: 30_000 }) // the same plan's assessment again
    await banner.waitFor({ state: 'detached', timeout: 10_000 })
  } finally {
    // The next steps work in the 3D view: return there even if this step failed, so one failure is reported once.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Mission Planner' }).click().catch(() => {})
    await page.getByRole('button', { name: 'Camera position' }).waitFor({ timeout: 60_000 }).catch(() => {})
  }
})

await step("Investigate: the lander's-eye Sun view, the sky plot and the map layers", async () => {
  await cameraView('Sun')
  const lit = await drawnFraction()
  if (lit < 0.02) throw new Error(`the Sun view looks empty (${(lit * 100).toFixed(1)}% drawn)`)
  await page.getByRole('tab', { name: 'Sky' }).click()
  await waitForText(/Sky from Connecting Ridge/, 10_000)
  await page.getByRole('tab', { name: 'Map' }).click()
  await page.getByRole('button', { name: 'Map layers' }).click()
  await page.getByRole('menu', { name: 'Map layers' }).waitFor({ timeout: 5_000 })
  await page.keyboard.press('Escape')
  await page.screenshot({ path: join(OUT, '2-investigate.png') })
  await cameraView('Site')
})

if (ONLINE) {
  await step('Investigate: live check against JPL Horizons', async () => {
    await page.locator('button[data-tour="jpl-verify"]').click()
    await page.getByRole('region', { name: 'Live check against JPL Horizons' }).waitFor({ timeout: 90_000 })
    if (/Couldn't reach JPL|needs an internet/.test(await text())) throw new Error('JPL check failed')
  })
}

await step('Rescue: a 10-day launch slip, find alternatives', async () => {
  const rescue = page.getByRole('region', { name: 'Mission rescue' })
  await rescue.waitFor({ timeout: 10_000 })
  await rescue.getByLabel('Launch delay (days)').fill('10')
  await rescue.getByRole('button', { name: 'Find alternatives' }).click()
  // Results are not shown in the sidebar (UI spec 4.1): the search imports the original, the changed plan and the
  // alternatives into Scenario Comparison and opens its Mission Rescue story. A failure stays in the sidebar as an alert.
  try {
    const story = page.locator('#cmp-rescue')
    await story.or(rescue.getByRole('alert')).first().waitFor({ timeout: 180_000 })
    const alert = await rescue.getByRole('alert').first().textContent({ timeout: 500 }).catch(() => null)
    if (alert) throw new Error(`rescue reported: ${alert}`)
    if ((await page.evaluate(() => location.hash)) !== '#app/compare/cmp-rescue') throw new Error('Find alternatives did not open the rescue story')
    for (const title of ['Original plan', 'What changed', 'Alternatives from Mission Rescue, re-assessed here']) await story.getByText(title).first().waitFor({ timeout: 60_000 })
    if (/found no alternative/.test(await story.innerText())) throw new Error('Mission Rescue found no alternative')
    await page.screenshot({ path: join(OUT, '3-rescue.png') })
  } finally {
    // The next step ticks plans in the sidebar.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Mission Planner' }).click().catch(() => {})
    await page.getByRole('button', { name: 'Camera position' }).waitFor({ timeout: 60_000 }).catch(() => {})
  }
})

await step('Compare the two plans side by side', async () => {
  for (const name of ['Smoke Malapert', 'Smoke Ridge']) {
    await page.getByRole('listitem', { name: `Plan ${name}` }).getByLabel('Compare').check()
  }
  await page.getByRole('button', { name: /^Compare \(2\)/ }).click()
  await page.locator('[data-tour="compare-dashboard"]').waitFor({ timeout: 10_000 })
  await waitForText(/Data loaded|Backend unavailable/, 180_000)
  if (/Backend unavailable/.test(await text())) throw new Error('comparison: backend unavailable')
  await waitForText(/Malapert Massif[\s\S]*Connecting Ridge|Connecting Ridge[\s\S]*Malapert Massif/, 5_000)
  await waitForText(/Passes|Fails|Cannot be decided/, 5_000)
  // The trade-off analysis sits in the "Detailed analysis" view, in a disclosure that is closed by default.
  await page.getByRole('tab', { name: 'Detailed analysis' }).click()
  const tradeoff = page.getByRole('button', { name: /Trade-off analysis/ })
  if ((await tradeoff.getAttribute('aria-expanded')) !== 'true') await tradeoff.click()
  await waitForText(/Recommended feasible options/, 10_000)
  if (!page.url().includes('#app/compare')) throw new Error(`unexpected URL ${page.url()}`)
  await page.screenshot({ path: join(OUT, '4-compare.png') })
})

await step('Export the comparison (JSON and CSV files the user can keep)', async () => {
  await page.getByRole('tab', { name: 'Overview' }).click() // the export buttons sit with the decision, on the Overview view
  const files = {}
  for (const kind of ['JSON', 'CSV']) {
    const button = page.getByRole('button', { name: `Export ${kind}` })
    if ((await button.count()) === 0) return MISSING
    await page.waitForFunction((k) => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === `Export ${k}` && !b.disabled), kind, { timeout: 60_000 })
    const download = page.waitForEvent('download', { timeout: 30_000 })
    await button.click()
    const file = await download
    const path = join(OUT, file.suggestedFilename())
    await file.saveAs(path)
    files[kind] = readFileSync(path, 'utf8')
  }
  const json = JSON.parse(files.JSON)
  if (!JSON.stringify(json).includes('Malapert Massif') || !JSON.stringify(json).includes('Connecting Ridge')) throw new Error('the JSON export lacks the compared sites')
  if (!/Malapert Massif/.test(files.CSV) || files.CSV.split('\n').length < 3) throw new Error('the CSV export looks empty')
})

await step('Feasibility Atlas: map dates x lengths, explain a cell, check neighbours, open it in the Planner', async () => {
  await page.locator('nav[aria-label=Main]').getByRole('button', { name: 'Feasibility Atlas', exact: true }).click()
  const grid = page.getByRole('grid')
  await grid.waitFor({ timeout: 90_000 })
  if (!page.url().includes('#app/atlas')) throw new Error(`unexpected URL ${page.url()}`)
  await page.getByLabel('Legend').waitFor()
  // Keyboard: the selected cell has focus handling; arrow right moves the selection and the explanation follows.
  const selected = grid.locator('[role=gridcell][aria-selected=true]')
  const before = await selected.getAttribute('aria-label')
  await selected.focus()
  await page.keyboard.press('ArrowRight')
  const after = await grid.locator('[role=gridcell][aria-selected=true]').getAttribute('aria-label')
  if (before === after) throw new Error('arrow key did not move the selection')
  if (!(await page.evaluate(() => document.activeElement?.getAttribute('aria-selected') === 'true'))) throw new Error('focus did not follow the selection')
  // Pick a failing cell if there is one: its explanation names the deciding requirement.
  const fail = grid.locator('[role=gridcell][data-status=fail]').first()
  if (await fail.count()) {
    await fail.click()
    await waitForText(/Fails: /, 5_000)
    await openDisclosure(/Every requirement for this mission/)
    await page.getByLabel('deciding requirement').first().waitFor({ timeout: 5_000 })
  }
  await openDisclosure(/Neighbouring tested dates/)
  await page.getByRole('list', { name: 'The same mission at the neighbouring tested landing dates' }).waitFor()
  await waitForText(/Passes at \d+ consecutive tested dates|Passes at this tested date only|Fails here|can't be decided here|Not assessed: this landing/, 5_000)
  await page.screenshot({ path: join(OUT, '5-atlas.png') })
  // A helpful state when nothing is feasible.
  await openDisclosure(/Spacecraft requirements/)
  await page.getByLabel('Sunlight needed after landing (h)').fill('5000') // longer than any tested mission
  await page.getByRole('button', { name: 'Map these missions' }).click()
  await waitForText(/No tested mission meets every requirement here|Passes \(0\)/, 60_000)
  await page.screenshot({ path: join(OUT, '6-atlas-none.png') })
  await page.getByRole('button', { name: 'Default requirements' }).click()
  await page.getByRole('button', { name: 'Map these missions' }).click()
  await page.waitForFunction(() => !document.querySelector('[aria-busy=true]') && document.querySelector('[role=gridcell][data-status=pass]'), null, { timeout: 60_000 })
  // One click: that exact mission becomes a running plan in the Planner.
  const pass = grid.locator('[role=gridcell][data-status=pass]').first()
  await pass.click()
  const label = await pass.getAttribute('aria-label') // "Landing 2027-01-05 00:00 UTC, 7 d mission: ..."
  const [, when, len] = /Landing (\d{4}-\d{2}-\d{2} \d\d:\d\d) UTC, ([\d.]+ d) mission/.exec(label)
  const shownSite = /Map shown: (.+?), landings/.exec(await page.getByTestId('atlas-shown').innerText())?.[1]
  // Edit the search (another site) without re-mapping: the transfer must still be the mapped mission.
  const siteSelect = page.locator('form[aria-label="Atlas search and requirements"] select').first()
  const other = await siteSelect.evaluate((el, cur) => [...el.options].find((o) => o.text !== cur)?.text, shownSite)
  await siteSelect.selectOption({ label: other })
  await page.getByTestId('atlas-edited').waitFor({ timeout: 5_000 })
  await page.getByRole('button', { name: 'Open this mission in the Planner' }).click()
  await page.getByRole('toolbar', { name: 'Map tools' }).waitFor({ timeout: 30_000 })
  const plan = page.getByRole('listitem', { name: `Plan Atlas: ${shownSite} ${when} UTC, ${len}` })
  await plan.getByText('Active · in 3D view').waitFor({ timeout: 10_000 })
  if ((await plan.innerText()).includes(other)) throw new Error(`the transferred plan took the edited site ${other}`)
  await plan.getByText('Passes', { exact: true }).waitFor({ timeout: 60_000 }) // the same verdict as the cell
  await waitForText(new RegExp(`${when.slice(0, 10)} \\d\\d:\\d\\d UTC`), 10_000) // the simulation time is the landing
})

await step('Browser Back / Forward between the views; the 3D view is drawn again', async () => {
  if (!page.url().includes('#app/planner')) await page.locator('nav[aria-label=Main]').getByRole('button', { name: 'Mission Planner' }).click()
  await page.getByRole('toolbar', { name: 'Map tools' }).waitFor({ timeout: 30_000 })
  await page.goBack() // to the page before (the Atlas, which sent the mission here)
  await page.getByRole('grid').or(page.locator('[data-tour="compare-dashboard"]')).first().waitFor({ timeout: 30_000 })
  await page.goForward()
  await page.getByRole('toolbar', { name: 'Map tools' }).waitFor({ timeout: 30_000 })
  await sleep(4000)
  if ((await drawnFraction()) < 0.05) throw new Error('the 3D view looks empty after coming back')
})

// ---------------------------------------------------------------- verdict

await browser.close()
await server?.close()
const failed = steps.filter((s) => s.status === 'fail')
const missing = steps.filter((s) => s.status === 'missing')
const report = { run_id: RUN_ID, started: STARTED, finished: new Date().toISOString(), strict: STRICT, app: base, api: DEPLOYED ? null : API, steps, page_errors: pageErrors, api_failures: apiFailures, console_errors: consoleErrors }
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))

console.log(`\n${steps.length - failed.length - missing.length}/${steps.length} steps passed${missing.length ? `, ${missing.length} missing from the app` : ''}`)
if (pageErrors.length) {
  console.log(`${pageErrors.length} uncaught page error(s):`)
  for (const e of [...new Set(pageErrors)].slice(0, 10)) console.log('  ' + e)
}
if (apiFailures.length) {
  console.log(`${apiFailures.length} API request(s) failed:`)
  for (const f of apiFailures.slice(0, 10)) console.log('  ' + f)
}
if (consoleErrors.length) console.log(`${consoleErrors.length} console error message(s) (not fatal; see report.json)`)
console.log(`report and screenshots: ${OUT}/`)
const broken = failed.length > 0 || pageErrors.length > 0 || apiFailures.length > 0 || (STRICT && missing.length > 0)
console.log(broken ? '\nFAILED: the production app is not working end to end.' : '\nPASSED: the production app works end to end.')
process.exit(broken ? 1 : 0)
