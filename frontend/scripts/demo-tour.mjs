// Terrain-cache tour (a diagnostic, not a test of the deployed app): drives the app on the Vite DEV server
// through what a demo shows, for each demo site: every camera view, a zoom out to the whole Moon and back, the
// top-down toggle, and the shadows across a real sunset. It steers the app through the dev server's modules
// (stores), so it proves the chosen views load their resources, not that a user can use the built app: that
// is scripts/smoke-prod.mjs (production build, real interface only). Three uses (docs/demo-setup.md):
//
//   node scripts/demo-tour.mjs                  warm the caches: run once online, the backend keeps all it fetched
//   node scripts/demo-tour.mjs --verify         prove the demo needs no downloads: start the backend with
//                                               LUNAR_OFFLINE=1 first; any failed /api request fails the run
//   node scripts/demo-tour.mjs --check-horizon  also compare the 3D terrain's skyline with the engine's horizon
//
// Options: --sites a,b,c (default: the south-polar demo sites), --url (default http://localhost:5173),
// --api (default http://localhost:8000), --out <dir> (screenshots + report.json, default tour-output/).
// Needs Chrome or Edge: set CHROME_PATH if it isn't found. Runs against the Vite dev server (it reads the
// app's terrain-loading state through the dev server's modules).
// Fails (exit 1) on any uncaught page error, in every mode, and with --verify on any failed /api request.
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const flag = (name) => args.includes(`--${name}`)
const URL_APP = opt('url', 'http://localhost:5173')
const URL_API = opt('api', 'http://localhost:8000')
const OUT = opt('out', 'tour-output')
const VERIFY = flag('verify')
const CHECK_HORIZON = flag('check-horizon')
const DEFAULT_SITES = [
  'connecting-ridge', 'malapert-massif', 'peak-near-shackleton', 'de-gerlache-rim', 'haworth-rim', 'nobile-rim-1',
  'mons-mouton', 'faustini-rim-a', 'shackleton-floor', 'im-1-odysseus', 'im-2-athena',
]
const SITES = opt('sites', DEFAULT_SITES.join(',')).split(',').filter(Boolean)
const TERRAIN_TIMEOUT_MS = VERIFY ? 30_000 : 180_000 // online, Moon Trek can take minutes for a new area

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
  const found = candidates.find((p) => p && existsSync(p))
  if (!found) throw new Error('Chrome/Edge not found: set CHROME_PATH')
  return found
}

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({
  executablePath: findChrome(),
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
})
const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage()

// Every backend request that failed (5xx = the backend couldn't get the data, e.g. offline and not cached).
const failures = []
let requests = 0
page.on('response', (r) => {
  if (!r.url().includes('/api/')) return
  requests++
  if (r.status() >= 500) failures.push(`${r.status()} ${r.url()}`)
})
// Requests the app cancels itself (e.g. on a site change) are not failures.
page.on('requestfailed', (r) => {
  if (r.url().includes('/api/') && !/ABORTED|cancel/i.test(r.failure()?.errorText ?? '')) failures.push(`failed ${r.url()}`)
})
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

// #app: the navigator itself (the first screen, "/", is the landing page).
await page.goto(`${URL_APP}/?perf#app`, { waitUntil: 'domcontentloaded' })
// The 3D view is up once its controls exist. A cold dev server or backend can take a while: one reload.
try {
  await page.waitForFunction(() => !!window.__nav, null, { timeout: 90_000 })
} catch {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.__nav, null, { timeout: 90_000 })
}
/**
 * The app's own stores, through the dev server's modules (same instances the app uses). Again after a
 * reload (e.g. the dev server reloading the page because files changed): returns once they are there.
 */
async function attach() {
  if (await page.evaluate(() => !!window.__tour).catch(() => false)) return
  await page.waitForFunction(() => !!window.__nav, null, { timeout: 90_000 })
  await page.evaluate(async () => {
    const find = (part) => performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes(part))
    window.__tour = {
      app: (await import(find('/src/store.ts'))).useAppStore,
      terrain: (await import(find('/globe/terrainLoad.ts'))).useTerrainLoad,
    }
  })
}
await attach()

