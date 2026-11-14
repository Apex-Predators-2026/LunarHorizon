// Draws one frame of the landing page's scroll film on a 2D canvas. `t` runs 0..1 over the whole film and the
// beats in content.ts split it up: the Moon from orbit, the south-pole sites, LOLA terrain, the horizon, the
// Sun, Earth, the verdict, the launch delay, the rescue and the landing. The terrain is an illustration (a
// procedural polar ridge with craters); the colours keep the app's meanings: Sun yellow, Earth blue, pass
// green, fail red, and coral for the rescued plan.
import { BEATS } from './content'

const C = {
  space: '#050607',
  sun: [232, 184, 74] as const,
  earth: [90, 169, 240] as const,
  ok: [63, 185, 80] as const,
  crit: [240, 96, 90] as const,
  coral: [255, 99, 74] as const,
  ink: [245, 245, 247] as const,
}
const rgba = (c: readonly number[], a: number) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * clamp01(t)
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

const BY_ID = Object.fromEntries(BEATS.map((b) => [b.id, b]))
/** Progress 0..1 inside a beat (0 before it, 1 after it). */
export function beatT(t: number, id: string) {
  const b = BY_ID[id]
  return b ? clamp01((t - b.start) / (b.end - b.start)) : 0
}
/** Scroll position (share of the film) a link to this beat lands on. */
export function beatJumpT(i: number) {
  const b = BEATS[i]
  return i === 0 ? 0 : b.start + (b.end - b.start) * 0.35
}

/** Index of the beat that contains t. */
export function beatAt(t: number) {
  const i = BEATS.findIndex((b, k) => t >= b.start && (t < b.end || k === BEATS.length - 1))
  return Math.max(0, i)
}

// Deterministic polar ridge with craters, flattened around the two candidate sites.
const CRATERS: [number, number, number, number][] = [
  [-0.36, -0.18, 0.28, 0.34], [0.42, 0.22, 0.25, 0.28], [-0.12, 0.38, 0.2, 0.24], [0.26, -0.34, 0.17, 0.2],
  [-0.52, 0.28, 0.16, 0.18], [-1.05, -0.5, 0.34, 0.3], [0.95, -0.62, 0.3, 0.26], [1.15, 0.45, 0.26, 0.22],
  [-0.95, 0.6, 0.22, 0.2], [0.62, 0.78, 0.18, 0.16], [-0.2, -0.82, 0.24, 0.22],
]
function elevation(nx: number, nz: number) {
  let h = Math.sin(nx * 2.6 + 0.4) * 0.14 + Math.cos(nz * 2.2 - 0.3) * 0.12 + Math.sin((nx + nz) * 4.5) * 0.035
  for (const [cx, cz, r, depth] of CRATERS) {
    const d = Math.hypot(nx - cx, nz - cz)
    if (d < r * 1.45) {
      const k = d / r
      h += k < 1 ? -depth * (1 - k * k) * 0.85 : depth * 0.24 * Math.sin((1 - (k - 1) / 0.45) * Math.PI)
    }
  }
  const pd = Math.hypot(nx - 0.14, nz - 0.02)
  if (pd < 0.24) {
    const b = Math.max(0, 1 - pd / 0.24) * 0.78
    h = h * (1 - b) + 0.08 * b
  }
  return h
}

const STARS = Array.from({ length: 130 }, (_, i) => {
  const f = (k: number) => {
    const s = Math.sin(i * k) * 43758.5453
    return s - Math.floor(s)
  }
  return { x: f(12.9898), y: f(78.233), r: 0.4 + f(39.346) * 1.1, a: 0.18 + f(39.346) * 0.5 }
})

let labelMaxX = 1e9 // right edge labels must stay left of (set per frame)

const PLANNED = { nx: 0.02, nz: 0.06 }
const RESCUE = { nx: 0.24, nz: -0.05 }
const CRATER = { nx: -0.36, nz: -0.18 }

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, alpha: number) {
  if (alpha <= 0.01) return
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.font = '500 13px Inter, ui-sans-serif, system-ui, sans-serif'
  const w = ctx.measureText(text).width
  x = Math.max(12, Math.min(x, labelMaxX - w - 34))
  ctx.fillStyle = 'rgba(12, 13, 15, 0.74)'
  ctx.beginPath()
  ctx.roundRect(x - 4, y - 12, w + 24, 24, 12)
  ctx.fill()
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(x + 7, y, 3.5, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = 'rgba(245, 245, 247, 0.94)'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x + 15, y + 0.5)
  ctx.restore()
}

