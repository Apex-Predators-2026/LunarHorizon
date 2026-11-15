import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, type Ref, type RefObject } from 'react'
import * as THREE from 'three'
import type { TimelineStep } from '../types'
import { MOON_RADIUS_M, type SiteFrame, type Vec3 } from './globe/cubeSphere'
import { groundHeightAt, MAX_RELIEF_M, type TileHeights } from './globe/terrainHeight'

/**
 * A planted flag and a "your rover" tag marking the rover.
 *
 * The flag is the six-frame waving sprite sheet (the exact artwork: cloth #FE1E57, pole #9E4739), played by a
 * CSS steps() animation. It is a DOM element, so it and its tag sit above every other label. Each frame we
 * project the pole's foot to the screen, so it stays on the surface point while the view orbits.
 *  - Size follows the camera: real size up close, never smaller than a readable minimum.
 *  - Lighting: it dims without sunlight and warms near the horizon; a soft shadow on the ground (a real 3D
 *    mesh) points away from the Sun, longer when the Sun is low.
 *  - Hidden: when terrain (or the Moon) is between the camera and the flag, the flag becomes a dotted
 *    outline and the tag turns white.
 */

// ---- The sprite sheet (as supplied): 224 x 167, a 3 x 2 grid of frames -------------------------------------
const SHEET_SVG = `<svg width="224" height="167" viewBox="0 0 224 167" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M159.5 4.09628C159.5 4.09628 167.39 5.65707 172.5 5.59628C180.696 5.49879 184.806 0.882636 193 1.09628C205.764 1.42911 223 14.0963 223 14.0963C223 14.0963 211.391 21.4974 203 22.0963C197.298 22.5032 194.201 19.6759 188.5 20.0963C179.345 20.7713 176.129 28.6386 167 29.5963C163.893 29.9222 159 29.5963 159 29.5963V4.09628H159.5Z" fill="#FE1E57" stroke="#FE1E57"/>
<path d="M4.5 27.0963C4.5 27.0963 12.9374 23.1357 19 23.1223C26.1637 23.1064 29.3696 29.3131 36.5 28.6223C44.8027 27.8179 54.5 17.1223 54.5 17.1223L66 3.62226C66 3.62226 53.387 10.8096 44.5 11.1223C34.0094 11.4913 29.4862 3.0989 19 2.62226C13.3131 2.36376 4.5 4.12226 4.5 4.12226V27.0963Z" fill="#FE1E57" stroke="#FE1E57"/>
<path d="M159.5 102.603C159.5 102.603 167.39 104.164 172.5 104.103C180.696 104.006 184.806 99.3897 193 99.6034C205.764 99.9362 223 112.603 223 112.603C223 112.603 211.391 120.005 203 120.603C197.298 121.01 194.201 118.183 188.5 118.603C179.345 119.278 176.129 127.146 167 128.103C163.893 128.429 159 128.103 159 128.103V102.603H159.5Z" fill="#FE1E57" stroke="#FE1E57"/>
<path d="M4.5 125.603C4.5 125.603 10.9374 129.11 17 129.096C24.1637 129.08 34.3696 117.787 41.5 117.096C48.6304 116.405 68.5 118.096 68.5 118.096C68.5 118.096 47.387 100.817 38.5 101.129C28.0094 101.498 28.9862 106.073 18.5 105.596C12.8131 105.338 4.5 102.629 4.5 102.629V125.603Z" fill="#FE1E57" stroke="#FE1E57"/>
<path d="M80 4.09634C80 4.09634 93.6424 -0.190633 102.5 0.596338C112.722 1.50451 117.032 12.5349 127 10.0963C132.63 8.7191 139.5 2.09634 139.5 2.09634C139.5 2.09634 130.826 21.5392 119.5 24.0963C111.544 25.8927 107.112 19.2423 99 20.0963C90.9934 20.9393 80 28.0963 80 28.0963V4.09634Z" fill="#FE1E57" stroke="#FE1E57"/>
<path d="M80 103.193C80 103.193 87.1424 101.809 96 102.596C101.014 103.042 105.513 108.526 111.5 109.096C117.717 109.689 125.422 105.339 130.5 104.096C136.13 102.719 150 119.596 150 119.596C150 119.596 138.326 114.539 127 117.096C119.044 118.893 111.112 129.242 103 130.096C94.9934 130.939 80 127.193 80 127.193V103.193Z" fill="#FE1E57" stroke="#FE1E57"/>
<rect y="3.59631" width="4" height="64" fill="#9E4739"/>
<rect x="76" y="3.59631" width="4" height="64" fill="#9E4739"/>
<rect x="155" y="3.59631" width="4" height="64" fill="#9E4739"/>
<rect y="102.103" width="4" height="64" fill="#9E4739"/>
<rect x="76" y="102.693" width="4" height="63" fill="#9E4739"/>
<rect x="156" y="102.596" width="4" height="64" fill="#9E4739"/>
</svg>`