const sleep = (ms) => page.waitForTimeout(ms)
/** Wait until the terrain has stopped loading (and something is drawn), or time out. */
async function terrainSettled(label) {
  const t0 = Date.now()
  let quietSince = 0
  while (Date.now() - t0 < TERRAIN_TIMEOUT_MS) {
    const { pending, drawn } = await page.evaluate(() => window.__tour.terrain.getState())
    if (pending === 0 && drawn > 0) {
      quietSince ||= Date.now()
      if (Date.now() - quietSince > 1200) return true
    } else quietSince = 0
    await sleep(250)
  }
  failures.push(`terrain still loading after ${TERRAIN_TIMEOUT_MS / 1000} s: ${label}`)
  return false
}
async function view(name) {
  const button = page.locator('button[aria-label="Camera position"]')
  if (!(await button.isVisible().catch(() => false))) {
    // The toolbar is hidden (e.g. the interface hidden, or a panel over it): note it, try to recover.
    await page.screenshot({ path: join(OUT, `no-toolbar-${Date.now()}.png`) })
    await page.keyboard.press('Escape')
    await sleep(500)
  }
  await button.hover({ timeout: 10_000 })
  await sleep(400)
  await page.getByRole('menuitemradio', { name }).click()
  await page.mouse.move(800, 300)
  await sleep(1500) // the flight
}
const shot = (name) => page.screenshot({ path: join(OUT, `${name}.png`) })
const api = async (path) => (await fetch(`${URL_API}${path}`)).json()

const report = { verify: VERIFY, sites: {}, horizon: {} }
for (const id of SITES) {
  try {
    await tourSite(id)
  } catch (e) {
    // One stop going wrong (e.g. a panel covering the toolbar) shouldn't end the whole tour.
    const msg = String(e).split('\n')[0]
    failures.push(`tour step failed at ${id}: ${msg}`)
    await page.screenshot({ path: join(OUT, `${id}_error.png`) }).catch(() => {})
    console.log(`   error: ${msg}`)
  }
}

async function tourSite(id) {
  const t0 = Date.now()
  console.log(`\n== ${id}`)
  await attach() // again, in case the page was reloaded meanwhile
  await page.evaluate((s) => window.__tour.app.getState().setSite(s), id)
  await sleep(2000)
  await terrainSettled(`${id} first view`)
  for (const v of ['Site', 'Region', 'Globe', 'Site', 'Sun', 'Earth']) {
    await view(v)
    await terrainSettled(`${id} ${v} view`)
    await shot(`${id}_${v.toLowerCase()}`)
  }
  // Zoom out to the whole Moon and back in (the in-between levels of detail and the imagery fade).
  await view('Site')
  await terrainSettled(`${id} site again`)
  await page.mouse.move(640, 420)
  for (let i = 0; i < 24; i++) {
    await page.mouse.wheel(0, 300)
    await sleep(120)
  }
  await terrainSettled(`${id} zoomed out`)
  for (let i = 0; i < 24; i++) {
    await page.mouse.wheel(0, -300)
    await sleep(120)
  }
  await terrainSettled(`${id} zoomed back in`)
  // Top-down and back.
  await page.keyboard.press('u')
  await sleep(1200)
  await terrainSettled(`${id} top-down`)
  await page.keyboard.press('u')
  await sleep(1200)
  // Shadows across the next sunset (from the engine), seen from the Site view.
  const now = await page.evaluate(() => window.__tour.app.getState().timeUtc)
  const status = await api(`/api/sites/${id}/status?time=${encodeURIComponent(now)}`)
  if (status.next_sunset_utc) {
    await view('Site')
    const sunset = Date.parse(status.next_sunset_utc)
    for (const [label, dh] of [['before', -6], ['at', 0], ['after', 6]]) {
      const t = new Date(sunset + dh * 3.6e6).toISOString()
      await page.evaluate((tt) => window.__tour.app.getState().setTime(tt), t)
      await sleep(1500)
      await terrainSettled(`${id} sunset ${label}`)
      await shot(`${id}_sunset_${label}`)
    }
    await page.evaluate((tt) => window.__tour.app.getState().setTime(tt), now)
  }
  if (CHECK_HORIZON) report.horizon[id] = await checkHorizon(id)
  report.sites[id] = { seconds: Math.round((Date.now() - t0) / 1000) }
  console.log(`   ${report.sites[id].seconds} s, ${failures.length} failed requests so far`)
}

