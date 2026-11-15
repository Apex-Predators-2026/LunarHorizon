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
// investigate one in 3D, rescue it after a launch slip, and compare the two. It fails (exit 1) on any failed
// step, any uncaught page error and any 5xx from the API. A journey step the app doesn't offer at all is
// reported as MISSING (and fails the run with --strict).
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
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
    steps.push({ name, status: 'fail', error: String(e.message ?? e).split('\n')[0], screenshot: shot })
    console.log(`FAIL    ${name}: ${String(e.message ?? e).split('\n')[0]}`)
  }
}
const MISSING = Symbol('missing')
const text = () => page.locator('body').innerText()
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

await step('Run a plan: it becomes the active mission', async () => {
  const card = page.getByRole('listitem', { name: 'Plan Smoke Ridge' })
  await card.getByRole('button', { name: 'Run' }).click()
  await card.getByText('Running').waitFor({ timeout: 10_000 })
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
  // A result brings its controls ("Show on map"); a failure shows an alert.
  await rescue.getByRole('switch', { name: 'Show on map' }).or(rescue.getByRole('alert')).first().waitFor({ timeout: 180_000 })
  const alert = await rescue.getByRole('alert').first().textContent({ timeout: 500 }).catch(() => null)
  if (alert) throw new Error(`rescue reported: ${alert}`)
  await rescue.getByRole('switch', { name: 'Explain' }).click() // the plain-language walkthrough
  await rescue.getByText('What rescue did').waitFor({ timeout: 5_000 })
  await page.screenshot({ path: join(OUT, '3-rescue.png') })
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
  await page.locator('nav[aria-label="Comparison sections"] a', { hasText: 'Trade-off' }).click()
  await waitForText(/Recommended feasible options/, 10_000)
  if (!page.url().includes('#app/compare')) throw new Error(`unexpected URL ${page.url()}`)
  await page.screenshot({ path: join(OUT, '4-compare.png') })
})

await step('Export the mission (a file the user can keep)', async () => {
  // Look for anything that offers an export or download, anywhere the user would look.
  const offer = page.getByRole('button', { name: /export|download|save as|report/i })
    .or(page.getByRole('link', { name: /export|download/i }))
  if ((await offer.count()) === 0) {
    await page.getByRole('button', { name: 'Mission Planner' }).click()
    await sleep(1500)
  }
  if ((await offer.count()) === 0) return MISSING
  const download = page.waitForEvent('download', { timeout: 30_000 })
  await offer.first().click()
  const file = await download
  const path = join(OUT, file.suggestedFilename())
  await file.saveAs(path)
})

await step('Browser Back / Forward between the views; the 3D view is drawn again', async () => {
  if (!page.url().includes('#app/planner')) await page.getByRole('button', { name: 'Mission Planner' }).click()
  await page.getByRole('toolbar', { name: 'Map tools' }).waitFor({ timeout: 30_000 })
  await page.goBack()
  await page.locator('[data-tour="compare-dashboard"]').waitFor({ timeout: 10_000 })
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
const report = { app: base, api: DEPLOYED ? null : API, steps, page_errors: pageErrors, api_failures: apiFailures, console_errors: consoleErrors }
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
