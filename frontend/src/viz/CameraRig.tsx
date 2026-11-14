import { useThree } from '@react-three/fiber'
import { useEffect } from 'react'
import type { Vector3 } from 'three'
import type { TimelineStep } from '../types'

// The bits of drei's OrbitControls (registered with makeDefault) that we use.
type Controls = { target: Vector3; update: () => void }
import { azElToVector } from './geometry'

export type ViewMode = 'overview' | 'sun' | 'earth'

const OVERVIEW: [number, number, number] = [2600, 1400, 3400]
const OVERVIEW_CLEARANCE_M = 800 // keep the overview camera this far above the highest nearby terrain

/**
 * Moves the camera for a view preset. 'sun' / 'earth' stand just behind the lander at eye level
 * and look along that body's azimuth/elevation, so the body is centred against the real skyline.
 * Those views follow the body as time changes; the user can still orbit freely afterwards.
 */
export function CameraRig({
  view,
  status,
  siteId,
  maxTerrainHeight,
}: {
  view: ViewMode
  status: TimelineStep | null
  siteId: string | null
  maxTerrainHeight: number | null // highest terrain in the grid, relative to the site (m)
}) {
  // Read camera/controls from the store inside the effect (they are mutable three.js objects).
  const get = useThree((s) => s.get)
  const controlsReady = useThree((s) => s.controls !== null)

  // Overview ignores the bodies, so it only resets when chosen or when the site changes;
  // body views re-aim whenever the body moves.
  const body = view === 'sun' ? status?.sun : view === 'earth' ? status?.earth : null
  const az = body?.azimuth_deg
  const el = body?.elevation_deg

  useEffect(() => {
    const { camera } = get()
    const controls = get().controls as unknown as Controls | null
    if (!controls) return
    if (view === 'overview' || az === undefined || el === undefined) {
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
  }, [view, siteId, az, el, maxTerrainHeight, controlsReady, get])

  return null
}
