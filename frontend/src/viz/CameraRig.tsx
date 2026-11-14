import { useThree } from '@react-three/fiber'
import { useEffect } from 'react'
import type { Vector3 } from 'three'
import type { TimelineStep } from '../types'
import { azElToVector } from './geometry'
import type { Vec3 } from './globe/cubeSphere'

// The bits of drei's OrbitControls (registered with makeDefault) that we use.
type Controls = { target: Vector3; update: () => void }

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
}: {
  view: ViewMode
  status: TimelineStep | null
  siteId: string | null
  maxTerrainHeight: number | null // highest nearby terrain, relative to the site (m)
  moonCentre: Vec3 | null // in the site frame
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

  useEffect(() => {
    const { camera } = get()
    const controls = get().controls as unknown as Controls | null
    if (!controls) return
    if (view === 'globe' && cy !== undefined) {
      // Above the site's hemisphere, tilted towards local north so the limb and terminator show.
      const d = GLOBE_DISTANCE_M
      camera.position.set(0, cy + d * 0.85, -d * 0.53)
      controls.target.set(0, cy, 0)
    } else if (view === 'region') {
      camera.position.set(...REGION_CAMERA)
      controls.target.set(0, 0, 0)
    } else if (view === 'overview' || az === undefined || el === undefined) {
      // e.g. on a crater floor, rise above the rim so we look down into it rather than at a wall
      const y = Math.max(OVERVIEW[1], (maxTerrainHeight ?? 0) + OVERVIEW_CLEARANCE_M)
      camera.position.set(OVERVIEW[0], y, OVERVIEW[2])
      controls.target.set(0, 0, 0)
    } else {
      const [dx, , dz] = azElToVector(az, 0, 1)
      camera.position.set(-dx * 45, 12, -dz * 45) // 45 m behind the lander, 12 m up
      controls.target.set(...azElToVector(az, el, 5000))
      controls.target.y += 12
    }
    controls.update()
    invalidate()
  }, [view, siteId, az, el, maxTerrainHeight, cy, controlsReady, get, invalidate])

  return null
}
