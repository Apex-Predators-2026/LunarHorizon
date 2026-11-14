import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { Vector3 } from 'three'
import type { TimelineStep } from '../types'
import { azElToVector } from './geometry'
import { MOON_RADIUS_M, type Vec3 } from './globe/cubeSphere'

// The bits of the scene's controls (GlobeControls, registered as the default controls) that we use.
type Controls = {
  target: Vector3
  update: () => void
  addEventListener: (type: 'start', fn: () => void) => void
  removeEventListener: (type: 'start', fn: () => void) => void
}

const FLY_MS = 850
type V3 = [number, number, number]
interface Flight {
  t0: number
  fromTarget: V3
  toTarget: V3
  fromOff: V3 // camera position relative to the target
  toOff: V3
}
const len = (v: V3) => Math.hypot(v[0], v[1], v[2])
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2) // ease-in-out cubic

export type ViewMode = 'globe' | 'region' | 'overview' | 'sun' | 'earth'

const OVERVIEW: [number, number, number] = [2600, 1400, 3400]
const OVERVIEW_CLEARANCE_M = 800 // keep the overview camera this far above the highest nearby terrain
const GLOBE_DISTANCE_M = 6_000_000 // from the Moon's centre: the whole Moon fits in a 50 deg view
const REGION_CAMERA: [number, number, number] = [0, 420_000, 250_000] // ~420 km up, offset towards +z

/**
 * Moves the camera for a view preset.
 *  - globe: the whole Moon, seen from above the site's hemisphere.
 *  - region: a few hundred km around the site (e.g. the whole south-polar region).
 *  - overview: a few km around the lander.
 *  - sun / earth: just behind the lander at eye level, looking along that body's azimuth/elevation,
 *    following the body as time changes.
 * The user can orbit and zoom freely afterwards.
 */