/**
 * The skyline of the 3D terrain (as drawn, from the lander's eye) against the engine's horizon mask, all
 * around: the eye-level camera is turned to each 45 deg sector so its terrain loads, then the sector is
 * measured every 2 deg (window.__horizon from HorizonProbe.tsx, mounted with ?perf).
 */
async function checkHorizon(id) {
  const hz = await api(`/api/sites/${id}/horizon`)
  const engineAt = (az) => {
    let best = 0
    for (let i = 1; i < hz.azimuth_deg.length; i++)
      if (Math.abs(hz.azimuth_deg[i] - az) < Math.abs(hz.azimuth_deg[best] - az)) best = i
    return hz.elevation_deg[best]
  }
  await view('Sun')
  const diffs = []
  for (let sector = 0; sector < 360; sector += 45) {
    await page.evaluate((az) => {
      const { camera, nav } = window.__nav
      const r = (az * Math.PI) / 180
      nav.target.set(camera.position.x + Math.sin(r) * 5000, camera.position.y, camera.position.z - Math.cos(r) * 5000)
      nav.update()
      window.__nav.invalidate() // the app draws on demand: ask for a frame so the new view loads its terrain
    }, sector)
    await sleep(800)
    await terrainSettled(`${id} horizon sector ${sector}`)
    const azs = []
    for (let a = sector - 20; a <= sector + 20; a += 2) azs.push((a + 360) % 360)
    const ours = await page.evaluate((list) => list.map((a) => window.__horizon.at(a)), azs)
    azs.forEach((a, i) => {
      const engine = engineAt(a)
      if (ours[i] !== null && engine !== null && engine !== undefined) diffs.push({ az: a, d: ours[i] - engine })
    })
  }
  const abs = diffs.map((x) => Math.abs(x.d)).sort((a, b) => a - b)
  const q = (p) => abs[Math.min(abs.length - 1, Math.floor(p * abs.length))]
  const worst = diffs.reduce((w, x) => (Math.abs(x.d) > Math.abs(w.d) ? x : w), { az: 0, d: 0 })
  const out = {
    samples: abs.length,
    median_deg: +q(0.5).toFixed(3),
    p95_deg: +q(0.95).toFixed(3),
    max_deg: +abs[abs.length - 1].toFixed(3),
    within_0_25_deg: +(abs.filter((x) => x <= 0.25).length / abs.length).toFixed(3),
    worst: { azimuth_deg: worst.az, diff_deg: +worst.d.toFixed(2) }, // + = 3D skyline higher than the engine's
  }
  console.log(`   horizon 3D vs engine: median ${out.median_deg} deg, 95% within ${out.p95_deg} deg, max ${out.max_deg} deg`)
  return out
}

report.requests = requests
report.failures = failures
report.page_errors = errors // every uncaught error: none is "known" and harmless
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
console.log(`\n${requests} backend requests, ${failures.length} failed${failures.length ? ':' : ''}`)
for (const f of failures.slice(0, 30)) console.log('  ' + f)
console.log(`${errors.length} page error${errors.length === 1 ? '' : 's'}${errors.length ? ':' : ''}`)
for (const e of [...new Set(errors)].slice(0, 10)) console.log('  ' + e)
console.log(`report and screenshots: ${OUT}/`)
await browser.close()
let ok = true
if (errors.length) {
  console.log('\nFAILED: the app threw errors during the tour (above).')
  ok = false
}
if (VERIFY && failures.length) {
  console.log('\nNOT ready for an offline demo: the requests above needed data that is not in the cache.')
  ok = false
}
if (!ok) process.exit(1)
if (VERIFY) console.log('\nReady: the whole tour ran from the caches, with no downloads and no page errors.')