/** The Moon seen from orbit, with the south pole and its candidate sites. */
function drawGlobe(ctx: CanvasRenderingContext2D, width: number, height: number, t: number, narrow: boolean) {
  const fade = 1 - smooth(0.13, 0.24, t)
  if (fade <= 0.01) return
  // Dive: the globe grows around the south pole, which stays where the terrain's centre will appear.
  const k = smooth(0.15, 0.24, t)
  const r = Math.min(width, height) * (narrow ? 0.34 : 0.3) * Math.pow(9, k)
  const cx = width * (narrow ? 0.5 : lerp(0.62, 0.6, k))
  const cy = height * (narrow ? 0.6 : 0.62) - r * 0.86
  ctx.save()
  ctx.globalAlpha = fade
  // Sunlight comes from low on the right, as it does at the pole.
  const g = ctx.createRadialGradient(cx + r * 0.45, cy - r * 0.15, r * 0.05, cx, cy, r)
  g.addColorStop(0, '#9a9a96')
  g.addColorStop(0.45, '#4a4b4d')
  g.addColorStop(0.85, '#151618')
  g.addColorStop(1, '#0b0c0d')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()
  // Maria and craters as soft darker patches (fixed pattern).
  ctx.fillStyle = 'rgba(10, 11, 12, 0.22)'
  for (const [dx, dy, s] of [[-0.3, -0.35, 0.22], [0.1, -0.5, 0.14], [-0.45, 0.05, 0.16], [0.28, 0.12, 0.12], [-0.05, 0.3, 0.1]]) {
    ctx.beginPath()
    ctx.ellipse(cx + dx * r, cy + dy * r, s * r, s * r * 0.75, 0.3, 0, Math.PI * 2)
    ctx.fill()
  }
  // Limb highlight.
  ctx.strokeStyle = 'rgba(245, 245, 247, 0.22)'
  ctx.lineWidth = 1.2
  ctx.beginPath()
  ctx.arc(cx, cy, r, -0.9, 1.1)
  ctx.stroke()
  // Orbit.
  ctx.strokeStyle = 'rgba(245, 245, 247, 0.18)'
  ctx.setLineDash([3, 6])
  ctx.beginPath()
  ctx.ellipse(cx, cy, r * 1.3, r * 0.38, -0.25, 0, Math.PI * 2)
  ctx.stroke()
  ctx.setLineDash([])
  // South pole and the eight candidate sites around it (beat "sites").
  const s = beatT(t, 'sites')
  const px = cx
  const py = cy + r * 0.86
  const ring = lerp(18, 10, s)
  ctx.strokeStyle = rgba(C.coral, 0.4 + 0.6 * s)
  ctx.lineWidth = 1.4
  ctx.beginPath()
  ctx.ellipse(px, py, ring * 2.2, ring * 0.8, 0, 0, Math.PI * 2)
  ctx.stroke()
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.4
    const on = smooth(i / 8 - 0.05, i / 8 + 0.1, s * 1.2)
    ctx.fillStyle = rgba(C.ink, on)
    ctx.beginPath()
    ctx.arc(px + Math.cos(a) * ring * 1.6, py + Math.sin(a) * ring * 0.55, 2.2, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
  label(ctx, 'South pole · 8 Artemis III candidates', px + ring * 2.6, py, rgba(C.coral, 1), fade * smooth(0.1, 0.5, s))
}

/** `rightInset`: pixels on the right covered by the side rail; the scene centres in the rest. */
export function renderStory(ctx: CanvasRenderingContext2D, width: number, height: number, t: number, rightInset = 0) {
  const p = clamp01(t)
  const vw = width - rightInset
  labelMaxX = vw
  const narrow = vw < 700
  const terrainB = beatT(p, 'terrain')
  const hor = beatT(p, 'horizon')
  const sun = beatT(p, 'sun')
  const earth = beatT(p, 'earth')
  const ver = beatT(p, 'verdict')
  const delay = beatT(p, 'delay')
  const res = beatT(p, 'rescue')
  const land = beatT(p, 'landed')

  ctx.fillStyle = C.space
  ctx.fillRect(0, 0, width, height)
  const starA = lerp(1, 0.35, smooth(0.6, 0.95, p))
  for (const s of STARS) {
    ctx.fillStyle = rgba(C.ink, s.a * starA)
    ctx.beginPath()
    ctx.arc(((s.x + p * 0.05) % 1) * width, s.y * height * 0.7, s.r, 0, Math.PI * 2)
    ctx.fill()
  }

  drawGlobe(ctx, vw, height, p, narrow)

  const terrainA = smooth(0.14, 0.24, p)
  if (terrainA <= 0.01) return

  ctx.save()
  ctx.globalAlpha = terrainA
  // Camera: comes down out of orbit, then slowly turns over the sites.
  const zoom = lerp(0.8, 1.12, smooth(0.16, 0.98, p)) * (narrow ? 0.82 : 1)
  const tilt = lerp(0.48, 0.72, smooth(0.16, 0.7, p))
  const yaw = lerp(-0.4, 0.16, smooth(0.16, 0.98, p))
  const ox = vw * (narrow ? 0.5 : 0.6)
  const oy = height * lerp(0.6, 0.62, smooth(0.2, 1, p))
  const scale = Math.max(width * 0.34, height * 0.6) * zoom
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  const project = (nx: number, e: number, nz: number): [number, number] => {
    const rx = nx * cy - nz * sy
    const rz = nx * sy + nz * cy
    const persp = 2.2 / Math.max(0.6, rz + 2.35)
    return [ox + rx * scale * persp, oy + (rz * tilt * 0.72 - e * 0.62) * scale * persp]
  }

  // The Sun circles low through the film; Earth sinks behind the terrain during the delay and is back for
  // the rescued date.
  const sunAz = lerp(-2.5, -0.5, smooth(0.16, 0.98, p))
  const sunEl = lerp(0.42, 0.2, smooth(0.2, 0.6, p))
  const sdx = Math.cos(sunAz)
  const sdz = Math.sin(sunAz)
  const earthDown = smooth(0.02, 0.28, delay) * (1 - smooth(0.25, 0.6, res))

  const cols = narrow ? 40 : 72
  const rows = narrow ? 30 : 52
  const XR = 1.5
  const ZR = 1.15
  const grid: { x: number; y: number; e: number; nx: number; nz: number }[][] = []
  for (let r = 0; r <= rows; r++) {
    const row = []
    const nz = (r / rows) * 2 * ZR - ZR
    for (let c = 0; c <= cols; c++) {
      const nx = (c / cols) * 2 * XR - XR
      const e = elevation(nx, nz)
      const [x, y] = project(nx, e, nz)
      row.push({ x, y, e, nx, nz })
    }
    grid.push(row)
  }

  // Shaded ground with fog toward the far horizon and soft sides. The "terrain" beat builds it from the front.
  const build = p >= BY_ID.terrain.end ? 1 : smooth(0, 0.85, terrainB)
  const buildZ = lerp(ZR + 0.1, -ZR - 0.1, build)
  const light = lerp(0.45, 1, smooth(0.2, 0.45, p))
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = grid[r][c]
      if (a.nz < buildZ) continue
      const b = grid[r][c + 1]
      const d = grid[r + 1][c + 1]
      const e = grid[r + 1][c]
      const dot = -(b.e - a.e) * 12 * sdx - (e.e - a.e) * 12 * sdz + sunEl
      const lit = clamp01(0.14 + dot * 0.8 * light)
      const g = lerp(14, 150, lit)
      const warm = lit * 12 * light
      const far = smooth(-0.35, -ZR, a.nz)
      const side = smooth(XR * 0.72, XR, Math.abs(a.nx))
      ctx.globalAlpha = terrainA * (1 - Math.max(far * 0.92, side))
      ctx.fillStyle = `rgb(${Math.round(g + warm)}, ${Math.round(g + warm * 0.55)}, ${Math.round(g)})`
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.lineTo(d.x, d.y)
      ctx.lineTo(e.x, e.y)
      ctx.closePath()
      ctx.fill()
    }
  }
  ctx.globalAlpha = terrainA

  // Contour lines; the build front glows like an altimeter sweep.
  for (let r = 0; r <= rows; r += 2) {
    const nz = grid[r][0].nz
    if (nz < buildZ) continue
    const front = build < 1 ? Math.max(0, 1 - Math.abs(nz - buildZ) / 0.14) : 0
    const fogK = 1 - smooth(-0.35, -ZR, nz) * 0.9
    ctx.strokeStyle = front > 0.2 ? rgba(C.ink, (0.3 + front * 0.6) * fogK) : rgba(C.ink, 0.06 * fogK)
    ctx.lineWidth = front > 0.4 ? 1.4 : 0.7
    ctx.beginPath()
    grid[r].forEach((pt, c) => (c ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)))
    ctx.stroke()
  }
  if (build < 1 && build > 0.02) {
    label(ctx, 'LOLA elevation, 5 m near the site', vw * (narrow ? 0.08 : 0.5), project(0, 0, buildZ)[1] - 30, rgba(C.ink, 1),
      smooth(0.05, 0.25, terrainB) * (1 - smooth(0.8, 1, terrainB)))
  }

  const [px, py] = project(PLANNED.nx, elevation(PLANNED.nx, PLANNED.nz), PLANNED.nz)
  const [rx, ry] = project(RESCUE.nx, elevation(RESCUE.nx, RESCUE.nz), RESCUE.nz)
  const [kx, ky] = project(CRATER.nx, elevation(CRATER.nx, CRATER.nz), CRATER.nz)

  // Sky: the Sun skims the far horizon on the right; Earth sits low further left.
  const horizonY = project(0, elevation(0, -ZR * 0.62), -ZR * 0.62)[1]
  const sunX = vw * (narrow ? lerp(0.8, 0.62, smooth(0.2, 1, p)) : lerp(0.88, 0.7, smooth(0.2, 1, p)))
  const sunY = horizonY - (sunEl * 0.5 + 0.03) * height * 0.32
  const ex = vw * (narrow ? 0.3 : 0.48)
  const ey = horizonY - height * lerp(0.04, -0.03, earthDown)
  ctx.save()
  ctx.strokeStyle = rgba(C.sun, 0.25 + 0.35 * smooth(0, 0.3, sun) * (1 - smooth(0.6, 1, earth)))
  ctx.setLineDash([2, 7])
  ctx.lineWidth = 1.2
  ctx.beginPath()
  ctx.ellipse(vw * 0.64, sunY + height * 0.05, vw * 0.42, height * 0.07, 0, Math.PI * 1.02, Math.PI * 1.98)
  ctx.stroke()
  ctx.setLineDash([])
  const glow = 70 + 30 * smooth(0, 0.4, sun) * (1 - smooth(0.6, 1, sun))
  const corona = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, glow)
  corona.addColorStop(0, rgba(C.sun, 0.5))
  corona.addColorStop(0.35, rgba(C.sun, 0.12))
  corona.addColorStop(1, rgba(C.sun, 0))
  ctx.fillStyle = corona
  ctx.beginPath()
  ctx.arc(sunX, sunY, glow, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = 'rgb(255, 238, 200)'
  ctx.beginPath()
  ctx.arc(sunX, sunY, 7, 0, Math.PI * 2)
  ctx.fill()
  // Earth, half lit; it slips behind the terrain line during the delay.
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, width, horizonY + 2)
  ctx.clip()
  ctx.fillStyle = rgba(C.earth, 0.95)
  ctx.beginPath()
  ctx.arc(ex, ey, 9, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = 'rgba(5, 6, 7, 0.55)'
  ctx.beginPath()
  ctx.arc(ex + 3, ey, 9, -Math.PI / 2, Math.PI / 2)
  ctx.fill()
  ctx.restore()
  ctx.restore()
  label(ctx, 'Sun · a degree above the horizon', sunX - 230, sunY - 34, rgba(C.sun, 1), smooth(0.1, 0.3, sun) * (1 - smooth(0.85, 1, sun)))

  // Horizon rays from the planned site.
  const rayA = smooth(0.1, 0.4, hor) * (1 - smooth(0.7, 1, hor) * 0.85)
  if (rayA > 0.01) {
    const n = 72
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + hor * Math.PI * 1.2
      const reach = 0.42 + 0.14 * Math.sin(i * 1.7) + 0.08 * Math.cos(i * 0.6)
      const ex2 = PLANNED.nx + Math.cos(a) * reach
      const ez2 = PLANNED.nz + Math.sin(a) * reach * 0.8
      const [tx, ty] = project(ex2, elevation(ex2, ez2) + 0.02, ez2)
      const sweep = ((i / n) * Math.PI * 2 - ((hor * Math.PI * 2.5) % (Math.PI * 2)) + Math.PI * 4) % (Math.PI * 2)
      const hot = Math.max(0, 1 - sweep / 1.2)
      ctx.strokeStyle = rgba(C.ink, (0.08 + hot * 0.45) * rayA)
      ctx.lineWidth = hot > 0.6 ? 1.2 : 0.7
      ctx.beginPath()
      ctx.moveTo(px, py)
      ctx.lineTo(tx, ty)
      ctx.stroke()
      ctx.fillStyle = rgba(C.ink, (0.25 + hot * 0.6) * rayA)
      ctx.beginPath()
      ctx.arc(tx, ty, hot > 0.6 ? 2 : 1.2, 0, Math.PI * 2)
      ctx.fill()
    }
    label(ctx, 'Horizon traced in 720 directions', px + 18, py - 52, rgba(C.ink, 1), smooth(0.25, 0.5, hor) * (1 - smooth(0.85, 1, hor)))
  }

  // Sunlight on the planned site (Sun beat) and the line to Earth (Earth beat onward).
  const sunRay = smooth(0.2, 0.5, sun) * (1 - smooth(0.4, 0.9, earth))
  if (sunRay > 0.01) {
    ctx.save()
    ctx.globalAlpha = sunRay
    ctx.strokeStyle = rgba(C.sun, 0.75)
    ctx.setLineDash([6, 5])
    ctx.beginPath()
    ctx.moveTo(sunX, sunY)
    ctx.lineTo(px, py)
    ctx.stroke()
    ctx.restore()
  }
  const los = smooth(0.15, 0.45, earth) * (1 - smooth(0.6, 1, res))
  if (los > 0.01) {
    const blocked = earthDown > 0.5
    ctx.save()
    ctx.globalAlpha = los
    ctx.strokeStyle = blocked ? rgba(C.crit, 0.85) : rgba(C.earth, 0.85)
    ctx.setLineDash(blocked ? [3, 5] : [6, 5])
    ctx.lineWidth = 1.3
    ctx.beginPath()
    ctx.moveTo(px, py)
    ctx.lineTo(ex, ey)
    ctx.stroke()
    ctx.restore()
    label(
      ctx,
      blocked ? 'Earth behind the terrain · blackout too long' : 'Earth in view · direct-to-Earth link',
      ex + 16,
      ey - 30,
      blocked ? rgba(C.crit, 1) : rgba(C.earth, 1),
      los * (blocked ? smooth(0.2, 0.32, delay) * (1 - smooth(0.1, 0.3, res)) : smooth(0.3, 0.5, earth) * (1 - smooth(0.85, 1, earth))),
    )
  }

  // Site rings: verdicts, the failure after the delay, and the rescue.
  const ring = (x: number, y: number, color: readonly number[], a: number, dashed = false) => {
    if (a <= 0.01) return
    ctx.save()
    ctx.globalAlpha = a
    ctx.strokeStyle = rgba(color, 1)
    ctx.lineWidth = 1.6
    ctx.setLineDash(dashed ? [3, 4] : [])
    ctx.beginPath()
    ctx.ellipse(x, y, 22 * zoom, 12 * zoom, 0, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }
  const verA = smooth(0.05, 0.35, ver)
  const fails = smooth(0.18, 0.32, delay)
  const rescued = smooth(0.18, 0.38, res)
  if (verA > 0.01) {
    const col = fails > 0.5 ? C.crit : C.ok
    ring(px, py, col, verA * (1 - rescued * 0.5), fails > 0.5)
    ring(kx, ky, C.crit, verA * (1 - smooth(0, 0.4, delay)), true)
    label(ctx, fails > 0.5 ? 'Plan after delay · fails' : 'Planned site · passes', px - 60, py + 34, rgba(col, 1), verA * (1 - rescued))
    label(ctx, 'Crater floor · fails: no sunlight', kx - 60, ky + 30, rgba(C.crit, 1), verA * (1 - smooth(0, 0.4, delay)))
  }
  const scanA = smooth(0, 0.12, res) * (1 - smooth(0.3, 0.55, res))
  if (scanA > 0.01) {
    for (let i = 0; i < 16; i++) {
      const a = i * 2.39996
      const d = 0.08 + (i / 16) * 0.34
      const nx = PLANNED.nx + Math.cos(a) * d
      const nz = PLANNED.nz + Math.sin(a) * d * 0.8
      const [cx2, cy2] = project(nx, elevation(nx, nz), nz)
      const on = smooth(i / 16 - 0.1, i / 16 + 0.05, smooth(0, 0.25, res))
      ctx.fillStyle = rgba(C.ink, 0.6 * scanA * on)
      ctx.beginPath()
      ctx.arc(cx2, cy2, 2.5, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  if (rescued > 0.01) {
    ring(rx, ry, C.coral, rescued)
    ctx.save()
    ctx.globalAlpha = rescued
    ctx.strokeStyle = rgba(C.coral, 1)
    ctx.lineWidth = 1.6
    ctx.beginPath()
    ctx.moveTo(rx - 30 * zoom, ry)
    ctx.lineTo(rx - 21 * zoom, ry)
    ctx.moveTo(rx + 21 * zoom, ry)
    ctx.lineTo(rx + 30 * zoom, ry)
    ctx.stroke()
    ctx.restore()
    label(ctx, 'Rescue · lit ridge nearby, Earth in view · passes', rx + 24, ry - 28, rgba(C.coral, 1), rescued * (1 - smooth(0.6, 1, land) * 0.6))
  }

  // Descent to the rescued site, touching down in the last beat.
  const descent = smooth(0.7, 1, res) * 0.6 + smooth(0, 0.85, land) * 0.4
  if (descent > 0.01) {
    const sx = vw * (narrow ? 0.2 : 0.36)
    const sy2 = height * 0.12
    const mx = lerp(sx, rx, 0.62)
    const my = lerp(sy2, ry, 0.5) - 40
    const pts: [number, number][] = []
    for (let i = 0; i <= 60; i++) {
      const k = i / 60
      const u = 1 - k
      pts.push([u * u * sx + 2 * u * k * mx + k * k * rx, u * u * sy2 + 2 * u * k * my + k * k * ry])
    }
    const n = Math.max(1, Math.min(60, Math.floor(descent * 60)))
    ctx.save()
    ctx.strokeStyle = rgba(C.ink, 0.22)
    ctx.setLineDash([4, 5])
    ctx.lineWidth = 1
    ctx.beginPath()
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
    ctx.stroke()
    ctx.setLineDash([])
    ctx.strokeStyle = rgba(C.coral, 1)
    ctx.lineWidth = 2
    ctx.beginPath()
    for (let i = 0; i <= n; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, pts[i][0], pts[i][1])
    ctx.stroke()
    const [lx, ly] = pts[n]
    if (descent < 0.97) {
      const len = lerp(30, 12, descent)
      const plume = ctx.createLinearGradient(lx, ly, lx, ly + len)
      plume.addColorStop(0, 'rgba(255, 236, 214, 0.75)')
      plume.addColorStop(1, 'rgba(255, 236, 214, 0)')
      ctx.fillStyle = plume
      ctx.beginPath()
      ctx.moveTo(lx - 4, ly + 6)
      ctx.lineTo(lx + 4, ly + 6)
      ctx.lineTo(lx + 10, ly + len)
      ctx.lineTo(lx - 10, ly + len)
      ctx.closePath()
      ctx.fill()
    }
    ctx.strokeStyle = rgba(C.ink, 1)
    ctx.fillStyle = '#1b1d20'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(lx - 5, ly + 3)
    ctx.lineTo(lx - 10, ly + 9)
    ctx.moveTo(lx + 5, ly + 3)
    ctx.lineTo(lx + 10, ly + 9)
    ctx.stroke()
    ctx.beginPath()
    ctx.rect(lx - 6, ly - 5, 12, 8)
    ctx.fill()
    ctx.stroke()
    if (descent > 0.93) {
      const k = (descent - 0.93) / 0.07
      ctx.strokeStyle = rgba(C.coral, 1 - k * 0.7)
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.ellipse(rx, ry, (22 + k * 30) * zoom, (12 + k * 16) * zoom, 0, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.restore()
    label(ctx, 'Touchdown', rx + 24, ry + 30, rgba(C.coral, 1), smooth(0.85, 1, land))
  }
  ctx.restore()
}
