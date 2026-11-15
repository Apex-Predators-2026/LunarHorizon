// End-to-end check of the judge-facing journey in a real browser against the running app (dev server or preview +
// backend): landing -> navigator header "Try a mission" -> original plan PASS -> 4-day delay -> blackout FAIL -> evidence in 3D ->
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

const USER_PLAN = {
  id: 'user-plan-e2e', name: 'My own plan',
  scenario: { site: { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.9635, lon: 357.6326 }, landing_utc: '2027-02-01T00:00:00Z', duration_days: 5,
    requirements: { min_sunlight_fraction: 0.5, battery_hours: 50, panel_threshold: 0.25, min_earth_visibility_fraction: 0.4, max_comms_gap_hours: 96, min_initial_sun_hours: 24, min_initial_comms_hours: 12 } },
}

async function run(viewport) {
  const browser = await chromium.launch({ executablePath: chrome, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] })
  const page = await (await browser.newContext({ viewport, acceptDownloads: true })).newPage()
  const tag = `${viewport.width}x${viewport.height}`
  const apiFailures = []
  const pageErrors = []
  page.on('response', (r) => r.url().includes('/api/') && r.status() >= 500 && apiFailures.push(`${r.status()} ${r.url()}`))
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  // A fresh browser profile with ONE plan the user made earlier (saved before the page loads): the guided mission must
  // never duplicate, replace or delete it, however often it is restarted or left.
  await page.addInitScript((plan) => { if (!localStorage.getItem('lunar-plans')) localStorage.setItem('lunar-plans', JSON.stringify({ state: { plans: [plan], activeId: null, compareIds: [] }, version: 0 })) }, USER_PLAN)
  // Start from the landing page, as a visitor would. Open the navigator, then launch the Full guided tour from More (⋮).
  await page.goto(`${URL_APP}/`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Open the navigator' }).first().click()
  const startFullTour = async () => {
    await page.locator('[data-tour="more-menu"] button').first().click()
    await page.getByRole('menuitem', { name: /Full guided tour/ }).click()
  }
  await startFullTour()

  const card = page.getByTestId('tutorial-coachmark')
  const shot = (n) => page.screenshot({ path: join(OUT, `${tag}-${n}.png`) })
  /** Wait until the tour step has settled with its live result (never a timer), then return its status and text. */
  const settle = async (stepId, timeout = 60_000) => {
    await page.waitForFunction((id) => {
      const c = document.querySelector('[data-testid=tutorial-coachmark]')
      const next = c?.querySelector('[data-testid=tutorial-next]')
      return c && c.getAttribute('data-step') === id && next && next.getAttribute('aria-disabled') !== 'true'
    }, stepId, { timeout })
    const err = (await card.locator('[role=alert]').count()) > 0
    const warn = (await card.locator('[role=status]').count()) > 0
    return { status: err ? 'error' : warn ? 'warn' : 'ready', text: await card.innerText() }
  }
  const primary = () => page.getByTestId('tutorial-next').click()
  const stepTo = async (stepId, timeout = 60_000) => {
    for (let i = 0; i < 12; i++) {
      const cur = await card.getAttribute('data-step')
      if (cur === stepId) return settle(stepId, timeout)
      await settle(cur, timeout)
      await primary()
    }
    throw new Error(`Did not reach tour step "${stepId}"`)
  }

  let s = await settle('mission')
  check(`${tag} 1 mission: definition loaded`, s.status === 'ready' && /Peak Near Shackleton/.test(s.text))
  await shot('1-mission')
  s = await stepTo('original')
  check(`${tag} 2 original plan passes`, s.status === 'ready' && /PASSES every requirement/.test(s.text), s.text.match(/Longest.*|Earth in.*|Average.*/)?.[0])
  // The Planner's plan card shows the same canonical verdict for the running plan (not just "running").
  const guidedCard = page.getByRole('listitem', { name: /^Plan Try a mission/ })
  await guidedCard.getByText('Passes', { exact: true }).waitFor({ timeout: 30_000 })
  check(`${tag} 2 plan card shows the active plan's canonical verdict`, /Active · in 3D view/.test(await guidedCard.innerText()) && /Passes/.test(await guidedCard.innerText()))
  await shot('2-original')
  await primary()
  s = await settle('delay')
  // In the unified tour, the delay step applies the 4-day delay through Rescue's change control and shows what changed.
  const savedUnchanged = async () => { const t = await guidedCard.innerText(); return /2027-10-10 00:00 UTC/.test(t) && /\bPasses\b/.test(t) }
  check(`${tag} 3 the saved plan keeps its date and verdict (the delay is a what-if)`, await savedUnchanged())
  check(`${tag} 4 what changed: blackout PASS -> FAIL`, s.status === 'ready' && /118 h/.test(s.text) && /FAIL/.test(s.text))
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
  check(`${tag} 6 Rescue recovery passes (canonical check)`, s.status === 'ready' && /Malapert Massif/.test(s.text) && /143 km/.test(s.text))
  // (Rescue pick tab: see stage 3. The recovery's PASS is checked above and in the report JSON.)
  check(`${tag} 6 the saved plan keeps its date and verdict after the Rescue search`, await savedUnchanged())
  await shot('6-rescue')
  await primary()
  s = await settle('compare', 120_000)
  check(`${tag} 7 comparison recommends the recovery`, s.status === 'ready' && /recovery ranks first/.test(s.text))
  await shot('7-compare')
  s = await stepTo('report')
  const preview = page.getByTestId('report-preview')
  await preview.waitFor({ timeout: 30_000 })
  const snapId = await preview.getAttribute('data-snapshot')
  check(`${tag} 8 summary report opens for the evaluated selection`, s.status === 'ready' && /^rpt-/.test(snapId ?? ''), snapId)
  const docText = await preview.innerText()
  // The Mission Report from the frozen snapshot: a title page with contents (added in the formal-document redesign,
  // 11500ad) then six section pages (executive summary, overview, performance, analysis, requirements, strengths,
  // recommendation, sources, disclaimer), with the technical record as an appendix. 7 = PAGE_COUNT in reportLayout.ts.
  const reportPages = await preview.locator('.rc-page').count()
  const sectionNames = ['Executive summary', 'Mission overview', 'Mission performance', 'Comparison analysis', 'Mission requirements assessment', 'Strengths and weaknesses', 'Final assessment and recommendation', 'Data sources and methodology']
  check(`${tag} 8 report first page: decision, plans, requirements, uncertainty, attribution`,
    reportPages === 7 && ['Lunar Mission Comparison Report', 'Peak Near Shackleton', 'Malapert Massif', 'PASS', 'FAIL', 'NASA JPL Horizons', ...sectionNames].every((t) => docText.includes(t)), `${reportPages} pages`)
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
  // One-click PDF (the report, laid out in the browser): a real PDF file. Its pages flow with the content (the guided
  // mission gives 10: a title page, then one A4 body that wraps with unsplittable figures and tables, ReportCardPdf.tsx),
  // so the check is a valid PDF of at least the preview's seven pages and not a runaway layout.
  const pdfDownload = page.waitForEvent('download', { timeout: 120_000 })
  await preview.getByTestId('download-report-pdf').click()
  const pdfDl = await pdfDownload
  const pdfFile = join(OUT, `${tag}-report-download.pdf`)
  await pdfDl.saveAs(pdfFile)
  const pdfBytes = readFileSync(pdfFile)
  const pdfPages = (pdfBytes.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length
  check(`${tag} 8 Download PDF produces the report PDF`, /\.pdf$/i.test(pdfDl.suggestedFilename()) && pdfBytes.subarray(0, 5).toString('latin1') === '%PDF-' && pdfBytes.length > 20_000 && pdfBytes.subarray(-1024).toString('latin1').includes('%%EOF') && pdfPages >= 7 && pdfPages <= 12,`${pdfDl.suggestedFilename()}, ${pdfBytes.length} bytes, ${pdfPages} pages`)
  // Browser-native print output (the same print stylesheet as Print / Save as PDF): the report and its technical appendix.
  await page.emulateMedia({ media: 'print' })
  for (const format of ['A4', 'Letter']) {
    const pdf = await page.pdf({ path: join(OUT, `${tag}-report-${format}.pdf`), format, printBackground: true })
    const pages = (pdf.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length
    check(`${tag} 8 ${format} PDF renders only the report`, pages >= 10 && pages <= 16, `${pages} pages (6 report pages + the technical appendix)`)
  }
  await page.emulateMedia({ media: 'screen' })
  await page.keyboard.press('Escape')
  check(`${tag} 8 Escape closes the preview`, (await preview.count()) === 0)
  // Finish Act 3 (Atlas -> Methodology -> Your turn recap) and leave the tour cleanly.
  s = await stepTo('atlas')
  s = await stepTo('method')
  s = await stepTo('your-turn')
  check(`${tag} Act 3 Your turn recap shows live verdicts`, /Peak Near Shackleton · PASS/.test(s.text) && /Peak Near Shackleton · FAIL/.test(s.text) && /Malapert Massif · PASS/.test(s.text))
  await primary() // Explore on my own
  check(`${tag} finish leaves the tour`, (await card.count()) === 0)

  // A live edit after generation: return to Scenario Comparison, verify the report flags a changed comparison, and regenerate.
  await page.locator('nav[aria-label=Main]').getByRole('button', { name: 'Scenario Comparison', exact: true }).click()
  await page.locator('#cmp-scenarios').waitFor({ timeout: 30_000 })
  // The scenario checkboxes live in the "Manage scenarios" disclosure, collapsed once two scenarios are compared.
  const manage = page.locator('#cmp-scenarios').getByRole('button', { name: /Manage plans/ })
  if ((await manage.getAttribute('aria-expanded')) !== 'true') await manage.click()
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
  check(`${tag} regenerate uses the new selection`, /Plans [A-Z0-9]+, [A-Z0-9]+ as evaluated/.test(await preview.innerText()) && (await page.getByTestId('report-stale').count()) === 0)
  await preview.getByRole('button', { name: 'Close the report preview' }).click()

  // Restart twice from the planner toolbar: one guided plan card, never duplicates.
  await page.locator('nav[aria-label=Main]').getByRole('button', { name: 'Mission Planner', exact: true }).click()
  await page.locator('[data-tour="more-menu"] button').first().waitFor({ timeout: 30_000 })
  for (let i = 0; i < 2; i++) {
    await startFullTour()
    await settle('mission')
    if (i === 0) await page.getByRole('button', { name: 'Skip guided tour' }).click()
  }
  await page.getByRole('button', { name: 'Skip guided tour' }).click()
  // Count the saved plans themselves (the Rescue panel also shows the running plan's name).
  const guidedPlans = await page.evaluate(() =>
    (JSON.parse(localStorage.getItem('lunar-plans') ?? '{}').state?.plans ?? []).filter((p) => p.name.startsWith('Try a mission')).length)
  check(`${tag} repeated restarts do not duplicate the saved plan`, guidedPlans === 1, `${guidedPlans} plan card(s)`)
  const kept = await page.evaluate(() => (JSON.parse(localStorage.getItem('lunar-plans') ?? '{}').state?.plans ?? []).filter((p) => p.id === 'user-plan-e2e'))
  check(`${tag} the user's own plan survives the restarts and leaving the guide unchanged`, kept.length === 1 && kept[0].name === 'My own plan' && kept[0].scenario.duration_days === 5 && kept[0].scenario.landing_utc === '2027-02-01T00:00:00Z', JSON.stringify(kept.map((p) => p.name)))

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
