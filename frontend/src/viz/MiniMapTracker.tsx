import { useFrame } from '@react-three/fiber'
import { useRef } from 'react'
import * as THREE from 'three'
import { MOON_RADIUS_M, vecToLatLon, type SiteFrame } from './globe/cubeSphere'
import { useCameraView, type LatLon } from './globe/miniMap'
import { raySphere } from './globeNav'

// Points around the edge of the screen (NDC), in order, for the camera's footprint on the minimap.
const EDGE: [number, number][] = [
  [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0],
]

/**
 * Tells the minimap (MoonMiniMap.tsx) what the 3D camera shows: the surface point in the middle of the
 * view and the points under the edges of the screen. Runs on rendered frames only (nothing while the
 * view is still) and publishes only when the picture changed.
 */
export function MiniMapTracker({ frame }: { frame: SiteFrame | null }) {
  const raycaster = useRef(new THREE.Raycaster())
  const ndc = useRef(new THREE.Vector2())
  const lastKey = useRef('')
  useFrame(({ camera }) => {
    if (!frame) return
    const centre = new THREE.Vector3(...frame.moonCentre)
    const toLatLon = (p: THREE.Vector3): LatLon => vecToLatLon(frame.toMoon([p.x, p.y, p.z]))
    const hit = (origin: THREE.Vector3, dir: THREE.Vector3) => {
      const t = raySphere(origin, dir, centre, MOON_RADIUS_M)
      return t === null ? null : toLatLon(origin.clone().addScaledVector(dir, t))
    }
    const forward = camera.getWorldDirection(new THREE.Vector3())
    const mid = hit(camera.position, forward) ?? toLatLon(camera.position) // looking at the sky: below the camera
    const footprint: LatLon[] = []
    for (const [x, y] of EDGE) {
      raycaster.current.setFromCamera(ndc.current.set(x, y), camera)
      const p = hit(raycaster.current.ray.origin, raycaster.current.ray.direction)
      if (p) footprint.push(p)
    }
    const key = [mid, ...footprint].map(([a, b]) => `${a.toFixed(3)},${b.toFixed(3)}`).join(' ')
    if (key === lastKey.current) return
    lastKey.current = key
    useCameraView.setState({ view: { centre: mid, footprint } })
  })
  return null
}