// The same shapes as a dotted white outline: what shows when something hides the flag.
const OUTLINE_SVG = SHEET_SVG.replace(/fill="#FE1E57" stroke="#FE1E57"/g, 'fill="none" stroke="#ffffff" stroke-width="1.4" stroke-dasharray="1.5 3" stroke-linecap="round"').replace(
  /fill="#9E4739"/g,
  'fill="none" stroke="#ffffff" stroke-width="1.4" stroke-dasharray="1.5 3" stroke-linecap="round"',
)

const toUrl = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`

// One frame cell: 75 x 69 design px. The pole's foot is at (2, 67.6) inside it.
const FRAME_W = 75
const FRAME_H = 69
const FOOT_X = 2
const FOOT_Y = 67.6
const POLE_DESIGN_PX = 64
const POLE_METRES = 3.2
const DESIGN_PX_PER_M = POLE_DESIGN_PX / POLE_METRES // 20
const MIN_SCREEN_PX = 56 // smallest on-screen frame height
const MAX_SCALE = 6
const FLAG_OFFSET: [number, number, number] = [2.4, 0, 0.6] // beside the rover, not inside it

const CSS = `
.rover-flag { position: absolute; left: 0; top: 0; z-index: 1; display: none; pointer-events: none; will-change: transform; }
.rover-flag-sprite {
  position: absolute; left: -${FOOT_X}px; top: -${FOOT_Y}px; width: ${FRAME_W}px; height: ${FRAME_H}px;
  transform-origin: ${FOOT_X}px ${FOOT_Y}px;
  background-image: ${toUrl(SHEET_SVG)}; background-size: 224px 167px; background-repeat: no-repeat;
  filter: brightness(var(--b, 1)) saturate(var(--sat, 1));
  animation: rover-flag-wave 0.9s steps(1, end) infinite;
}
.rover-flag-ghost { background-image: ${toUrl(OUTLINE_SVG)}; filter: none; display: none; }
@keyframes rover-flag-wave {
  0%      { background-position: 0 0; }
  16.667% { background-position: -76px 0; }
  33.333% { background-position: -155px 0; }
  50%     { background-position: 0 -98.5px; }
  66.667% { background-position: -76px -98.5px; }
  83.333% { background-position: -156px -98.5px; }
}
@media (prefers-reduced-motion: reduce) { .rover-flag-sprite { animation: none; } }
.rover-flag-text {
  position: absolute; left: 0; top: 0; white-space: nowrap;
  font-family: 'Fredoka', 'Inter', sans-serif; font-size: 16px; line-height: 1; letter-spacing: 0.04em; text-transform: uppercase;
  color: #FEB08C; text-shadow: 0 1px 3px rgba(0,0,0,0.85);
}
.rover-flag-text-ghost { display: none; color: transparent; text-shadow: none; -webkit-text-stroke: 1px #ffffff; }
`

/** The flag and tag as DOM (above every other label). Positioned each frame by <RoverFlag>. */
export function RoverFlagTag({ ref }: { ref: Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} className="rover-flag" role="img" aria-label="Your rover">
      <style>{CSS}</style>
      <div className="rover-flag-sprite" />
      {/* Dotted outline of the same frame; shown only over the parts of the flag that something hides. */}
      <div className="rover-flag-sprite rover-flag-ghost" />
      <div className="rover-flag-text">YOUR ROVER</div>
      {/* Outlined copy of the tag: shown only over the part of it that the ground hides. */}
      <div className="rover-flag-text rover-flag-text-ghost" aria-hidden>YOUR ROVER</div>
    </div>
  )
}

const _p = new THREE.Vector3()
const FOOT_ARR: Vec3 = [FLAG_OFFSET[0], FLAG_OFFSET[1], FLAG_OFFSET[2]]
const MAX_STEPS = 32
const A_MOON: Vec3 = [0, 0, 0]
const _q = new THREE.Vector3()
const _right = new THREE.Vector3()
const _up = new THREE.Vector3()
const _fwd = new THREE.Vector3()

/**
 * Is the straight line from the camera `cam` to the point `pt` (both in the site frame) blocked by the ground?
 * Marches along the line comparing its height with the loaded terrain (the same height lookup the camera uses
 * to stay above ground), so no triangles are tested: a handful of lookups instead of ray casting the mesh.
 */
function lineBlocked(frame: SiteFrame, tiles: TileHeights, cam: THREE.Vector3, pt: Vec3): boolean {
  const a = frame.toMoon([cam.x, cam.y, cam.z])
  const b = frame.toMoon(pt)
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const dz = b[2] - a[2]
  const dist = Math.hypot(dx, dy, dz)
  const steps = Math.max(8, Math.min(MAX_STEPS, Math.ceil(dist / 18)))
  for (let i = 1; i < steps; i++) {
    const t = i / steps
    if ((1 - t) * dist < 3) break // right at the target: nothing in the way
    A_MOON[0] = a[0] + dx * t
    A_MOON[1] = a[1] + dy * t
    A_MOON[2] = a[2] + dz * t
    const r = Math.hypot(A_MOON[0], A_MOON[1], A_MOON[2])
    if (r > MOON_RADIUS_M + MAX_RELIEF_M) continue // above every peak: no terrain to test
    const h = groundHeightAt(A_MOON, tiles) ?? 0
    if (r < MOON_RADIUS_M + h - 0.25) return true
  }
  return false
}

const COLS = 9 // columns where the ground's edge is found exactly; it is interpolated between them
const SEGS = 36 // vertices of the cut edge
const f1 = (n: number) => n.toFixed(1)

/** Inside the <Canvas>: projects the flag to the screen, finds how much of it the ground hides, lights it, lays its shadow. */
export function RoverFlag({
  flagRef,
  status,
  frame,
  tileHeightsRef,
}: {
  flagRef: RefObject<HTMLDivElement | null>
  status: TimelineStep | null
  frame: SiteFrame | null
  tileHeightsRef: { current: TileHeights | null }
}) {
  const invalidate = useThree((s) => s.invalidate)
  const shadowMat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4 }),
    [],
  )
  const shadowRef = useMemo(() => ({ current: null as THREE.Mesh | null }), [])
  const last = useMemo(() => ({ x: NaN, y: NaN, k: NaN, tw: 92, th: 16, edge: '#', hidden: 'off' }), []) // hidden: 'off' until first shown

  const sunFrac = status?.sun.visible_fraction ?? (status && status.sun.elevation_deg > 0 ? 1 : 0)
  const sunEl = status?.sun.elevation_deg ?? 0
  const sunAz = status?.sun.azimuth_deg ?? 0

  // Lighting on the flag itself.
  useEffect(() => {
    const el = flagRef.current
    if (!el) return
    const lit = Math.max(0, Math.min(1, sunFrac))
    const warm = 1 - Math.max(0, Math.min(1, sunEl / 18))
    el.style.setProperty('--b', (0.34 + 0.66 * lit).toFixed(3))
    el.style.setProperty('--sat', (1 - 0.15 * (1 - lit) + 0.1 * warm * lit).toFixed(3))
    invalidate()
  }, [flagRef, sunFrac, sunEl, invalidate])

  useFrame(({ camera, size }) => {
    const el = flagRef.current
    if (!el) return
    _p.set(...FLAG_OFFSET)
    const d = Math.max(0.5, camera.position.distanceTo(_p))
    _p.project(camera)
    if (!(_p.z < 1 && Math.abs(_p.x) < 1.3 && Math.abs(_p.y) < 1.3)) {
      if (last.hidden !== 'off') {
        el.style.display = 'none' // behind the camera or far off screen
        last.hidden = 'off'
      }
      return
    }
    const x = Math.round(((_p.x * 0.5 + 0.5) * size.width) * 2) / 2
    const y = Math.round(((-_p.y * 0.5 + 0.5) * size.height) * 2) / 2
    // Scale: real size up close, never below a readable height on screen.
    const fov = ((camera as THREE.PerspectiveCamera).fov * Math.PI) / 180
    const pxPerMetre = size.height / (2 * d * Math.tan(fov / 2))
    const k = Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCREEN_PX / FRAME_H, pxPerMetre / DESIGN_PX_PER_M)) * 200) / 200
    const solid = el.children[1] as HTMLElement
    const ghost = el.children[2] as HTMLElement
    const text = el.children[3] as HTMLElement
    const textGhost = el.children[4] as HTMLElement
    if (last.hidden === 'off') {
      el.style.display = 'block'
      last.hidden = ''
    }
    if (x !== last.x || y !== last.y) {
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`
      last.x = x
      last.y = y
    }
    if (k !== last.k) {
      const sc = `scale(${k})`
      solid.style.transform = sc
      ghost.style.transform = sc
      const tt = `translate(-50%, calc(-100% - ${(k * (FRAME_H - 4) + 4).toFixed(1)}px))`
      text.style.transform = tt
      textGhost.style.transform = tt
      if (text.offsetWidth) {
        last.tw = text.offsetWidth
        last.th = text.offsetHeight
      }
      last.k = k
    }

    // Where does the ground hide the flag and its tag? For a few columns across them, find the exact height on the
    // flag's plane where the line of sight to the camera is first clear (bisection against the terrain height).
    // The edge between is interpolated, giving the true skyline of the terrain across the flag; everything
    // below it is drawn as a dotted outline, everything above as the solid flag, split along the same line.
    const tiles = tileHeightsRef.current
    const sM = k / pxPerMetre // metres per design pixel as drawn (the flag is enlarged when far away)
    const tw2 = last.tw / (2 * k) // half the tag's width in design pixels
    const uMin = Math.min(-FOOT_X - 4, FOOT_X - tw2 - 4)
    const uMax = Math.max(FRAME_W + 4, FOOT_X + tw2 + 4)
    const vTop = FOOT_Y - (FRAME_H - 4) - (last.th + 8) / k // the top of the tag
    const vBot = FRAME_H + 2 // just below the pole's foot
    let edge = 'none' // 'none' = all visible, 'all' = all hidden, otherwise the polygon of the visible part
    let ghostPoly = ''
    if (frame && tiles) {
      camera.matrixWorld.extractBasis(_right, _up, _fwd)
      const blockedAt = (u: number, v: number) => {
        _q.set(FOOT_ARR[0], FOOT_ARR[1], FOOT_ARR[2]).addScaledVector(_right, (u - FOOT_X) * sM).addScaledVector(_up, (FOOT_Y - v) * sM)
        return lineBlocked(frame, tiles, camera.position, [_q.x, _q.y, _q.z])
      }
      // Quick check on three columns: all clear / all hidden covers nearly every frame.
      const us = [uMin, (uMin + uMax) / 2, uMax]
      const tops = us.map((u) => blockedAt(u, vTop))
      const bots = us.map((u) => blockedAt(u, vBot))
      if (!tops.some(Boolean) && !bots.some(Boolean)) edge = 'none'
      else if (tops.every(Boolean) && bots.every(Boolean)) edge = 'all'
      else {
        const vs: number[] = []
        for (let c = 0; c <= COLS; c++) {
          const u = uMin + ((uMax - uMin) * c) / COLS
          if (blockedAt(u, vTop)) vs.push(vTop - 6) // hidden to the top
          else if (!blockedAt(u, vBot)) vs.push(vBot + 6) // visible all the way down
          else {
            let lo = vTop // visible
            let hi = vBot // hidden
            for (let n = 0; n < 7; n++) {
              const mid = (lo + hi) / 2
              if (blockedAt(u, mid)) hi = mid
              else lo = mid
            }
            vs.push((lo + hi) / 2)
          }
        }
        // Smooth edge: interpolate the column results with a cosine ease so it reads as a curve, not segments.
        const pts: [number, number][] = []
        for (let i = 0; i <= SEGS; i++) {
          const f = (i / SEGS) * COLS
          const c0 = Math.min(COLS - 1, Math.floor(f))
          const t = f - c0
          const e = (1 - Math.cos(t * Math.PI)) / 2
          pts.push([uMin + ((uMax - uMin) * i) / SEGS, vs[c0] * (1 - e) + vs[c0 + 1] * e])
        }
        const toSprite = (p: [number, number]) => `${f1(p[0])}px ${f1(p[1])}px`
        const spriteAbove = [`${f1(uMin - 10)}px ${f1(vTop - 60)}px`, `${f1(uMax + 10)}px ${f1(vTop - 60)}px`, ...[...pts].reverse().map(toSprite)]
        const spriteBelow = [`${f1(uMin - 10)}px ${f1(vBot + 60)}px`, `${f1(uMax + 10)}px ${f1(vBot + 60)}px`, ...[...pts].reverse().map(toSprite)]
        // The tag is not scaled with the flag: express the same edge in its own pixels.
        const toText = (p: [number, number]) => `${f1((p[0] - FOOT_X) * k + last.tw / 2)}px ${f1((p[1] - FOOT_Y) * k + last.th + k * (FRAME_H - 4) + 4)}px`
        const bigX = 4000
        const textAbove = [`${-bigX}px ${-bigX}px`, `${bigX}px ${-bigX}px`, ...[...pts].reverse().map(toText)]
        const textBelow = [`${-bigX}px ${bigX}px`, `${bigX}px ${bigX}px`, ...[...pts].reverse().map(toText)]
        edge = [spriteAbove, spriteBelow, textAbove, textBelow].map((p) => `polygon(${p.join(',')})`).join('|')
        ghostPoly = edge
      }
    }
    if (edge !== last.edge) {
      last.edge = edge
      if (edge === 'none') {
        solid.style.display = text.style.display = 'block'
        solid.style.clipPath = text.style.clipPath = 'none'
        ghost.style.display = textGhost.style.display = 'none'
      } else if (edge === 'all') {
        solid.style.display = text.style.display = 'none'
        ghost.style.display = textGhost.style.display = 'block'
        ghost.style.clipPath = textGhost.style.clipPath = 'none'
      } else {
        const [sa, sb, ta, tb] = ghostPoly.split('|')
        solid.style.display = text.style.display = 'block'
        ghost.style.display = textGhost.style.display = 'block'
        solid.style.clipPath = sa
        ghost.style.clipPath = sb
        text.style.clipPath = ta
        textGhost.style.clipPath = tb
      }
    }

    // Ground shadow: points away from the Sun, longer when the Sun is low, gone without sunlight.
    const sh = shadowRef.current
    if (sh) {
      const e = Math.max(2, Math.min(60, sunEl)) * (Math.PI / 180)
      const ks = Math.min(k * 2, 4)
      const len = Math.min(5 * POLE_METRES, POLE_METRES / Math.tan(e)) * ks * 0.5
      const az = sunAz * (Math.PI / 180)
      const dx = -Math.sin(az)
      const dz = Math.cos(az)
      sh.position.set((dx * len) / 2, 0.12, (dz * len) / 2)
      sh.rotation.set(-Math.PI / 2, 0, -Math.atan2(dz, dx))
      sh.scale.set(len, 0.7 * ks, 1)
      shadowMat.opacity = 0.38 * Math.max(0, Math.min(1, sunFrac)) * (sunEl > 0 ? 1 : 0)
    }
  })

  return (
    <group position={FLAG_OFFSET}>
      <mesh
        ref={(m) => {
          shadowRef.current = m
        }}
        material={shadowMat}
        renderOrder={19}
      >
        <circleGeometry args={[0.5, 24]} />
      </mesh>
    </group>
  )
}