export function CameraRig({
  view,
  status,
  siteId,
  maxTerrainHeight,
  moonCentre,
  resetKey = 0,
}: {
  view: ViewMode
  status: TimelineStep | null
  siteId: string | null
  maxTerrainHeight: number | null // highest nearby terrain, relative to the site (m)
  moonCentre: Vec3 | null // in the site frame
  resetKey?: number // bump to fly back to the current view preset (e.g. after orbiting away)
}) {
  // Read camera/controls from the store inside the effect (they are mutable three.js objects).
  const get = useThree((s) => s.get)
  const invalidate = useThree((s) => s.invalidate)
  const controlsReady = useThree((s) => s.controls !== null)

  // Only the body views follow the Sun/Earth; the others reset when chosen or when the site changes.
  const body = view === 'sun' ? status?.sun : view === 'earth' ? status?.earth : null
  const az = body?.azimuth_deg
  const el = body?.elevation_deg
  const cy = moonCentre?.[1]

  const flight = useRef<Flight | null>(null)
  const last = useRef<{ view: ViewMode; resetKey: number } | null>(null)

  // The user grabbing the view cancels a flight in progress.
  useEffect(() => {
    const controls = get().controls as unknown as Controls | null
    if (!controls) return
    const stop = () => (flight.current = null)
    controls.addEventListener('start', stop)
    return () => controls.removeEventListener('start', stop)
  }, [controlsReady, get])

  useEffect(() => {
    const { camera } = get()
    const controls = get().controls as unknown as Controls | null
    if (!controls) return
    let pos: V3
    let target: V3
    if (view === 'globe' && cy !== undefined) {
      // Above the site's hemisphere, tilted towards local north so the limb and terminator show.
      const d = GLOBE_DISTANCE_M
      pos = [0, cy + d * 0.85, -d * 0.53]
      target = [0, cy, 0]
    } else if (view === 'region') {
      pos = [...REGION_CAMERA]
      target = [0, 0, 0]
    } else if (view === 'overview' || az === undefined || el === undefined) {
      // e.g. on a crater floor, rise above the rim so we look down into it rather than at a wall
      const y = Math.max(OVERVIEW[1], (maxTerrainHeight ?? 0) + OVERVIEW_CLEARANCE_M)
      pos = [OVERVIEW[0], y, OVERVIEW[2]]
      target = [0, 0, 0]
    } else {
      const [dx, , dz] = azElToVector(az, 0, 1)
      pos = [-dx * 45, 12, -dz * 45] // 45 m behind the lander, 12 m up
      const t = azElToVector(az, el, 5000)
      target = [t[0], t[1] + 12, t[2]]
    }

    // Fly (rather than jump) when the user asked for a different view or pressed the camera button.
    // Sun/Earth following the clock, or a site change, just re-aim instantly.
    const asked = last.current !== null && (last.current.view !== view || last.current.resetKey !== resetKey)
    last.current = { view, resetKey }
    if (asked) {
      flight.current = {
        t0: performance.now(),
        fromTarget: [controls.target.x, controls.target.y, controls.target.z],
        toTarget: target,
        fromOff: [camera.position.x - controls.target.x, camera.position.y - controls.target.y, camera.position.z - controls.target.z],
        toOff: [pos[0] - target[0], pos[1] - target[1], pos[2] - target[2]],
      }
      invalidate()
      return
    }
    flight.current = null
    camera.position.set(...pos)
    controls.target.set(...target)
    controls.update()
    invalidate()
  }, [view, siteId, az, el, maxTerrainHeight, cy, controlsReady, resetKey, get, invalidate])

  // Advance the flight: the target slides, and the camera's offset from it turns along the shortest
  // way while its distance changes exponentially, so a globe -> site move feels like a steady dive.
  useFrame(({ camera }) => {
    const f = flight.current
    const controls = get().controls as unknown as Controls | null
    if (!f || !controls) return
    const raw = Math.min(1, (performance.now() - f.t0) / FLY_MS)
    const k = ease(raw)
    const lerp = (a: number, b: number) => a + (b - a) * k
    const tgt: V3 = [lerp(f.fromTarget[0], f.toTarget[0]), lerp(f.fromTarget[1], f.toTarget[1]), lerp(f.fromTarget[2], f.toTarget[2])]
    const l0 = Math.max(len(f.fromOff), 1e-3)
    const l1 = Math.max(len(f.toOff), 1e-3)
    const dir: V3 = [0, 0, 0]
    for (let i = 0; i < 3; i++) dir[i] = lerp(f.fromOff[i] / l0, f.toOff[i] / l1)
    const dl = Math.max(len(dir), 1e-6)
    const dist = Math.exp(lerp(Math.log(l0), Math.log(l1)))
    controls.target.set(...tgt)
    camera.position.set(tgt[0] + (dir[0] / dl) * dist, tgt[1] + (dir[1] / dl) * dist, tgt[2] + (dir[2] / dl) * dist)
    // Never through the Moon: e.g. Site -> Globe slides the target from the surface down to the
    // Moon's centre, which took the camera hundreds of km underground (a black screen mid-flight).
    // Keep it at least a smooth blend of its start and end heights above the surface.
    if (moonCentre) {
      const height = (t: V3, o: V3) => Math.hypot(t[0] + o[0] - moonCentre[0], t[1] + o[1] - moonCentre[1], t[2] + o[2] - moonCentre[2]) - MOON_RADIUS_M
      const h0 = Math.max(1, height(f.fromTarget, f.fromOff))
      const h1 = Math.max(1, height(f.toTarget, f.toOff))
      const minR = MOON_RADIUS_M + Math.exp(lerp(Math.log(h0), Math.log(h1)))
      const rel = camera.position.clone().sub(new Vector3(...moonCentre))
      if (rel.length() < minR) camera.position.set(...moonCentre).add(rel.setLength(minR))
    }
    controls.update()
    if (raw >= 1) flight.current = null
    else invalidate()
  })

  return null
}
