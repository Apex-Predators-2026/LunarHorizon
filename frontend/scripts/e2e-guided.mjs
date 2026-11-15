// End-to-end check of the judge-facing journey in a real browser against the running app (dev server or preview +
// backend): landing "Try a mission" -> original plan PASS -> 4-day delay -> blackout FAIL -> evidence in 3D ->
// Mission Rescue recovery PASS -> Comparison recommends it -> export stage; then an Atlas cell opened in the planner.
// Runs at 1366x768 and 1920x1080 through real UI controls only (no store manipulation).
//
//   node scripts/e2e-guided.mjs [--url http://localhost:5173] [--out e2e-output]
//   node scripts/e2e-guided.mjs --serve-dist --api http://127.0.0.1:8011   the PRODUCTION build (dist/), served here
//
// --run-id <id> is written into report.json so a caller can tell this run's results from an older file.
// Exits non-zero on any failed expectation, page error or failed /api request. Needs Chrome or Edge (CHROME_PATH).
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  server = await preview({ preview: { port: 4180, strictPort: false, proxy: { '/api': opt('api', 'http://127.0.0.1:8000') } }, logLevel: 'warn' })
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
  const browser = await chromium.launch({ executablePath: chrome, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] })
  const page = await (await browser.newContext({ viewport, acceptDownloads: true })).newPage()
  const tag = `${viewport.width}x${viewport.height}`
  const apiFailures = []
  const pageErrors = []
  page.on('response', (r) => r.url().includes('/api/') && r.status() >= 500 && apiFailures.push(`${r.status()} ${r.url()}`))
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  // A fresh browser profile: no saved plans. Start from the landing page, as a visitor would.
  await page.goto(`${URL_APP}/`, { waitUntil: 'domcontentloaded' })
  await page.getByTestId('landing-try-mission').click()

  const card = page.getByTestId('guide-card')
  const assessment = page.locator('#mission-assessment')
  const shot = (n) => page.screenshot({ path: join(OUT, `${tag}-${n}.png`) })
  /** Wait until the stage has its real result (never a timer), then return its status and text. */
  const settle = async (stage, timeout = 60_000) => {
    await page.waitForFunction((st) => {
      const c = document.querySelector('[data-testid=guide-card]')
      return c && c.getAttribute('data-stage') === st && c.getAttribute('data-status') !== 'working'
    }, stage, { timeout })
    return { status: await card.getAttribute('data-status'), text: await card.innerText() }
  }
  const primary = () => page.getByTestId('guide-primary').click()

  let s = await settle('mission')
  check(`${tag} 1 mission: definition loaded`, s.status === 'ready' && /Peak Near Shackleton/.test(s.text))
  await shot('1-mission')
  await primary()
  s = await settle('original')
  check(`${tag} 2 original plan passes`, s.status === 'ready' && /PASSES every requirement/.test(s.text), s.text.match(/Maximum direct.*/)?.[0])
  await assessment.getByText('Passes').first().waitFor({ timeout: 30_000 })
  // The Planner's plan card shows the same canonical verdict for the running plan (not just "running").
  const guidedCard = page.getByRole('listitem', { name: /^Plan Try a mission/ })
  await guidedCard.getByText('Passes', { exact: true }).waitFor({ timeout: 30_000 })
  check(`${tag} 2 plan card shows the active plan's canonical verdict`, /Active · in 3D view/.test(await guidedCard.innerText()) && /Passes/.test(await guidedCard.innerText()))
  await shot('2-original')
  await primary()
  s = await settle('delay')
  check(`${tag} 3 delay applied through Rescue's change control`, s.status === 'ready' && /14 Oct 2027/.test(s.text))
  const afterTab = assessment.getByRole('tab', { name: 'After change' })
  check(`${tag} 3 assessment shows the plan after the change`, (await afterTab.getAttribute('aria-selected')) === 'true')
  await shot('3-delay')
  await primary()
  s = await settle('changed')
  check(`${tag} 4 what changed: blackout PASS -> FAIL`, s.status === 'ready' && /118 h/.test(s.text) && /22 h over the limit/.test(s.text))
  await shot('4-changed')
  await primary()
  s = await settle('evidence')
  const banner = page.getByRole('status').filter({ hasText: 'Exit evidence view' })
  await banner.waitFor({ timeout: 30_000 })
  const bannerText = await banner.innerText()
  check(`${tag} 5 evidence opens the blackout window in 3D`, s.status === 'ready' && /2027-10-23 02:00 UTC/.test(bannerText), bannerText.split(/\r?\n/)[0])
  await shot('5-evidence')
  await primary()
  s = await settle('rescue', 120_000)
  check(`${tag} 6 Rescue recovery passes (canonical check)`, s.status === 'ready' && /Malapert Massif/.test(s.text) && /confirms it PASSES/.test(s.text))
  const pickTab = assessment.getByRole('tab', { name: 'Rescue pick' })
  check(`${tag} 6 assessment shows the Rescue pick`, (await pickTab.getAttribute('aria-selected')) === 'true')
  await shot('6-rescue')
  await primary()
  s = await settle('compare', 120_000)
  check(`${tag} 7 comparison recommends the recovery`, s.status === 'ready' && /recommends the recovery/.test(s.text))
  await shot('7-compare')
  await primary()
  s = await settle('report')
  const preview = page.getByTestId('report-preview')
  await preview.waitFor({ timeout: 30_000 })
  const snapId = await preview.getAttribute('data-snapshot')
  check(`${tag} 8 summary report opens for the evaluated selection`, s.status === 'ready' && /^rpt-/.test(snapId ?? ''), snapId)
  const docText = await preview.innerText()
  check(`${tag} 8 report first page: decision, plans, requirements, uncertainty, attribution`,
    ['Mission decision summary', 'Recommended', 'Plans evaluated', 'Declared requirements', 'Main uncertainty', 'NASA JPL Horizons'].every((t) => docText.includes(t)))
  await shot('8-report')
  // The JSON download is the same snapshot.
  const dl = page.waitForEvent('download')
  await preview.getByRole('button', { name: 'Download JSON' }).click()
  const file = join(OUT, `${tag}-report.json`)
  await (await dl).saveAs(file)
  const snap = JSON.parse(readFileSync(file, 'utf8'))
  const byRole = Object.fromEntries(snap.export.scenarios.map((x) => [x.role, x]))
  const recoveryRole = Object.keys(byRole).find((r) => /^Recovery/.test(r ?? ''))
  check(`${tag} 8 JSON = report snapshot (same id, verdicts, recommendation)`,
    snap.snapshot_id === snapId && byRole['Original plan']?.eligibility === 'pass' && byRole['After the change']?.eligibility === 'fail'
    && byRole[recoveryRole]?.eligibility === 'pass' && byRole[recoveryRole]?.recommended === true)
  check(`${tag} 8 JSON records dataset hashes, revisions and the mission definition`,
    snap.export.reproduction.datasets.every((d) => /^[0-9a-f]{64}$/.test(d.sha256 ?? '')) && snap.export.scenarios.every((x) => x.revision)
    && snap.mission.mission_id === 'pns-oct-2027-launch-delay')
  // Browser-native print output (the same print stylesheet as Print / Save as PDF).
  await page.emulateMedia({ media: 'print' })
  for (const format of ['A4', 'Letter']) {
    const pdf = await page.pdf({ path: join(OUT, `${tag}-report-${format}.pdf`), format, printBackground: true })
    const pages = (pdf.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length
    check(`${tag} 8 ${format} PDF renders only the report`, pages >= 4 && pages <= 10, `${pages} pages`)
  }
  await page.emulateMedia({ media: 'screen' })
  await page.keyboard.press('Escape')
  check(`${tag} 8 Escape closes the preview`, (await preview.count()) === 0)
  await primary() // Finish
  check(`${tag} finish leaves the story`, (await card.count()) === 0)

  // A live edit after generation: the report keeps its snapshot, says it is out of date, and regenerates on request.
  await page.locator('#cmp-scenarios').getByRole('checkbox', { checked: true }).first().uncheck()
  await page.getByTestId('reopen-report').first().click() // the page header and the decision area both offer it
  await page.getByTestId('report-stale').waitFor({ timeout: 10_000 })
  check(`${tag} report flags a changed comparison and keeps its snapshot`, (await preview.getAttribute('data-snapshot')) === snapId)
  const regen = page.getByRole('button', { name: 'Regenerate from the current comparison' })
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes('Regenerate from the current comparison'))
    return b && !b.disabled
  }, null, { timeout: 60_000 })
  await regen.click()
  await page.waitForFunction((id) => document.querySelector('[data-testid=report-preview]')?.getAttribute('data-snapshot') !== id, snapId, { timeout: 10_000 })
  check(`${tag} regenerate uses the new selection`, /Scenarios [A-Z0-9]+, [A-Z0-9]+ as evaluated/.test(await preview.innerText()) && (await page.getByTestId('report-stale').count()) === 0)
  await preview.getByRole('button', { name: 'Close the report preview' }).click()

  // Restart twice from the header: one guided plan card, never duplicates.
  for (let i = 0; i < 2; i++) {
    await page.locator('header').getByRole('button', { name: /^(Try a mission|Restart the mission)$/ }).click()
    await settle('mission')
  }
  await page.getByRole('button', { name: 'Exit the guided mission' }).click()
  // Count the saved plans themselves (the Rescue panel also shows the running plan's name).
  const guidedPlans = await page.evaluate(() =>
    (JSON.parse(localStorage.getItem('lunar-plans') ?? '{}').state?.plans ?? []).filter((p) => p.name.startsWith('Try a mission')).length)
  check(`${tag} repeated restarts do not duplicate the saved plan`, guidedPlans === 1, `${guidedPlans} plan card(s)`)

  // Atlas: a map cell goes to the Planner as the mission that map evaluated, even after the search form is edited
  // without re-mapping, by Enter and by the button (the same path).
  await page.locator('nav[aria-label=Main]').getByRole('button', { name: 'Feasibility Atlas', exact: true }).click()
  const grid = page.getByRole('grid', { name: /^Feasibility of / })
  await grid.waitFor({ timeout: 90_000 })
  const shown = page.getByTestId('atlas-shown')
  await page.waitForFunction(() => !document.querySelector('[aria-busy=true]'), null, { timeout: 90_000 })
  const shownSite = /Map shown: (.+?), landings/.exec(await shown.innerText())?.[1]
  check(`${tag} atlas map shown is labelled with its site`, !!shownSite, shownSite)
  const openPlanned = async (how) => {
    const cell = grid.locator('[role=gridcell][data-status=pass]').first().or(grid.locator('[role=gridcell][data-status=fail]').first()).first()
    await cell.click()
    const label = await cell.getAttribute('aria-label') // "Landing 2027-01-05 00:00 UTC, 7 d mission: Passes. ..."
    const [, when, len, word] = /^Landing (\d{4}-\d{2}-\d{2} \d\d:\d\d) UTC, ([\d.]+ d) mission: (\w+)/.exec(label)
    // Edit the search (another site) without pressing "Map these missions".
    const siteSelect = page.locator('form[aria-label="Atlas search and requirements"] select').first()
    const other = await siteSelect.evaluate((el, current) => [...el.options].find((o) => o.text !== current)?.text, shownSite)
    await siteSelect.selectOption({ label: other })
    await page.getByTestId('atlas-edited').waitFor({ timeout: 5_000 })
    const plansBefore = await page.evaluate(() => (JSON.parse(localStorage.getItem('lunar-plans') ?? '{}').state?.plans ?? []).map((p) => p.name))
    if (how === 'enter') {
      await grid.locator('[role=gridcell][aria-selected=true]').focus()
      await page.keyboard.press('Enter')
    } else {
      await page.getByTestId('atlas-open-planner').click()
    }
    await page.getByRole('toolbar', { name: 'Map tools' }).waitFor({ timeout: 30_000 })
    const planName = `Atlas: ${shownSite} ${when} UTC, ${len}`
    const card = page.getByRole('listitem', { name: `Plan ${planName}`, exact: true }).first()
    await card.waitFor({ timeout: 10_000 })
    const saved = await page.evaluate(() => (JSON.parse(localStorage.getItem('lunar-plans') ?? '{}').state?.plans ?? []).map((p) => p.name))
    const before = plansBefore.filter((n) => n === planName).length
    check(`${tag} atlas ${how} transfer creates exactly one plan`, saved.filter((n) => n === planName).length === before + 1, `${saved.filter((n) => n === planName).length - before} new; saved: ${saved.join(' | ')}`)
    const expected = word === 'Passes' ? 'pass' : word === 'Fails' ? 'fail' : 'unknown'
    const badge = { pass: 'Passes', fail: 'Fails', unknown: 'Cannot be decided' }[expected]
    await card.getByText(badge, { exact: true }).waitFor({ timeout: 60_000 })
    const text = await card.innerText()
    check(`${tag} atlas ${how} transfer: the mapped site and instant, not the edited form (${other})`,
      text.includes(`${shownSite} · ${when} UTC · ${len}`) && !text.includes(other), `${shownSite} ${when} ${len} -> ${expected}`)
    check(`${tag} atlas ${how} transfer: the Planner's canonical verdict matches the cell`, (await card.innerText()).includes(badge), `cell ${word}, Planner badge ${badge}`)
  }
  await openPlanned('enter')
  await shot('9-atlas-enter')
  await page.goBack()
  await grid.waitFor({ timeout: 30_000 })
  await page.waitForFunction(() => !document.querySelector('[aria-busy=true]'), null, { timeout: 90_000 })
  await openPlanned('button')
  await shot('9-atlas-button')

  check(`${tag} no page errors`, pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  check(`${tag} no failed API requests`, apiFailures.length === 0, apiFailures.slice(0, 3).join(' | '))
  await browser.close()
}

try {
  for (const vp of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) await run(vp)
} catch (e) {
  check('journey completed', false, String(e).split('\n')[0])
}
await server?.close()
writeFileSync(join(OUT, 'report.json'), JSON.stringify({ run_id: RUN_ID, started: STARTED, finished: new Date().toISOString(), app: URL_APP, results }, null, 2))
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
