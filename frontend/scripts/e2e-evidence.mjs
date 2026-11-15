// End-to-end check of "Show why" across screens, in a real browser against the running app: Scenario Comparison -> a
// failed or undecided requirement -> "Show why" -> the Mission Planner's 3D view opens (it was not mounted when the
// request was made) at the right site, paused, looking toward the body concerned, with the canonical window shaded and
// explained -> "Back to comparison" -> the same "Show why" again (repeat after unmount / remount) -> ordinary
// navigation does not replay stale evidence over the user's own time. Recovered from the source branch (1b5f5f3) and
// adapted to the current UI (production build option, report with this run's id, both target viewports).
//
//   node scripts/e2e-evidence.mjs [--url http://localhost:5173] [--out e2e-output]
//   node scripts/e2e-evidence.mjs --serve-dist --api http://127.0.0.1:8011   the PRODUCTION build (dist/), served here
//
// --run-id <id> is written into report.json so a caller can tell this run's results from an older file.
// Exits non-zero on any failed expectation, page error or failed /api request. Needs Chrome or Edge (CHROME_PATH).
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const OUT = opt('out', 'e2e-output')
const RUN_ID = opt('run-id', null)
const STARTED = new Date().toISOString()
rmSync(OUT, { recursive: true, force: true }) // never leave an older run's screenshots or report beside this one
mkdirSync(OUT, { recursive: true })
let server = null
let URL_APP = opt('url', 'http://localhost:5173')
if (args.includes('--serve-dist')) {
  if (!existsSync('dist/index.html')) throw new Error('dist/ is missing: run npm run build first')
  const { preview } = await import('vite')
  server = await preview({ preview: { port: 4182, strictPort: false, proxy: { '/api': opt('api', 'http://127.0.0.1:8000') } }, logLevel: 'warn' })
  URL_APP = server.resolvedUrls.local[0].replace(/\/$/, '')
}
console.log(`App: ${URL_APP}`)

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

async function run(viewport) {
  const tag = `${viewport.width}x${viewport.height}`
  const browser = await chromium.launch({ executablePath: chrome, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] })
  const page = await (await browser.newContext({ viewport })).newPage()
  const apiFailures = []
  const pageErrors = []
  page.on('response', (r) => r.url().includes('/api/') && r.status() >= 500 && apiFailures.push(`${r.status()} ${r.url()}`))
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  const shot = (n) => page.screenshot({ path: join(OUT, `${tag}-evidence-${n}.png`) })
  const hash = () => page.evaluate(() => window.location.hash)
  const scene = page.locator('[data-testid=scene]')
  const banner = page.locator('[data-testid=evidence-banner]')
  const main = page.getByRole('navigation', { name: 'Main' })
  try {
    // 1. Open the Comparison directly (fresh profile: preset scenarios). The 3D view is NOT mounted here.
    await page.goto(`${URL_APP}/#app/compare/cmp-performance`, { waitUntil: 'domcontentloaded' })
    const whyButtons = page.getByRole('button', { name: /^Show why: / })
    await whyButtons.first().waitFor({ timeout: 90_000 })
    check(`${tag} comparison offers Show why for a failed or undecided requirement`, (await whyButtons.count()) > 0, `${await whyButtons.count()} buttons`)
    check(`${tag} 3D view not mounted on the comparison page`, (await scene.count()) === 0)
    const first = whyButtons.first()
    const label = await first.getAttribute('aria-label')
    await shot('1-comparison')

    // 2. Show why -> planner, paused, at the evidence, looking at the body, window shaded and explained.
    await first.click()
    await banner.waitFor({ timeout: 30_000 })
    check(`${tag} navigates to the Mission Planner`, (await hash()) === '#app/planner', await hash())
    const text = await banner.innerText()
    check(`${tag} banner names the requirement and its origin`, /(Evidence|Data missing): /.test(text) && /from Plan [A-Z]/.test(text), text.split('\n')[0])
    check(`${tag} banner shows the threshold and the measured value or bounds`, /Required .+ · Measured .+/.test(text))
    const band = page.locator('[data-testid=evidence-band]')
    await band.waitFor({ timeout: 30_000 })
    const evStart = Number(await band.getAttribute('data-evidence-start'))
    const evEnd = Number(await band.getAttribute('data-evidence-end'))
    const st = await scene.evaluate((el) => ({ ...el.dataset }))
    check(`${tag} scene paused`, st.playing === 'false')
    check(`${tag} scene looks toward the Sun or Earth`, st.view === 'sun' || st.view === 'earth', st.view)
    check(`${tag} scene time is the evidence start`, Date.parse(st.time) === evStart, `${st.time} vs ${new Date(evStart).toISOString()}`)
    check(`${tag} a real interval is shaded (start < end)`, evEnd > evStart, `${(evEnd - evStart) / 3.6e6} h`)
    check(`${tag} scene site matches the scenario`, !!st.site, st.site)
    await shot('2-evidence')

    // 3. Way back to the originating result.
    await banner.getByRole('button', { name: 'Back to comparison' }).click()
    await whyButtons.first().waitFor({ timeout: 30_000 })
    check(`${tag} Back returns to the comparison section`, (await hash()) === '#app/compare/cmp-performance', await hash())

    // 4. The same Show why again: a new request, applied again after the 3D view unmounted and remounted.
    await page.getByRole('button', { name: label }).click()
    await banner.waitFor({ timeout: 30_000 })
    await band.waitFor({ timeout: 30_000 })
    const st2 = await scene.evaluate((el) => ({ ...el.dataset }))
    check(`${tag} repeated Show why applies again`, Date.parse(st2.time) === evStart && (await hash()) === '#app/planner')

    // 5. Ordinary navigation does not replay stale evidence over the user's own time.
    await page.getByRole('slider').first().focus()
    await page.keyboard.press('Shift+ArrowRight') // one day later
    await page.waitForFunction((t) => document.querySelector('[data-testid=scene]')?.getAttribute('data-time') !== t, st2.time)
    const userTime = await scene.getAttribute('data-time')
    await main.getByRole('button', { name: /Comparison/ }).click()
    await whyButtons.first().waitFor({ timeout: 30_000 })
    await main.getByRole('button', { name: 'Mission Planner' }).click()
    await scene.waitFor({ timeout: 30_000 })
    await page.waitForTimeout(1500) // give a (wrong) replay the chance to happen
    check(`${tag} returning to the planner keeps the user's time (no replay)`, (await scene.getAttribute('data-time')) === userTime, `${userTime}`)
    await shot('3-after-navigation')
  } catch (e) {
    check(`${tag} journey completed`, false, String(e).split('\n').slice(0, 3).join(' | '))
    await shot('error').catch(() => {})
  }
  check(`${tag} no page errors`, pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300))
  check(`${tag} no failed API requests`, apiFailures.length === 0, apiFailures.join(' | ').slice(0, 300))
  await browser.close()
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) await run(viewport)
await server?.close()
writeFileSync(join(OUT, 'report.json'), JSON.stringify({ run_id: RUN_ID, started: STARTED, finished: new Date().toISOString(), app: URL_APP, results }, null, 2))
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
